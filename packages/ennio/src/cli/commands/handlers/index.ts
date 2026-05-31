// Handler registration barrel. New handler files import here so the
// FlowExecutor wiring is a single call.

import type { CommandRegistry } from '../../core/command-registry';

import { registerAssertHandlers } from './assert';
import { registerControlFlowHandlers } from './control-flow';
import { registerLifecycleHandlers } from './lifecycle';
import { registerRandomInputHandlers } from './random-input';
import { registerSystemHandlers } from './system';

export function registerAllHandlers(registry: CommandRegistry): void {
  registerSystemHandlers(registry);
  registerRandomInputHandlers(registry);
  registerAssertHandlers(registry);
  registerLifecycleHandlers(registry);
  registerControlFlowHandlers(registry);
  // Future handler groups (tap, input, scroll) register themselves
  // here as they migrate out of runner/index.ts.
}
