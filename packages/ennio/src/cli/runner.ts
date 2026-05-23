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

import { execFileSync, spawnSync } from 'node:child_process';

import { dirname, resolve } from 'node:path';

import {
  MaestroCommand,
  MaestroFlow,
  MaestroSelector,
  normalizeSelector,
  parseMaestroFile,
} from './maestro-parser';
import { EnnioSocketClient } from './socket-client';
import {
  tap as hidTap,
  tapFast as hidTapFast,
  tapPureFast as hidTapPureFast,
  tapArgent as hidTapArgent,
  swipe as hidSwipe,
  longPressDrag as hidLongPressDrag,
  typeText as hidType,
  axQueryByText,
} from './hid';
import { ensureBootedSim, findDylib, getAppContainer, terminateApp } from './sim';

// =====================================================================
// runScript — Maestro JS sandbox
// =====================================================================
//
// Maestro's runScript executes JS in a GraalVM sandbox with custom
// globals: http.{get,post,put,delete}, output (mutable bag), json
// (synchronous parse), env (script-step env block). Bluesky's e2e
// flows lean on this to bootstrap mock data and write the result
// into output.X for later steps to interpolate via ${output.X}.
//
// We can't ship GraalVM, but Node's `vm` module + a tiny curl-backed
// synchronous http shim covers the surface area Bluesky actually
// uses (one http.post per setupServer.js invocation).
//
// Limitations:
// - http calls are spawn-per-request (no keepalive); fine for setup.
// - Only http.{get,post,put,delete} — no websockets, no streaming.
// - Sandbox is permissive: scripts share the parent require graph
//   for `node:vm` reasons but we don't expose require/process.

import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

// Default implicit-wait on visibility predicates. Maestro's default is
// 5s. We use 10s because on iOS 26 sim, a tile-tap-driven screen
// transition can take 4-7s (RN bundle execute on the destination
// screen + UIKit layout pass + RNGH gesture acceptance). Tests pass
// the same flow definitions Maestro accepts; we just give the runtime
// more headroom.
const DEFAULT_WAIT_MS = 15000;
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
  /** TestID of the previously-tapped target. Used to apply an extra
   *  pre-tap settle when the previous tap was on a button that
   *  triggers an async network round-trip (publish, submit, send),
   *  to outlast that flow before letting the next tap proceed. */
  lastTapTestID?: string;
  /** Set when the previous step typed/erased text. The next non-input
   *  tap calls hide_keyboard first so iOS's editing-menu popover
   *  doesn't intercept the touch (observed on Bluesky's edit-profile
   *  modal: Save tap fires onto the popover instead of the button,
   *  modal never dismisses). */
  lastWasTextInput?: boolean;
  /** Timestamp of the last UIRefreshControl trigger. Throttles the
   *  trigger_refresh shortcut so a YAML pattern of "warmup swipe +
   *  real swipe" doesn't fire the refresh handler twice. */
  lastRefreshAtMs?: number;
  /** Aggregate per-phase timings. Used by the bottleneck reporter at
   *  the end of each flow. Phase names map to the discrete chunks of
   *  work inside a single command (preWaitCommit, find, hidTap, …). */
  phaseTotals?: Map<string, number>;
  phaseCounts?: Map<string, number>;
  /** Mutable bag populated by runScript and consumed by ${output.X}
   *  substitution in subsequent inputText / tapOn text args. Mirrors
   *  Maestro's `output` global available inside its JS sandbox. */
  outputs: Record<string, unknown>;
}

