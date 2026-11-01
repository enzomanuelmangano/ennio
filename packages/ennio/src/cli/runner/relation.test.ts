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

describe('hasRelation', () => {
  it('is false without a relation and true for a text selector with one', async () => {
    const { hasRelation } = await import('./relation');
    expect(hasRelation({ text: 'Delete' })).toBe(false);
    expect(hasRelation({ text: 'Delete', below: { text: 'Title' } })).toBe(true);
  });

  it('refuses a relation on a selector without text', async () => {
    const { hasRelation } = await import('./relation');
    expect(() => hasRelation({ id: 'x', rightOf: { id: 'y' } })).toThrow(/need a text selector/);
  });
});

describe('findRelationOnce', () => {
  it('finds the anchor in leaf mode, then the target scoped to it, without waiting', async () => {
    const { findRelationOnce } = await import('./relation');
    const calls: { op: string; args: Record<string, unknown> }[] = [];
    const rects: Record<string, unknown> = {
      Title: anchor,
      Delete: { x: 10, y: 300, w: 80, h: 30 },
    };
    const c = {
      profile: { textMatchDefault: 'literal' },
      client: {
        call: async (op: string, args: Record<string, unknown>) => {
          calls.push({ op, args });
          return { ok: true, data: rects[args.text as string] };
        },
      },
    } as unknown as RunContext;
    const r = await findRelationOnce(c, { text: 'Delete', below: { text: 'Title' } });
    expect(r).toEqual({ x: 10, y: 300, w: 80, h: 30 });
    expect(calls.map((x) => x.op)).toEqual(['find_by_text', 'find_by_text']);
    expect(calls[0].args.leaf).toBe(true);
    expect(calls[1].args.relation).toEqual({ kind: 'below', ...anchor });
  });
});
