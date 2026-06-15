import { describe, it, expect } from 'vitest';

import type { RunContext } from './context';
import { isVisible, waitUntilAnyVisible } from './visibility';

type Resp = { ok: boolean; data?: unknown };

// A RunContext stub whose only live part is client.call — visibility
// predicates touch nothing else for the paths under test (the id/index/
// childOf branches short-circuit before the alert/AX fallbacks). Records
// the ops issued so a test can assert which resolver a selector routed to.
function stubCtx(handler: (op: string, args: Record<string, unknown>) => Resp): {
  ctx: RunContext;
  calls: { op: string; args: Record<string, unknown> }[];
} {
  const calls: { op: string; args: Record<string, unknown> }[] = [];
  const ctx = {
    udid: 'sim',
    platform: { name: 'ios' },
    client: {
      call: async (op: string, args: Record<string, unknown> = {}) => {
        calls.push({ op, args });
        return handler(op, args);
      },
    },
  } as unknown as RunContext;
  return { ctx, calls };
}

const RECT: Resp = { ok: true, data: { x: 0, y: 0, w: 10, h: 10 } };
const MISS: Resp = { ok: false };

describe('isVisible — narrowing qualifiers route through the same resolver as find', () => {
  it('childOf goes through find_child_by_testid, not the flat visible/find_by_text', async () => {
    const { ctx, calls } = stubCtx((op) => (op === 'find_child_by_testid' ? RECT : MISS));
    const ok = await isVisible(ctx, { id: 'row', childOf: { id: 'list' } });
    expect(ok).toBe(true);
    expect(calls.map((c) => c.op)).toEqual(['find_child_by_testid']);
    expect(calls[0].args).toMatchObject({ childTestID: 'row', parentTestID: 'list' });
  });

  it('childOf with no match reports NOT visible (no flat fallback that would false-pass)', async () => {
    const { ctx } = stubCtx(() => MISS);
    expect(await isVisible(ctx, { id: 'row', childOf: { id: 'list' } })).toBe(false);
  });

  it('index goes through find_by_testid_nth with the requested index', async () => {
    const { ctx, calls } = stubCtx((op, args) =>
      op === 'find_by_testid_nth' && args.index === 0 ? RECT : MISS,
    );
    expect(await isVisible(ctx, { id: 'item', index: 0 })).toBe(true);
    expect(calls).toEqual([{ op: 'find_by_testid_nth', args: { testID: 'item', index: 0 } }]);
  });

  it('a requested index that does not exist is NOT visible — the false-pass the audit flagged', async () => {
    // Only index 0 exists; asserting index 5 must NOT silently match index 0.
    const { ctx } = stubCtx((op, args) =>
      op === 'find_by_testid_nth' && args.index === 0 ? RECT : MISS,
    );
    expect(await isVisible(ctx, { id: 'item', index: 5 })).toBe(false);
  });

  it('a plain id (no qualifier) still uses the rich visible op', async () => {
    const { ctx, calls } = stubCtx((op) =>
      op === 'visible' ? { ok: true, data: { visible: true } } : MISS,
    );
    expect(await isVisible(ctx, { id: 'plain' })).toBe(true);
    expect(calls[0].op).toBe('visible');
  });
});

describe('waitUntilAnyVisible — OR semantics', () => {
  it('resolves as soon as ONE selector is visible', async () => {
    const { ctx } = stubCtx((op, args) =>
      op === 'visible' && args.testID === 'b' ? { ok: true, data: { visible: true } } : MISS,
    );
    await expect(
      waitUntilAnyVisible(ctx, [{ id: 'a' }, { id: 'b' }], 1000),
    ).resolves.toBeUndefined();
  });

  it('throws once the budget elapses with none visible', async () => {
    const { ctx } = stubCtx(() => ({ ok: true, data: { visible: false } }));
    await expect(waitUntilAnyVisible(ctx, [{ id: 'a' }], 60)).rejects.toThrow(/anyOf/);
  });
});
