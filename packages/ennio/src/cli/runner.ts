// Maestro YAML runner — socket-first, idb HID for taps.
//
// Scope (v0.1):
//   tapOn        { id | text | point }
//   doubleTapOn  (same selectors)
//   longPress
//   assertVisible / assertNotVisible / waitFor / assertAnyVisible
//   inputText    (current focused field)
//   eraseText    (n chars)
//   back
//   hideKeyboard
//   scroll       (direction)
//   launchApp    ({ clearState?: boolean })
//   takeScreenshot
//   extendedWaitUntil (visible / notVisible)
//
// Deferred to v0.2:
//   spatial / hierarchical selectors (below / above / containsChild / ...)
//   runFlow / runScript / evalScript
//   retry / repeat blocks (we honour the per-step waitFor timeout but
//                          not a full retry block)
//   scrollUntilVisible
//   swipe between testIDs
//   travel / setLocation / setPermissions
//   recordVideo / startRecording

import { execFileSync } from 'node:child_process';

import { dirname, resolve } from 'node:path';

import {
  MaestroCommand,
  MaestroFlow,
  MaestroSelector,
  normalizeSelector,
  parseMaestroFile,
} from './maestro-parser';
import { EnnioSocketClient } from './socket-client';
import { tap as hidTap, swipe as hidSwipe, typeText as hidType } from './hid';
import { ensureBootedSim, findDylib, getAppContainer, terminateApp } from './sim';

// Default implicit-wait on visibility predicates. Maestro's default is
// 5s. We use 10s because on iOS 26 sim, a tile-tap-driven screen
// transition can take 4-7s (RN bundle execute on the destination
// screen + UIKit layout pass + RNGH gesture acceptance). Tests pass
// the same flow definitions Maestro accepts; we just give the runtime
// more headroom.
const DEFAULT_WAIT_MS = 10000;
const POLL_MS = 100;
// Minimum fixed wait after every tap. wait_commit can return immediately
// if the frame-hash is stable, but RN often starts the navigation
// animation slightly LATER than the tap (event dispatched → JS handles
// onPress → setState → React commit → mount → animation begins). 800ms
// covers the JS+commit gap; the subsequent wait_commit catches the
// transition itself.
// Bridge wait — gives JS thread time to fire onPress → setState
// → React commit before wait_commit observes the screen. The
// frame-hash hasn't changed yet immediately post-tap, so without
// this buffer wait_commit would see "stable" prematurely and
// return. 800ms is the empirical sweet spot — shorter values let
// wait_commit return on the unchanged pre-commit frame and pass
// stability through to the next find; longer values bloat suite
// runtime without measurable gain.
const POST_TAP_SETTLE_MS = 800;
const POST_LAUNCH_SETTLE_MS = 1500;

interface RunContext {
  client: EnnioSocketClient;
  udid: string;
  bundleId: string;
  /** dylib path; only used for clearState relaunch */
  dylibPath: string | null;
  verbose: boolean;
  /** Path to the currently-executing flow file. Used for runFlow
   *  subflow path resolution. */
  flowPath: string;
  /** Last tapOn target signature. When the next tapOn matches the
   *  same target, the runner shortens its post-tap settle so the two
   *  taps land inside RN's double-tap window (<350 ms). */
  lastTapKey?: string;
  /** Timestamp of the last UIRefreshControl trigger. Throttles the
   *  trigger_refresh shortcut so a YAML pattern of "warmup swipe +
   *  real swipe" doesn't fire the refresh handler twice. */
  lastRefreshAtMs?: number;
  /** Aggregate per-phase timings. Used by the bottleneck reporter at
   *  the end of each flow. Phase names map to the discrete chunks of
   *  work inside a single command (preWaitCommit, find, hidTap, …). */
  phaseTotals?: Map<string, number>;
  phaseCounts?: Map<string, number>;
}

function recordPhase(ctx: RunContext, name: string, ms: number): void {
  if (!ctx.phaseTotals) ctx.phaseTotals = new Map();
  if (!ctx.phaseCounts) ctx.phaseCounts = new Map();
  ctx.phaseTotals.set(name, (ctx.phaseTotals.get(name) ?? 0) + ms);
  ctx.phaseCounts.set(name, (ctx.phaseCounts.get(name) ?? 0) + 1);
}

async function timedAsync<T>(ctx: RunContext, name: string, fn: () => Promise<T>): Promise<T> {
  const t = Date.now();
  try {
    return await fn();
  } finally {
    recordPhase(ctx, name, Date.now() - t);
  }
}

function timedSync<T>(ctx: RunContext, name: string, fn: () => T): T {
  const t = Date.now();
  try {
    return fn();
  } finally {
    recordPhase(ctx, name, Date.now() - t);
  }
}

export interface RunResult {
  passed: boolean;
  stepsRun: number;
  stepsPassed: number;
  failure?: { step: number; command: string; reason: string };
}

// =====================================================================
// Top-level
// =====================================================================

