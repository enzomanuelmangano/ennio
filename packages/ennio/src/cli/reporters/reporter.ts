// Pluggable reporter interface. Every CLI output event flows through
// here so the formatter is swappable (TTY pretty, JSON for CI, JUnit
// for test infra). Implementations are stateless from the runner's
// perspective — they decide whether to buffer / write immediately.

import type { MaestroCommand, MaestroFlow } from '../maestro-parser';

export interface FlowResult {
  flow: MaestroFlow;
  passed: boolean;
  stepsRun: number;
  stepsPassed: number;
  durationMs: number;
  failure?: {
    step: number;
    command: string;
    reason: string;
  };
  stepTimings: { step: number; ms: number; cmd: string }[];
}

export interface SuiteResult {
  passed: boolean;
  totalFlows: number;
  flowsPassed: number;
  flowsFailed: number;
  durationMs: number;
  flows: FlowResult[];
}

export interface Reporter {
  /** Called once when the suite starts. */
  suiteStart(flows: MaestroFlow[]): void;

  /** Called when a single flow starts. */
  flowStart(flow: MaestroFlow): void;

  /** Called when a step completes successfully. */
  stepPass(step: number, cmd: MaestroCommand, durationMs: number): void;

  /** Called when a step fails. */
  stepFail(step: number, cmd: MaestroCommand, error: Error, durationMs: number): void;

  /** Called when a retry happens (re-firing previous tap before retry). */
  stepRetry?(step: number, info: string): void;

  /** Warning emitted during a step (e.g. lenient mode unknown command). */
  warn?(message: string): void;

  /** Called when the flow finishes. */
  flowEnd(result: FlowResult): void;

  /** Called once when the suite finishes. */
  suiteEnd(result: SuiteResult): void;
}
