// Core OOP barrel. Public surface for callers (CLI entry, future
// programmatic API users).

export { CommandRegistry } from './command-registry';
export type { CommandHandler, CommandMatcher, DispatchContext } from './command-registry';
export { EnnioConnection } from './ennio-connection';
export type { EnnioConnectionOptions } from './ennio-connection';
export { EnnioRunner } from './ennio-runner';
export type { EnnioRunnerOptions } from './ennio-runner';
export { FlowExecutor } from './flow-executor';
export type { FlowExecutorOptions } from './flow-executor';
export { SimulatorSession } from './simulator-session';
export type { SimulatorSessionOptions } from './simulator-session';
