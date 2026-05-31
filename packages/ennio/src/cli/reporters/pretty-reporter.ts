// Human-friendly TTY reporter. Colored output when stdout is a TTY,
// plain otherwise. Mirrors the current default output style so the
// migration is invisible to existing users.

import type { MaestroCommand, MaestroFlow } from '../maestro-parser';

import type { FlowResult, Reporter, SuiteResult } from './reporter';

const isTty = process.stdout.isTTY === true && !process.env.NO_COLOR;

function color(code: string, s: string): string {
  return isTty ? `[${code}m${s}[0m` : s;
}

/**
 * OSC 8 hyperlink. Supported by iTerm2, VSCode terminal, kitty,
 * WezTerm. Other terminals render as plain text (graceful fallback).
 */
function hyperlink(target: string, label?: string): string {
  if (!isTty) return target;
  const url = target.startsWith('/') ? `file://${target}` : target;
  const text = label ?? target;
  return `]8;;${url}\\${text}]8;;\\`;
}

const c = {
  green: (s: string) => color('32', s),
  red: (s: string) => color('31', s),
  yellow: (s: string) => color('33', s),
  dim: (s: string) => color('2', s),
  bold: (s: string) => color('1', s),
  cyan: (s: string) => color('36', s),
};

/**
 * Smart time formatter. <1s → `42ms`, <60s → `5.2s`, otherwise `2.5m`.
 */
function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

/**
 * Readable command description — strip JSON.stringify noise.
 *   tapOn: {"id":"foo"}              → tapOn id:foo
 *   assertVisible: {"text":"Welcome"}→ assertVisible text:"Welcome"
 *   scrollUntilVisible: {...}        → scrollUntilVisible id:foo ↓
 */
function describe(cmd: MaestroCommand): string {
  const key = Object.keys(cmd)[0];
  const value = (cmd as Record<string, unknown>)[key];

  if (typeof value === 'string') return `${key} ${JSON.stringify(value)}`;
  if (typeof value === 'boolean') return key;

  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof obj.id === 'string') parts.push(`id:${obj.id}`);
    if (typeof obj.text === 'string') parts.push(`text:${JSON.stringify(obj.text)}`);
    if (obj.element && typeof obj.element === 'object') {
      const el = obj.element as Record<string, unknown>;
      if (typeof el.id === 'string') parts.push(`id:${el.id}`);
      if (typeof el.text === 'string') parts.push(`text:${JSON.stringify(el.text)}`);
    }
    if (obj.direction === 'DOWN') parts.push('↓');
    if (obj.direction === 'UP') parts.push('↑');
    if (obj.clearState === true) parts.push('{clearState}');
    if (parts.length === 0) return `${key} ${JSON.stringify(value)}`;
    return `${key} ${parts.join(' ')}`;
  }
  return key;
}

export interface PrettyReporterOptions {
  /** Print every step inline. Default false (only summary + slow steps). */
  verbose?: boolean;
}

export class PrettyReporter implements Reporter {
  private flowStepTimings: { step: number; ms: number; cmd: string }[] = [];
  private flowStart_!: number;
  private suiteStart_!: number;
  private totalFlows = 0;
  private currentFlowIndex = 0;

  constructor(private opts: PrettyReporterOptions = {}) {}

  suiteStart(flows: MaestroFlow[]): void {
    this.suiteStart_ = Date.now();
    this.totalFlows = flows.length;
    this.currentFlowIndex = 0;
    process.stdout.write(`\n${c.bold('🧪 Ennio')}\n\n`);
  }

  flowStart(flow: MaestroFlow): void {
    this.flowStart_ = Date.now();
    this.flowStepTimings = [];
    this.currentFlowIndex++;
    const file = flow.filePath ? flow.filePath.split('/').pop() : flow.name;
    const progress =
      this.totalFlows > 1 ? c.dim(`[${this.currentFlowIndex}/${this.totalFlows}] `) : '';
    process.stdout.write(`${progress}${c.cyan('▸')} ${c.bold(file ?? 'unknown')}\n`);
    if (this.opts.verbose && flow.name) {
      process.stderr.write(c.dim(`   ${flow.name} (${flow.commands.length} steps)\n`));
    }
  }