export async function runFlow(
  flow: MaestroFlow,
  options: { udid?: string; dylibPath?: string; verbose?: boolean } = {},
): Promise<RunResult> {
  const udid = options.udid || ensureBootedSim();
  if (!udid) {
    throw new Error('No iOS simulator available. Install one via Xcode or set ENNIO_UDID.');
  }
  if (!flow.appId) {
    throw new Error(`Flow ${flow.filePath} is missing top-level appId`);
  }

  const client = new EnnioSocketClient();
  if (!(await client.connect())) {
    // Socket not up — app isn't running with libennio injected. Auto-
    // launch with the dylib so users don't need a pre-step. Auto-locate
    // the dylib from common install paths; ENNIO_DYLIB_PATH or
    // options.dylibPath wins if set.
    const dylib = options.dylibPath || findDylib();
    if (!dylib) {
      throw new Error(
        'Could not find libennio.dylib. Looked in:\n' +
          '  - $ENNIO_DYLIB_PATH (unset)\n' +
          '  - /tmp/ennio-build/libennio.dylib\n' +
          '  - <package>/prebuilt/libennio.dylib\n' +
          'Build the dylib (see ARCHITECTURE.md) or set ENNIO_DYLIB_PATH.',
      );
    }
    try {
      terminateApp(udid, flow.appId);
    } catch {
      /* not running */
    }
    execFileSync('xcrun', ['simctl', 'launch', '--terminate-running-process', udid, flow.appId], {
      env: { ...process.env, SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: dylib },
      stdio: 'pipe',
    });
    if (!(await client.connectWithRetry(15_000))) {
      throw new Error(
        'Auto-launched the app with DYLD injection but libennio socket ' +
          'never came up. Check the app is a Debug build and the dylib ' +
          'path is correct.',
      );
    }
    // Wait for bootstrap=ready.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        const r = await client.call('ping');
        const ready = r.ok && r.data && (r.data as { bootstrap?: string }).bootstrap === 'ready';
        if (ready) break;
      } catch {
        /* try again */
      }
      await sleep(100);
    }
    // Same first-paint settle as clearStateAndRelaunch — wait_commit
    // reports stable immediately on a blank screen, so couple it with
    // a minimum sleep that covers RN bridge boot + first paint.
    await client.call('wait_commit', { maxMs: 8000, stableMs: 250 }).catch(() => undefined);
    await sleep(2000);
    await client.call('wait_commit', { maxMs: 3000, stableMs: 300 }).catch(() => undefined);
  }

  const ctx: RunContext = {
    client,
    udid,
    bundleId: flow.appId,
    dylibPath: options.dylibPath ?? null,
    verbose: options.verbose ?? false,
    flowPath: flow.filePath,
  };

  log(ctx, `▶ ${flow.name || flow.filePath} (${flow.commands.length} steps)`);

  let stepsPassed = 0;
  const stepTimings: { step: number; ms: number; cmd: string }[] = [];
  for (let i = 0; i < flow.commands.length; i++) {
    const cmd = flow.commands[i];
    const nextCmd = flow.commands[i + 1];
    const t0 = Date.now();
    try {
      await runCommand(ctx, cmd, nextCmd);
      const dt = Date.now() - t0;
      stepTimings.push({ step: i + 1, ms: dt, cmd: describeCommand(cmd) });
      logStep(ctx, i + 1, dt, describeCommand(cmd));
      stepsPassed++;
    } catch (err) {
      const dt = Date.now() - t0;
      stepTimings.push({ step: i + 1, ms: dt, cmd: describeCommand(cmd) });
      logStep(ctx, i + 1, dt, describeCommand(cmd));
      client.close();
      printSlowSteps(stepTimings);
      printPhaseTotals(ctx);
      return {
        passed: false,
        stepsRun: i + 1,
        stepsPassed,
        failure: {
          step: i + 1,
          command: describeCommand(cmd),
          reason: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }
  client.close();
  printSlowSteps(stepTimings);
  printPhaseTotals(ctx);
  return { passed: true, stepsRun: flow.commands.length, stepsPassed };
}

// Always print the top-5 slowest steps so the suite log surfaces
// bottlenecks per-flow without verbose mode.
function printSlowSteps(timings: { step: number; ms: number; cmd: string }[]): void {
  const total = timings.reduce((s, t) => s + t.ms, 0);
  const top = [...timings].sort((a, b) => b.ms - a.ms).slice(0, 5);
  process.stderr.write(`[ennio] total ${total}ms across ${timings.length} steps. Top 5:\n`);
  for (const t of top)
    process.stderr.write(`[ennio]   ${String(t.ms).padStart(5)}ms  step ${t.step}: ${t.cmd}\n`);
}

// Aggregate per-phase totals across the flow so the bottleneck is
// obvious: e.g. "tap.postSleep took 32s across 40 taps" tells us the
// 800 ms POST_TAP_SETTLE_MS is the dominant cost.
function printPhaseTotals(ctx: RunContext): void {
  if (!ctx.phaseTotals || ctx.phaseTotals.size === 0) return;
  const entries = [...ctx.phaseTotals.entries()].map(([name, total]) => ({
    name,
    total,
    count: ctx.phaseCounts?.get(name) ?? 0,
  }));
  entries.sort((a, b) => b.total - a.total);
  process.stderr.write(`[ennio] phase totals (sorted by ms):\n`);
  for (const e of entries) {
    const avg = e.count > 0 ? Math.round(e.total / e.count) : 0;
    process.stderr.write(
      `[ennio]   ${String(e.total).padStart(6)}ms  ` +
        `${String(e.count).padStart(4)}x  ` +
        `${String(avg).padStart(4)}ms/call  ` +
        `${e.name}\n`,
    );
  }
}

// =====================================================================
// Per-command dispatch
// =====================================================================

async function runCommand(
  ctx: RunContext,
  rawCmd: MaestroCommand,
  nextRawCmd?: MaestroCommand,
): Promise<void> {
  // Maestro lets some commands be bare strings: `- hideKeyboard`,
  // `- back`, `- launchApp`, etc. js-yaml parses those as plain strings,
  // not `{hideKeyboard: true}`. Normalise so the dispatch below can use
  // the same `'op' in cmd` shape unconditionally.
  const cmd: MaestroCommand =
    typeof rawCmd === 'string' ? ({ [rawCmd]: true } as unknown as MaestroCommand) : rawCmd;

  // Reset repeat-tap tracking unless this command itself is a tapOn.
  if (!('tapOn' in cmd)) ctx.lastTapKey = undefined;

  if ('tapOn' in cmd) {
    const sel = normalizeSelector(cmd.tapOn);
    const tapKey = JSON.stringify(sel);
    const isRepeatTap = ctx.lastTapKey === tapKey;
    // Look-ahead: if the NEXT command is a tapOn on the same target,
    // skip our post-settle so the two HID events land inside RN's
    // double-tap window (<350 ms). Without this, even with the
    // repeat-tap fast-path on the second tap, the first tap's
    // 800 ms POST_TAP_SETTLE + post wait_commit pushes the gap
    // over a second.
    let nextIsSameTap = false;
    if (nextRawCmd && typeof nextRawCmd === 'object' && 'tapOn' in nextRawCmd) {
      const nextSel = normalizeSelector((nextRawCmd as { tapOn: unknown }).tapOn as any);
      if (JSON.stringify(nextSel) === tapKey) nextIsSameTap = true;
    }
    // Pre-tap settle: wait for the screen to stop animating so we tap
    // a stable button frame, not a half-transitioned one. Without this,
    // the tap can land on a view that's still sliding in from a tab
    // switch and RNGH's gesture recognizer rejects the touch.
    // stableMs 600ms outlasts React-Navigation's modal dismiss
    // animation (~300ms) plus UIKit's presented-VC teardown — a
    // shorter window reports "stable" while a residual sheet overlay
    // is still absorbing touches and the next tap silently misses.
    // Repeat-tap case skips this — back-to-back tapOns on the same
    // target are typically intentional double-taps (RN DoubleTapBox
    // uses a <350 ms Date.now() gap detector).
    if (!isRepeatTap) {
      await timedAsync(ctx, 'tap.preWaitCommit', () =>
        ctx.client.call('wait_commit', { maxMs: 3500, stableMs: 600 }).catch(() => undefined),
      );
      // Belt-and-braces: even after the frame-hash is stable, a
      // presented sheet's residual overlay UIView can absorb touches
      // for a few hundred ms while UIKit tears it down. Waiting until
      // no view controller reports isBeingPresented / isBeingDismissed
      // closes that gap. No-op when nothing is mid-transition.
      await timedAsync(ctx, 'tap.preWaitPresentation', () =>
        ctx.client.call('wait_presentation_idle', { maxMs: 2000 }).catch(() => undefined),
      );
    }
    const preTapHash = await captureHash(ctx);
    await timedAsync(ctx, 'tap.execTapOn', () => execTapOn(ctx, sel, preTapHash));
    if (isRepeatTap || nextIsSameTap) {
      // Tight gap so consecutive same-target taps register as a
      // double-tap on RN Pressables / RNGH Tap recognizers.
      await timedAsync(ctx, 'tap.postSleepRepeat', () => sleep(120));
    } else {
      await timedAsync(ctx, 'tap.postSleep', () => sleep(POST_TAP_SETTLE_MS));
      await timedAsync(ctx, 'tap.postWaitCommit', () =>
        ctx.client.call('wait_commit', { maxMs: 2500, stableMs: 300 }).catch(() => undefined),
      );
    }
    ctx.lastTapKey = tapKey;
    return;
  }
  if ('doubleTapOn' in cmd) {
    const sel = normalizeSelector(cmd.doubleTapOn);
    const { x, y } = await resolveCenter(ctx, sel);
    hidTap(ctx.udid, x, y);
    await sleep(80);
    hidTap(ctx.udid, x, y);
    await sleep(POST_TAP_SETTLE_MS);
    return;
  }
  if ('longPress' in cmd || 'longPressOn' in cmd) {
    const sel = normalizeSelector(('longPress' in cmd ? cmd.longPress : cmd.longPressOn) as any);
    const { x, y } = await resolveCenter(ctx, sel);
    // Long press = idb ui tap with a hold duration. Maestro's default
    // long-press is 1500ms; many RN long-press handlers register at
    // ~500ms so 0.8s comfortably crosses both thresholds without making
    // the test feel slow.
    hidTap(ctx.udid, x, y, 0.8);
    await sleep(POST_TAP_SETTLE_MS);
    return;
  }
  if ('assertVisible' in cmd) {
    const sel = normalizeSelector(cmd.assertVisible);
    const timeout = cmd.assertVisible.timeout ?? DEFAULT_WAIT_MS;
    await waitUntilVisible(ctx, sel, timeout);
    return;
  }
  if ('assertNotVisible' in cmd) {
    const sel = normalizeSelector(cmd.assertNotVisible);
    const timeout = cmd.assertNotVisible.timeout ?? DEFAULT_WAIT_MS;
    await waitUntilNotVisible(ctx, sel, timeout);
    return;
  }
  if ('waitFor' in cmd) {
    const sel = normalizeSelector(cmd.waitFor);
    const timeout = cmd.waitFor.timeout ?? DEFAULT_WAIT_MS;
    await waitUntilVisible(ctx, sel, timeout);
    return;
  }
  if ('assertAnyVisible' in cmd) {
    const timeout = DEFAULT_WAIT_MS;
    const selectors = cmd.assertAnyVisible.anyOf.map(normalizeSelector);
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      for (const s of selectors) {
        if (await isVisible(ctx, s)) return;
      }
      await sleep(POLL_MS);
    }
    throw new Error(`assertAnyVisible: none of the ${selectors.length} selectors became visible`);
  }
  if ('extendedWaitUntil' in cmd) {
    const timeout = cmd.extendedWaitUntil.timeout ?? DEFAULT_WAIT_MS;
    if (cmd.extendedWaitUntil.visible) {
      await waitUntilVisible(ctx, cmd.extendedWaitUntil.visible, timeout);
    } else if (cmd.extendedWaitUntil.notVisible) {
      await waitUntilNotVisible(ctx, cmd.extendedWaitUntil.notVisible, timeout);
    }
    return;
  }
  if ('inputText' in cmd) {
    // Prefer the in-process UIKeyInput.insertText path — it bypasses
    // the sim's hardware-keyboard locale, so chars like @, è, accents,
    // and quotes survive verbatim. Fall back to idb's HID-text path
    // when no firstResponder conforms to UIKeyInput (rare).
    let ok = false;
    try {
      const r = await ctx.client.call('insert_text', { text: cmd.inputText });
      ok = !!(r.ok && r.data && (r.data as { ok: boolean }).ok);
    } catch {
      /* fall through to hidType */
    }
    if (!ok) hidType(ctx.udid, cmd.inputText);
    await sleep(200);
    await ctx.client.call('wait_commit', { maxMs: 500, stableMs: 80 });
    return;
  }
  if ('eraseText' in cmd) {
    // Maestro semantics:
    //   - eraseText                 → erase ALL text in focused field
    //   - eraseText: 5              → erase exactly 5 chars
    //   - eraseText: { characters } → erase that many chars
    let count: number;
    if (typeof cmd.eraseText === 'number') {
      count = cmd.eraseText;
    } else if (
      cmd.eraseText &&
      typeof cmd.eraseText === 'object' &&
      'characters' in cmd.eraseText
    ) {
      count = (cmd.eraseText as { characters: number }).characters;
    } else {
      count = 100; // bare form: clear the field
    }
    for (let i = 0; i < count; i++) await ctx.client.call('hardware_key', { keyCode: 42 });
    return;
  }
  if ('clearText' in cmd) {
    // Best effort: erase a generous chunk via backspace key on the dylib's
    // hardware-key handler. Real Maestro semantics: erase until the field
    // is empty.
    for (let i = 0; i < 200; i++) await ctx.client.call('hardware_key', { keyCode: 42 });
    return;
  }
  if ('pressKey' in cmd) {
    // Map Maestro key names to HID keycodes. Maestro accepts a string
    // like 'Backspace' / 'Enter' / 'Tab' / 'Home' / etc.
    const name = String(cmd.pressKey).toLowerCase();
    const map: Record<string, number> = {
      backspace: 42,
      delete: 42,
      enter: 40,
      return: 40,
      tab: 43,
      space: 44,
      escape: 41,
      esc: 41,
    };
    const code = map[name];
    if (code != null) await ctx.client.call('hardware_key', { keyCode: code });
    await sleep(80);
    return;
  }
  if ('back' in cmd) {
    await ctx.client.call('back');
    await sleep(POST_TAP_SETTLE_MS);
    return;
  }
  if ('hideKeyboard' in cmd) {
    await ctx.client.call('hide_keyboard');
    await sleep(150);
    return;
  }
  if ('scrollUntilVisible' in cmd) {
    // Resolve the target selector. Maestro accepts either a bare
    // selector or { element: ..., direction, timeout }.
    const arg = cmd.scrollUntilVisible as
      | MaestroSelector
      | { element: MaestroSelector; direction?: string; timeout?: number };
    const target = 'element' in arg ? arg.element : (arg as MaestroSelector);
    const dir = ('direction' in arg && arg.direction ? arg.direction : 'DOWN').toUpperCase();
    const timeout = ('timeout' in arg && arg.timeout) || 10000;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await isVisible(ctx, target)) {
        // Important: scroll momentum keeps the list moving for a beat
        // after the swipe ends. A tap fired immediately after isVisible
        // returns true lands on a moving target — RN's gesture
        // recognizer either rejects it or routes to whatever is at the
        // moving-touch point. Wait for the scrollview to settle before
        // returning so the next tapOn has stable coords.
        await sleep(600);
        await ctx.client.call('wait_commit', { maxMs: 2000, stableMs: 300 }).catch(() => undefined);
        // Tab-bar overlap guard: if target's centre Y falls into the
        // bottom ~25% of the viewport, do one short extra scroll to
        // push it up. Otherwise tile coords overlap the UITabBar
        // buttons (Home/Cart/etc.) and the next tap routes to the
        // wrong element.
        const rect = await resolveRect(ctx, target);
        if (rect && rect.y + rect.h / 2 > 700) {
          const cx = 195;
          const cy = 422;
          const small = 150;
          if (dir === 'DOWN') {
            hidSwipe(ctx.udid, cx, cy + small / 2, cx, cy - small / 2, 250);
          } else if (dir === 'UP') {
            hidSwipe(ctx.udid, cx, cy - small / 2, cx, cy + small / 2, 250);
          }
          await sleep(500);
          await ctx.client
            .call('wait_commit', { maxMs: 1500, stableMs: 200 })
            .catch(() => undefined);
        }
        return;
      }
      // Centre swipe in the requested direction. Shorter swipe distance
      // (250 vs 400) so we don't overshoot a tile that's just out of
      // viewport — overshoot puts the target back off-screen on the
      // other side and the next isVisible miss loops forever.
      const cx = 195;
      const cy = 422;
      const dist = 250;
      let x1 = cx,
        y1 = cy,
        x2 = cx,
        y2 = cy;
      if (dir === 'DOWN') {
        y1 = cy + dist / 2;
        y2 = cy - dist / 2;
      } else if (dir === 'UP') {
        y1 = cy - dist / 2;
        y2 = cy + dist / 2;
      } else if (dir === 'LEFT') {
        x1 = cx + dist / 2;
        x2 = cx - dist / 2;
      } else if (dir === 'RIGHT') {
        x1 = cx - dist / 2;
        x2 = cx + dist / 2;
      }
      hidSwipe(ctx.udid, x1, y1, x2, y2, 250);
      await sleep(500);
    }
    throw new Error(`scrollUntilVisible: target never visible within ${timeout}ms`);
  }
  if ('swipe' in cmd) {
    const s = cmd.swipe;
    // Accept any of:
    //   { direction: 'UP'|'DOWN'|'LEFT'|'RIGHT' }
    //   { start: "50%,50%" | {x,y}, end: ... }
    //   { from: <selector|string>, direction?: ... }
    const sw = s as {
      direction?: string;
      start?: string | { x: number; y: number };
      end?: string | { x: number; y: number };
      from?: unknown;
      duration?: number;
    };
    const winW = 390;
    const winH = 844;
    const parseCoord = (
      val: string | { x: number; y: number } | undefined,
      fallback: { x: number; y: number },
    ): { x: number; y: number } => {
      if (!val) return fallback;
      if (typeof val === 'string') {
        const [xs, ys] = val.split(',').map((p) => p.trim());
        let x = parseFloat(xs);
        let y = parseFloat(ys);
        if (xs.endsWith('%') || (x <= 1 && xs.length > 0)) x = (x > 1 ? x / 100 : x) * winW;
        if (ys.endsWith('%') || (y <= 1 && ys.length > 0)) y = (y > 1 ? y / 100 : y) * winH;
        return { x, y };
      }
      return val;
    };
    let from = { x: winW / 2, y: winH / 2 };
    let to = { x: winW / 2, y: winH / 2 };
    if (sw.start || sw.end) {
      from = parseCoord(sw.start, from);
      to = parseCoord(sw.end, to);
    } else if (sw.direction) {
      const d = sw.direction.toUpperCase();
      const dist = 400;
      if (d === 'DOWN') {
        from = { x: winW / 2, y: winH / 2 + dist / 2 };
        to = { x: winW / 2, y: winH / 2 - dist / 2 };
      } else if (d === 'UP') {
        from = { x: winW / 2, y: winH / 2 - dist / 2 };
        to = { x: winW / 2, y: winH / 2 + dist / 2 };
      } else if (d === 'LEFT') {
        from = { x: winW / 2 + dist / 2, y: winH / 2 };
        to = { x: winW / 2 - dist / 2, y: winH / 2 };
      } else if (d === 'RIGHT') {
        from = { x: winW / 2 - dist / 2, y: winH / 2 };
        to = { x: winW / 2 + dist / 2, y: winH / 2 };
      }
    }
    // Pre-swipe pull-to-refresh dedupe: if this is a downward pull
    // from the top of the screen and a UIRefreshControl on the
    // underlying scroll view is already in the refreshing state,
    // skip the swipe. idb HID swipes reliably cross UIRefreshControl's
    // pan threshold on iOS 26 sim, so a YAML "warm-up + trigger"
    // double-swipe pattern would otherwise fire onRefresh twice.
    const dy = to.y - from.y;
    const dx = Math.abs(to.x - from.x);
    const isPullToRefresh = dy > 100 && dx < 40 && from.y < winH * 0.4;
    if (isPullToRefresh) {
      const now = Date.now();
      // Two checks: (a) is the refresh actively spinning right now?,
      // (b) did we just fire one in the past 3s? RN's onRefresh
      // handler typically clears the spinner in <1s, so an "is_refreshing
      // == false" snapshot a moment later doesn't mean the second
      // swipe should fire — the YAML's "warm-up swipe" was the same
      // intent as the first, just with redundant insurance.
      try {
        const r = await ctx.client.call('is_refreshing', {
          x: Math.round(from.x),
          y: Math.round(from.y),
        });
        if (r.ok && r.data && (r.data as { refreshing: boolean }).refreshing) {
          ctx.lastRefreshAtMs = now;
          await sleep(200);
          return;
        }
      } catch {
        /* fall through */
      }
      if (ctx.lastRefreshAtMs && now - ctx.lastRefreshAtMs < 3000) {
        await sleep(200);
        return;
      }
      ctx.lastRefreshAtMs = now;
    }
    hidSwipe(ctx.udid, from.x, from.y, to.x, to.y, sw.duration ?? 250);
    await sleep(500);
    await ctx.client.call('wait_commit', { maxMs: 1000, stableMs: 150 }).catch(() => undefined);
    return;
  }
  if ('scroll' in cmd) {
    const dir = (cmd.scroll.direction || 'DOWN').toLowerCase();
    // Centre swipe approximation. Window size assumed 390x844 — good
    // enough for v0.1, replaced with real key-window size later.
    const cx = 195;
    const cy = 422;
    const dist = 300;
    let x1 = cx,
      y1 = cy,
      x2 = cx,
      y2 = cy;
    if (dir === 'down') {
      y1 = cy + dist / 2;
      y2 = cy - dist / 2;
    } else if (dir === 'up') {
      y1 = cy - dist / 2;
      y2 = cy + dist / 2;
    } else if (dir === 'left') {
      x1 = cx + dist / 2;
      x2 = cx - dist / 2;
    } else if (dir === 'right') {
      x1 = cx - dist / 2;
      x2 = cx + dist / 2;
    }
    hidSwipe(ctx.udid, x1, y1, x2, y2, 250);
    await sleep(400);
    return;
  }
  if ('launchApp' in cmd) {
    const opts =
      cmd.launchApp === true ? { clearState: false } : (cmd.launchApp as { clearState?: boolean });
    if (opts.clearState) {
      await clearStateAndRelaunch(ctx);
    } else if (!ctx.client.isConnected()) {
      // Socket dropped — app was killed (stopApp/killApp) or crashed.
      // Re-launch with DYLD inject so the dylib reattaches.
      await relaunchAndReconnect(ctx);
    }
    await sleep(POST_LAUNCH_SETTLE_MS);
    return;
  }
  if ('clearState' in cmd) {
    await clearStateAndRelaunch(ctx);
    await sleep(POST_LAUNCH_SETTLE_MS);
    return;
  }
  if ('stopApp' in cmd || 'killApp' in cmd) {
    // Close the socket BEFORE killing the app — otherwise the socket
    // FIN from the dying process races our next isConnected() check
    // and the following launchApp incorrectly skips the relaunch.
    ctx.client.close();
    terminateApp(ctx.udid, ctx.bundleId);
    return;
  }
  if ('takeScreenshot' in cmd) {
    const path =
      typeof cmd.takeScreenshot === 'string' ? cmd.takeScreenshot : cmd.takeScreenshot.path;
    execFileSync('xcrun', ['simctl', 'io', ctx.udid, 'screenshot', path]);
    return;
  }
  if ('dismissAlert' in cmd) {
    await ctx.client.call('alert_dismiss');
    return;
  }
  if ('openLink' in cmd) {
    const link = typeof cmd.openLink === 'string' ? cmd.openLink : cmd.openLink.link;
    execFileSync('xcrun', ['simctl', 'openurl', ctx.udid, link]);
    await sleep(POST_LAUNCH_SETTLE_MS);
    return;
  }
  if ('waitForAnimationToEnd' in cmd) {
    const timeout =
      cmd.waitForAnimationToEnd === true ? 3000 : (cmd.waitForAnimationToEnd.timeout ?? 3000);
    await ctx.client.call('wait_commit', { maxMs: timeout, stableMs: 150 });
    return;
  }
  if ('runFlow' in cmd) {
    const sub = cmd.runFlow;
    // `when:` clause — evaluate the predicate against current screen.
    // If false, skip the subflow entirely.
    if (sub.when) {
      const w = sub.when;
      let satisfied = true;
      if (w.visible) {
        satisfied = await isVisible(ctx, normalizeSelector(w.visible));
      } else if (w.notVisible) {
        satisfied = !(await isVisible(ctx, normalizeSelector(w.notVisible)));
      }
      if (!satisfied) return;
    }
    // Inline commands form: { runFlow: { when?: ..., commands: [...] } }
    if (sub.commands && Array.isArray(sub.commands)) {
      for (let i = 0; i < sub.commands.length; i++)
        await runCommand(ctx, sub.commands[i], sub.commands[i + 1]);
      return;
    }
    // File form: { runFlow: { file: "subflows/foo.yaml" } }
    if (sub.file) {
      const subPath = resolve(dirname(ctx.flowPath), sub.file);
      const subFlow = parseMaestroFile(subPath);
      const prevPath = ctx.flowPath;
      ctx.flowPath = subPath;
      try {
        for (let i = 0; i < subFlow.commands.length; i++)
          await runCommand(ctx, subFlow.commands[i], subFlow.commands[i + 1]);
      } finally {
        ctx.flowPath = prevPath;
      }
      return;
    }
    return;
  }
  if ('repeat' in cmd) {
    for (let i = 0; i < cmd.repeat.times; i++) {
      for (let i = 0; i < cmd.repeat.commands.length; i++)
        await runCommand(ctx, cmd.repeat.commands[i], cmd.repeat.commands[i + 1]);
    }
    return;
  }
  if ('retry' in cmd) {
    const maxRetries = cmd.retry.maxRetries ?? 3;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        for (let i = 0; i < cmd.retry.commands.length; i++)
          await runCommand(ctx, cmd.retry.commands[i], cmd.retry.commands[i + 1]);
        return;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  // Anything else: warn and skip rather than fail loudly. v0.1 covers
  // ~80% of common Maestro grammar; unsupported ops are documented as
  // such in ARCHITECTURE.md.
  log(ctx, `  (unsupported in v0.1, skipped: ${describeCommand(cmd)})`);
}

