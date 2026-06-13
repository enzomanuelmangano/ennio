// Handler registration barrel. New handler files import here so the
// FlowExecutor wiring is a single call.

import type { CommandRegistry } from '../../core/command-registry';

import { registerAssertHandlers } from './assert';
import { registerConformanceHandlers } from './conformance';
import { registerControlFlowHandlers } from './control-flow';
import { registerInputHandlers } from './input';
import { registerLifecycleHandlers } from './lifecycle';
import { registerRandomInputHandlers } from './random-input';
import { registerScrollHandlers } from './scroll';
import { registerSystemHandlers } from './system';
import { registerTapHandlers } from './tap';
import { registerVisualHandlers } from './visual';

export function registerAllHandlers(registry: CommandRegistry): void {
  registerSystemHandlers(registry);
  registerRandomInputHandlers(registry);
  registerAssertHandlers(registry);
  registerLifecycleHandlers(registry);
  registerControlFlowHandlers(registry);
  registerTapHandlers(registry);
  registerInputHandlers(registry);
  registerScrollHandlers(registry);
  registerVisualHandlers(registry);
  registerConformanceHandlers(registry);
}
