// Live, animated TTY reporter. Finished flows scroll up as permanent ✔/✖
// lines; the bottom region shows the suite progress bar and the current flow's
// in-flight step (spinner + running timer). Thin glue: state lives in RunModel,
// drawing in live-view (both pure), terminal mechanics in LiveRegion. Selected
// by pickReporter only when stdout is an interactive TTY.

import type { MaestroCommand, MaestroFlow } from '../maestro-parser';
import { dim, yellow } from '../ui/ansi';
import { LiveRegion, type OutputStream } from '../ui/live-region';
import { currentVersion } from '../update-check';

import { flowResultLines, headerLines, renderFrame, suiteLines } from './live-view';
import type { FlowResult, Reporter, SuiteResult } from './reporter';
import { RunModel } from './run-model';

const SPIN_MS = 80;

export class LiveReporter implements Reporter {
  private readonly model = new RunModel();
  private readonly region: LiveRegion;
  private tick = 0;
  private spin: ReturnType<typeof setInterval> | null = null;

  constructor(
    out: OutputStream = process.stdout,
    private readonly now: () => number = Date.now,
  ) {
    this.region = new LiveRegion(out);
  }

  suiteStart(flows: MaestroFlow[]): void {
    this.model.startSuite(flows.length, this.now());
    this.region.printAbove(headerLines(currentVersion()));
    this.spin = setInterval(() => {
      this.tick++;
      this.draw();
    }, SPIN_MS);
    this.spin.unref?.();
    this.draw();
  }

  flowStart(flow: MaestroFlow): void {
    this.model.startFlow(flow);
    this.draw();
  }

  stepStart(step: number, cmd: MaestroCommand): void {
    this.model.startStep(step, cmd, this.now());
    this.draw();
  }

  stepPass(step: number, cmd: MaestroCommand, ms: number): void {
    this.model.finishStep(step, cmd, ms, true);
    this.draw();
  }

  stepFail(step: number, cmd: MaestroCommand, _err: Error, ms: number): void {
    this.model.finishStep(step, cmd, ms, false);
    this.draw();
  }

  stepRetry(_step: number, info: string): void {
    this.region.printAbove([dim(`      ↻ ${info}`)]);
  }

  warn(message: string): void {
    this.region.printAbove([yellow(`  ⚠ ${message}`)]);
  }

  flowEnd(result: FlowResult): void {
    const name = this.model.current?.name ?? 'flow';
    this.model.endFlow(result.passed, result.durationMs, result.failure);
    this.region.printAbove(flowResultLines(name, result));
    this.draw();
  }

  suiteEnd(result: SuiteResult): void {
    if (this.spin) {
      clearInterval(this.spin);
      this.spin = null;
    }
    this.region.stop(suiteLines(result));
  }

  private draw(): void {
    const cols = Math.max(40, process.stdout.columns ?? 80);
    this.region.render(renderFrame(this.model, { tick: this.tick, cols, now: this.now() }));
  }
}
