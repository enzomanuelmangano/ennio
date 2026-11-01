// Maestro relative selectors — `below`, `above`, `leftOf`, `rightOf`. The
// anchor is itself a selector: resolve it to a window rect here, once, and
// hand the rect to the dylib's text finds (`relation`), which keep only the
// matches on that side of it and pick the nearest. Without this the relation
// was parsed and silently ignored: `tapOn: {text: "DELETE|Delete", below:
// "Delete this item?"}` tapped the header's "DELETE|Delete" instead of the
// dialog's.

import type { MaestroSelector } from '../maestro-parser';
import { normalizeSelector, textMatchArgs } from '../maestro-parser';

import type { Rect, RunContext } from './context';

const KINDS = ['below', 'above', 'leftOf', 'rightOf'] as const;

/**
 * The selector with its relation resolved (`relation` set), the selector
 * unchanged when it has none, or null when the anchor is not on screen —
 * then nothing can match.
 */
export async function withResolvedRelation(
  ctx: RunContext,
  sel: MaestroSelector,
  resolveAnchor: (
    ctx: RunContext,
    sel: MaestroSelector,
  ) => Promise<{
    x: number;
    y: number;
    w: number;
    h: number;
  } | null>,
): Promise<MaestroSelector | null> {
  if (sel.relation) return sel;
  const kind = KINDS.find((k) => sel[k] !== undefined);
  if (!kind) return sel;
  const anchor = await resolveAnchor(ctx, normalizeSelector(sel[kind] as MaestroSelector | string));
  if (!anchor) return null;
  return { ...sel, relation: { kind, ...anchor } };
}

export function hasRelation(sel: MaestroSelector): boolean {
  const relative = !!sel.relation || KINDS.some((k) => sel[k] !== undefined);
  // Implemented on text selectors only: say so rather than silently tap the
  // first match of an id and ignore the relation.
  if (relative && !sel.text) {
    throw new Error(`below/above/leftOf/rightOf need a text selector (got ${JSON.stringify(sel)})`);
  }
  return relative;
}

/**
 * The anchor's OWN bounds (Maestro measures relations on them): a text
 * anchor is found in leaf mode, not promoted to its interactive ancestor —
 * the ancestor of a "Option A" segment is the whole segmented control, and
 * nothing is to the right of that.
 */
export async function resolveAnchorRect(
  ctx: RunContext,
  sel: MaestroSelector,
): Promise<Rect | null> {
  const r = sel.id
    ? await ctx.client
        .call('wait_find_by_testid', { testID: sel.id, maxMs: 2500 })
        .catch(() => undefined)
    : sel.text
      ? await ctx.client
          .call('wait_find_by_text', {
            ...textMatchArgs(sel, ctx.profile.textMatchDefault),
            leaf: true,
            maxMs: 2500,
          })
          .catch(() => undefined)
      : undefined;
  return r && r.ok && r.data ? (r.data as Rect) : null;
}

/**
 * One relation-aware probe, no waiting — the optional-tap check (findOnce's
 * counterpart). Anchor and target are each looked up once.
 */
export async function findRelationOnce(
  ctx: RunContext,
  sel: MaestroSelector,
): Promise<Rect | null> {
  const scoped = await withResolvedRelation(ctx, sel, async (c, anchor) => {
    const r = anchor.id
      ? await c.client.call('find_by_testid', { testID: anchor.id }).catch(() => undefined)
      : await c.client
          .call('find_by_text', {
            ...textMatchArgs(anchor, c.profile.textMatchDefault),
            leaf: true,
          })
          .catch(() => undefined);
    return r && r.ok && r.data ? (r.data as Rect) : null;
  });
  if (!scoped) return null;
  const r = await ctx.client
    .call('find_by_text', { ...textMatchArgs(scoped, ctx.profile.textMatchDefault) })
    .catch(() => undefined);
  return r && r.ok && r.data ? (r.data as Rect) : null;
}