// =====================================================================
// Helpers
// =====================================================================

async function captureHash(ctx: RunContext): Promise<string> {
  try {
    const r = await ctx.client.call('frame_hash');
    if (r.ok && r.data) return String((r.data as { hash: string }).hash);
  } catch {
    /* hash unavailable */
  }
  return '';
}

// Retained for future post-tap settle experiments — see commit message.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function _waitForHashChange(
  ctx: RunContext,
  baseline: string,
  maxMs: number,
): Promise<boolean> {
  if (!baseline) {
    await sleep(POST_TAP_SETTLE_MS);
    return true;
  }
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await sleep(60);
    const cur = await captureHash(ctx);
    if (cur && cur !== baseline) return true;
  }
  return false;
}

async function execTapOn(
  ctx: RunContext,
  sel: MaestroSelector,
  preHash?: string,
): Promise<void> {
  // Point-tap fast path — no discovery needed.
  if (sel.point !== undefined) {
    const { x, y } = parsePoint(sel.point);
    hidTap(ctx.udid, x, y);
    return;
  }
  // UIAlertController auto-handler: button labels never make it into
  // the RN view tree, so a text-selector tap on an alert button would
  // miss. Detect a present alert and route through the dylib's
  // alert_tap op, which targets the UIAlertAction directly.
  if (sel.text) {
    try {
      const a = await ctx.client.call('alert_present');
      if (a.ok && a.data && (a.data as { present: boolean }).present) {
        const t = await ctx.client.call('alert_tap', { buttonText: sel.text });
        if (t.ok && t.data && (t.data as { tapped: boolean }).tapped) return;
      }
    } catch {
      /* fall through to normal find */
    }
  }
  const center = await timedAsync(ctx, 'tap.find', () => resolveCenter(ctx, sel));
  const baseHash = preHash ?? (await captureHash(ctx));
  // Critical micro-sleep between discovery + tap. find_by_testid
  // dispatch_syncs onto main; immediately following that with idb's
  // HID event lands the touch in a narrow window where UIKit's
  // hit-test layer-tree is still being re-established. RNGH's
  // gesture recognizer silently rejects the tap. 80ms is enough on
  // iOS 26 sims to clear the window; verified by smoke run of the
  // race-sensitive flows (09 / 03).
  await timedAsync(ctx, 'tap.preTapSleep', () => sleep(80));
  timedSync(ctx, 'tap.hidTap', () => hidTap(ctx.udid, center.x, center.y));
  // Self-healing recovery for testID taps. If after the tap
  //   (a) the same testID still resolves at the same coords, AND
  //   (b) the screen hash is unchanged from before the tap,
  // the touch did not activate the pressable — usually because a
  // residual presented-VC overlay absorbed it after a modal dismiss.
  // Re-fire the tap once. We use the hash check (in addition to the
  // identity check) so legitimate state-only taps — toggles, switches,
  // counters — aren't double-fired: even an "in place" toggle changes
  // the frame hash because its tint/value redraws.
  // Replace the old 500ms fixed wait with a hash-poll: as soon as we
  // observe a hash change the tap clearly worked, so we can exit
  // self-heal early. Most successful taps fire the change in <150ms.
  if (sel.id && baseHash) {
    // Fixed 500ms gives the JS pipeline a fair shot at running
    // onPress → setState → commit. Shorter windows (a hash poll that
    // returns immediately on ANY change) wrongly treated incidental
    // hash flickers (focus ring, pressed-state tint, scroll inertia
    // half-pixel offsets) as "the tap worked" and skipped retap on
    // genuine misses where the underlying nav never started.
    await timedAsync(ctx, 'tap.selfHealSleep', () => sleep(500));
    const recheck = await timedAsync(ctx, 'tap.selfHealRefind', () =>
      ctx.client.call('find_by_testid', { testID: sel.id! }),
    );
    if (recheck.ok && recheck.data) {
      const r = recheck.data as Rect;
      const sameSpot =
        Math.abs(r.x + r.w / 2 - center.x) < 6 && Math.abs(r.y + r.h / 2 - center.y) < 6;
      if (sameSpot) {
        const postHash = await captureHash(ctx);
        if (postHash && postHash === baseHash) {
          timedSync(ctx, 'tap.selfHealRetap', () => hidTap(ctx.udid, center.x, center.y));
        }
      }
    }
  }
}

