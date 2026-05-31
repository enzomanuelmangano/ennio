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

import { MaestroCommand, MaestroFlow, MaestroSelector, normalizeSelector } from '../maestro-parser';
import { EnnioSocketClient, ennioSocketPath } from '../socket-client';
import {
  swipe as hidSwipe,
  longPressDrag as hidLongPressDrag,
  setDylibClient,
  closeAllIdbClients,
} from '../hid';
import { enableAccessibility, ensureBootedSim, findDylib, terminateApp } from '../sim';

// Helper modules — split out of the original 2071-line runner.ts.
import {
  DEFAULT_WIN_H,
  DEFAULT_WIN_W,
  RunContext,
  RunResult,
  recordPhase,
  sleep,
} from './context';
import { resolveRect } from './find';
import { isVisible } from './visibility';
import { waitForFirstPaint } from './lifecycle';

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

// Constants, RunContext, RunResult, interpolate, recordPhase, timedAsync,
// and sleep live in ./context. They're re-exported below for callers that
// imported them from ../runner historically.

export type { RunContext, RunResult };
export { recordPhase };

// =====================================================================
// Top-level
// =====================================================================

export async function runFlow(
  flow: MaestroFlow,
  options: { udid?: string; dylibPath?: string; verbose?: boolean; lenient?: boolean } = {},
): Promise<RunResult> {
  const udid = options.udid || ensureBootedSim();
  if (!udid) {
    throw new Error('No iOS simulator available. Install one via Xcode or set ENNIO_UDID.');
  }
  if (!flow.appId) {
    throw new Error(`Flow ${flow.filePath} is missing top-level appId`);
  }

  // Make SwiftUI / native apps readable by ennio's in-process AX walk.
  // Off by default, SwiftUI builds no accessibility tree, so a screen
  // like iOS Settings is invisible to find_ax_by_text. One-time, cheap.
  enableAccessibility(udid);

  const client = new EnnioSocketClient(udid);
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
    // Set ENNIO_SOCKET_PATH on the simulator's launchctl env so the
    // dylib reads it via getenv() at +load time. SIMCTL_CHILD_* only
    // forwards DYLD_* / CFNETWORK_* and a few other known prefixes —
    // arbitrary names are dropped silently. Setting via launchctl
    // setenv is sim-wide but harmless: per-UDID path, not a secret.
    execFileSync(
      'xcrun',
      ['simctl', 'spawn', udid, 'launchctl', 'setenv', 'ENNIO_SOCKET_PATH', ennioSocketPath(udid)],
      { stdio: 'pipe' },
    );
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
    await waitForFirstPaint(client);
  }

  // Expose the runner's dylib socket connection to hid.ts so its
  // in-process tap/swipe/keyboard ops reuse this connection instead
  // of opening a second one (which would serialise behind the runner's
  // in-flight find_by_text calls inside the dylib worker).
  setDylibClient(client);

  const ctx: RunContext = {
    client,
    udid,
    bundleId: flow.appId,
    dylibPath: options.dylibPath ?? null,
    verbose: options.verbose ?? false,
    lenient: options.lenient ?? false,
    flowPath: flow.filePath,
    outputs: {},
  };

  // Header printed by caller (test.ts) — flow name + step count.
  if (ctx.verbose) {
    process.stderr.write(`   ${flow.name || ''} (${flow.commands.length} steps)\n`);
  }

  // onFlowStart hook — failures abort the flow.
  if (flow.onFlowStart) {
    for (const cmd of flow.onFlowStart) {
      await runCommand(ctx, cmd, undefined);
    }
  }

  let stepsPassed = 0;
  const stepTimings: { step: number; ms: number; cmd: string }[] = [];
  let lastTapCmd: unknown = undefined;
  // Wrap the step loop in a try/finally so a thrown error in
  // runCommand or runOnFlowComplete can't leave the socket open and
  // idb gRPC clients pooled across flows. Without this, a partial-
  // flow crash deadlocks the next launch attempt.
  try {
    for (let i = 0; i < flow.commands.length; i++) {
      const cmd = flow.commands[i];
      const nextCmd = flow.commands[i + 1];
      const t0 = Date.now();
      try {
        await runCommand(ctx, cmd, nextCmd);
        // A step (typically tapOn collapsing with its same-target peer
        // into a single double-tap) can mark the next command consumed.
        // Advance one extra position to skip it.
        if (ctx.skipNextCmd) {
          ctx.skipNextCmd = false;
          if (i + 1 < flow.commands.length) {
            const consumed = flow.commands[i + 1];
            stepsPassed++;
            stepTimings.push({
              step: i + 2,
              ms: 0,
              cmd: describeCommand(consumed) + ' (collapsed)',
            });
            logStep(ctx, i + 2, 0, describeCommand(consumed) + ' (collapsed)', true);
            i++;
          }
        }
        const dt = Date.now() - t0;
        stepTimings.push({ step: i + 1, ms: dt, cmd: describeCommand(cmd) });
        logStep(ctx, i + 1, dt, describeCommand(cmd), true);
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
            if (ctx.verbose) {
              process.stderr.write(
                `   ↻  re-firing previous tap (${describeCommand(lastTapCmd as MaestroCommand)})\n`,
              );
            }
            await runCommand(ctx, lastTapCmd as any, cmd);
            await sleep(150);
            await runCommand(ctx, cmd, nextCmd);
            const dt = Date.now() - t0;
            stepTimings.push({ step: i + 1, ms: dt, cmd: describeCommand(cmd) });
            logStep(ctx, i + 1, dt, describeCommand(cmd), true);
            stepsPassed++;
            lastTapCmd = typeof cmd === 'object' && cmd && 'tapOn' in cmd ? cmd : undefined;
            continue;
          } catch {
            /* fall through to fail */
          }
        }
        const dt = Date.now() - t0;
        stepTimings.push({ step: i + 1, ms: dt, cmd: describeCommand(cmd) });
        logStep(ctx, i + 1, dt, describeCommand(cmd), false);
        await runOnFlowComplete(ctx, flow);
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
    await runOnFlowComplete(ctx, flow);
    printSlowSteps(stepTimings);
    printPhaseTotals(ctx);
    return { passed: true, stepsRun: flow.commands.length, stepsPassed };
  } finally {
    // Always clean up — socket close, idb gRPC pool drain, runner-
    // facing dylib client unset. Safe to call even after early return.
    setDylibClient(null);
    try {
      client.close();
    } catch {
      /* socket may already be closed */
    }
    closeAllIdbClients();
  }
}

