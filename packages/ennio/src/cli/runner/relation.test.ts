import { describe, expect, it, vi } from 'vitest';

import type { RunContext } from './context';
import { withResolvedRelation } from './relation';

const ctx = {} as RunContext;
const anchor = { x: 10, y: 200, w: 100, h: 20 };

describe('withResolvedRelation', () => {
  it('leaves a selector without a relation untouched', async () => {
    const resolve = vi.fn();
    const sel = { text: 'DELETE|Delete' };
    expect(await withResolvedRelation(ctx, sel, resolve)).toBe(sel);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('resolves the anchor (string or selector) to the relation rect', async () => {
    const resolve = vi.fn().mockResolvedValue(anchor);
    const out = await withResolvedRelation(
      ctx,
      { text: 'DELETE|Delete', below: 'Delete this item\\?' as never },
      resolve,
    );
    expect(resolve).toHaveBeenCalledWith(ctx, { text: 'Delete this item\\?' });
    expect(out?.relation).toEqual({ kind: 'below', ...anchor });
  });

  it('is null when the anchor is not on screen', async () => {
    const out = await withResolvedRelation(
      ctx,
      { text: 'Save', rightOf: { id: 'cancel' } },
      vi.fn().mockResolvedValue(null),
    );
    expect(out).toBeNull();
  });
});