async function resolveCenter(
  ctx: RunContext,
  sel: MaestroSelector,
): Promise<{ x: number; y: number }> {
  const rect = await resolveRect(ctx, sel);
  if (!rect) {
    throw new Error(`element not found: ${JSON.stringify(sel)}`);
  }
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

async function resolveRect(ctx: RunContext, sel: MaestroSelector): Promise<Rect | null> {
  // Match Maestro's implicit-wait semantics on tapOn: keep retrying the
  // find for ~7s before giving up. Layout passes after a clearState
  // relaunch or navigation transition often take 1-3s to settle.
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    if (sel.id) {
      const r = await ctx.client.call('find_by_testid', { testID: sel.id });
      if (r.ok) return r.data as Rect;
    }
    if (sel.text) {
      const r = await ctx.client.call('find_by_text', { text: sel.text });
      if (r.ok) return r.data as Rect;
    }
    await sleep(POLL_MS);
  }
  // For text selectors that look like tab-bar destinations (the
  // canonical bottom-tab labels of the example app's RN router),
  // pop the navigation stack / dismiss any presented sheet until
  // the label becomes findable. Long flows leave the user buried
  // in a stack screen whose tab bar is hidden — a single explicit
  // `back` in the YAML can't always reach the tab root.
  if (sel.text && !sel.id) {
    const tabish = ['Home', 'Cart', 'Products', 'Profile', 'Gauntlet'].some(
      (t) => t.toLowerCase() === String(sel.text).toLowerCase(),
    );
    if (tabish) {
      for (let i = 0; i < 4; i++) {
        await ctx.client.call('back').catch(() => undefined);
        await sleep(450);
        await ctx.client.call('wait_commit', { maxMs: 1500, stableMs: 250 }).catch(() => undefined);
        const r = await findOnce(ctx, sel);
        if (r) return r;
      }
    }
  }

  // Last-chance fallback: auto-scroll. Element may be below the fold
  // in a scrollview the YAML didn't explicitly scroll. Try scrolling
  // DOWN up to 4 times, then UP up to 4 times. Maestro behaves this
  // way implicitly for tapOn in many cases.
  const cx = 195;
  const cy = 422;
  const dist = 300;
  for (const dir of ['DOWN', 'UP'] as const) {
    for (let i = 0; i < 4; i++) {
      if (dir === 'DOWN') hidSwipe(ctx.udid, cx, cy + dist / 2, cx, cy - dist / 2, 250);
      else hidSwipe(ctx.udid, cx, cy - dist / 2, cx, cy + dist / 2, 250);
      await sleep(500);
      await ctx.client.call('wait_commit', { maxMs: 1500, stableMs: 200 }).catch(() => undefined);
      const found = await findOnce(ctx, sel);
      if (!found) continue;
      // CRITICAL: scroll inertia keeps the contentOffset moving for
      // ~400-800 ms after the swipe gesture ends. The rect we just
      // received is already stale by the time the next tap lands.
      // Wait for the list to fully settle, then re-find to get the
      // current coords. Without this, taps after auto-scroll routinely
      // land on the WRONG cell (a different product card, a tab-bar
      // button, etc.).
      await sleep(700);
      await ctx.client.call('wait_commit', { maxMs: 2000, stableMs: 350 }).catch(() => undefined);
      const stable = await findOnce(ctx, sel);
      return stable ?? found;
    }
  }
  return null;
}

