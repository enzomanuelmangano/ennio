import { describe, expect, it } from 'vitest';

import { toMaestroSelector } from './selectors';

describe('toMaestroSelector', () => {
  it('maps testID to a Maestro id selector', () => {
    expect(toMaestroSelector({ testID: 'submit' })).toEqual({ ok: true, data: { id: 'submit' } });
  });

  it('maps text to a Maestro text selector', () => {
    expect(toMaestroSelector({ text: 'Log in' })).toEqual({ ok: true, data: { text: 'Log in' } });
  });

  it('converts a normalized point to a Maestro percentage string', () => {
    expect(toMaestroSelector({ point: { x: 0.5, y: 0.9 } })).toEqual({
      ok: true,
      data: { point: '50%,90%' },
    });
  });

  it('rejects an empty selector', () => {
    const r = toMaestroSelector({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid');
  });

  it('rejects more than one field', () => {
    const r = toMaestroSelector({ testID: 'a', text: 'b' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/exactly one/);
  });

  it('rejects an out-of-range point', () => {
    const r = toMaestroSelector({ point: { x: 1.5, y: 0.2 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid');
  });

  it('rejects a missing selector entirely', () => {
    expect(toMaestroSelector(undefined).ok).toBe(false);
  });
});
