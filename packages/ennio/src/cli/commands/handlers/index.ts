// Handler registration barrel. New handler files import here so the
// FlowExecutor wiring is a single call.

import type { CommandRegistry } from '../../core/command-registry';

import { registerRandomInputHandlers } from './random-input';
import { registerSystemHandlers } from './system';

export function registerAllHandlers(registry: CommandRegistry): void {
  registerSystemHandlers(registry);
  registerRandomInputHandlers(registry);
  // Future handler groups (tap, input, assert, scroll, lifecycle)
  // register themselves here as they migrate out of runner/index.ts.
}
