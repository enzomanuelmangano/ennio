// Runs a single Maestro flow against an open EnnioConnection.
//
// Owns the step loop, retry policy, and Reporter notifications.
// Command dispatch goes through the CommandRegistry (currently
// delegates to the legacy runCommand monolith via a fallback handler
// — new handlers can be registered to override piecemeal).
//
// FlowExecutor does NOT manage the simulator or the connection
// lifecycle. The caller (EnnioRunner) opens the connection, hands it
// in, and closes it afterwards. This keeps the executor easy to test
// against a mock connection.

import { registerAllHandlers } from '../commands/handlers';
import { diagnoseSocketFailure } from '../crash-detector';
import { createDriver } from '../driver';
import type { GestureDriver } from '../driver';
import type { MaestroCommand, MaestroFlow, MaestroSelector } from '../maestro-parser';
import { extractModifiers, normalizeSelector } from '../maestro-parser';
import { evaluateCondition } from '../runner/conditions';
import { captureHash } from '../runner/find';
import { isVisible } from '../runner/visibility';
import type { DeviceSession, Platform } from '../platform';
import { selectPlatform } from '../platform';
import type { RunContext } from '../runner/context';
import { describeCommand } from '../runner/index';
import { resolveProfile } from '../settle/profile';

import { CommandRegistry } from './command-registry';
import type { EnnioConnection } from './ennio-connection';
import type { FlowResult, Reporter } from '../reporters';

export interface FlowExecutorOptions {
  session: DeviceSession;
  connection: EnnioConnection;
  platform?: Platform;
  reporter: Reporter;
  registry?: CommandRegistry;
  verbose?: boolean;
  lenient?: boolean;
  driver?: GestureDriver;
}

interface StepTiming {
  step: number;
  ms: number;
  cmd: string;
}

export class FlowExecutor {
  private session: DeviceSession;
  private connection: EnnioConnection;
  private platform: Platform;
  private reporter: Reporter;
  private registry: CommandRegistry;
  private verbose: boolean;
  private lenient: boolean;
  private driver: GestureDriver;

  constructor(opts: FlowExecutorOptions) {
    this.session = opts.session;
    this.connection = opts.connection;
    this.platform = opts.platform ?? selectPlatform('ios');
    this.reporter = opts.reporter;
    this.verbose = opts.verbose ?? false;
    this.lenient = opts.lenient ?? false;
    this.driver = opts.driver ?? createDriver(false);
    this.registry =
      opts.registry ??
      new CommandRegistry({
        // Unknown command: --lenient skips with a warning; default
        // fails so YAML typos don't silently pass.
        onUnknown: async (cmd, { ctx }) => {
          const desc = describeCommand(cmd);
          if (ctx.lenient) {
            this.reporter.warn?.(`skipped (unsupported command): ${desc}`);
            return;
          }
          throw new Error(`unsupported command: ${desc}`);
        },
      });
    registerAllHandlers(this.registry);
  }

