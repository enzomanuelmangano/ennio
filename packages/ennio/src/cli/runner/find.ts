// Find utilities — resolve a Maestro selector to a window-space rect.
//
// Three layers, fastest first:
//   1. dylib fast path (wait_find_by_*) — pushes the polling INTO the
//      app process where the testID swizzle index is event-driven.
//   2. CLI-side poll (findOnce + sleep(POLL_MS)) — covers selectors the
//      fast path doesn't support (childOf, mixed id+text).
//   3. Auto-scroll fallback — Maestro's implicit "scroll until visible"
//      semantics for off-screen targets.
//   4. Cross-process AX fallback (find_ax_by_text) — for content
//      rendered by remote view services (PHPicker, share sheet).

import { axQueryByText, swipe as hidSwipe } from '../hid';
import { MaestroSelector } from '../maestro-parser';

import {
  DEFAULT_WIN_H,
  DEFAULT_WIN_W,
  FIND_DEADLINE_DEFAULT_MS,
  POLL_MS,
  POST_TAP_SETTLE_MS,
  Rect,
  RunContext,
  sleep,
  timedAsync,
} from './context';

// =====================================================================
// State capture — preserved across pre-tap / post-tap so the runner can
// detect "did the tap actually change anything".
// =====================================================================

export async function captureHash(ctx: RunContext): Promise<string> {
  try {
    const r = await ctx.client.call('frame_hash');
    if (r.ok && r.data) return String((r.data as { hash: string }).hash);
  } catch {
    /* hash unavailable */
  }
  return '';
}

/// React Native commit observer — see ios/EnnioReactObserver.mm. Returns
/// `{ts, attach}`. `attach` is "paper" | "fabric" | "both" | "none".
/// When "none" the dylib has no RN hook attached and the caller falls
/// back to the UIView frame-hash signal.
export async function captureReactTs(
  ctx: RunContext,
): Promise<{ ts: number; attach: 'paper' | 'fabric' | 'both' | 'none' }> {
  try {
    const r = await ctx.client.call('react_commit_ts');
    if (r.ok && r.data) {
      const d = r.data as { ts: number | string; attach: string };
      const ts = typeof d.ts === 'number' ? d.ts : Number(d.ts) || 0;
      const attach = (d.attach || 'none') as 'paper' | 'fabric' | 'both' | 'none';
      return { ts, attach };
    }
  } catch {
    /* observer op unavailable on older dylibs */
  }
  return { ts: 0, attach: 'none' };
}

// Retained for future post-tap settle experiments.
async function _waitForHashChange(
  ctx: RunContext,
  baseline: string,
  maxMs: number,
): Promise<boolean> {
  if (!baseline) {
    await sleep(POST_TAP_SETTLE_MS);
    return true;
  }
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await sleep(60);
    const cur = await captureHash(ctx);
    if (cur && cur !== baseline) return true;
  }
  return false;
}

// =====================================================================
// Selector → rect
// =====================================================================

export async function findOnce(ctx: RunContext, sel: MaestroSelector): Promise<Rect | null> {
  // Hierarchical childOf: prefer the dylib's scoped search so we
  // don't pick the wrong matching descendant from a different
  // ancestor (Maestro idiom:
  //   `id: postDropdownBtn / childOf: { id: feedItem-by-alice.test }`).
  if (sel.childOf && sel.childOf.id && sel.id) {
    const r = await ctx.client
      .call('find_child_by_testid', {
        childTestID: sel.id,
        parentTestID: sel.childOf.id,
      })
      .catch(() => undefined);
    if (r && r.ok) return r.data as Rect;
    // Don't fall back to flat find — that would defeat the childOf
    // constraint and return the first match anywhere.
    return null;
  }
  if (sel.id) {
    const r = await ctx.client.call('find_by_testid', { testID: sel.id });
    if (r.ok) return r.data as Rect;
  }
  if (sel.text) {
    const r = await ctx.client.call('find_by_text', { text: sel.text });
    if (r.ok) return r.data as Rect;
  }
  return null;
}