async function findOnce(ctx: RunContext, sel: MaestroSelector): Promise<Rect | null> {
  if (sel.id) {
    const r = await ctx.client.call('find_by_testid', { testID: sel.id });
    if (r.ok) return r.data as Rect;
  }
  if (sel.text) {
    const r = await ctx.client.call('find_by_text', { text: sel.text });
    if (r.ok) return r.data as Rect;
  }
  return null;
}

async function isVisible(ctx: RunContext, sel: MaestroSelector): Promise<boolean> {
  if (sel.id) {
    const r = await ctx.client.call('visible', { testID: sel.id });
    if (r.ok && r.data && (r.data as { visible: boolean }).visible) return true;
  }
  if (sel.text) {
    const r = await ctx.client.call('find_by_text', { text: sel.text });
    if (r.ok) return true;
    // UIAlertController titles/messages/buttons sit outside the React
    // tree, so find_by_text misses them. Check the alert layer too.
    try {
      const a = await ctx.client.call('alert_present');
      if (a.ok && a.data && (a.data as { present: boolean }).present) {
        const t = await ctx.client.call('alert_text');
        const txt = t.ok && t.data ? String((t.data as { text: string }).text || '') : '';
        if (txt && txt.toLowerCase().includes(sel.text.toLowerCase())) return true;
        const b = await ctx.client.call('alert_buttons');
        const btns = b.ok && b.data ? ((b.data as { buttons: string[] }).buttons ?? []) : [];
        for (const btn of btns) {
          if (btn && btn.toLowerCase().includes(sel.text.toLowerCase())) return true;
        }
      }
    } catch {
      /* not an alert */
    }
  }
  return false;
}

