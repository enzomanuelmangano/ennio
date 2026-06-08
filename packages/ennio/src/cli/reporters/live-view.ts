// Pure projection of a RunModel to terminal lines. No `this`, no I/O, no
// timers — everything time/width/tick-dependent is passed in — so every frame
// is snapshot-testable. LiveReporter is just glue around these.

import { SPINNER, bold, cyan, dim, fmtMs, green, hyperlink, red, truncate } from '../ui/ansi';

import type { FlowResult, SuiteResult } from './reporter';
import type { RunModel } from './run-model';

const BAR_WIDTH = 20;

export interface FrameOpts {
  tick: number;
  cols: number;
  now: number;
}

/** The header printed once, permanently, at suite start. */
export function headerLines(version: string): string[] {
  return ['', `  ${bold('🧪 ennio')} ${dim(version)}`, ''];
}

/** The live (bottom) region: suite progress + the current flow's in-flight step. */
export function renderFrame(model: RunModel, o: FrameOpts): string[] {
  const lines = [progressLine(model, o.now)];
  const f = model.current;
  if (!f || f.result) return lines;

  lines.push(`  ${cyan('▸')} ${bold(f.name)}`);
  for (const s of f.steps.slice(-2)) {
    const icon = s.ok ? green('✓') : red('✗');
    lines.push(
      `      ${icon} ${dim(String(s.step).padStart(3))}  ${dim(truncate(s.text, o.cols - 14))}`,
    );
  }
  if (f.active) {
    const spinner = cyan(SPINNER[o.tick % SPINNER.length]);
    const elapsed = dim(fmtMs(o.now - f.active.startedAt));
    const text = truncate(f.active.text, o.cols - 22);
    lines.push(`      ${spinner} ${dim(String(f.active.step).padStart(3))}  ${text}  ${elapsed}`);
  }
  return lines;
}

function progressLine(model: RunModel, now: number): string {
  const done = model.finished;
  const total = Math.max(model.total, 1);
  const filled = Math.round((done / total) * BAR_WIDTH);
  const bar = green('█'.repeat(filled)) + dim('░'.repeat(BAR_WIDTH - filled));
  return `  ${dim('Suite')}  ${bar}  ${done}/${model.total} flows · ${dim(fmtMs(now - model.startedAt))}`;
}

/** The permanent ✔/✖ line(s) emitted when a flow finishes. */
export function flowResultLines(flowName: string, result: FlowResult): string[] {
  const name = flowName.padEnd(22);
  if (result.passed) {
    return [
      `  ${green('✔')} ${name} ${dim(`${result.stepsRun} steps`)}  ${dim(fmtMs(result.durationMs))}`,
    ];
  }
  const fail = result.failure!;
  const out = [
    `  ${red('✖')} ${name} ${dim(`step ${fail.step}/${result.stepsRun}`)}  ${dim(fmtMs(result.durationMs))}`,
    `      ${red(fail.command)}`,
    `      ${dim(fail.reason)}`,
  ];
  if (fail.screenshotPath) out.push(`      📷 ${hyperlink(fail.screenshotPath)}`);
  return out;
}

/** The final suite summary. */
export function suiteLines(result: SuiteResult): string[] {
  const word = result.totalFlows === 1 ? 'flow' : 'flows';
  const head = result.passed
    ? green(`  ✔ ${result.flowsPassed} passed`)
    : red(`  ✖ ${result.flowsFailed} failed`) + dim(` · ${result.flowsPassed} passed`);
  return ['', `${head}${dim(` · ${result.totalFlows} ${word} · ${fmtMs(result.durationMs)}`)}`, ''];
}