export async function resolveRect(ctx: RunContext, sel: MaestroSelector): Promise<Rect | null> {
  // Fast path: push the polling INTO the dylib via wait_find_by_*
  // so each retry is ~16 ms (one CADisplayLink tick) instead of
  // the CLI's 100 ms loop. Single round-trip, ~6× lower latency on
  // misses. Falls back to the legacy retry loop for selectors the
  // fast path can't handle (childOf, mixed id+text, etc.).
  if (sel.childOf && sel.childOf.id && sel.id) {
    // childOf goes through the dedicated find_child_by_testid (no
    // wait variant yet) — keep its existing path.
  } else if (sel.id && typeof sel.index === 'number') {
    // Maestro `index: N` — pick the Nth matching testID instance,
    // sorted top-to-bottom by window Y. Needed for feed-item flows
    // (postDropdownBtn index:0 must hit the first post, not the
    // last-mounted one that find_by_testid returns by default).
    const r = await timedAsync(ctx, 'tap.findFast', () =>
      ctx.client
        .call('find_by_testid_nth', { testID: sel.id!, index: sel.index })
        .catch(() => undefined),
    );
    if (r && r.ok && r.data) return r.data as Rect;
  } else if (sel.id) {
    // Drop sel.text gating: when both id and text/label are set in
    // YAML, the label is human-readable metadata, not an additional
    // filter — find_by_testid alone identifies the unique element.
    const r = await timedAsync(ctx, 'tap.findFast', () =>
      ctx.client
        .call('wait_find_by_testid', { testID: sel.id!, maxMs: FIND_DEADLINE_DEFAULT_MS })
        .catch(() => undefined),
    );
    if (r && r.ok && r.data) return r.data as Rect;
  } else if (sel.text && !sel.id) {
    const r = await timedAsync(ctx, 'tap.findFast', () =>
      ctx.client.call('wait_find_by_text', { text: sel.text!, maxMs: 2500 }).catch(() => undefined),
    );
    if (r && r.ok && r.data) return r.data as Rect;
  }
  // Match Maestro's implicit-wait semantics on tapOn: keep retrying
  // the find for ~7 s before giving up. Layout passes after a
  // clearState relaunch, RNGH bottom-sheet expansion, React-Nav push
  // each take 1-3 s to settle.
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    const r = await findOnce(ctx, sel);
    if (r) return r;
    await sleep(POLL_MS);
  }
  // Tab-bar destinations: pop the navigation stack until the label
  // becomes findable. Long flows leave the user buried in a stack
  // screen whose tab bar is hidden — a single explicit `back` in the
  // YAML can't always reach the tab root.
  if (sel.text && !sel.id) {
    const tabish = ['Home', 'Cart', 'Products', 'Profile', 'Gauntlet'].some(
      (t) => t.toLowerCase() === String(sel.text).toLowerCase(),
    );
    if (tabish) {
      for (let i = 0; i < 4; i++) {
        await ctx.client.call('back').catch(() => undefined);
        await sleep(450);
        await ctx.client.call('wait_commit', { maxMs: 1500, stableMs: 250 }).catch(() => undefined);
        const r = await findOnce(ctx, sel);
        if (r) return r;
      }
    }
  }

  // Skip auto-scroll for childOf selectors — scrolling shifts the
  // parent out of view, turning a "parent not yet mounted" race into
  // a wrong-target tap.
  if (sel.childOf) {
    if (sel.text) {
      const axRect = await timedAsync(ctx, 'tap.findAxFallback', () =>
        axQueryByText(ctx.udid, sel.text!),
      );
      if (axRect) return axRect;
    }
    return null;
  }
  // Last-chance fallback: auto-scroll. Try DOWN×4, then UP×4.
  const cx = 195;
  const cy = 422;
  const dist = 300;
  for (const dir of ['DOWN', 'UP'] as const) {
    for (let i = 0; i < 4; i++) {
      if (dir === 'DOWN') await hidSwipe(ctx.udid, cx, cy + dist / 2, cx, cy - dist / 2, 250);
      else await hidSwipe(ctx.udid, cx, cy - dist / 2, cx, cy + dist / 2, 250);
      await sleep(500);
      await ctx.client.call('wait_commit', { maxMs: 1500, stableMs: 200 }).catch(() => undefined);
      const found = await findOnce(ctx, sel);
      if (!found) continue;
      // Scroll inertia keeps the contentOffset moving for ~400-800 ms
      // after the swipe gesture ends. Wait for the list to fully
      // settle, then re-find to get the current coords.
      await sleep(700);
      await ctx.client.call('wait_commit', { maxMs: 2000, stableMs: 350 }).catch(() => undefined);
      const stable = await findOnce(ctx, sel);
      return stable ?? found;
    }
  }

  // In-process accessibility fallback for cross-process content
  // (PHPicker, share sheet, document picker — host app holds only a
  // UIRemoteView placeholder, but UIKit synthesises
  // UIAccessibilityElement proxies on the remote view that carry the
  // cross-process content's a11y labels).
  if (sel.text) {
    const r = await timedAsync(ctx, 'tap.findAxFallback', () =>
      ctx.client.call('find_ax_by_text', { text: sel.text! }).catch(() => undefined),
    );
    if (r && r.ok && r.data) return r.data as Rect;
  }
  return null;
}

export async function resolveCenter(
  ctx: RunContext,
  sel: MaestroSelector,
): Promise<{ x: number; y: number }> {
  const rect = await resolveRect(ctx, sel);
  if (!rect) {
    throw new Error(`element not found: ${JSON.stringify(sel)}`);
  }
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

// =====================================================================
// Point parsing — Maestro coords can be "x%,y%" (percentage of window)
// or "x,y" (pixels) or an object { x, y }. The hardcoded window dims
// match a 6.1" iPhone in portrait — the e2e tests don't run on other
// form factors, but if they did we'd query the device size first.
// =====================================================================

export function parsePoint(
  p: MaestroSelector['point'],
  winW: number = DEFAULT_WIN_W,
  winH: number = DEFAULT_WIN_H,
): { x: number; y: number } {
  const parseAxis = (s: string, max: number): number => {
    const t = s.trim();
    if (t.endsWith('%')) return (parseFloat(t.slice(0, -1)) / 100) * max;
    return parseFloat(t);
  };
  if (typeof p === 'string') {
    const [xs, ys] = p.split(',').map((s) => s.trim());
    return { x: parseAxis(xs, winW), y: parseAxis(ys, winH) };
  }
  if (p && typeof p === 'object') {
    const x = typeof p.x === 'number' ? p.x : parseAxis(p.x, winW);
    const y = typeof p.y === 'number' ? p.y : parseAxis(p.y, winH);
    return { x, y };
  }
  throw new Error('tapOn point: invalid');
}
