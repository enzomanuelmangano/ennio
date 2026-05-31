// Handler registration barrel. New handler files import here so the
// FlowExecutor wiring is a single call.

import type { CommandRegistry } from '../../core/command-registry';

import { registerAssertHandlers } from './assert';
import { registerControlFlowHandlers } from './control-flow';
import { registerInputHandlers } from './input';
import { registerLifecycleHandlers } from './lifecycle';
import { registerRandomInputHandlers } from './random-input';
import { registerSystemHandlers } from './system';
import { registerTapHandlers } from './tap';

export function registerAllHandlers(registry: CommandRegistry): void {
  registerSystemHandlers(registry);
  registerRandomInputHandlers(registry);
  registerAssertHandlers(registry);
  registerLifecycleHandlers(registry);
  registerControlFlowHandlers(registry);
  registerTapHandlers(registry);
  registerInputHandlers(registry);
  // Future handler groups (scroll) register themselves here as they
  // migrate out of runner/index.ts.
}