// Replace Maestro-style ${output.X} placeholders with values from
// ctx.outputs. Also handles ${env.X} → process.env.X.
function interpolate(str: string, ctx: RunContext): string {
  if (typeof str !== 'string') return str;
  return str.replace(/\$\{(output|env)\.([A-Za-z0-9_]+)\}/g, (_, scope, key) => {
    if (scope === 'output') {
      const v = ctx.outputs[key];
      return v == null ? '' : String(v);
    }
    return process.env[key] ?? '';
  });
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

// eslint-disable-next-line @typescript-eslint/no-unused-vars
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
    outputs: {},
  };

  log(ctx, `▶ ${flow.name || flow.filePath} (${flow.commands.length} steps)`);

  let stepsPassed = 0;
  const stepTimings: { step: number; ms: number; cmd: string }[] = [];
  let lastTapCmd: unknown = undefined;
  for (let i = 0; i < flow.commands.length; i++) {
    const cmd = flow.commands[i];
    const nextCmd = flow.commands[i + 1];
    const t0 = Date.now();
    try {
      process.stderr.write(`[step ${i + 1}] ${describeCommand(cmd)}\n`);
      await runCommand(ctx, cmd, nextCmd);
      const dt = Date.now() - t0;
      stepTimings.push({ step: i + 1, ms: dt, cmd: describeCommand(cmd) });
      logStep(ctx, i + 1, dt, describeCommand(cmd));
      stepsPassed++;
      if (typeof cmd === 'object' && cmd && 'tapOn' in cmd) {
        lastTapCmd = cmd;
      } else {
        lastTapCmd = undefined;
      }
    } catch (err) {
      // Step-level retry for find-failure following a tapOn. Bluesky's
      // dropdown / sheet open is non-deterministic: ennio's HID tap
      // lands at the right pixel but the RN responder system
      // intermittently swallows the press (~40% flake on home-screen
      // step 21→22). If the failing step is a tapOn or assertVisible
      // that can't find its target AND the previous step was a tapOn,
      // re-fire that previous tap once and retry the current step.
      const msg = err instanceof Error ? err.message : String(err);
      const isFindMiss = /element not found|assertVisible\/waitFor timeout/i.test(msg);
      const isFindableStep =
        cmd &&
        typeof cmd === 'object' &&
        ('tapOn' in cmd || 'assertVisible' in cmd || 'waitFor' in cmd);
      if (lastTapCmd && isFindMiss && isFindableStep) {
        try {
          log(ctx, `↻ retrying previous tap before step ${i + 1}`);
          await runCommand(ctx, lastTapCmd as any, cmd);
          await sleep(150);
          await runCommand(ctx, cmd, nextCmd);
          const dt = Date.now() - t0;
          stepTimings.push({ step: i + 1, ms: dt, cmd: describeCommand(cmd) });
          logStep(ctx, i + 1, dt, describeCommand(cmd));
          stepsPassed++;
          lastTapCmd = typeof cmd === 'object' && cmd && 'tapOn' in cmd ? cmd : undefined;
          continue;
        } catch {
          /* fall through to fail */
        }
      }
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
  process.stderr.write(`[ennio] total ${total}ms across ${timings.length} steps:\n`);
  // Full per-step dump (in execution order). Outliers are easier to
  // spot than from a top-5 — a single 8 s step amid 30 fast ones
  // shows up as a vertical bar of zeros around it.
  const avg = total / Math.max(timings.length, 1);
  for (const t of timings) {
    const flag = t.ms >= Math.max(avg * 3, 1500) ? '  ⚠ outlier' : '';
    process.stderr.write(
      `[ennio]   ${String(t.ms).padStart(6)}ms  step ${String(t.step).padStart(2)}: ${t.cmd}${flag}\n`,
    );
  }
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
    // Maestro's `optional: true` modifier on tapOn: if the selector
    // doesn't resolve within a short window, silently skip the step
    // instead of failing the flow. Used in flows that may or may
    // not see e.g. a "Not Now" prompt depending on app state.
    const tapObj =
      cmd.tapOn && typeof cmd.tapOn === 'object'
        ? (cmd.tapOn as { optional?: boolean; repeat?: number; delay?: number })
        : null;
    const isOptional = !!tapObj?.optional;
    if (isOptional) {
      const r = await findOnce(ctx, sel);
      if (!r) return;
    }
    // Maestro `repeat: N` + `delay: ms`: tap the same target N times
    // with `delay` ms between taps. Used for dismissing
    // sometimes-present prompts (e.g. iCloud save-password sheet).
    // Without this, ennio fires the tap once and proceeds, missing
    // the dismiss when a slow-mounting prompt appears late.
    if (tapObj?.repeat && tapObj.repeat > 1) {
      const times = tapObj.repeat;
      const delayMs = tapObj.delay ?? 200;
      for (let i = 0; i < times; i++) {
        if (i > 0) await sleep(delayMs);
        await execTapOn(ctx, sel);
      }
      return;
    }
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
    // If the previous step typed/erased text and the next tap targets
    // anything other than another text field, iOS's editing-menu
    // popover ("Select / Select All / AutoFill") is still floating
    // over the screen — it eats the first tap as a dismiss, so the
    // intended Save / Submit button never fires. Resign first
    // responder before the tap so the popover clears with the
    // keyboard. Skipped when the tap IS into another Input field
    // (back-to-back form edits stay focused).
    const tapIsIntoInput = sel.id && /Input$/i.test(sel.id);
    if (ctx.lastWasTextInput && !tapIsIntoInput) {
      await ctx.client.call('hide_keyboard').catch(() => undefined);
    }
    ctx.lastWasTextInput = false;
    if (!isRepeatTap) {
      // Run pre-tap settles in parallel — they observe orthogonal
      // signals (React commit stability vs presented-VC animation
      // teardown). Sequential was ~250 ms/call * 2; parallel collapses
      // to the slower of the two (~190 ms/call).
      await Promise.all([
        timedAsync(ctx, 'tap.preWaitCommit', () =>
          ctx.client.call('wait_commit', { maxMs: 1500, stableMs: 150 }).catch(() => undefined),
        ),
        timedAsync(ctx, 'tap.preWaitPresentation', () =>
          ctx.client.call('wait_presentation_idle', { maxMs: 2000 }).catch(() => undefined),
        ),
      ]);
      // If the previous tap was on a button whose onPress runs async
      // work (publish / save / submit / send / signIn / signOut /
      // confirm), the standard hash-quiet exits while the callback
      // is still in-flight. Block on React commits going quiet so
      // the next tap doesn't race a still-mutating navigator stack.
      const ASYNC_BTN_RE = /publish|submit|send|signIn|signOut|confirm|save/i;
      if (ctx.lastTapTestID && ASYNC_BTN_RE.test(ctx.lastTapTestID)) {
        await timedAsync(ctx, 'tap.preWaitAsyncSettle', () =>
          ctx.client
            .call('wait_react_quiet', { stableMs: 400, maxMs: 2000 })
            .catch(() => undefined),
        );
      }
    }
    const preTapHash = await captureHash(ctx);
    const preReact = await captureReactTs(ctx);
    // If the next op is inputText (typing) and we have a testID,
    // route the "tap to focus" through focus_testid: it calls
    // becomeFirstResponder in-process — deterministic, no race with
    // RN's onPress firing a state-driven focus transition. Without
    // this, a freshly-presented form's first TextInput tap can land
    // before RN has wired up the press handler, leaving the field
    // unfocused; the inputText that follows types into nowhere.
    // Observed on Bluesky's "Create moderation list" name field.
    // Edit-form text inputs (RN TextInput with `defaultValue`) reject
    // the first tap. Detect by testID matching /Input$/ AND next op
    // editing the field — call focus_testid as primary; argent tap
    // still fires below as belt-and-braces.
    const nextEditsField =
      !!nextRawCmd &&
      typeof nextRawCmd === 'object' &&
      ('inputText' in nextRawCmd || 'eraseText' in nextRawCmd || 'clearText' in nextRawCmd);
    if (sel.id && /Input$/i.test(sel.id) && nextEditsField) {
      await ctx.client.call('focus_testid', { testID: sel.id }).catch(() => undefined);
    }
    await timedAsync(ctx, 'tap.execTapOn', () => execTapOn(ctx, sel, preTapHash));
    if (isRepeatTap || nextIsSameTap) {
      // Tight gap so consecutive same-target taps register as a
      // double-tap on RN Pressables / RNGH Tap recognizers.
      await timedAsync(ctx, 'tap.postSleepRepeat', () => sleep(120));
    } else if (preReact.attach !== 'none') {
      // Hermes/Paper/Fabric commit observer attached — block on the
      // next RN commit AFTER the tap. This is O(1) inside the dylib
      // (NSCondition broadcast from a swizzled mount method) and
      // returns on the same vsync RN commits.
      //
      // We wait for *two* commits, not one: a Pressable's onPress
      // typically dispatches a setState that takes one commit to
      // reach the view tree, plus a second commit for the React
      // effect that follows (focus transition, navigation push,
      // dropdown open). Stopping after commit #1 caused inputText
      // to fire before the just-tapped TextInput became first
      // responder — see "Please enter your username" regression on
      // login.yml.
      const waitOneCommit = async (since: number, maxMs: number): Promise<number> => {
        const r = await ctx.client
          .call('wait_react_commit', { sinceMs: since, maxMs })
          .catch(() => undefined);
        if (!r || !r.ok || !r.data) return 0;
        const data = r.data as { ok: boolean; elapsedMs: number };
        if (!data.ok) return 0;
        // Re-sample lastCommitMs so the next wait starts after this one.
        const ts = await captureReactTs(ctx);
        return ts.ts || since + (data.elapsedMs ?? 0);
      };
      const committed = await timedAsync(ctx, 'tap.postWaitReactCommit', async () => {
        const after1 = await waitOneCommit(preReact.ts, 600);
        if (!after1) return false;
        await waitOneCommit(after1, 250);
        return true;
      });
      if (!committed) {
        // No commit fired — likely a no-op tap, fall back to the
        // hash-change signal so we don't skip ahead.
        await timedAsync(ctx, 'tap.postWaitHashChange', async () => {
          await ctx.client
            .call('wait_hash_change', { sinceHash: preTapHash, maxMs: 400 })
            .catch(() => undefined);
        });
      }
      await timedAsync(ctx, 'tap.postWaitCommit', () =>
        ctx.client.call('wait_commit', { maxMs: 1500, stableMs: 80 }).catch(() => undefined),
      );
    } else {
      // Event-driven post-tap settle. Replaces fixed POST_TAP_SETTLE_MS
      // sleep with a CADisplayLink-condition wait inside the dylib:
      // returns the instant the visible-UIView hash differs from
      // pre-tap. Active screens react in 50-200ms; static-screen taps
      // hit the 600ms ceiling and fall through to a short fixed sleep
      // so we don't skip ahead of a slow React commit. Subsequent
      // wait_commit smooths the transition's tail.
      const changed = await timedAsync(ctx, 'tap.postWaitHashChange', async () => {
        const r = await ctx.client
          .call('wait_hash_change', { sinceHash: preTapHash, maxMs: 600 })
          .catch(() => undefined);
        return !!(r && r.ok && r.data && (r.data as { ok: boolean }).ok);
      });
      if (!changed) {
        // Likely a no-op tap, OR the JS bridge hasn't fired its
        // commit yet. Pay the legacy fixed-sleep budget so we don't
        // race the next find on slow Hermes mounts.
        await timedAsync(ctx, 'tap.postSleep', () => sleep(POST_TAP_SETTLE_MS));
      }
      // 250 ms of commit-quiet outlasts setState batching in cases
      // like Bluesky's composer: closeComposer fires setState(undefined)
      // synchronously, but the subsequent commit (which clears the
      // overlay's view subtree) can land 100-200 ms later. The next
      // tapOn composeFAB would otherwise race that commit and trigger
      // the "Never replace an already open composer" guard — leaving
      // the FAB onPress a no-op. 80 ms was enough on lighter screens
      // but missed this window. 250 ms × ~20 taps/flow ≈ 5 s/flow
      // budget, still well inside the 3× Maestro speedup target.
      await timedAsync(ctx, 'tap.postWaitCommit', () =>
        ctx.client.call('wait_commit', { maxMs: 1500, stableMs: 250 }).catch(() => undefined),
      );
    }
    ctx.lastTapKey = tapKey;
    ctx.lastTapTestID = sel.id;
    return;
  }
  if ('doubleTapOn' in cmd) {
    const sel = normalizeSelector(cmd.doubleTapOn);
    const { x, y } = await resolveCenter(ctx, sel);
    await hidTap(ctx.udid, x, y);
    await sleep(80);
    await hidTap(ctx.udid, x, y);
    await sleep(POST_TAP_SETTLE_MS);
    return;
  }
  if ('longPress' in cmd || 'longPressOn' in cmd) {
    const sel = normalizeSelector(('longPress' in cmd ? cmd.longPress : cmd.longPressOn) as any);
    const { x, y } = await resolveCenter(ctx, sel);
    // Long press = tap with hold duration. Maestro default 1500ms;
    // many RN long-press handlers register at ~500ms.
    await hidTap(ctx.udid, x, y, 0.8);
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
    // Maestro's extendedWaitUntil is meant for slow async data
    // fetches that the regular 10s implicit wait can't cover. We
    // use 60s default — Bluesky's home feed on a cold sign-in via
    // mock PDS routinely takes 30-40s to render its first post.
    const timeout = cmd.extendedWaitUntil.timeout ?? 60000;
    if (cmd.extendedWaitUntil.visible) {
      await waitUntilVisible(ctx, normalizeSelector(cmd.extendedWaitUntil.visible), timeout);
    } else if (cmd.extendedWaitUntil.notVisible) {
      await waitUntilNotVisible(ctx, normalizeSelector(cmd.extendedWaitUntil.notVisible), timeout);
    }
    return;
  }
  if ('inputText' in cmd) {
    // Wait for ANY view to be the firstResponder before typing.
    // Without this, a previous tap that opens a composer / modal
    // may still be mid-animation when inputText fires — no field
    // is focused yet, insert_text returns NO, hidType fallback
    // types into nowhere.
    // Poll for up to 2 s; first responder usually lands within
    // 100-300 ms of an onPress-driven focus transition.
    // 500 ms is enough for a healthy focus transition; longer windows
    // routinely fire on already-broken state (prior tap landed on
    // the wrong field) and pad the step by 2 s before we fall back
    // to the hardware-keyboard path that types into nowhere anyway.
    const text = interpolate(String(cmd.inputText), ctx);
    // Try insert_text (UIKeyInput on the current firstResponder) up
    // to 3 times. Between attempts, if the prior tap target was a
    // testID, re-tap it via argent — that's the cheapest way to
    // recover when the original tap didn't actually move focus into
    // the field (Bluesky's login username TextInput is the textbook
    // case). After 3 failed attempts, fall back to a single
    // hardware-keyboard type — at worst the chars land somewhere
    // useful and the next step fails fast.
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      if (attempt > 0 && ctx.lastTapTestID) {
        const rect = await ctx.client
          .call('find_by_testid', { testID: ctx.lastTapTestID })
          .catch(() => undefined);
        if (rect && rect.ok && rect.data) {
          const r = rect.data as { x: number; y: number; w: number; h: number };
          await hidTapFast(ctx.udid, r.x + r.w / 2, r.y + r.h / 2);
        }
      }
      const fr = await ctx.client
        .call('first_responder_ready', { maxMs: 500 })
        .catch(() => undefined);
      void fr;
      try {
        const r = await ctx.client.call('insert_text', { text });
        ok = !!(r.ok && r.data && (r.data as { ok: boolean }).ok);
      } catch {
        /* retry */
      }
    }
    if (!ok) await hidType(ctx.udid, text);
    // No fixed sleep: wait_commit's CADisplayLink ticker already
    // catches the post-insert layout pass + onChangeText commit.
    await ctx.client.call('wait_commit', { maxMs: 500, stableMs: 80 });
    ctx.lastWasTextInput = true;
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
    ctx.lastWasTextInput = true;
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
    // pressKey Enter on a form input typically triggers a submit
    // handler that runs React state updates (Bluesky's
    // configureProxy → agent.setHeader → re-render of the entire
    // navigator). Without waiting for that to settle, the very next
    // tapOn lands on a JS bridge mid-update — onPress wired to a
    // stale closure, press registered but no effect. Wait for
    // commit + UIView stable.
    await sleep(80);
    await ctx.client.call('wait_react_commit', { sinceMs: 0, maxMs: 800 }).catch(() => undefined);
    await ctx.client.call('wait_commit', { maxMs: 1500, stableMs: 150 }).catch(() => undefined);
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
            await hidSwipe(ctx.udid, cx, cy + small / 2, cx, cy - small / 2, 250);
          } else if (dir === 'UP') {
            await hidSwipe(ctx.udid, cx, cy - small / 2, cx, cy + small / 2, 250);
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
      await hidSwipe(ctx.udid, x1, y1, x2, y2, 250);
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
    // Maestro idiom: `from: <selector>` resolves the selector and
    // uses its centre as the drag start. Used for drag-to-sort
    // handles (feed-reorder.yml's `from: { id: "feed-drag-handle" }`).
    // Without this, the runner falls back to mid-screen which lands
    // on a static row → no drag fires → reorder never happens.
    if (sw.from && typeof sw.from === 'object') {
      const fromSel = normalizeSelector(sw.from as MaestroSelector);
      const rect = await resolveRect(ctx, fromSel);
      if (rect) {
        from = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
      }
    }
    if (sw.start || sw.end) {
      from = parseCoord(sw.start, from);
      to = parseCoord(sw.end, to);
    } else if (sw.direction) {
      const d = sw.direction.toUpperCase();
      // If `from:` resolved a selector above, drag relative to that
      // point — needed for drag-to-sort handles where the YAML
      // specifies both `from: <selector>` and `direction:` (the
      // selector is the grab handle, the direction is the sort
      // movement). Without this branch, we'd discard the resolved
      // selector and drag from mid-screen, missing the handle entirely.
      const usingSelectorFrom = !!(sw.from && typeof sw.from === 'object');
      const dist = 200;
      // Maestro semantics: direction = finger drag direction on
      // screen. iOS y-axis increases downward, so
      // from.y < to.y for DOWN.
      if (usingSelectorFrom) {
        if (d === 'DOWN') to = { x: from.x, y: from.y + dist };
        else if (d === 'UP') to = { x: from.x, y: from.y - dist };
        else if (d === 'LEFT') to = { x: from.x - dist, y: from.y };
        else if (d === 'RIGHT') to = { x: from.x + dist, y: from.y };
      } else {
        // No selector — full-screen swing. Wide swing: 700 pt covers
        // a full bottom-sheet drag-to-dismiss. Plenty of margin for
        // page scrolls and tab switches too.
        const full = 700;
        if (d === 'DOWN') {
          // Start ABOVE the sheet's grab handle (y~80 on iOS 26
          // UISheetPresentationController) so the drag-to-dismiss
          // gesture wins over the sheet's inner scroll view, which
          // would otherwise eat the swipe as a content scroll.
          from = { x: winW / 2, y: 60 };
          to = { x: winW / 2, y: 60 + full };
        } else if (d === 'UP') {
          from = { x: winW / 2, y: winH - 120 };
          to = { x: winW / 2, y: winH - 120 - full };
        } else if (d === 'LEFT') {
          from = { x: winW - 40, y: winH / 2 };
          to = { x: winW - 40 - full, y: winH / 2 };
        } else if (d === 'RIGHT') {
          from = { x: 40, y: winH / 2 };
          to = { x: 40 + full, y: winH / 2 };
        }
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
    // Drag-to-sort detection. RN draggable-flatlist (used by Bluesky's
    // "Edit my feeds" reorder UI) only enters drag mode after a
    // long-press of ~400 ms. A plain swipe — even with a 1 s
    // duration — is read as a scroll because every emitted Move
    // event arrives between Down and the scroll-recogniser's pan
    // threshold. The "select by handle + then move" pattern fires
    // when YAML uses `from: <selector>` (Maestro's idiom for drag
    // anchored on a known element). Drop into a long-press-then-drag
    // gesture in that case: Down, hold ~500 ms, then glide to the
    // target.
    const usingSelectorFrom = !!(sw.from && typeof sw.from === 'object');
    if (usingSelectorFrom) {
      const totalDur = sw.duration ?? 1000;
      const holdMs = Math.min(600, Math.max(400, totalDur * 0.5));
      const moveMs = Math.max(250, totalDur - holdMs);
      await hidLongPressDrag(ctx.udid, from.x, from.y, to.x, to.y, holdMs, moveMs);
      await sleep(400);
      await ctx.client.call('wait_commit', { maxMs: 1000, stableMs: 150 }).catch(() => undefined);
      return;
    }
    await hidSwipe(ctx.udid, from.x, from.y, to.x, to.y, sw.duration ?? 250);
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
    await hidSwipe(ctx.udid, x1, y1, x2, y2, 250);
    await sleep(400);
    return;
  }
  if ('launchApp' in cmd) {
    const opts =
      cmd.launchApp === true
        ? { clearState: false }
        : (cmd.launchApp as {
            clearState?: boolean;
            arguments?: Record<string, string | boolean | number>;
          });
    // Convert Maestro's `arguments:` map into a flat list passed to
    // `simctl launch` after the bundle id. iOS NSUserDefaults launch
    // arguments require a key+value pair (`-Key Value`) — emitting
    // just the key is silently ignored, which surfaced as Bluesky's
    // Expo dev-menu onboarding sheet popping up despite the
    // `-EXDevMenuIsOnboardingFinished true` argument in setupApp.yml.
    // Stringify booleans the way iOS expects ("YES"/"NO").
    const launchArgs: string[] = [];
    if (opts.arguments) {
      for (const [k, v] of Object.entries(opts.arguments)) {
        launchArgs.push(k);
        if (v === true) launchArgs.push('YES');
        else if (v === false) launchArgs.push('NO');
        else launchArgs.push(String(v));
      }
    }
    if (opts.clearState) {
      await clearStateAndRelaunch(ctx, launchArgs);
    } else if (!ctx.client.isConnected()) {
      // Socket dropped — app was killed (stopApp/killApp) or crashed.
      // Re-launch with DYLD inject so the dylib reattaches.
      await relaunchAndReconnect(ctx, launchArgs);
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
    // In-process: React-commit quiet. Catches RN-side animations
    // ending (sheet animateOut, navigation transition).
  }
    // Cross-process safety: PHPicker / share sheet / document picker
    // dismiss in another XPC process — wait_commit is blind to that.
    // Poll the in-process VC chain until no cross-process picker VC
    // is presented. ~10 ms per poll (one socket round-trip), and we
    // bail the instant the picker is gone, so cost is negligible on
    // RN-only screens. Reusing the in-process `top_vc_chain` op:
    // pure UIKit, no argent, no AX-server dependency.
    const dismissDeadline = Date.now() + 2500;
    while (Date.now() < dismissDeadline) {
      const r = await ctx.client.call('top_vc_chain').catch(() => undefined);
      if (!r || !r.ok) break;
      const chain = ((r.data as { chain?: string[] })?.chain ?? []);
      const hasCrossProcess = chain.some(
        (cls) =>
          cls.includes('PHPicker') ||
          cls.includes('PhotoPicker') ||
          cls.includes('PHImagePicker') ||
          cls.includes('UIActivityViewController') ||
          cls.includes('UIDocumentPickerViewController'),
      );
      if (!hasCrossProcess) break;
      await sleep(80);
    }
  if ('runScript' in cmd) {
    const scriptCmd = (cmd as { runScript: { file: string; env?: Record<string, string> } })
      .runScript;
    await runMaestroScript(ctx, scriptCmd);
    return;
  }
  if ('runFlow' in cmd) {
    const sub = cmd.runFlow;
    // `when:` clause — evaluate the predicate against current screen.
    // If false, skip the subflow entirely.
    if (sub.when) {
      const w = sub.when as {
        visible?: unknown;
        notVisible?: unknown;
        platform?: string;
      };
      let satisfied = true;
      if (w.platform) {
        // Maestro platform gate: iOS / Android. We're an iOS-only
        // runner, so the iOS branch always runs and the Android one
        // is skipped.
        satisfied = String(w.platform).toLowerCase() === 'ios';
      }
      if (satisfied && w.visible) {
        satisfied = await isVisible(ctx, normalizeSelector(w.visible));
      } else if (satisfied && w.notVisible) {
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

// React Native commit observer — see ios/EnnioReactObserver.mm. Returns
// {ts, attach}. attach is "paper" | "fabric" | "both" | "none". When
// "none" the dylib has no RN hook attached and the caller should fall
// back to the UIView frame-hash signal.
async function captureReactTs(
  ctx: RunContext,
): Promise<{ ts: number; attach: 'paper' | 'fabric' | 'both' | 'none' }> {
  try {
    const r = await ctx.client.call('react_commit_ts');
    if (r.ok && r.data) {
      const d = r.data as { ts: number | string; attach: string };
      const ts = typeof d.ts === 'number' ? d.ts : Number(d.ts) || 0;
      const attach = (d.attach || 'none') as 'paper' | 'fabric' | 'both' | 'none';
      return { ts, attach };
    }
  } catch {
    /* observer op unavailable on older dylibs */
  }
  return { ts: 0, attach: 'none' };
}

// Retained for future post-tap settle experiments — see commit message.

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

async function execTapOn(ctx: RunContext, sel: MaestroSelector, preHash?: string): Promise<void> {
  // Point-tap fast path — no discovery needed.
  if (sel.point !== undefined) {
    const { x, y } = parsePoint(sel.point);
    await hidTap(ctx.udid, x, y);
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
  const rect = await timedAsync(ctx, 'tap.find', () => resolveRect(ctx, sel));
  if (!rect) {
    throw new Error(`element not found: ${JSON.stringify(sel)}`);
  }
  // Hidden test-only controls: some apps expose 1×1 px elements
  // (TextInput and Pressable variants) as side-channels for e2e
  // harnesses. idb HID taps round to int — a 1×1 rect at
  // (401, 101) has its FP-center at (401.5, 101.5) which rounds
  // to (402, 102) — landing on the sibling button 1 px below.
  // Fall back to focus_testid for tiny TextInputs so the next
  // inputText routes via insert_text → firstResponder.
  if (sel.id && rect.w < 6 && rect.h < 6) {
    try {
      const r = await ctx.client.call('focus_testid', { testID: sel.id });
      if (r.ok && r.data && (r.data as { ok: boolean }).ok) return;
    } catch {
      /* fall through */
    }
  }
  // Position-stability gate: poll the selector-aware finder until 3
  // consecutive samples (10 ms apart) return the same rect. Catches
  // RN list reorder + composer mount animations — both shift the
  // target's window-space coords mid-layout, and a tap fired at the
  // first-seen rect lands on whatever view is at those coords AFTER
  // the shift completes (postDropdownBtn → Bob's post instead of
  // Alice's). The check costs ~30 ms in the common steady-state case
  // (first 3 samples already identical), but climbs to ~2 s on a
  // shifting layout. Replaces a stack of pre-tap settles that burned
  // 700+ ms unconditionally.
  const sampleRect = async (): Promise<Rect | null> => {
    if (sel.childOf && sel.childOf.id && sel.id) {
      const r = await ctx.client
        .call('find_child_by_testid', {
          childTestID: sel.id,
          parentTestID: sel.childOf.id,
        })
        .catch(() => undefined);
      if (r && r.ok && r.data) return r.data as Rect;
      return null;
    }
    if (sel.id) {
      const r = await ctx.client.call('find_by_testid', { testID: sel.id }).catch(() => undefined);
      if (r && r.ok && r.data) return r.data as Rect;
    }
    if (sel.text) {
      const r = await ctx.client.call('find_by_text', { text: sel.text }).catch(() => undefined);
      if (r && r.ok && r.data) return r.data as Rect;
    }
    return null;
  };
  const sameRect = (a: Rect | null, b: Rect | null): boolean =>
    !!a &&
    !!b &&
    Math.abs(a.x - b.x) < 1 &&
    Math.abs(a.y - b.y) < 1 &&
    Math.abs(a.w - b.w) < 1 &&
    Math.abs(a.h - b.h) < 1;
  let stableRect: Rect = rect;
  {
    const deadline = Date.now() + 800;
    let s1: Rect | null = rect;
    let s2: Rect | null = null;
    let s3: Rect | null = null;
    while (Date.now() < deadline) {
      await sleep(10);
      const cur = await sampleRect();
      if (cur) {
        s3 = s2;
        s2 = s1;
        s1 = cur;
        if (sameRect(s1, s2) && sameRect(s2, s3)) {
          stableRect = s1!;
          break;
        }
      }
    }
  }
  const center = {
    x: stableRect.x + stableRect.w / 2,
    y: stableRect.y + stableRect.h / 2,
  };
  const baseHash = preHash ?? (await captureHash(ctx));
  // Target-driven exposure wait. When a previous step's modal is
  // still mid-dismiss, the target may already be findable in the
  // view tree but covered by the closing overlay — tap lands on the
  // overlay and gets eaten. Only blocks when this is actually the
  // case, so there's zero overhead on normal taps. Caps at 2 s.
  if (sel.id) {
    const ex = await ctx.client.call('is_exposed', { testID: sel.id }).catch(() => undefined);
    const exposed = !!(ex && ex.ok && ex.data && (ex.data as { exposed?: boolean }).exposed);
    if (!exposed) {
      await timedAsync(ctx, 'tap.waitExposed', async () => {
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
          await sleep(80);
          const r = await ctx.client.call('is_exposed', { testID: sel.id! }).catch(() => undefined);
          const ok = !!(r && r.ok && r.data && (r.data as { exposed?: boolean }).exposed);
          if (ok) break;
        }
      });
    }
  }
  // Argent HID — reliable on iOS 26 RN Pressables. No pre-tap sleep:
  // the position-stability gate above already proved the rect isn't
  // moving, so UIKit's hit-test layer-tree is settled.
  await timedAsync(ctx, 'tap.hidTap', () => hidTapFast(ctx.udid, center.x, center.y));
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
  // Tiny ≤5px test-harness controls (Bluesky's TestCtrls.e2e.tsx
  // pattern — 1×1 Pressables stacked in a top:100 absolute view with
  // zIndex 100) stay exposed at the same coords across screen
  // transitions, so an exposure-based retap loop never sees them
  // disappear and burns its full 5 s budget firing duplicate onPress
  // events. They DO need a couple of retaps though — coord rounding /
  // animation timing can swallow a single touch. Cap them at a short
  // fixed budget.
  // Tiny ≤5px test-harness Pressables (Bluesky's TestCtrls.e2e.tsx,
  // stacked 1×1 px Pressables at top:100 right:0 zIndex:100): the
  // integer-rounding hidTap path on the CLI subprocess rounds the
  // FP center (401.5, 111.5) up to (402, 112) and misses the 1×1
  // sibling's hit-box, hitting a *different* sibling whose onPress
  // does something unwanted (the e2eRefreshHome → setShowLoggedOut
  // regression — log the user out). Use the gRPC daemon path, which
  // passes float coords through unrounded, and fire 3 times so a
  // first-tap simulator miss still has recovery shots.
  if (rect.w <= 5 && rect.h <= 5) {
    // 1×1 px test-harness Pressables (Bluesky's TestCtrls.e2e.tsx).
    // Use pure DOWN+UP — the swipe-as-tap path's 0.5 px Move lands
    // outside the 1 px hit box.
    for (let i = 0; i < 3; i++) {
      if (i > 0) await sleep(80);
      await hidTapPureFast(ctx.udid, center.x, center.y);
    }
    return;
  }
  // Single retap if the first tap left the screen unchanged. Wait
  // long enough (1.5 s) for save/publish-style async commits to
  // land, so we don't fire onPress twice and break navigation.
  // If the tap opened a bottom-sheet / modal that takes longer than
  // 1.5 s to animate (RNGH bottom sheet ~600 ms spring + content
  // mount + first-frame layout), the hash-change exit fires late and
  // we'd retap right as the sheet finishes opening — closing it. So
  // also probe `is_exposed`: if the original target is now covered
  // by a presented overlay, the tap registered even if the rendered
  // frame hash is steady. Only retap when the target is BOTH still
  // findable AND still topmost-hittable.
  // Multi-retap self-heal. Some buttons are findable the same frame
  // they mount (Mantis cropper's Done — appears as cropper finishes
  // animating in, gesture recogniser attached a few frames later).
  // The hit-test resolves to the button but onPress doesn't fire yet,
  // so the tap is silently consumed. Maestro covers this by retrying
  // the labelled tap for ~5 s; we do the same here.
  //
  // Success signal: target disappears from the find walk (button
  // dismissed its host modal / triggered nav). The hash-change
  // signal isn't strong enough — minor UI updates (status-bar
  // ticks, cursor blink) flip the hash without proving the press
  // actually fired. Each iteration: short wait, re-find. If
  // findable AND still topmost-hittable → retap. If gone → exit.
  // Single retap. Multi-retap caused toggle-button regression
  // (tapping "Open drawer menu" repeatedly toggles drawer open/closed).
  // Mantis cropper's late-recogniser case is rare enough that we
  // accept a single retap and rely on flow-level retry for the
  // residual cases.
  if ((sel.id || sel.text) && baseHash) {
    const hc = await ctx.client
      .call('wait_hash_change', { sinceHash: baseHash, maxMs: 1500 })
      .catch(() => undefined);
    const hashChanged = !!(hc && hc.ok && (hc.data as { ok?: boolean })?.ok);
    if (!hashChanged) {
      const re = await sampleRect();
      if (re) {
        let stillExposed = true;
        if (sel.id) {
          const ex = await ctx.client.call('is_exposed', { testID: sel.id }).catch(() => undefined);
          if (ex && ex.ok && ex.data) {
            stillExposed = !!(ex.data as { exposed?: boolean }).exposed;
          }
        }
        if (stillExposed) {
          const c = { x: re.x + re.w / 2, y: re.y + re.h / 2 };
          await timedAsync(ctx, 'tap.selfHealRetap', () => hidTapArgent(ctx.udid, c.x, c.y));
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
  // Fast path: push the polling INTO the dylib via wait_find_by_*
  // so each retry is ~16 ms (one CADisplayLink tick) instead of
  // the CLI's 100 ms loop. Single round-trip, ~6x lower latency
  // on misses. Falls back to the legacy retry loop for selectors
  // the fast path can't handle (childOf, mixed id+text, etc.).
  if (sel.childOf && sel.childOf.id && sel.id) {
    // childOf goes through the dedicated find_child_by_testid (no
    // wait variant yet) — keep its existing path.
  } else if (sel.id && typeof sel.index === 'number') {
    // Maestro `index: N` — pick the Nth matching testID instance,
    // sorted top-to-bottom by window Y. Needed for feed-item flows
    // (postDropdownBtn index:0 must hit the first post, not the
    // last-mounted one that find_by_testid returns by default).
    const r = await timedAsync(ctx, 'tap.findFast', () =>
      ctx.client
        .call('find_by_testid_nth', { testID: sel.id!, index: sel.index })
        .catch(() => undefined),
    );
    if (r && r.ok && r.data) return r.data as Rect;
  } else if (sel.id) {
    // Drop sel.text gating: when both id and text/label are set in
    // YAML, the label is human-readable metadata, not an additional
    // filter — find_by_testid alone identifies the unique element.
    // Falling through to the slow CLI poll for the id+text case was
    // burning ~7s/step on labelled buttons (home-screen `likeBtn`).
    const r = await timedAsync(ctx, 'tap.findFast', () =>
      ctx.client
        .call('wait_find_by_testid', { testID: sel.id!, maxMs: 2500 })
        .catch(() => undefined),
    );
    if (r && r.ok && r.data) return r.data as Rect;
  } else if (sel.text && !sel.id) {
    const r = await timedAsync(ctx, 'tap.findFast', () =>
      ctx.client.call('wait_find_by_text', { text: sel.text!, maxMs: 2500 }).catch(() => undefined),
    );
    if (r && r.ok && r.data) return r.data as Rect;
  }
  // Match Maestro's implicit-wait semantics on tapOn: keep retrying
  // the find for ~7s before giving up. Layout passes after a
  // clearState relaunch, RNGH bottom-sheet expansion (~600 ms spring
  // + lazy-mount of inner buttons), or React-Navigation push can
  // each take 1-3s to settle. Matches Maestro's default 10s a11y
  // tap timeout closely enough for parity on slow-mount flows.
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    const r = await findOnce(ctx, sel);
    if (r) return r;
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

  // Skip auto-scroll for childOf selectors. Scrolling the screen
  // shifts the parent out of view, then the child resolves against
  // whatever happens to be at the polled coords — turning a "parent
  // not yet mounted" race into a wrong-target tap. Wait was enough
  // upstream; this selector cannot be auto-scroll-recovered.
  if (sel.childOf) {
    if (sel.text) {
      const axRect = await timedAsync(ctx, 'tap.findAxFallback', () =>
        axQueryByText(ctx.udid, sel.text!),
      );
      if (axRect) return axRect;
    }
    return null;
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
      if (dir === 'DOWN') await hidSwipe(ctx.udid, cx, cy + dist / 2, cx, cy - dist / 2, 250);
      else await hidSwipe(ctx.udid, cx, cy - dist / 2, cx, cy + dist / 2, 250);
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

  // In-process accessibility fallback. find_by_text walks the UIView
  // subtree only; that misses content rendered by out-of-process
  // view services (PHPickerViewController, document picker, share
  // sheet) whose host app gets only a UIRemoteView placeholder.
  // UIKit synthesises UIAccessibilityElement proxies on the remote
  // view that carry the cross-process content's a11y labels — the
  // dylib's find_ax_by_text walks accessibilityElements +
  // accessibilityElementAtIndex: and picks those proxies up. Stays
  // entirely in-process (no argent describe).
  if (sel.text) {
    const r = await timedAsync(ctx, 'tap.findAxFallback', () =>
      ctx.client.call('find_ax_by_text', { text: sel.text! }).catch(() => undefined),
    );
    if (r && r.ok && r.data) return r.data as Rect;
  }
  return null;
}

async function findOnce(ctx: RunContext, sel: MaestroSelector): Promise<Rect | null> {
  // Hierarchical childOf: prefer the dylib's scoped search so we
  // don't pick the wrong matching descendant from a different
  // ancestor (Maestro idiom: `id: postDropdownBtn / childOf: { id: feedItem-by-alice.test }`).
  if (sel.childOf && sel.childOf.id && sel.id) {
    const r = await ctx.client
      .call('find_child_by_testid', {
        childTestID: sel.id,
        parentTestID: sel.childOf.id,
      })
      .catch(() => undefined);
    if (r && r.ok) return r.data as Rect;
    // Don't fall back to flat find — that would defeat the childOf
    // constraint and return the first match anywhere.
    return null;
  }
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
      // Cross-process AX via in-process UIAccessibilityElement proxy
      // walk. UIRemoteView (PHPicker, share sheet, document picker)
      // exposes the remote content's a11y labels through proxy
      // objects sitting on the UIRemoteView itself — visible to a
      // UIAccessibilityContainer walk even though they're not in
      // the regular subview tree.
      const r2 = await ctx.client.call('find_ax_by_text', { text: sel.text }).catch(() => undefined);
      if (r2 && r2.ok && r2.data) return true;
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
async function relaunchAndReconnect(ctx: RunContext, launchArgs: string[] = []): Promise<void> {
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
    ['simctl', 'launch', '--terminate-running-process', ctx.udid, ctx.bundleId, ...launchArgs],
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

async function clearStateAndRelaunch(ctx: RunContext, launchArgs: string[] = []): Promise<void> {
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
    ['simctl', 'launch', '--terminate-running-process', ctx.udid, ctx.bundleId, ...launchArgs],
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
  // Maestro lets coords be `"x%,y%"` (percentage of window) or
  // `"x,y"` (pixels). Without the %-aware path, `"90%,43%"` got
  // parsed as the pixel point (90, 43) — top-left corner — instead
  // of (362, 376), which is what every `point: 90%,43%` flow
  // (curate-lists row Edit, create-account save-password
  // dismiss) actually wants.
  const winW = 402;
  const winH = 874;
  const parseAxis = (s: string, max: number): number => {
    const t = s.trim();
    if (t.endsWith('%')) return (parseFloat(t.slice(0, -1)) / 100) * max;
    return parseFloat(t);
  };
  if (typeof p === 'string') {
    const [xs, ys] = p.split(',').map((s) => s.trim());
    return { x: parseAxis(xs, winW), y: parseAxis(ys, winH) };
  }
  if (p && typeof p === 'object') {
    const x = typeof p.x === 'number' ? p.x : parseAxis(p.x, winW);
    const y = typeof p.y === 'number' ? p.y : parseAxis(p.y, winH);
    return { x, y };
  }
  throw new Error('tapOn point: invalid');
}

function maestroHttpSyncOnce(
  method: string,
  url: string,
  opts?: { headers?: Record<string, string>; body?: string },
): { status: number; body: string; headers: Record<string, string> } {
  const args = ['-sS', '-X', method.toUpperCase(), '-w', '\n%{http_code}', url];
  if (opts?.headers) {
    for (const [k, v] of Object.entries(opts.headers)) {
      args.push('-H', `${k}: ${v}`);
    }
  }
  if (opts?.body !== undefined) {
    args.push('--data-binary', opts.body);
  }
  const res = spawnSync('curl', args, { encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 });
  const out = (res.stdout ?? '') + (res.stderr ?? '');
  const nl = out.lastIndexOf('\n');
  let status = 0;
  let body = out;
  if (nl >= 0) {
    const tail = out.slice(nl + 1).trim();
    if (/^\d{3}$/.test(tail)) {
      status = parseInt(tail, 10);
      body = out.slice(0, nl);
    }
  }
  return { status, body, headers: {} };
}

function maestroHttpSync(
  method: string,
  url: string,
  opts?: { headers?: Record<string, string>; body?: string },
): { status: number; body: string; headers: Record<string, string> } {
  // Bluesky's mock PDS cycles its underlying process on each
  // setupServer.js POST — the first call after a cycle can land
  // mid-restart and return empty body + 500. Retry a few times
  // with backoff before giving up.
  let last = maestroHttpSyncOnce(method, url, opts);
  for (let i = 0; i < 4 && (last.status >= 500 || last.body.trim() === ''); i++) {
    const sleepMs = 500 * (i + 1);
    spawnSync('sleep', [(sleepMs / 1000).toString()]);
    last = maestroHttpSyncOnce(method, url, opts);
  }
  return last;
}

async function runMaestroScript(
  ctx: RunContext,
  script: { file: string; env?: Record<string, string> },
): Promise<void> {
  const scriptPath = resolve(dirname(ctx.flowPath), script.file);
  const src = readFileSync(scriptPath, 'utf-8');
  const sandbox = {
    output: ctx.outputs,
    http: {
      get: (url: string, opts?: { headers?: Record<string, string>; body?: string }) =>
        maestroHttpSync('GET', url, opts),
      post: (url: string, opts?: { headers?: Record<string, string>; body?: string }) =>
        maestroHttpSync('POST', url, opts),
      put: (url: string, opts?: { headers?: Record<string, string>; body?: string }) =>
        maestroHttpSync('PUT', url, opts),
      delete: (url: string, opts?: { headers?: Record<string, string>; body?: string }) =>
        maestroHttpSync('DELETE', url, opts),
    },
    json: (s: string) => JSON.parse(s),
    console: { log: (...a: unknown[]) => process.stderr.write(`[script] ${a.join(' ')}\n`) },
    ...(script.env ?? {}),
  };
  const vmCtx = createContext(sandbox);
  runInContext(src, vmCtx, { filename: scriptPath, timeout: 30_000 });
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