async function waitUntilVisible(
  ctx: RunContext,
  sel: MaestroSelector,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isVisible(ctx, sel)) return;
    await sleep(POLL_MS);
  }
  throw new Error(`assertVisible/waitFor timeout: ${JSON.stringify(sel)}`);
}

async function waitUntilNotVisible(
  ctx: RunContext,
  sel: MaestroSelector,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isVisible(ctx, sel))) return;
    await sleep(POLL_MS);
  }
  throw new Error(`assertNotVisible timeout: ${JSON.stringify(sel)}`);
}

/**
 * Re-launch the app with DYLD inject and re-open the control socket.
 * Used after a stopApp/killApp followed by launchApp — the original
 * process is dead, but the YAML expects a fresh app instance.
 */
async function relaunchAndReconnect(ctx: RunContext): Promise<void> {
  ctx.client.close();
  // Make sure the previous process is fully gone before we launch
  // again — simctl launch can otherwise attach to the still-shutting
  // -down PID and lose the dylib.
  terminateApp(ctx.udid, ctx.bundleId);
  await sleep(300);
  if (!ctx.dylibPath) {
    const auto = findDylib();
    if (!auto) {
      throw new Error(
        'launchApp after killApp requires libennio.dylib — none found. Set ENNIO_DYLIB_PATH.',
      );
    }
    ctx.dylibPath = auto;
  }
  execFileSync(
    'xcrun',
    ['simctl', 'launch', '--terminate-running-process', ctx.udid, ctx.bundleId],
    {
      env: { ...process.env, SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: ctx.dylibPath },
      stdio: 'pipe',
    },
  );
  const reopen = new EnnioSocketClient();
  if (!(await reopen.connectWithRetry(15_000))) {
    throw new Error('socket reconnect failed after launchApp');
  }
  ctx.client = reopen;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const r = await reopen.call('ping');
      const ready = r.ok && r.data && (r.data as { bootstrap?: string }).bootstrap === 'ready';
      if (ready) break;
    } catch {
      /* try again */
    }
    await sleep(100);
  }
  await reopen.call('wait_commit', { maxMs: 8000, stableMs: 250 }).catch(() => undefined);
  await sleep(2000);
  await reopen.call('wait_commit', { maxMs: 3000, stableMs: 300 }).catch(() => undefined);
}