  stepPass(step: number, cmd: MaestroCommand, ms: number): void {
    this.flowStepTimings.push({ step, ms, cmd: describe(cmd) });
    if (this.opts.verbose) {
      const stepStr = String(step).padStart(3);
      const msStr = fmtMs(ms).padStart(7);
      process.stderr.write(
        `   ${c.green('✓')} ${c.dim(stepStr)}  ${c.dim(msStr)}  ${describe(cmd)}\n`,
      );
    }
  }

  stepFail(step: number, cmd: MaestroCommand, _err: Error, ms: number): void {
    this.flowStepTimings.push({ step, ms, cmd: describe(cmd) });
    if (this.opts.verbose) {
      const stepStr = String(step).padStart(3);
      const msStr = fmtMs(ms).padStart(7);
      process.stderr.write(
        `   ${c.red('✗')} ${c.dim(stepStr)}  ${c.dim(msStr)}  ${describe(cmd)}\n`,
      );
    }
  }

  stepRetry(_step: number, info: string): void {
    if (this.opts.verbose) {
      process.stderr.write(c.yellow(`   ↻  ${info}\n`));
    }
  }

  warn(message: string): void {
    process.stderr.write(c.yellow(`   ⚠ ${message}\n`));
  }

  flowEnd(result: FlowResult): void {
    const total = result.stepTimings.reduce((s, t) => s + t.ms, 0);
    const avg = total / Math.max(result.stepTimings.length, 1);
    const outliers = result.stepTimings.filter((t) => t.ms >= Math.max(avg * 3, 1500));

    process.stderr.write(
      c.dim(`   total ${fmtMs(total)} across ${result.stepTimings.length} steps\n`),
    );
    for (const o of outliers) {
      process.stderr.write(
        c.yellow(
          `   ⚠ slow  step ${String(o.step).padStart(2)}  ${fmtMs(o.ms).padStart(7)}  ${o.cmd}\n`,
        ),
      );
    }
    if (result.passed) {
      process.stdout.write(
        `  ${c.green('✓ PASS')}  ${result.stepsRun} steps  ${c.dim(fmtMs(result.durationMs))}\n\n`,
      );
    } else {
      const f = result.failure!;
      process.stdout.write(
        `  ${c.red('✗ FAIL')}  step ${f.step}/${result.stepsRun}  ${c.dim(fmtMs(result.durationMs))}\n`,
      );
      // Show last 3 passing steps for context — helps spot whether
      // the failure is "didn't get there" vs "got there but broke".
      const passingBefore = result.stepTimings.filter((t) => t.step < f.step).slice(-3);
      for (const t of passingBefore) {
        process.stdout.write(
          c.dim(
            `         ${String(t.step).padStart(3)}  ✓  ${fmtMs(t.ms).padStart(7)}  ${t.cmd}\n`,
          ),
        );
      }
      process.stdout.write(
        `         ${String(f.step).padStart(3)}  ${c.red('✗')}  ${c.red(f.command)}\n` +
          `              ${c.red(f.reason)}\n`,
      );
      if (f.screenshotPath) {
        process.stdout.write(`         📷 ${hyperlink(f.screenshotPath)}\n`);
      }
      process.stdout.write('\n');
    }
  }

  suiteEnd(result: SuiteResult): void {
    process.stdout.write(c.dim('─'.repeat(40)) + '\n');
    const word = result.totalFlows === 1 ? 'flow' : 'flows';
    const summary =
      `${result.totalFlows} ${word} · ` +
      `${c.green(`${result.flowsPassed} passed`)} · ` +
      (result.flowsFailed > 0
        ? c.red(`${result.flowsFailed} failed`)
        : `${result.flowsFailed} failed`) +
      ` · ${c.dim(fmtMs(result.durationMs))}`;
    process.stdout.write(summary + '\n');
  }
}
