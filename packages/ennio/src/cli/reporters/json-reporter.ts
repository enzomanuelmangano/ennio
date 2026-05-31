// JSON reporter — machine-readable output for CI integrations.
// Streams events as JSON Lines (one event per line) so consumers can
// pipe directly without waiting for suite completion.

import type { MaestroCommand, MaestroFlow } from '../maestro-parser';

import type { FlowResult, Reporter, SuiteResult } from './reporter';

interface JsonEvent {
  kind: string;
  timestamp: number;
  [key: string]: unknown;
}

export class JsonReporter implements Reporter {
  private emit(event: JsonEvent): void {
    process.stdout.write(JSON.stringify(event) + '\n');
  }

  suiteStart(flows: MaestroFlow[]): void {
    this.emit({
      kind: 'suiteStart',
      timestamp: Date.now(),
      flowCount: flows.length,
      flows: flows.map((f) => f.filePath ?? f.name ?? 'unknown'),
    });
  }

  flowStart(flow: MaestroFlow): void {
    this.emit({
      kind: 'flowStart',
      timestamp: Date.now(),
      file: flow.filePath ?? null,
      name: flow.name ?? null,
      stepCount: flow.commands.length,
    });
  }

  stepPass(step: number, cmd: MaestroCommand, durationMs: number): void {
    this.emit({
      kind: 'stepPass',
      timestamp: Date.now(),
      step,
      command: Object.keys(cmd)[0],
      args: (cmd as Record<string, unknown>)[Object.keys(cmd)[0]],
      durationMs,
    });
  }

  stepFail(step: number, cmd: MaestroCommand, error: Error, durationMs: number): void {
    this.emit({
      kind: 'stepFail',
      timestamp: Date.now(),
      step,
      command: Object.keys(cmd)[0],
      args: (cmd as Record<string, unknown>)[Object.keys(cmd)[0]],
      durationMs,
      error: error.message,
    });
  }

  stepRetry(step: number, info: string): void {
    this.emit({ kind: 'stepRetry', timestamp: Date.now(), step, info });
  }

  warn(message: string): void {
    this.emit({ kind: 'warn', timestamp: Date.now(), message });
  }

  flowEnd(result: FlowResult): void {
    this.emit({
      kind: 'flowEnd',
      timestamp: Date.now(),
      file: result.flow.filePath ?? null,
      passed: result.passed,
      stepsRun: result.stepsRun,
      stepsPassed: result.stepsPassed,
      durationMs: result.durationMs,
      failure: result.failure ?? null,
    });
  }

  suiteEnd(result: SuiteResult): void {
    this.emit({
      kind: 'suiteEnd',
      timestamp: Date.now(),
      passed: result.passed,
      totalFlows: result.totalFlows,
      flowsPassed: result.flowsPassed,
      flowsFailed: result.flowsFailed,
      durationMs: result.durationMs,
    });
  }
}