async function clearStateAndRelaunch(ctx: RunContext): Promise<void> {
  // In-process wipe of Library/Documents/tmp.
  await ctx.client.call('clear_state').catch(() => undefined);
  // Hard relaunch — close socket so the reconnect picks up the new
  // process's socket binding.
  ctx.client.close();
  terminateApp(ctx.udid, ctx.bundleId);
  await sleep(300);
  if (!ctx.dylibPath) {
    const auto = findDylib();
    if (!auto) {
      throw new Error(
        'clearState relaunch requires libennio.dylib — none found in default paths. Set ENNIO_DYLIB_PATH.',
      );
    }
    ctx.dylibPath = auto;
  }
  execFileSync(
    'xcrun',
    ['simctl', 'launch', '--terminate-running-process', ctx.udid, ctx.bundleId],
    {
      env: { ...process.env, SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: ctx.dylibPath },
      stdio: 'pipe',
    },
  );
  // Re-open the socket against the new process.
  const reopen = new EnnioSocketClient();
  if (!(await reopen.connectWithRetry(15_000))) {
    throw new Error('socket reconnect failed after clearState relaunch');
  }
  ctx.client = reopen;
  // Wait for the new process's UIApplicationDidFinishLaunchingNotification
  // observer to fire — bootstrap=ready means the key UIWindow has been
  // captured and discovery handlers will see real UIViews. Without this
  // we race the launch and the first find returns empty.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const r = await reopen.call('ping');
      const ready = r.ok && r.data && (r.data as { bootstrap?: string }).bootstrap === 'ready';
      if (ready) break;
    } catch {
      /* try again */
    }
    await sleep(100);
  }
  // Past bootstrap=ready, but React Native + view layout pass needs a
  // beat to populate the first frame. wait_commit returns "stable"
  // even on a blank screen, so couple it with a minimum sleep that
  // covers the RN bridge boot + first paint (~2s typical on iOS 26).
  await reopen.call('wait_commit', { maxMs: 8000, stableMs: 250 }).catch(() => undefined);
  await sleep(2000);
  await reopen.call('wait_commit', { maxMs: 3000, stableMs: 300 }).catch(() => undefined);
  // Discard the app-data path cache — sandbox UUID may have rotated.
  getAppContainer(ctx.udid, ctx.bundleId);
}

