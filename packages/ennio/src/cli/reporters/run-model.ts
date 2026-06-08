// Pure state for the live run view. No I/O, no timers — the reporter feeds it
// events (with timestamps) and the renderer projects it to lines. Kept separate
// so both are trivially unit-testable.

import type { MaestroCommand, MaestroFlow } from '../maestro-parser';

import { formatCommand } from './format';

export interface StepRow {
  step: number;
  text: string;
  ms: number;
  ok: boolean;
}

export interface ActiveStep {
  step: number;
  text: string;
  startedAt: number;
}

export interface FlowFailure {
  step: number;
  reason: string;
  screenshotPath?: string;
}

export interface FlowRow {
  name: string;
  index: number; // 1-based
  steps: StepRow[];
  active: ActiveStep | null;
  result: { passed: boolean; durationMs: number; failure?: FlowFailure } | null;
}

export class RunModel {
  total = 0;
  startedAt = 0;
  readonly flows: FlowRow[] = [];

  get current(): FlowRow | undefined {
    return this.flows[this.flows.length - 1];
  }

  get finished(): number {
    return this.flows.filter((f) => f.result).length;
  }
  get passed(): number {
    return this.flows.filter((f) => f.result?.passed).length;
  }
  get failed(): number {
    return this.flows.filter((f) => f.result && !f.result.passed).length;
  }

  startSuite(total: number, now: number): void {
    this.total = total;
    this.startedAt = now;
  }

  startFlow(flow: MaestroFlow): void {
    const name = flow.filePath ? (flow.filePath.split('/').pop() as string) : (flow.name ?? 'flow');
    this.flows.push({ name, index: this.flows.length + 1, steps: [], active: null, result: null });
  }

  startStep(step: number, cmd: MaestroCommand, now: number): void {
    const f = this.current;
    if (f) f.active = { step, text: formatCommand(cmd), startedAt: now };
  }

  finishStep(step: number, cmd: MaestroCommand, ms: number, ok: boolean): void {
    const f = this.current;
    if (!f) return;
    f.active = null;
    f.steps.push({ step, text: formatCommand(cmd), ms, ok });
  }

  endFlow(passed: boolean, durationMs: number, failure?: FlowFailure): void {
    const f = this.current;
    if (!f) return;
    f.active = null;
    f.result = { passed, durationMs, failure };
  }
}
