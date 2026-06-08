import { describe, it, expect } from 'vitest';

import type { MaestroCommand, MaestroFlow } from '../maestro-parser';
import { stripAnsi } from '../ui/ansi';

import { flowResultLines, renderFrame, suiteLines } from './live-view';
import { RunModel } from './run-model';

const flow = (p: string): MaestroFlow =>
  ({ filePath: p, name: p, commands: [] }) as unknown as MaestroFlow;
const tap = (id: string): MaestroCommand => ({ tapOn: { id } }) as unknown as MaestroCommand;
const plain = (lines: string[]) => lines.map(stripAnsi);

describe('renderFrame', () => {
  it('shows progress, the current flow, a completed step, and the in-flight step', () => {
    const m = new RunModel();
    m.startSuite(2, 0);
    m.startFlow(flow('/e2e/login.yml'));
    m.finishStep(1, tap('a'), 50, true);
    m.startStep(2, tap('b'), 1000);

    const out = plain(renderFrame(m, { tick: 2, cols: 80, now: 1500 }));
    expect(out[0]).toContain('0/2 flows');
    expect(out[0]).toContain('1.5s');
    expect(out).toContain('  ▸ login.yml');
    expect(out.some((l) => l.includes('✓') && l.includes('tapOn id:a'))).toBe(true);
    // active step: spinner + step text + running elapsed (1500-1000)
    expect(out[out.length - 1]).toContain('tapOn id:b');
    expect(out[out.length - 1]).toContain('500ms');
  });

  it('collapses to just the progress line once the flow has a result', () => {
    const m = new RunModel();
    m.startSuite(1, 0);
    m.startFlow(flow('/e2e/x.yml'));
    m.endFlow(true, 100);
    expect(renderFrame(m, { tick: 0, cols: 80, now: 200 })).toHaveLength(1);
  });
});

describe('flowResultLines', () => {
  it('one ✔ line on pass', () => {
    const lines = plain(
      flowResultLines('login.yml', {
        passed: true,
        stepsRun: 17,
        durationMs: 23_000,
      } as never),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('✔');
    expect(lines[0]).toContain('login.yml');
    expect(lines[0]).toContain('17 steps');
  });

  it('failure shows command, reason, and screenshot link', () => {
    const lines = plain(
      flowResultLines('thread.yml', {
        passed: false,
        stepsRun: 24,
        durationMs: 60_000,
        failure: {
          step: 4,
          command: 'assertVisible "Root"',
          reason: 'timeout',
          screenshotPath: '/tmp/x.png',
        },
      } as never),
    );
    expect(lines[0]).toContain('✖');
    expect(lines.join('\n')).toContain('assertVisible "Root"');
    expect(lines.join('\n')).toContain('timeout');
    expect(lines.join('\n')).toContain('x.png');
  });
});

describe('suiteLines', () => {
  it('summarizes pass/fail counts', () => {
    expect(
      plain(
        suiteLines({
          passed: true,
          totalFlows: 2,
          flowsPassed: 2,
          flowsFailed: 0,
          durationMs: 1000,
        } as never),
      ).join('\n'),
    ).toContain('2 passed');
    expect(
      plain(
        suiteLines({
          passed: false,
          totalFlows: 2,
          flowsPassed: 1,
          flowsFailed: 1,
          durationMs: 1000,
        } as never),
      ).join('\n'),
    ).toContain('1 failed');
  });
});