function parsePoint(p: MaestroSelector['point']): { x: number; y: number } {
  if (typeof p === 'string') {
    const [xs, ys] = p.split(',').map((s) => s.trim());
    return { x: parseFloat(xs), y: parseFloat(ys) };
  }
  if (p && typeof p === 'object') {
    const x = typeof p.x === 'number' ? p.x : parseFloat(p.x);
    const y = typeof p.y === 'number' ? p.y : parseFloat(p.y);
    return { x, y };
  }
  throw new Error('tapOn point: invalid');
}

function describeCommand(cmd: MaestroCommand): string {
  const key = Object.keys(cmd)[0];
  const value = (cmd as Record<string, unknown>)[key];
  if (typeof value === 'string') return `${key}: ${value}`;
  if (typeof value === 'boolean') return key;
  if (value && typeof value === 'object') {
    return `${key}: ${JSON.stringify(value)}`;
  }
  return key;
}

function log(ctx: RunContext, msg: string): void {
  if (ctx.verbose || msg.startsWith('▶') || msg.startsWith('FAIL')) {
    process.stderr.write(`[ennio] ${msg}\n`);
  }
}

// One-line per-step trace. Always shown under --verbose so timing is
// inline with the action that produced it — no separate "(Xms)" line.
function logStep(ctx: RunContext, step: number, ms: number, cmd: string): void {
  if (!ctx.verbose) return;
  const stepStr = String(step).padStart(3);
  const msStr = String(ms).padStart(5);
  process.stderr.write(`[ennio] ${stepStr}  ${msStr}ms  ${cmd}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
