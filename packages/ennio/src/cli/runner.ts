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
import { getAppContainer, getTargetUdid, terminateApp } from './sim';

const DEFAULT_WAIT_MS = 5000;
const POLL_MS = 100;
// Minimum fixed wait after every tap. wait_commit can return immediately
// if the frame-hash is stable, but RN often starts the navigation
// animation slightly LATER than the tap (event dispatched → JS handles
// onPress → setState → React commit → mount → animation begins). 800ms
// covers the JS+commit gap; the subsequent wait_commit catches the
// transition itself.
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
  const udid = options.udid || getTargetUdid();
  if (!udid) {
    throw new Error('No booted iOS simulator found. Boot one or set ENNIO_UDID.');
  }
  if (!flow.appId) {
    throw new Error(`Flow ${flow.filePath} is missing top-level appId`);
  }

  const client = new EnnioSocketClient();
  if (!(await client.connect())) {
    // Socket not up — app isn't running with libennio injected. Auto-
    // launch with the dylib so users don't need a pre-step. Requires
    // ENNIO_DYLIB_PATH (or --dylib) so we know which dylib to inject.
    const dylib = options.dylibPath;
    if (!dylib) {
      throw new Error(
        'libennio socket at /tmp/ennio-control.sock is not reachable. ' +
          'Set ENNIO_DYLIB_PATH=<path-to-libennio.dylib> so the CLI can ' +
          'auto-launch the app with DYLD injection, or launch it yourself ' +
          'with SIMCTL_CHILD_DYLD_INSERT_LIBRARIES set.',
      );
    }
    try {
      terminateApp(udid, flow.appId);
    } catch {
      /* not running */
    }
    execFileSync(
      'xcrun',
      ['simctl', 'launch', '--terminate-running-process', udid, flow.appId],
      {
        env: { ...process.env, SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: dylib },
        stdio: 'pipe',
      },
    );
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
        const ready =
          r.ok && r.data && (r.data as { bootstrap?: string }).bootstrap === 'ready';
        if (ready) break;
      } catch {
        /* try again */
      }
      await sleep(100);
    }
    await client.call('wait_commit', { maxMs: 6000, stableMs: 200 }).catch(() => undefined);
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
  for (let i = 0; i < flow.commands.length; i++) {
    const cmd = flow.commands[i];
    try {
      await runCommand(ctx, cmd);
      stepsPassed++;
    } catch (err) {
      client.close();
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
  return { passed: true, stepsRun: flow.commands.length, stepsPassed };
}

// =====================================================================
// Per-command dispatch
// =====================================================================

async function runCommand(ctx: RunContext, rawCmd: MaestroCommand): Promise<void> {
  // Maestro lets some commands be bare strings: `- hideKeyboard`,
  // `- back`, `- launchApp`, etc. js-yaml parses those as plain strings,
  // not `{hideKeyboard: true}`. Normalise so the dispatch below can use
  // the same `'op' in cmd` shape unconditionally.
  const cmd: MaestroCommand =
    typeof rawCmd === 'string' ? ({ [rawCmd]: true } as unknown as MaestroCommand) : rawCmd;
  const desc = describeCommand(cmd);
  log(ctx, `· ${desc}`);

  if ('tapOn' in cmd) {
    const sel = normalizeSelector(cmd.tapOn);
    // Pre-tap settle: wait for the screen to stop animating so we tap
    // a stable button frame, not a half-transitioned one. Without this,
    // the tap can land on a view that's still sliding in from a tab
    // switch and RNGH's gesture recognizer rejects the touch.
    await ctx.client.call('wait_commit', { maxMs: 1500, stableMs: 250 }).catch(() => undefined);
    await execTapOn(ctx, sel);
    await sleep(POST_TAP_SETTLE_MS);
    // Post-tap settle: wait for the navigation / state-change transition
    // to complete before the next find. RN navigation animations + Hermes
    // mount + UIKit layout can take ~600-1000ms on iOS 26 sims.
    await ctx.client.call('wait_commit', { maxMs: 1500, stableMs: 200 }).catch(() => undefined);
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
    // idb ui tap with --duration approximates long press; absent that
    // we shell out to a swipe-in-place. Use a tiny swipe.
    hidSwipe(ctx.udid, x, y, x, y, 700);
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
    hidType(ctx.udid, cmd.inputText);
    await sleep(200);
    await ctx.client.call('wait_commit', { maxMs: 500, stableMs: 80 });
    return;
  }
  if ('eraseText' in cmd) {
    const count =
      typeof cmd.eraseText === 'number' ? cmd.eraseText : (cmd.eraseText.characters ?? 1);
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
      if (await isVisible(ctx, target)) return;
      // Centre swipe in the requested direction.
      const cx = 195;
      const cy = 422;
      const dist = 400;
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
      await sleep(350);
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
    } else {
      // No-op when app is already running; the +load swizzle ensures
      // the dylib is already attached.
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
      for (const inner of sub.commands) await runCommand(ctx, inner);
      return;
    }
    // File form: { runFlow: { file: "subflows/foo.yaml" } }
    if (sub.file) {
      const subPath = resolve(dirname(ctx.flowPath), sub.file);
      const subFlow = parseMaestroFile(subPath);
      const prevPath = ctx.flowPath;
      ctx.flowPath = subPath;
      try {
        for (const inner of subFlow.commands) await runCommand(ctx, inner);
      } finally {
        ctx.flowPath = prevPath;
      }
      return;
    }
    return;
  }
  if ('repeat' in cmd) {
    for (let i = 0; i < cmd.repeat.times; i++) {
      for (const inner of cmd.repeat.commands) await runCommand(ctx, inner);
    }
    return;
  }
  if ('retry' in cmd) {
    const maxRetries = cmd.retry.maxRetries ?? 3;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        for (const inner of cmd.retry.commands) await runCommand(ctx, inner);
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
  log(ctx, `  (unsupported in v0.1, skipped: ${desc})`);
}

// =====================================================================
// Helpers
// =====================================================================

async function execTapOn(ctx: RunContext, sel: MaestroSelector): Promise<void> {
  // Point-tap fast path — no discovery needed.
  if (sel.point !== undefined) {
    const { x, y } = parsePoint(sel.point);
    hidTap(ctx.udid, x, y);
    return;
  }
  const center = await resolveCenter(ctx, sel);
  hidTap(ctx.udid, center.x, center.y);
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

async function clearStateAndRelaunch(ctx: RunContext): Promise<void> {
  // In-process wipe of Library/Documents/tmp.
  await ctx.client.call('clear_state').catch(() => undefined);
  // Hard relaunch — close socket so the reconnect picks up the new
  // process's socket binding.
  ctx.client.close();
  terminateApp(ctx.udid, ctx.bundleId);
  await sleep(300);
  if (!ctx.dylibPath) {
    throw new Error('clearState requires --dylib (or ENNIO_DYLIB_PATH) to relaunch with injection');
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
  // beat to populate the first frame. Wait_commit polls the visible
  // UIView hash; we hold until it's stable for 200ms or we cap at 6s.
  await reopen.call('wait_commit', { maxMs: 6000, stableMs: 200 }).catch(() => undefined);
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
