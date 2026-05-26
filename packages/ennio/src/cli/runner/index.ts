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
} from '../maestro-parser';
import { EnnioSocketClient } from '../socket-client';
import {
  tap as hidTap,
  tapFast as hidTapFast,
  doubleTap as hidDoubleTap,
  swipe as hidSwipe,
  longPressDrag as hidLongPressDrag,
  typeText as hidType,
  setDylibClient,
} from '../hid';
import { ensureBootedSim, findDylib, terminateApp } from '../sim';

// Helper modules — split out of the original 2071-line runner.ts.
import {
  DEFAULT_WAIT_MS,
  DEFAULT_WIN_H,
  DEFAULT_WIN_W,
  POLL_MS,
  POST_LAUNCH_SETTLE_MS,
  POST_TAP_SETTLE_MS,
  RunContext,
  RunResult,
  interpolate,
  recordPhase,
  sleep,
  timedAsync,
} from './context';
import { captureHash, captureReactTs, findOnce, resolveCenter, resolveRect } from './find';
import { execTapOn } from './tap';
import { isVisible, waitUntilNotVisible, waitUntilVisible } from './visibility';
import { clearStateAndRelaunch, relaunchAndReconnect, waitForFirstPaint } from './lifecycle';

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
      // A step (typically tapOn collapsing with its same-target peer
      // into a single double-tap) can mark the next command consumed.
      // Advance one extra position to skip it.
      if (ctx.skipNextCmd) {
        ctx.skipNextCmd = false;
        if (i + 1 < flow.commands.length) {
          const consumed = flow.commands[i + 1];
          process.stderr.write(`[step ${i + 2}] ${describeCommand(consumed)} (collapsed)\n`);
          stepsPassed++;
          stepTimings.push({ step: i + 2, ms: 0, cmd: describeCommand(consumed) + ' (collapsed)' });
          i++;
        }
      }
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
          process.stderr.write(
            `[retry] re-firing previous tap (${describeCommand(lastTapCmd as MaestroCommand)}) before step ${i + 1}\n`,
          );
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
      setDylibClient(null);
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
    // When the next step taps the same target, collapse the pair into
    // a single double-tap dispatched within ONE idb HID session. Each
    // standalone tap() opens + closes its own gRPC stream — that
    // open/close cycle inserts ~100ms between the two Down/Up sequences
    // and exceeds RN/UIKit's ~350ms double-tap window, so the second
    // tap registers as a fresh single tap (onPress fires twice instead
    // of onDoubleTap once). Keeping both taps on one stream eliminates
    // the gap. Skipped when the current tap targets a tiny (≤5 px)
    // hidden test control where the pure-fast retry loop takes over.
    if (nextIsSameTap && sel.id && !ctx.lastWasTextInput) {
      const rect = await findOnce(ctx, sel);
      if (rect && (rect.w > 5 || rect.h > 5)) {
        await timedAsync(ctx, 'tap.execTapOn', () =>
          hidDoubleTap(ctx.udid, rect.x + rect.w / 2, rect.y + rect.h / 2),
        );
        ctx.lastTapKey = tapKey;
        ctx.lastTapTestID = sel.id;
        ctx.skipNextCmd = true;
        return;
      }
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
      // Pre-tap settle reduced to ONE check: wait_commit (frame-hash
      // stability). The hit-test exposure gate further down in the
      // tap-pipeline catches cases where the layout settled but the
      // visual layer is still mid-animation, so we don't need the
      // VC-transition / React-mount checks here too. Dropping those
      // two saves ~450 ms / tap on average — curate-lists 97-step
      // run drops ~25 s. Generous maxMs gives slow async submits
      // room; stableMs floor keeps the average low.
      await timedAsync(ctx, 'tap.preWaitCommit', async () => {
        // Wait for any UIKit transition (modal dismiss, nav push/pop)
        // to fully end before tapping. Signal-based: polls
        // animations_active (checks UIViewController.transitionCoordinator
        // across the VC chain). No magic-number stable-quiet window —
        // we wait until the system itself reports no transition in
        // flight. Cap at 1500 ms for safety; the cap is reached only
        // when a custom transition holds the coordinator open past the
        // visible animation end.
        const deadline = Date.now() + 1500;
        while (Date.now() < deadline) {
          const r = await ctx.client.call('animations_active').catch(() => undefined);
          const active = !!(r && r.ok && r.data && (r.data as { active?: boolean }).active);
          if (!active) break;
          await sleep(20);
        }
      });
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
    // editing the field — call focus_testid as primary; the regular
    // tap below still fires as belt-and-braces.
    const nextEditsField =
      !!nextRawCmd &&
      typeof nextRawCmd === 'object' &&
      ('inputText' in nextRawCmd || 'eraseText' in nextRawCmd || 'clearText' in nextRawCmd);
    let focusedViaTestId = false;
    if (sel.id && nextEditsField) {
      // Focus the field in-process via becomeFirstResponder. This is
      // deterministic and avoids the race where a fresh form's first
      // TextInput tap lands before RN has wired up the press handler.
      const r = await ctx.client.call('focus_testid', { testID: sel.id }).catch(() => undefined);
      focusedViaTestId = !!(r && r.ok);
    }
    if (focusedViaTestId) {
      // Field is already firstResponder — skip the redundant HID tap.
      // The keyboard is animating up and the tap coordinates (computed
      // from the pre-keyboard layout) may now land on the keyboard
      // itself, injecting a ghost keypress (observed: "tbanana"
      // instead of "banana" when the tap hit the "t" key).
      await ctx.client.call('wait_commit', { maxMs: 1000, stableMs: 200 }).catch(() => undefined);
      ctx.lastTapKey = tapKey;
      ctx.lastTapTestID = sel.id;
      return;
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
        // Signal-based post-tap wait. Two coupled signals:
        //   1. Frame hash must DIFFER from preTapHash (something
        //      changed on screen — press handler ran, layer
        //      repainted, or modal dismissed).
        //   2. UIViewController.transitionCoordinator must be nil
        //      (no animation in flight).
        // Both must be true to return committed=true. Cap 1500 ms —
        // covers modal-dismiss tails after `router.dismiss()`-style
        // calls that don't trigger React commits.
        const deadline = Date.now() + 1500;
        while (Date.now() < deadline) {
          const cur = await captureHash(ctx);
          if (cur !== preTapHash) {
            const animR = await ctx.client.call('animations_active').catch(() => undefined);
            const animActive = !!(
              animR &&
              animR.ok &&
              animR.data &&
              (animR.data as { active?: boolean }).active
            );
            if (!animActive) {
              if (nextEditsField) {
                await waitOneCommit(preReact.ts, 250);
              }
              return true;
            }
          }
        }
        return false;
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
        ctx.client.call('wait_commit', { maxMs: 1500, stableMs: 200 }).catch(() => undefined),
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
        // No hash change — likely a no-op tap, OR the JS bridge
        // hasn't fired its commit yet. Check animations_active: if
        // UIKit reports idle, halve the sleep since the screen is
        // genuinely static. Full budget only when animations are
        // in-flight (a transition may be producing the commit we're
        // waiting for).
        const animR = await ctx.client.call('animations_active').catch(() => undefined);
        const animActive = !!(
          animR && animR.ok && animR.data && (animR.data as { active?: boolean }).active
        );
        const settleMs = animActive ? POST_TAP_SETTLE_MS : Math.min(POST_TAP_SETTLE_MS, 400);
        await timedAsync(ctx, 'tap.postSleep', () => sleep(settleMs));
      }
      // 350 ms of commit-quiet outlasts setState batching, RN-Nav
      // pop animations, list re-layouts. Below ~300 ms we race the
      // next tap onto a still-transitioning view. maxMs trimmed
      // 1500 → 800: in practice the screen stabilizes within
      // 300-500 ms of the dismiss, so 800 ms is generous headroom
      // without paying for the legacy worst-case ceiling.
      await timedAsync(ctx, 'tap.postWaitCommit', () =>
        ctx.client.call('wait_commit', { maxMs: 800, stableMs: 350 }).catch(() => undefined),
      );
      // Tail-end: UIKit-level transitions (modal dismiss, RN-Nav
      // interactive pop) that don't fire React commits. The
      // transitionCoordinator on the dismissing VC clears in
      // 300-400 ms; 500 ms cap covers normal cases. wait_commit
      // above already absorbs longer JS-driven settle.
      await ctx.client.call('wait_presentation_idle', { maxMs: 500 }).catch(() => undefined);
    }
    ctx.lastTapKey = tapKey;
    ctx.lastTapTestID = sel.id;
    return;
  }
  if ('doubleTapOn' in cmd) {
    const sel = normalizeSelector(cmd.doubleTapOn);
    const { x, y } = await resolveCenter(ctx, sel);
    await hidDoubleTap(ctx.udid, x, y);
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
    // testID, re-tap it via the dylib activate path — that's the cheapest way to
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
    // Poll animations_active until the pop transition ends.
    // popViewControllerAnimated's CAAnimation registers on UIKit's
    // transitionCoordinator immediately; the poll exits as soon as
    // no VC in the chain is transitioning. Capped at 800 ms for
    // custom transitions that exceed the default ~250 ms.
    const deadline = Date.now() + 800;
    while (Date.now() < deadline) {
      const r = await ctx.client.call('animations_active').catch(() => undefined);
      const active = !!(r && r.ok && r.data && (r.data as { active?: boolean }).active);
      if (!active) break;
      await sleep(20);
    }
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
      cmd.waitForAnimationToEnd === true ? 600 : (cmd.waitForAnimationToEnd.timeout ?? 600);
    // Race two signals:
    //   - UIViewController.transitionCoordinator (animations_active)
    //   - frame_hash quiet for 80 ms
    // Either green-light returns. iOS 26 navigation occasionally
    // holds the transition coordinator open past the visible
    // animation end (custom presentation chain on liquid-glass tab
    // bar) so transitionCoordinator alone hits the cap. Hash-quiet
    // catches that case — the screen visibly stops changing well
    // before transitionCoordinator releases.
    const deadline = Date.now() + timeout;
    let prevR = await ctx.client.call('frame_hash').catch(() => undefined);
    let prevHash = (prevR?.data as { hash?: string })?.hash ?? '';
    let lastChange = Date.now();
    while (Date.now() < deadline) {
      const animR = await ctx.client.call('animations_active').catch(() => undefined);
      const animActive = !!(
        animR &&
        animR.ok &&
        animR.data &&
        (animR.data as { active?: boolean }).active
      );
      const hashR = await ctx.client.call('frame_hash').catch(() => undefined);
      const curHash = (hashR?.data as { hash?: string })?.hash ?? '';
      if (curHash !== prevHash) {
        prevHash = curHash;
        lastChange = Date.now();
      }
      const hashQuiet = Date.now() - lastChange >= 80;
      if (!animActive || hashQuiet) break;
      await sleep(20);
    }
    // Cross-process safety: PHPicker / share sheet / document picker
    // dismiss in another XPC process — the animations_active check
    // above is blind to those because their views live in a remote
    // process. Bail the instant the picker leaves the VC chain.
    const dismissDeadline = Date.now() + 2500;
    while (Date.now() < dismissDeadline) {
      const r = await ctx.client.call('top_vc_chain').catch(() => undefined);
      if (!r || !r.ok) break;
      const chain = (r.data as { chain?: string[] })?.chain ?? [];
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
    return;
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
      const trace = !!process.env.ENNIO_PHASE_TRACE;
      try {
        for (let i = 0; i < subFlow.commands.length; i++) {
          const t = Date.now();
          await runCommand(ctx, subFlow.commands[i], subFlow.commands[i + 1]);
          if (trace) {
            process.stderr.write(
              `[sub] ${sub.file} #${i + 1} ${Date.now() - t}ms ${describeCommand(subFlow.commands[i])}\n`,
            );
          }
        }
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

  // Unknown/unsupported command. Default: fail so YAML typos don't
  // silently pass. --lenient mode skips with a warning instead.
  const desc = describeCommand(cmd);
  if (ctx.lenient) {
    log(ctx, `  (unsupported, skipped: ${desc})`);
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
