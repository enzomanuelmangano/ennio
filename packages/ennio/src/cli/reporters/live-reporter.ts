// Live, animated TTY reporter. Finished flows scroll up as permanent ✔/✖
// lines; the live region at the bottom shows the suite progress bar and the
// current flow's in-flight step (spinner + running timer). A drop-in Reporter
// — selected by pickReporter only when stdout is an interactive TTY.

import type { MaestroCommand, MaestroFlow } from '../maestro-parser';
import {
  SPINNER,
  bold,
  cyan,
  dim,
  fmtMs,
  green,
  hyperlink,
  red,
  truncate,
  yellow,
} from '../ui/ansi';
import { LiveRegion, type OutputStream } from '../ui/live-region';
import { currentVersion } from '../update-check';

import type { FlowResult, Reporter, SuiteResult } from './reporter';
import { RunModel, type FlowRow } from './run-model';

const SPIN_MS = 80;
const BAR_WIDTH = 20;

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
    this.region.printAbove(['', `  ${bold('🧪 ennio')} ${dim(currentVersion())}`, '']);
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
    this.model.endFlow(
      result.passed,
      result.durationMs,
      result.failure && {
        step: result.failure.step,
        reason: result.failure.reason,
        screenshotPath: result.failure.screenshotPath,
      },
    );
    this.region.printAbove(this.flowLines(result));
    this.draw();
  }

  suiteEnd(result: SuiteResult): void {
    if (this.spin) {
      clearInterval(this.spin);
      this.spin = null;
    }
    this.region.stop(this.suiteLines(result));
  }

  // ── rendering ───────────────────────────────────────────────────────

  private cols(): number {
    return Math.max(40, process.stdout.columns ?? 80);
  }

  private draw(): void {
    this.region.render(this.liveFrame());
  }

  private liveFrame(): string[] {
    const lines = [this.progressLine()];
    const f = this.model.current;
    if (f && !f.result) {
      lines.push(`  ${cyan('▸')} ${bold(f.name)}`);
      for (const s of f.steps.slice(-2)) {
        const icon = s.ok ? green('✓') : red('✗');
        lines.push(
          `      ${icon} ${dim(String(s.step).padStart(3))}  ${dim(truncate(s.text, this.cols() - 14))}`,
        );
      }
      if (f.active) {
        const spinner = cyan(SPINNER[this.tick % SPINNER.length]);
        const elapsed = dim(fmtMs(this.now() - f.active.startedAt));
        const text = truncate(f.active.text, this.cols() - 22);
        lines.push(
          `      ${spinner} ${dim(String(f.active.step).padStart(3))}  ${text}  ${elapsed}`,
        );
      }
    }
    return lines;
  }

  private progressLine(): string {
    const done = this.model.finished;
    const total = Math.max(this.model.total, 1);
    const filled = Math.round((done / total) * BAR_WIDTH);
    const bar = green('█'.repeat(filled)) + dim('░'.repeat(BAR_WIDTH - filled));
    const elapsed = dim(fmtMs(this.now() - this.model.startedAt));
    return `  ${dim('Suite')}  ${bar}  ${done}/${this.model.total} flows · ${elapsed}`;
  }

  private flowLines(result: FlowResult): string[] {
    const f = this.model.current as FlowRow;
    if (result.passed) {
      return [
        `  ${green('✔')} ${f.name.padEnd(22)} ${dim(`${result.stepsRun} steps`)}  ${dim(fmtMs(result.durationMs))}`,
      ];
    }
    const fail = result.failure!;
    const out = [
      `  ${red('✖')} ${f.name.padEnd(22)} ${dim(`step ${fail.step}/${result.stepsRun}`)}  ${dim(fmtMs(result.durationMs))}`,
      `      ${red(fail.command)}`,
      `      ${dim(fail.reason)}`,
    ];
    if (fail.screenshotPath) out.push(`      📷 ${hyperlink(fail.screenshotPath)}`);
    return out;
  }

  private suiteLines(result: SuiteResult): string[] {
    const word = result.totalFlows === 1 ? 'flow' : 'flows';
    const head = result.passed
      ? green(`  ✔ ${result.flowsPassed} passed`)
      : red(`  ✖ ${result.flowsFailed} failed`) + dim(` · ${result.flowsPassed} passed`);
    return [
      '',
      `${head}${dim(` · ${result.totalFlows} ${word} · ${fmtMs(result.durationMs)}`)}`,
      '',
    ];
  }
}
