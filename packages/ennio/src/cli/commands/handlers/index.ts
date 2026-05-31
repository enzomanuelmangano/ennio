// Handler registration barrel. New handler files import here so the
// FlowExecutor wiring is a single call.

import type { CommandRegistry } from '../../core/command-registry';

import { registerAssertHandlers } from './assert';
import { registerRandomInputHandlers } from './random-input';
import { registerSystemHandlers } from './system';

export function registerAllHandlers(registry: CommandRegistry): void {
  registerSystemHandlers(registry);
  registerRandomInputHandlers(registry);
  registerAssertHandlers(registry);
  // Future handler groups (tap, input, scroll, lifecycle)
  // register themselves here as they migrate out of runner/index.ts.
}
