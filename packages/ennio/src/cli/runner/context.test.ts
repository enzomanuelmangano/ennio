import { describe, it, expect, afterEach } from 'vitest';

import { createJsScope, evaluateJsExpression, interpolate, interpolateSelector } from './context';
import type { RunContext } from './context';

// interpolate/interpolateSelector only touch flowEnv, outputs, and copiedText.
// A partial stub cast to RunContext is enough — the rest of the context is
// never read by the substitution path.
function stubCtx(over: Partial<RunContext> = {}): RunContext {
  return { outputs: {}, ...over } as RunContext;
}

describe('interpolate — Maestro variable precedence', () => {
  const saved = { ...process.env };
  afterEach(() => {
    // Restore any env keys the tests poked at.
    for (const k of ['LINK', 'TEXT', 'TOKEN', 'MAESTRO_TOKEN', 'SECRET']) delete process.env[k];
    Object.assign(process.env, saved);
  });

  it('resolves a bare ${VAR} from flowEnv', () => {
    expect(interpolate('${LINK}', stubCtx({ flowEnv: { LINK: 'drawer' } }))).toBe('drawer');
  });

  it('flowEnv WINS over process.env for the same bare ${VAR}', () => {
    process.env.LINK = 'from-process';
    expect(interpolate('${LINK}', stubCtx({ flowEnv: { LINK: 'from-flow' } }))).toBe('from-flow');
  });

  it('falls back to process.env when flowEnv has no entry', () => {
    process.env.TOKEN = 'shell-token';
    expect(interpolate('${TOKEN}', stubCtx({ flowEnv: {} }))).toBe('shell-token');
  });

  it('throws at the command containing an unresolved expression', () => {
    expect(() => interpolate('a-${MISSING}-b', stubCtx())).toThrow(
      'failed to evaluate interpolation `${MISSING}`',
    );
  });

  it('exposes only MAESTRO_-prefixed process variables through the JS env global', () => {
    process.env.MAESTRO_TOKEN = 'maestro-token';
    process.env.SECRET = 'must-not-leak';
    expect(interpolate('${env.MAESTRO_TOKEN}', stubCtx())).toBe('maestro-token');
    expect(interpolate('${env.SECRET}', stubCtx())).toBe('');
    expect(createJsScope(stubCtx()).env).toEqual(
      expect.objectContaining({ MAESTRO_TOKEN: 'maestro-token' }),
    );
    expect(createJsScope(stubCtx()).env).not.toHaveProperty('SECRET');
  });

  it('${env.X} missing resolves to empty string', () => {
    expect(interpolate('[${env.NOPE}]', stubCtx())).toBe('[]');
  });

  it('${output.X} reads ctx.outputs; missing → empty string', () => {
    expect(interpolate('${output.id}', stubCtx({ outputs: { id: 42 } }))).toBe('42');
    expect(interpolate('${output.gone}', stubCtx({ outputs: {} }))).toBe('');
  });

  it('${maestro.copiedText} reads the last copyTextFrom', () => {
    expect(interpolate('${maestro.copiedText}', stubCtx({ copiedText: 'hello' }))).toBe('hello');
  });

  it('evaluates JavaScript expressions and keeps nullish output empty', () => {
    const ctx = stubCtx({ flowEnv: { PREFIX: 'item' }, outputs: { id: 42, gone: null } });
    expect(interpolate('${PREFIX + "-" + output.id}', ctx)).toBe('item-42');
    expect(interpolate('[${output.gone}]', ctx)).toBe('[]');
  });

  it('persists evalScript assignments in the shared flow scope', () => {
    const ctx = stubCtx({ flowEnv: { counter: 0 } });
    expect(evaluateJsExpression('${counter += 1}', ctx)).toBe(1);
    expect(evaluateJsExpression('counter += 1', ctx)).toBe(2);
    expect(ctx.flowEnv?.counter).toBe(2);
  });
});

describe('interpolateSelector — deep field substitution', () => {
  it('interpolates every string field, flowEnv winning over process.env', () => {
    process.env.TEXT = 'from-process';
    const out = interpolateSelector(
      { text: '${TEXT}', below: { id: '${LINK}' } },
      stubCtx({ flowEnv: { TEXT: 'from-flow', LINK: 'panel' } }),
    );
    expect(out).toEqual({ text: 'from-flow', below: { id: 'panel' } });
    delete process.env.TEXT;
  });
});
