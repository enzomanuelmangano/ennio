import { describe, it, expect, afterEach } from 'vitest';

import { interpolate, interpolateSelector } from './context';
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
    for (const k of ['LINK', 'TEXT', 'TOKEN']) delete process.env[k];
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

  it('leaves an unresolved bare ${VAR} as a literal (never empty, never regex bait)', () => {
    expect(interpolate('a-${MISSING}-b', stubCtx())).toBe('a-${MISSING}-b');
  });

  it('${env.X} reads process.env regardless of flowEnv', () => {
    process.env.TOKEN = 'shell-token';
    expect(interpolate('${env.TOKEN}', stubCtx({ flowEnv: { TOKEN: 'flow-token' } }))).toBe(
      'shell-token',
    );
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
