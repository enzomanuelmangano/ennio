import { describe, expect, it } from 'vitest';

import { aggregate, compare, parseDiag, type DiagEvent } from './diag-report';

function ev(component: string, event: string, extra: Record<string, unknown> = {}): DiagEvent {
  return { ms: 0, pid: 1, component, event, ...extra };
}

describe('parseDiag', () => {
  it('parses JSONL and skips blank / non-JSON lines', () => {
    const text = [
      '{"ms":1,"pid":2,"component":"inject","event":"bound","bindMs":5}',
      '',
      'not json',
      '{"nope":true}', // no `event` → skipped
      '{"ms":2,"pid":2,"component":"flow","event":"end","passed":true,"durationMs":10}',
    ].join('\n');
    const evs = parseDiag(text);
    expect(evs).toHaveLength(2);
    expect(evs[0].event).toBe('bound');
    expect(evs[1].event).toBe('end');
  });
});

describe('aggregate — inject', () => {
  it('counts attempts, outcomes, relaunches and per-connect across two connects', () => {
    const events: DiagEvent[] = [
      // connect 1: two attempts (one relaunch), second binds + ready
      ev('inject', 'establish:start'),
      ev('inject', 'attempt:start', { attempt: 0 }),
      ev('inject', 'no-bind', { pidDied: false }),
      ev('inject', 'attempt:done', { outcome: 'no-bind' }),
      ev('inject', 'relaunch', { attempt: 1 }),
      ev('inject', 'attempt:start', { attempt: 1 }),
      ev('inject', 'bound', { bindMs: 100 }),
      ev('inject', 'ready', { totalMs: 5000 }),
      ev('inject', 'attempt:done', { outcome: 'ready' }),
      // connect 2: one clean attempt
      ev('inject', 'establish:start'),
      ev('inject', 'attempt:start', { attempt: 0 }),
      ev('inject', 'bound', { bindMs: 20 }),
      ev('inject', 'ready', { totalMs: 800 }),
      ev('inject', 'attempt:done', { outcome: 'ready' }),
    ];
    const m = aggregate(events).inject;
    expect(m.connects).toBe(2);
    expect(m.ready).toBe(2);
    expect(m.attempts).toBe(3);
    expect(m.attemptsPerConnect).toBe(1.5);
    expect(m.maxAttemptsInAConnect).toBe(2);
    expect(m.relaunches).toBe(1);
    expect(m.outcomes).toEqual({ 'no-bind': 1, ready: 2 });
    expect(m.bindMs.n).toBe(2);
    expect(m.bindMs.max).toBe(100);
    expect(m.readyTotalMs.max).toBe(5000);
  });

  it('records establish failures and ready-wait bail reasons', () => {
    const events: DiagEvent[] = [
      ev('inject', 'establish:start'),
      ev('inject', 'attempt:start', { attempt: 0 }),
      ev('inject', 'ready-wait:pid-gone', { pid: '99' }),
      ev('inject', 'attempt:done', { outcome: 'not-ready' }),
      ev('inject', 'ready-wait:wedged', { pid: '99' }),
      ev('inject', 'establish:fail', { lastErr: 'budget exhausted' }),
    ];
    const m = aggregate(events).inject;
    expect(m.failed).toBe(1);
    expect(m.readyWaitBail).toEqual({ 'pid-gone': 1, wedged: 1 });
  });
});

describe('aggregate — flows', () => {
  it('splits pass/fail and collects failure details', () => {
    const events: DiagEvent[] = [
      ev('flow', 'end', { name: 'a', passed: true, durationMs: 100 }),
      ev('flow', 'end', {
        name: 'b',
        passed: false,
        durationMs: 200,
        failStep: 5,
        failCommand: 'assertVisible',
        failReason: 'timeout',
      }),
      ev('lifecycle', 'clearState'),
      ev('lifecycle', 'clearState'),
    ];
    const m = aggregate(events);
    expect(m.flows.total).toBe(2);
    expect(m.flows.passed).toBe(1);
    expect(m.flows.failed).toBe(1);
    expect(m.flows.failures[0]).toMatchObject({ name: 'b', step: 5, reason: 'timeout' });
    expect(m.lifecycle.clearState).toBe(2);
  });
});

describe('compare', () => {
  const base = aggregate([
    ev('inject', 'establish:start'),
    ev('inject', 'attempt:start', { attempt: 0 }),
    ev('inject', 'bound', { bindMs: 50 }),
    ev('inject', 'ready', { totalMs: 800 }),
    ev('inject', 'attempt:done', { outcome: 'ready' }),
    ev('flow', 'end', { name: 'a', passed: true, durationMs: 1000 }),
  ]);

  it('flags a regression when the PR run works harder', () => {
    const cur = aggregate([
      ev('inject', 'establish:start'),
      ev('inject', 'attempt:start', { attempt: 0 }),
      ev('inject', 'no-bind'),
      ev('inject', 'attempt:done', { outcome: 'no-bind' }),
      ev('inject', 'relaunch', { attempt: 1 }),
      ev('inject', 'attempt:start', { attempt: 1 }),
      ev('inject', 'relaunch', { attempt: 2 }),
      ev('inject', 'attempt:start', { attempt: 2 }),
      ev('inject', 'relaunch', { attempt: 3 }),
      ev('inject', 'attempt:start', { attempt: 3 }),
      ev('inject', 'bound', { bindMs: 50 }),
      ev('inject', 'ready', { totalMs: 800 }),
      ev('inject', 'attempt:done', { outcome: 'ready' }),
      ev('flow', 'end', { name: 'a', passed: true, durationMs: 1000 }),
    ]);
    const diffs = compare(base, cur);
    const reg = diffs.filter((d) => d.severity === 'regression').map((d) => d.metric);
    expect(reg).toContain('inject.attemptsPerConnect');
    expect(reg).toContain('inject.relaunches');
  });

  it('flags a flow-failure regression', () => {
    const cur = aggregate([ev('flow', 'end', { name: 'a', passed: false, durationMs: 1000 })]);
    const diffs = compare(base, cur);
    expect(diffs.some((d) => d.metric === 'flows.failed' && d.severity === 'regression')).toBe(
      true,
    );
  });

  it('reports no regression for an identical run', () => {
    const diffs = compare(base, base);
    expect(diffs.some((d) => d.severity === 'regression')).toBe(false);
  });
});
