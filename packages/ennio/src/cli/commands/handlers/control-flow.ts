// Control-flow handlers: repeat / retry / runFlow / runScript.
// All re-enter dispatch via dctx.dispatch — they're composers, not
// leaf operations.

import { dirname, resolve } from 'node:path';

import { CommandRegistry } from '../../core/command-registry';
import type { MaestroCommand, MaestroCondition } from '../../maestro-parser';
import { parseMaestroFile } from '../../maestro-parser';
import { evaluateCondition } from '../../runner/conditions';
import { interpolate, type RunContext } from '../../runner/context';
import { describeCommand, runMaestroScript } from '../../runner/index';

/** Belt-and-braces cap so a `repeat.while` whose condition never flips false
 *  can't spin forever (a flow bug should fail loudly, not hang CI). */
const REPEAT_WHILE_MAX_ITERATIONS = 1000;

interface RepeatCmd {
  repeat: { times?: number; while?: MaestroCondition; commands: MaestroCommand[] };
}
interface RetryCmd {
  retry: { maxRetries?: number; commands: MaestroCommand[] };
}
interface RunFlowCmd {
  runFlow:
    | string
    | {
        when?: MaestroCondition;
        commands?: MaestroCommand[];
        file?: string;
        env?: Record<string, string>;
      };
}
interface RunScriptCmd {
  runScript: string | { file: string; env?: Record<string, string> };
}

function has<T extends string>(
  cmd: MaestroCommand,
  key: T,
): cmd is MaestroCommand & Record<T, unknown> {
  return typeof cmd === 'object' && cmd !== null && key in cmd;
}

export function registerControlFlowHandlers(registry: CommandRegistry): void {
  registry.register(
    (c): c is MaestroCommand & RepeatCmd => has(c, 'repeat'),
    async (cmd, { ctx, dispatch }) => {
      const { times, while: whileCond, commands } = cmd.repeat;
      const runOnce = async () => {
        for (const sub of commands) await dispatch(sub);
      };
      // Maestro: `while` and `times` can combine — loop while the condition
      // holds, but never more than `times` iterations when both are given.
      if (whileCond) {
        for (let iter = 0; iter < REPEAT_WHILE_MAX_ITERATIONS; iter++) {
          if (times != null && iter >= times) break;
          if (!(await evaluateCondition(ctx, whileCond))) break;
          await runOnce();
        }
        return;
      }
      const n = times ?? 0;
      for (let t = 0; t < n; t++) await runOnce();
    },
  );

  registry.register(
    (c): c is MaestroCommand & RetryCmd => has(c, 'retry'),
    async (cmd, { dispatch }) => {
      const maxRetries = cmd.retry.maxRetries ?? 3;
      let lastErr: unknown;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          for (const sub of cmd.retry.commands) {
            await dispatch(sub);
          }
          return;
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    },
  );

  registry.register(
    (c): c is MaestroCommand & RunFlowCmd => has(c, 'runFlow'),
    async (cmd, { ctx, dispatch }) => {
      // Maestro shorthand: `runFlow: path.yaml` (bare string) ==
      // `runFlow: { file: path.yaml }`. Without this the string fell
      // through every branch below and silently ran nothing.
      const sub = typeof cmd.runFlow === 'string' ? { file: cmd.runFlow } : cmd.runFlow;
      // `when:` predicate — skip the subflow if not satisfied. Same evaluator
      // as per-command `when` and `repeat.while`, so semantics never diverge.
      if (sub.when && !(await evaluateCondition(ctx, sub.when))) return;
      // Resolve call-site values against the parent before entering the child
      // scope. This stays lazy: nested commands are untouched until dispatch.
      const callEnv = Object.fromEntries(
        Object.entries(sub.env ?? {}).map(([key, value]) => [key, interpolate(String(value), ctx)]),
      );
      // Inline commands form.
      if (sub.commands && Array.isArray(sub.commands)) {
        const prevEnv = ctx.flowEnv;
        ctx.flowEnv = { ...prevEnv, ...callEnv };
        try {
          for (const c of sub.commands) await dispatch(c);
        } finally {
          ctx.flowEnv = prevEnv;
        }
        return;
      }
      // File form — parse + run, restore flowPath and flowEnv after.
      if (sub.file) {
        const subPath = resolve(dirname(ctx.flowPath), interpolate(sub.file, ctx));
        const subFlow = parseMaestroFile(subPath);
        const prevPath = ctx.flowPath;
        const prevEnv = ctx.flowEnv;
        // A subflow's own defaults may also reference parent values. Resolve
        // those before swapping ctx.flowEnv so they cannot self-reference.
        const subFlowEnv = Object.fromEntries(
          Object.entries(subFlow.env ?? {}).map(([key, value]) => [
            key,
            interpolate(String(value), ctx),
          ]),
        );
        ctx.flowPath = subPath;
        // The subflow's `${VAR}` interpolation resolves against flowEnv first
        // (context.ts). Layer it lowest→highest: the parent's env, then the
        // subflow's own `env:` defaults, then the per-call `runFlow.env`
        // overrides — so `runFlow: { file: launch.yml, env: { LINK } }` makes
        // `${LINK}` resolve inside launch.yml instead of falling back to an
        // empty process.env value.
        ctx.flowEnv = { ...prevEnv, ...subFlowEnv, ...callEnv };
        const trace = !!process.env.ENNIO_PHASE_TRACE;
        try {
          for (let i = 0; i < subFlow.commands.length; i++) {
            const t = Date.now();
            await dispatch(subFlow.commands[i]);
            if (trace) {
              process.stderr.write(
                `[sub] ${sub.file} #${i + 1} ${Date.now() - t}ms ${describeCommand(subFlow.commands[i])}\n`,
              );
            }
          }
        } finally {
          ctx.flowPath = prevPath;
          ctx.flowEnv = prevEnv;
        }
      }
    },
  );

  registry.register(
    (c): c is MaestroCommand & RunScriptCmd => has(c, 'runScript'),
    async (cmd, { ctx }) => {
      // Maestro shorthand: `runScript: file.js` == `{ file: file.js }`.
      const script = typeof cmd.runScript === 'string' ? { file: cmd.runScript } : cmd.runScript;
      if (!script.file) throw new Error('runScript: missing file path');
      await runMaestroScript(ctx as RunContext, script);
    },
  );
}
