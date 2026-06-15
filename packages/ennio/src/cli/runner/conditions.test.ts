import { describe, it, expect } from 'vitest';

import type { RunContext } from './context';
import { evaluateCondition } from './conditions';

// A RunContext stub for `when.true` expression evaluation: only platform,
// outputs, and copiedText are touched (visible/notVisible branches aren't
// exercised here).
function ctxFor(platform: 'ios' | 'android', outputs: Record<string, unknown> = {}): RunContext {
  return {
    platform: { name: platform },
    outputs,
    copiedText: '',
  } as unknown as RunContext;
}

describe('evaluateCondition — when.true expression', () => {
  it('exposes maestro.platform so a platform guard evaluates per-backend', async () => {
    const cond = { true: "${maestro.platform == 'android' || maestro.platform == 'ios'}" };
    expect(await evaluateCondition(ctxFor('android'), cond)).toBe(true);
    expect(await evaluateCondition(ctxFor('ios'), cond)).toBe(true);

    const androidOnly = { true: "${maestro.platform == 'android'}" };
    expect(await evaluateCondition(ctxFor('android'), androidOnly)).toBe(true);
    expect(await evaluateCondition(ctxFor('ios'), androidOnly)).toBe(false);
  });

  it('exposes output.* from prior runScript steps', async () => {
    const cond = { true: '${output.ready === "yes"}' };
    expect(await evaluateCondition(ctxFor('ios', { ready: 'yes' }), cond)).toBe(true);
    expect(await evaluateCondition(ctxFor('ios', { ready: 'no' }), cond)).toBe(false);
  });

  it('treats a malformed expression as false (guard does not run)', async () => {
    const cond = { true: '${this is not valid js}' };
    expect(await evaluateCondition(ctxFor('ios'), cond)).toBe(false);
  });
});
