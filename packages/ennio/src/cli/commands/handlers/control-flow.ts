// Control-flow handlers: repeat / retry / runFlow / runScript.
// All re-enter dispatch via dctx.dispatch — they're composers, not
// leaf operations.

import { dirname, resolve } from 'node:path';

import { CommandRegistry } from '../../core/command-registry';
import type { MaestroCommand } from '../../maestro-parser';
import { normalizeSelector, parseMaestroFile } from '../../maestro-parser';
import type { RunContext } from '../../runner/context';
import { describeCommand, runMaestroScript } from '../../runner/index';
import { isVisible } from '../../runner/visibility';

interface RepeatCmd {
  repeat: { times: number; commands: MaestroCommand[] };
}
interface RetryCmd {
  retry: { maxRetries?: number; commands: MaestroCommand[] };
}
interface RunFlowCmd {
  runFlow:
    | string
    | {
        when?: { visible?: unknown; notVisible?: unknown; platform?: string };
        commands?: MaestroCommand[];
        file?: string;
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
    async (cmd, { dispatch }) => {
      for (let t = 0; t < cmd.repeat.times; t++) {
        for (const sub of cmd.repeat.commands) {
          await dispatch(sub);
        }
      }
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
      // `when:` predicate — skip subflow if not satisfied.
      if (sub.when) {
        let satisfied = true;
        if (sub.when.platform) {
          // iOS-only runner; iOS branch always runs, others skip.
          satisfied = String(sub.when.platform).toLowerCase() === 'ios';
        }
        if (satisfied && sub.when.visible) {
          satisfied = await isVisible(ctx, normalizeSelector(sub.when.visible as never));
        } else if (satisfied && sub.when.notVisible) {
          satisfied = !(await isVisible(ctx, normalizeSelector(sub.when.notVisible as never)));
        }
        if (!satisfied) return;
      }
      // Inline commands form.
      if (sub.commands && Array.isArray(sub.commands)) {
        for (const c of sub.commands) await dispatch(c);
        return;
      }
      // File form — parse + run, restore flowPath after.
      if (sub.file) {
        const subPath = resolve(dirname(ctx.flowPath), sub.file);
        const subFlow = parseMaestroFile(subPath);
        const prevPath = ctx.flowPath;
        ctx.flowPath = subPath;
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
        }
      }
    },
  );

  registry.register(
    (c): c is MaestroCommand & RunScriptCmd => has(c, 'runScript'),
    async (cmd, { ctx }) => {
      // Maestro shorthand: `runScript: file.js` == `{ file: file.js }`.
      const script = typeof cmd.runScript === 'string' ? { file: cmd.runScript } : cmd.runScript;
      await runMaestroScript(ctx as RunContext, script);
    },
  );
}