async function runOnFlowComplete(ctx: RunContext, flow: MaestroFlow): Promise<void> {
  if (!flow.onFlowComplete) return;
  for (const cmd of flow.onFlowComplete) {
    try {
      await runCommand(ctx, cmd, undefined);
    } catch (e) {
      process.stderr.write(
        `[onFlowComplete] ${describeCommand(cmd)} failed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }
}

// One-line summary: total time + step count + outliers (if any).
// Always shown, regardless of verbose. Outliers (steps ≥3× avg or
// ≥1.5s) are surfaced as bullets so slow steps stand out without
// dumping the full timing table.
function printSlowSteps(timings: { step: number; ms: number; cmd: string }[]): void {
  const total = timings.reduce((s, t) => s + t.ms, 0);
  const avg = total / Math.max(timings.length, 1);
  const outliers = timings.filter((t) => t.ms >= Math.max(avg * 3, 1500));
  process.stderr.write(`   total ${total}ms across ${timings.length} steps\n`);
  if (outliers.length > 0) {
    for (const t of outliers) {
      process.stderr.write(
        `   ⚠ slow  step ${String(t.step).padStart(2)}  ${String(t.ms).padStart(6)}ms  ${t.cmd}\n`,
      );
    }
  }
}

// Per-phase timing breakdown (e.g. "tap.postWaitCommit took 32s
// across 40 taps"). Useful for runtime tuning but noisy for typical
// users — gated on ENNIO_PHASE_TRACE.
function printPhaseTotals(ctx: RunContext): void {
  if (!process.env.ENNIO_PHASE_TRACE) return;
  if (!ctx.phaseTotals || ctx.phaseTotals.size === 0) return;
  const entries = [...ctx.phaseTotals.entries()].map(([name, total]) => ({
    name,
    total,
    count: ctx.phaseCounts?.get(name) ?? 0,
  }));
  entries.sort((a, b) => b.total - a.total);
  process.stderr.write(`   phase totals:\n`);
  for (const e of entries) {
    const avg = e.count > 0 ? Math.round(e.total / e.count) : 0;
    process.stderr.write(
      `     ${String(e.total).padStart(6)}ms  ` +
        `${String(e.count).padStart(4)}x  ` +
        `${String(avg).padStart(4)}ms/call  ` +
        `${e.name}\n`,
    );
  }
}

// =====================================================================
// Per-command dispatch
// =====================================================================

export async function runCommand(
  ctx: RunContext,
  rawCmd: MaestroCommand,
  _nextRawCmd?: MaestroCommand,
): Promise<void> {
  // Maestro lets some commands be bare strings: `- hideKeyboard`,
  // `- back`, `- launchApp`, etc. js-yaml parses those as plain strings,
  // not `{hideKeyboard: true}`. Normalise so the dispatch below can use
  // the same `'op' in cmd` shape unconditionally.
  const cmd: MaestroCommand =
    typeof rawCmd === 'string' ? ({ [rawCmd]: true } as unknown as MaestroCommand) : rawCmd;

  // Reset repeat-tap tracking unless this command itself is a tapOn.
  // (FlowExecutor also resets this before dispatch — kept here for the
  // legacy direct callers of runCommand still in this file.)
  if (!('tapOn' in cmd)) ctx.lastTapKey = undefined;

  // tapOn: migrated to commands/handlers/tap.ts.
  // tapOn, doubleTapOn, longPress, longPressOn: migrated to commands/handlers/tap.ts.
  // assertVisible, assertNotVisible, waitFor, assertAnyVisible,
  // extendedWaitUntil: migrated to commands/handlers/assert.ts.
  // inputText, eraseText, clearText, pressKey: migrated to commands/handlers/input.ts.
  // back, hideKeyboard: migrated to commands/handlers/system.ts.
  if ('scrollUntilVisible' in cmd) {
    // Resolve the target selector. Maestro accepts either a bare
    // selector or { element: ..., direction, timeout }.
    const arg = cmd.scrollUntilVisible as
      | MaestroSelector
      | { element: MaestroSelector; direction?: string; timeout?: number };
    const target = 'element' in arg ? arg.element : (arg as MaestroSelector);
    const dir = ('direction' in arg && arg.direction ? arg.direction : 'DOWN').toUpperCase();
    const timeout = ('timeout' in arg && arg.timeout) || 15000;
    const wsz = await ctx.client.call('window_size').catch(() => undefined);
    const wd = (wsz?.data as { w?: number; h?: number }) ?? {};
    // Fallback to iPhone 17 Pro logical dimensions if window_size fails
    const winW = wd.w ?? DEFAULT_WIN_W;
    const winH = wd.h ?? DEFAULT_WIN_H;
    const SWIPE_CENTER_X = Math.round(winW / 2);
    // Below vertical midpoint to avoid the navigation bar header area
    const SWIPE_CENTER_Y = Math.round(winH / 2);
    // ~30% of screen per swipe — enough to scroll but not overshoot
    const SWIPE_DISTANCE = Math.round((winH * 3) / 10);
    // Small push to move element above the tab bar
    const NUDGE_DISTANCE = Math.round(winH / 6);
    // Bottom 20% of screen overlaps with tab bar
    const TAB_BAR_THRESHOLD = (winH * 4) / 5;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await isVisible(ctx, target)) {
        await sleep(600);
        await ctx.client.call('wait_commit', { maxMs: 2000, stableMs: 300 }).catch(() => undefined);
        const rect = await resolveRect(ctx, target);
        if (rect && rect.y + rect.h / 2 > TAB_BAR_THRESHOLD) {
          if (dir === 'DOWN') {
            await hidSwipe(
              ctx.udid,
              SWIPE_CENTER_X,
              SWIPE_CENTER_Y + NUDGE_DISTANCE / 2,
              SWIPE_CENTER_X,
              SWIPE_CENTER_Y - NUDGE_DISTANCE / 2,
              250,
            );
          } else if (dir === 'UP') {
            await hidSwipe(
              ctx.udid,
              SWIPE_CENTER_X,
              SWIPE_CENTER_Y - NUDGE_DISTANCE / 2,
              SWIPE_CENTER_X,
              SWIPE_CENTER_Y + NUDGE_DISTANCE / 2,
              250,
            );
          }
          await sleep(500);
          await ctx.client
            .call('wait_commit', { maxMs: 1500, stableMs: 200 })
            .catch(() => undefined);
        }
        return;
      }
      const dist = SWIPE_DISTANCE;
      let x1 = SWIPE_CENTER_X,
        y1 = SWIPE_CENTER_Y,
        x2 = SWIPE_CENTER_X,
        y2 = SWIPE_CENTER_Y;
      if (dir === 'DOWN') {
        y1 = SWIPE_CENTER_Y + dist / 2;
        y2 = SWIPE_CENTER_Y - dist / 2;
      } else if (dir === 'UP') {
        y1 = SWIPE_CENTER_Y - dist / 2;
        y2 = SWIPE_CENTER_Y + dist / 2;
      } else if (dir === 'LEFT') {
        x1 = SWIPE_CENTER_X + dist / 2;
        x2 = SWIPE_CENTER_X - dist / 2;
      } else if (dir === 'RIGHT') {
        x1 = SWIPE_CENTER_X - dist / 2;
        x2 = SWIPE_CENTER_X + dist / 2;
      }
      await hidSwipe(ctx.udid, x1, y1, x2, y2, 250);
      // Wait for scroll momentum to settle before the next isVisible
      // check. sleep(500) isn't enough on slow CI runners — the scroll
      // animation is still in-flight and UIKit hasn't laid out the final
      // frame positions yet, so the visibility check returns false even
      // when the element IS on screen.
      await ctx.client.call('wait_commit', { maxMs: 2000, stableMs: 300 }).catch(() => undefined);
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
    // Query actual device dims so `%` swipe coords land on the real
    // pixel — the hardcoded 390×844 was a 6.1" iPhone in portrait and
    // is 12-30 pt off on iPhone 17 Pro / iPhone Air / iPad. That 30 pt
    // gap is enough to land outside an RN carousel's content area:
    // the gesture lands on the page-list background instead of the
    // page itself, the recogniser ignores it, and the carousel never
    // advances.
    const sizeResp = await ctx.client.call('window_size').catch(() => undefined);
    const sizeData = (sizeResp?.data as { w?: number; h?: number }) ?? {};
    const winW = sizeData.w && sizeData.w > 0 ? sizeData.w : 390;
    const winH = sizeData.h && sizeData.h > 0 ? sizeData.h : 844;
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
    // Row-spacing detection. When the YAML uses a testID for the
    // drag handle (e.g. "feed-drag-handle" — the same testID is on
    // every row's handle), we can find the 0th and 1st instance
    // and use the delta-Y between them as the actual row height.
    // That replaces a fixed-pixel drag distance with a measurement
    // taken from the live layout — works on any RN draggable-flatlist
    // regardless of row height. Falls back to a single-handle find
    // when only one row exists.
    let rowSpacing: number | null = null;
    if (sw.from && typeof sw.from === 'object') {
      const fromSel = normalizeSelector(sw.from as MaestroSelector);
      const rect = await resolveRect(ctx, fromSel);
      if (rect) {
        from = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
      }
      if (fromSel.id) {
        const second = await ctx.client
          .call('find_by_testid_nth', { testID: fromSel.id, index: 1 })
          .catch(() => undefined);
        if (second && second.ok && second.data) {
          const sd = second.data as { y: number; h: number };
          const r0Center = rect ? rect.y + rect.h / 2 : null;
          const r1Center = sd.y + sd.h / 2;
          if (r0Center !== null) rowSpacing = Math.abs(r1Center - r0Center);
        }
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
      // Drag distance = measured row spacing × 1.6. The recogniser
      // commits the swap when the finger crosses the next row's
      // midpoint; 1.6× gives margin against rounding without
      // overshooting two rows. rowSpacing comes from delta-Y between
      // the 0th and 1st instance of the same testID — so it's
      // measured live from the list rather than hardcoded.
      const dist = rowSpacing ? Math.round(rowSpacing * 1.6) : 160;
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
      // RN draggable-flatlist enters drag mode on a hold >= ~500 ms.
      // 800 ms gives a safe margin over the recogniser's debounce.
      // Glide intentionally slow so each move event is consumed by
      // the list's onMove callback — a fast glide overshoots before
      // the data array updates.
      const totalDur = sw.duration ?? 1000;
      const holdMs = 800;
      const moveMs = Math.max(500, totalDur - holdMs);
      await hidLongPressDrag(ctx.udid, from.x, from.y, to.x, to.y, holdMs, moveMs);
      await sleep(500);
      await ctx.client.call('wait_commit', { maxMs: 1000, stableMs: 150 }).catch(() => undefined);
      return;
    }
    // Pre-swipe settle: wait for the screen to stop animating so the
    // gesture lands on a stable target. Without this, a swipe fired
    // immediately after a tab change or navigation push lands while
    // the destination view is still in its layout pass — the
    // gesture-recogniser hasn't been attached yet and the swipe is
    // silently dropped. Observed on RN horizontal carousels: the
    // first card looked stable but the FlatList's onLayout hadn't
    // fired so the page-snap math couldn't run.
    //
    // stableMs 350 / maxMs 2500 outlasts:
    // - RN-Nav push spring (~300 ms tail commit)
    // - FlatList initial layout + page-snap-state attach (~150 ms)
    // - expo-router tab change transition (~250 ms)
    // Below ~300 ms the carousel's gesture-recogniser was still
    // mid-mount when the swipe Down event arrived; the recogniser
    // received only the Up event after attaching, which it dropped
    // as a no-op.
    await ctx.client.call('wait_commit', { maxMs: 2500, stableMs: 350 }).catch(() => undefined);
    await ctx.client.call('wait_presentation_idle', { maxMs: 800 }).catch(() => undefined);
    // Maestro default swipe duration is 400 ms (verified with
    // `maestro test` on a swipe-only flow: "Swipe ... in 400 ms").
    // We previously defaulted to 250 ms which was fast enough for
    // page-scroll but undershot the inertia threshold on RN
    // horizontal carousels — pages snapped back to the original
    // index instead of advancing.
    await hidSwipe(ctx.udid, from.x, from.y, to.x, to.y, sw.duration ?? 400);
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
  // launchApp, clearState, stopApp, killApp: migrated to
  // commands/handlers/lifecycle.ts.
  // takeScreenshot: migrated to commands/handlers/system.ts.
  // Legacy fallback removed.
  // dismissAlert: migrated to commands/handlers/system.ts.
  // openLink, waitForAnimationToEnd: migrated to commands/handlers/lifecycle.ts.
  // runScript, runFlow, repeat, retry: migrated to commands/handlers/control-flow.ts.

  // inputRandom* family — generate random text and type it into the
  // currently focused field.
  // inputRandomText, inputRandomNumber, inputRandomEmail,
  // inputRandomPersonName, pasteText, copyTextFrom, evalScript,
  // assertTrue: migrated to commands/handlers/random-input.ts.
  // clearKeychain: migrated to commands/handlers/system.ts.
  // Legacy fallback removed.

  // Unknown/unsupported command. Default: fail so YAML typos don't
  // silently pass. --lenient mode skips with a warning printed
  // regardless of --verbose, since a silent skip in lenient mode is
  // exactly the misuse case (typo in command name produces a green
  // run instead of a clear error).
  const desc = describeCommand(cmd);
  if (ctx.lenient) {
    process.stderr.write(`   ⚠ skipped (unsupported command): ${desc}\n`);
    return;
  }
  throw new Error(`unsupported command: ${desc}`);
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
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleepMs);
    last = maestroHttpSyncOnce(method, url, opts);
  }
  return last;
}

export async function runMaestroScript(
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

export function describeCommand(cmd: MaestroCommand): string {
  const key = Object.keys(cmd)[0];
  const value = (cmd as Record<string, unknown>)[key];
  if (typeof value === 'string') return `${key}: ${value}`;
  if (typeof value === 'boolean') return key;
  if (value && typeof value === 'object') {
    return `${key}: ${JSON.stringify(value)}`;
  }
  return key;
}

// One-line per-step trace under --verbose. Format:
//   ✓   3   5230ms  launchApp: {clearState: true}
//   ✗   8   1234ms  tapOn: Submit
// Pass/fail glyph + step number + duration + command summary.
function logStep(ctx: RunContext, step: number, ms: number, cmd: string, ok: boolean): void {
  if (!ctx.verbose) return;
  const glyph = ok ? '✓' : '✗';
  const stepStr = String(step).padStart(3);
  const msStr = String(ms).padStart(6);
  process.stderr.write(`   ${glyph}  ${stepStr}  ${msStr}ms  ${cmd}\n`);
}
