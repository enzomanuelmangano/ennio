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
import type { MaestroCommand, MaestroFlow } from '../maestro-parser';
import type { RunContext } from '../runner/context';
import { describeCommand } from '../runner/index';

import { CommandRegistry } from './command-registry';
import type { EnnioConnection } from './ennio-connection';
import type { FlowResult, Reporter } from '../reporters';
import type { SimulatorSession } from './simulator-session';

export interface FlowExecutorOptions {
  session: SimulatorSession;
  connection: EnnioConnection;
  reporter: Reporter;
  registry?: CommandRegistry;
  verbose?: boolean;
  lenient?: boolean;
}

interface StepTiming {
  step: number;
  ms: number;
  cmd: string;
}

export class FlowExecutor {
  private session: SimulatorSession;
  private connection: EnnioConnection;
  private reporter: Reporter;
  private registry: CommandRegistry;
  private verbose: boolean;
  private lenient: boolean;

  constructor(opts: FlowExecutorOptions) {
    this.session = opts.session;
    this.connection = opts.connection;
    this.reporter = opts.reporter;
    this.verbose = opts.verbose ?? false;
    this.lenient = opts.lenient ?? false;
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
      flowPath: flow.filePath,
      outputs: {},
    };

    this.reporter.flowStart(flow);
    const flowStart = Date.now();

    const buildDctx = (nextCmd: MaestroCommand | undefined) => ({
      ctx,
      nextCmd,
      dispatch: (c: MaestroCommand) =>
        this.registry.dispatch(normalizeBareString(c), buildDctx(undefined)),
    });

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
      const cmd = normalizeBareString(rawCmd);
      const nextCmd = rawNext === undefined ? undefined : normalizeBareString(rawNext);
      // Any non-tapOn command breaks the repeat-tap chain — the next
      // tapOn should NOT see the previous tapOn as its "last tap".
      if (typeof cmd !== 'object' || cmd === null || !('tapOn' in cmd)) {
        ctx.lastTapKey = undefined;
      }
      const t0 = Date.now();

      try {
        await this.registry.dispatch(cmd, buildDctx(nextCmd));

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
        if (/socket not connected|socket closed|socket reconnect failed|socket request timeout/i.test(msg)) {
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