  async run(flow: MaestroFlow): Promise<FlowResult> {
    if (!flow.appId) {
      throw new Error(`Flow ${flow.filePath} is missing top-level appId`);
    }

    const ctx: RunContext = {
      client: this.connection.socket,
      udid: this.session.udid,
      bundleId: this.session.bundleId,
      dylibPath: this.session.dylibPath,
      verbose: this.verbose,
      lenient: this.lenient,
      driver: this.driver,
      platform: this.platform,
      flowPath: flow.filePath,
      outputs: {},
      flowEnv: { ...(flow.env ?? {}) },
      profile: resolveProfile(),
    };

    this.reporter.flowStart(flow);
    const flowStart = Date.now();

    const buildDctx = (nextCmd: MaestroCommand | undefined) => ({
      ctx,
      nextCmd,
      dispatch: (c: MaestroCommand) =>
        this.registry.dispatch(normalizeBareString(c), buildDctx(undefined)),
    });

    // A visibility assert right after a tap, with a fast recovery for the
    // "eaten tap": the tap actuated but its onPress never fired (keyboard
    // reflow moved the button, a gesture-handler button missed, a press
    // dropped). Probe the target with a SHORT budget; if it appears, done (the
    // common path, no penalty — and on that path we capture NO frame hashes at
    // all). Only if it misses do we sample the frame hash twice ~120ms apart: if
    // the screen hasn't changed between the two samples, the tap was eaten —
    // re-fire it once, then assert the full budget. If the screen IS changing,
    // it's a legit slow transition:
    // assert the full budget WITHOUT re-firing (re-firing a tap that worked
    // would double-act — over-count a counter, double-navigate). Caps the
    // eaten-tap stall at ~1.5s instead of the full assert timeout the outer
    // catch's re-fire used to pay, with the frame-quiet gate keeping
    // non-idempotent taps safe.
    const dispatchAssertAfterTap = async (
      cmd: MaestroCommand,
      nextCmd: MaestroCommand | undefined,
      lastTapCmd: MaestroCommand,
      stepIdx: number,
    ): Promise<void> => {
      const probe = withProbeTimeout(cmd, EATEN_TAP_PROBE_MS);
      if (!probe) {
        await this.registry.dispatch(cmd, buildDctx(nextCmd));
        return;
      }
      try {
        await this.registry.dispatch(probe, buildDctx(nextCmd));
        return; // target appeared within the probe — fast path, ZERO hash round-trips
      } catch (e) {
        if (!FIND_MISS_RE.test(e instanceof Error ? e.message : String(e))) throw e;
      }
      // MISS path only — the common fast path above pays NO round-trips; this
      // is the sole place hashes are captured. Decide whether the tap was
      // EATEN (re-fire) or merely SLOW (wait) from TWO independent signals:
      //
      //   1. Frame STILL — sample the hash twice ~120ms apart. h1===h2 means
      //      scroll/nav momentum has stopped. We sample AFTER the probe (not
      //      before it) on purpose: a before-probe sample catches the residual
      //      fling from a preceding scrollUntilVisible and misreads an eaten
      //      tap as "animating" — the bug that let an eaten tap-after-scroll
      //      slip through on slow runners (g-bottomsheet).
      //   2. Target STILL PRESENT — a tap that took effect makes its own
      //      target disappear (navigated away, sheet opened, row dismissed).
      //      So the thing we tapped still sitting on screen proves the tap did
      //      nothing. A point/coordinate tap has no findable target, so this
      //      signal abstains (true) and we fall back to the frame-still gate.
      //
      // Re-fire only when BOTH hold: a frozen screen AND the tapped target
      // still there. That recovers the eaten tap-after-scroll (momentum gone,
      // target still listed) without ever double-acting a tap that already
      // worked (its target is gone → we skip the re-fire), which a still-only
      // gate would do on an instant navigation whose destination renders slow.
      const h1 = await captureHash(ctx).catch(() => '');
      await sleep(120);
      const h2 = await captureHash(ctx).catch(() => '');
      const still = h1 !== '' && h1 === h2;
      const tapTarget = tapSelectorOf(lastTapCmd);
      const targetStillThere = tapTarget ? await isVisible(ctx, tapTarget).catch(() => false) : true;
      if (still && targetStillThere) {
        this.reporter.stepRetry?.(
          stepIdx + 1,
          `re-firing previous tap (${describeCommand(lastTapCmd)})`,
        );
        await this.registry.dispatch(lastTapCmd, buildDctx(cmd));
        await sleep(150);
      }
      // Otherwise the tap either worked (target gone) or is mid-transition
      // (screen animating) — run the full-budget assert WITHOUT re-firing.
      await this.registry.dispatch(cmd, buildDctx(nextCmd));
    };

    // onFlowStart hook — failures abort the flow before the main loop.
    if (flow.onFlowStart) {
      for (const rawHookCmd of flow.onFlowStart) {
        const hookCmd = normalizeBareString(rawHookCmd);
        await this.registry.dispatch(hookCmd, buildDctx(undefined));
      }
    }

    const stepTimings: StepTiming[] = [];
    let stepsPassed = 0;
    let lastTapCmd: MaestroCommand | undefined;
    let failure: FlowResult['failure'];

    for (let i = 0; i < flow.commands.length; i++) {
      const rawCmd = flow.commands[i];
      const rawNext = flow.commands[i + 1];
      // Maestro lets some commands be bare strings: `- hideKeyboard`,
      // `- back`, `- launchApp`. js-yaml parses those as plain
      // strings. Normalise to `{op: true}` so registry matchers using
      // `'op' in cmd` work uniformly.
      // Maestro per-command modifiers (optional / label / when) ride as
      // sibling keys on the command map. Split them off so the bare command
      // reaches the registry and the modifiers are evaluated here, once, for
      // every command — rather than each handler re-implementing them.
      const { command: cmd, modifiers } = extractModifiers(normalizeBareString(rawCmd));
      const stepLabel = modifiers.label ? ` «${modifiers.label}»` : '';
      const nextCmd = rawNext === undefined ? undefined : normalizeBareString(rawNext);
      // Any non-tapOn command breaks the repeat-tap chain — the next
      // tapOn should NOT see the previous tapOn as its "last tap".
      if (typeof cmd !== 'object' || cmd === null || !('tapOn' in cmd)) {
        ctx.lastTapKey = undefined;
      }
      // when: gate — skip the step (counts as passed) if the condition is not
      // satisfied. A skipped step is not a tap, so it can't re-fire below.
      if (modifiers.when && !(await evaluateCondition(ctx, modifiers.when))) {
        this.reporter.stepStart?.(i + 1, cmd);
        stepTimings.push({
          step: i + 1,
          ms: 0,
          cmd: describeCommand(cmd) + stepLabel + ' (skipped: when)',
        });
        this.reporter.stepPass(i + 1, cmd, 0);
        stepsPassed++;
        lastTapCmd = undefined;
        continue;
      }
      const t0 = Date.now();
      this.reporter.stepStart?.(i + 1, cmd);

      try {
        if (lastTapCmd && cmdIsVisibilityAssert(cmd)) {
          await dispatchAssertAfterTap(cmd, nextCmd, lastTapCmd, i);
        } else {
          await this.registry.dispatch(cmd, buildDctx(nextCmd));
        }

        // Handle collapsed double-tap: runCommand can mark the next
        // command consumed (two same-target taps → one doubleTap).
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
            this.reporter.stepPass(i + 2, consumed, 0);
            i++;
          }
        }

        const dt = Date.now() - t0;
        stepTimings.push({ step: i + 1, ms: dt, cmd: describeCommand(cmd) });
        this.reporter.stepPass(i + 1, cmd, dt);
        stepsPassed++;
        lastTapCmd = cmdIsTap(cmd) ? cmd : undefined;
      } catch (err) {
        // optional: a failed step is skipped, not fatal (Maestro). Soft-pass
        // before any retry/fail handling, and don't let it re-fire a prior tap.
        if (modifiers.optional) {
          const dt = Date.now() - t0;
          stepTimings.push({
            step: i + 1,
            ms: dt,
            cmd: describeCommand(cmd) + stepLabel + ' (optional, skipped)',
          });
          this.reporter.stepPass(i + 1, cmd, dt);
          stepsPassed++;
          lastTapCmd = undefined;
          continue;
        }
        // Step-level retry: if a find-failure follows a tapOn, re-fire
        // the previous tap once and retry the current step.
        const msg = err instanceof Error ? err.message : String(err);
        const isFindMiss = /element not found|assertVisible\/waitFor timeout/i.test(msg);
        const isFindableStep = cmdIsFindable(cmd);

        if (lastTapCmd && isFindMiss && isFindableStep) {
          try {
            this.reporter.stepRetry?.(
              i + 1,
              `re-firing previous tap (${describeCommand(lastTapCmd)})`,
            );
            await this.registry.dispatch(lastTapCmd, buildDctx(cmd));
            await sleep(150);
            await this.registry.dispatch(cmd, buildDctx(nextCmd));
            const dt = Date.now() - t0;
            stepTimings.push({ step: i + 1, ms: dt, cmd: describeCommand(cmd) });
            this.reporter.stepPass(i + 1, cmd, dt);
            stepsPassed++;
            lastTapCmd = cmdIsTap(cmd) ? cmd : undefined;
            continue;
          } catch {
            /* fall through to fail */
          }
        }

        const dt = Date.now() - t0;
        stepTimings.push({ step: i + 1, ms: dt, cmd: describeCommand(cmd) });
        // Socket-death errors are symptoms; check whether the app
        // actually crashed under injection and say so (issue #44).
        let reason = msg;
        if (
          /socket not connected|socket closed|socket reconnect failed|socket request timeout/i.test(
            msg,
          )
        ) {
          const diagnosis = diagnoseSocketFailure(ctx.udid, ctx.bundleId, flowStart);
          if (diagnosis) reason = `${msg}\n${diagnosis}`;
        }
        this.reporter.stepFail(i + 1, cmd, new Error(reason), dt);
        failure = {
          step: i + 1,
          command: describeCommand(cmd),
          reason,
          screenshotPath: findLatestScreenshot(flowStart),
        };

        await this.runOnFlowComplete(flow, ctx);
        const result: FlowResult = {
          flow,
          passed: false,
          stepsRun: i + 1,
          stepsPassed,
          durationMs: Date.now() - flowStart,
          failure,
          stepTimings,
        };
        this.reporter.flowEnd(result);
        return result;
      }
    }

    await this.runOnFlowComplete(flow, ctx);
    const result: FlowResult = {
      flow,
      passed: true,
      stepsRun: flow.commands.length,
      stepsPassed,
      durationMs: Date.now() - flowStart,
      stepTimings,
    };
    this.reporter.flowEnd(result);
    return result;
  }

  private async runOnFlowComplete(flow: MaestroFlow, ctx: RunContext): Promise<void> {
    if (!flow.onFlowComplete) return;
    const buildDctx = (nextCmd: MaestroCommand | undefined) => ({
      ctx,
      nextCmd,
      dispatch: (c: MaestroCommand) =>
        this.registry.dispatch(normalizeBareString(c), buildDctx(undefined)),
    });
    for (const rawHookCmd of flow.onFlowComplete) {
      const hookCmd = normalizeBareString(rawHookCmd);
      try {
        await this.registry.dispatch(hookCmd, buildDctx(undefined));
      } catch (e) {
        this.reporter.warn?.(
          `onFlowComplete: ${describeCommand(hookCmd)} failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }
}

function cmdIsTap(cmd: MaestroCommand): boolean {
  return typeof cmd === 'object' && cmd !== null && 'tapOn' in cmd;
}

function cmdIsFindable(cmd: MaestroCommand): boolean {
  return (
    typeof cmd === 'object' &&
    cmd !== null &&
    ('tapOn' in cmd || 'assertVisible' in cmd || 'waitFor' in cmd)
  );
}

// A find-miss error from a visibility wait — the signal the previous tap may
// not have landed. Kept identical to the string the outer catch matches.
const FIND_MISS_RE = /element not found|assertVisible\/waitFor timeout/i;

// Short budget for the eaten-tap probe (see dispatchAssertAfterTap). A real
// onPress lands its target well inside this; overrun means the tap was likely
// eaten or the screen is mid-transition. Tunable for slow runners.
const EATEN_TAP_PROBE_MS = Number(process.env.ENNIO_EATEN_PROBE_MS) || 1200;

function cmdIsVisibilityAssert(cmd: MaestroCommand): boolean {
  return typeof cmd === 'object' && cmd !== null && ('assertVisible' in cmd || 'waitFor' in cmd);
}

// The findable selector of a tapOn, for the eaten-tap "is the target still
// there?" check. Returns null when the tap has no locatable target — a pure
// point/coordinate tap (nothing to re-find) or a malformed command — so the
// caller falls back to the frame-still gate alone.
function tapSelectorOf(cmd: MaestroCommand): MaestroSelector | null {
  if (typeof cmd !== 'object' || cmd === null || !('tapOn' in cmd)) return null;
  const sel = normalizeSelector((cmd as { tapOn: MaestroSelector | string }).tapOn);
  if (!sel.id && !sel.text) return null;
  return sel;
}

// Clone an assertVisible/waitFor with its wait clamped to `ms` for the fast
// probe. Bare-string specs (no object to carry a timeout) return null — those
// fall back to a normal full-budget dispatch.
function withProbeTimeout(cmd: MaestroCommand, ms: number): MaestroCommand | null {
  const key = 'assertVisible' in (cmd as object) ? 'assertVisible' : 'waitFor';
  const spec = (cmd as Record<string, unknown>)[key];
  if (typeof spec !== 'object' || spec === null) return null;
  const cur = (spec as { timeout?: number }).timeout;
  return {
    [key]: { ...(spec as object), timeout: cur ? Math.min(cur, ms) : ms },
  } as unknown as MaestroCommand;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeBareString(cmd: MaestroCommand | string): MaestroCommand {
  if (typeof cmd === 'string') {
    return { [cmd]: true } as unknown as MaestroCommand;
  }
  return cmd;
}

/**
 * Locate the most recently-modified screenshot file in /tmp/ennio-shots/
 * dated after the given start time. Returns null if no shots dir or
 * no matching file. The dylib's assertVisible-timeout diagnostic
 * writes screenshots here via xcrun simctl io screenshot.
 */
function findLatestScreenshot(sinceMs: number): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs');
    const dir = '/tmp/ennio-shots';
    if (!fs.existsSync(dir)) return undefined;
    const entries = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.png'))
      .map((f) => {
        const path = `${dir}/${f}`;
        try {
          return { path, mtime: fs.statSync(path).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((e): e is { path: string; mtime: number } => e !== null)
      .filter((e) => e.mtime >= sinceMs)
      .sort((a, b) => b.mtime - a.mtime);
    return entries[0]?.path;
  } catch {
    return undefined;
  }
}
