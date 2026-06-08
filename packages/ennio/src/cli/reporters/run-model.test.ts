import { describe, it, expect } from 'vitest';

import type { MaestroCommand, MaestroFlow } from '../maestro-parser';

import { RunModel } from './run-model';

const flow = (filePath: string): MaestroFlow =>
  ({ filePath, name: filePath, commands: [] }) as unknown as MaestroFlow;
const tap = (id: string): MaestroCommand => ({ tapOn: { id } }) as unknown as MaestroCommand;

describe('RunModel', () => {
  it('tracks suite → flow → step → result', () => {
    const m = new RunModel();
    m.startSuite(2, 0);
    expect(m.total).toBe(2);

    m.startFlow(flow('/e2e/login.yml'));
    expect(m.current?.name).toBe('login.yml');
    expect(m.current?.index).toBe(1);

    m.startStep(1, tap('go'), 100);
    expect(m.current?.active?.text).toContain('id:go');

    m.finishStep(1, tap('go'), 50, true);
    expect(m.current?.active).toBeNull();
    expect(m.current?.steps[0]).toMatchObject({ step: 1, ok: true, ms: 50 });

    m.endFlow(true, 200);
    expect(m.finished).toBe(1);
    expect(m.passed).toBe(1);
    expect(m.failed).toBe(0);
  });

  it('records failures and counts them', () => {
    const m = new RunModel();
    m.startSuite(1, 0);
    m.startFlow(flow('/e2e/x.yml'));
    m.finishStep(1, tap('a'), 10, false);
    m.endFlow(false, 30, { step: 1, reason: 'not found', screenshotPath: '/tmp/x.png' });
    expect(m.failed).toBe(1);
    expect(m.passed).toBe(0);
    expect(m.current?.result?.failure?.screenshotPath).toBe('/tmp/x.png');
  });
});
