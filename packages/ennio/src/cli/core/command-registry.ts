// Command dispatch via a registry instead of a 400-line switch.
//
// Each handler registers a matcher predicate + handler function. The
// registry tries matchers in registration order; first match wins.
// Unknown commands hit the registry's default policy (throw or warn).
//
// This is the seam that lets new commands live in their own files
// (commands/handlers/<group>.ts) instead of piling onto runner/index.ts.

import type { MaestroCommand } from '../maestro-parser';
import type { RunContext } from '../runner/context';

export type CommandMatcher<T extends MaestroCommand = MaestroCommand> = (
  cmd: MaestroCommand,
) => cmd is T;

export interface DispatchContext {
  ctx: RunContext;
  nextCmd: MaestroCommand | undefined;
  /**
   * Re-enter dispatch. Handlers use this to chain commands —
   * e.g. inputRandomText composes a string then dispatches inputText.
   * Bound to the same registry that called the handler.
   */
  dispatch: (cmd: MaestroCommand) => Promise<void>;
}

export type CommandHandler<T extends MaestroCommand = MaestroCommand> = (
  cmd: T,
  dctx: DispatchContext,
) => Promise<void>;

interface Entry {
  matcher: CommandMatcher;
  handler: CommandHandler;
}

export interface CommandRegistryOptions {
  /** Called when no handler matches. Default: throws. */
  onUnknown?: (cmd: MaestroCommand, dctx: DispatchContext) => Promise<void>;
}

export class CommandRegistry {
  private entries: Entry[] = [];

  constructor(private opts: CommandRegistryOptions = {}) {}

  register<T extends MaestroCommand>(matcher: CommandMatcher<T>, handler: CommandHandler<T>): this {
    this.entries.push({
      matcher: matcher as CommandMatcher,
      handler: handler as CommandHandler,
    });
    return this;
  }

  async dispatch(cmd: MaestroCommand, dctx: DispatchContext): Promise<void> {
    for (const e of this.entries) {
      if (e.matcher(cmd)) {
        return e.handler(cmd, dctx);
      }
    }
    if (this.opts.onUnknown) {
      return this.opts.onUnknown(cmd, dctx);
    }
    const key = Object.keys(cmd)[0] ?? '<empty>';
    throw new Error(`unsupported command: ${key}`);
  }

  size(): number {
    return this.entries.length;
  }
}
