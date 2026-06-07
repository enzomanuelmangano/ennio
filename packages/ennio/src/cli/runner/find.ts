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

import { dismissSystemSheet } from '../ennio-ax';
import { axQueryByText, swipe as hidSwipe } from '../hid';
import { MaestroSelector } from '../maestro-parser';

import {
  DEFAULT_WIN_H,
  DEFAULT_WIN_W,
  FIND_DEADLINE_DEFAULT_MS,
  POLL_MS,
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
    // Quick synchronous probe — if the element is already on screen skip
    // the 2.5 s in-process wait entirely (~20 ms vs 2500 ms on a miss).
    const quick = await findOnce(ctx, sel);
    if (quick) return quick;
    // Tab-bar early detection: if the label matches a UITabBarItem the
    // element is buried under a pushed nav stack, not absent. Unwind
    // immediately via backs rather than burning 2.5 s polling a view
    // tree that will never surface the hidden tab bar.
    const tabResp = await ctx.client.call('find_tab', { name: sel.text! }).catch(() => undefined);
    if (tabResp?.ok && (tabResp.data as { present?: boolean } | undefined)?.present) {
      for (let i = 0; i < 4; i++) {
        await ctx.client.call('back').catch(() => undefined);
        await sleep(450);
        await ctx.client.call('wait_commit', { maxMs: 1500, stableMs: 250 }).catch(() => undefined);
        const found = await findOnce(ctx, sel);
        if (found) return found;
      }
      return null; // tab recovery exhausted — element genuinely absent
    }
    // Not a tab — poll in-process until the element mounts.
    const r = await timedAsync(ctx, 'tap.findFast', () =>
      ctx.client.call('wait_find_by_text', { text: sel.text!, maxMs: 2500 }).catch(() => undefined),
    );
    if (r && r.ok && r.data) return r.data as Rect;
  }
  // In-process accessibility match — tried EARLY, right after the
  // UIView fast-path misses. UIKit text lives in UILabels (caught by
  // findOnce above), but SwiftUI / drawn text exposes itself only
  // through the accessibility tree. Walking it in-process
  // (find_ax_by_text, ~50ms) here means a SwiftUI control (e.g. an iOS
  // Settings row) is found immediately — NOT after a 2.5 s poll the
  // UIView walk can never satisfy, nor ~10 s of blind scrolling.
  // On-screen only, so a still-mounting / off-screen target falls
  // through to the poll + scroll below. Skipped for childOf (own path).
  if (sel.text && !sel.childOf) {
    const ax = await ctx.client.call('find_ax_by_text', { text: sel.text }).catch(() => undefined);
    if (ax && ax.ok && ax.data) return ax.data as Rect;
  }
  // CLI-side implicit-wait top-up for elements that are mounting (RN
  // commit lag, React-Nav push tail) — re-poll the UIView/index finder.
  let deadline = Date.now() + 2500;
  // A cross-process system permission sheet (Photo Library limited-
  // access upgrade, notifications, tracking) floats over the app and
  // swallows every touch — the in-app dylib can't see it, so the find
  // would spin to timeout while the target sits behind the sheet
  // (profile-screen-edit: tapOn "Done" blocked by the Photos
  // "Requesting Additional Access" prompt). The fast path above already
  // burned its budget, so probe once on the first poll-loop miss; on a
  // successful dismissal extend the deadline so the now-unblocked UI
  // has time to finish presenting.
  let permProbed = false;
  while (Date.now() < deadline) {
    const r = await findOnce(ctx, sel);
    if (r) return r;
    if (!permProbed) {
      permProbed = true;
      const dismissed = await dismissSystemSheet(ctx.udid).catch(() => false);
      if (dismissed) {
        process.stderr.write('[ennio] dismissed system permission sheet during find\n');
        deadline = Date.now() + 4000;
        await ctx.client.call('wait_commit', { maxMs: 1500, stableMs: 200 }).catch(() => undefined);
        continue;
      }
    }
    await sleep(POLL_MS);
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
  // Last-chance fallback: auto-scroll. Try DOWN then UP, but STOP the
  // moment a swipe doesn't move content (frame hash unchanged = end of
  // the scroll view, or nothing scrollable here). The old code swiped
  // 4× each way unconditionally, so a find for an element that simply
  // isn't on this screen burned ~10-16 s of blind scrolling and left
  // the screen at a random offset. Now a non-scrollable / short screen
  // bails after one swipe per direction.
  // Derive scroll center from actual window size so this works on
  // any device, not just iPhone 17 Pro.
  let scrW = DEFAULT_WIN_W;
  let scrH = DEFAULT_WIN_H;
  const wsR = await ctx.client.call('window_size').catch(() => undefined);
  if (wsR && wsR.ok && wsR.data) {
    const d = wsR.data as { w: number; h: number };
    if (d.w > 0 && d.h > 0) {
      scrW = d.w;
      scrH = d.h;
    }
  }
  const cx = Math.round(scrW / 2);
  const cy = Math.round(scrH / 2);
  const dist = Math.round(scrH * 0.34);
  for (const dir of ['DOWN', 'UP'] as const) {
    for (let i = 0; i < 4; i++) {
      const beforeHash = await captureHash(ctx);
      if (dir === 'DOWN') await hidSwipe(ctx.udid, cx, cy + dist / 2, cx, cy - dist / 2, 250);
      else await hidSwipe(ctx.udid, cx, cy - dist / 2, cx, cy + dist / 2, 250);
      await sleep(300);
      await ctx.client.call('wait_commit', { maxMs: 1200, stableMs: 200 }).catch(() => undefined);
      const found = await findOnce(ctx, sel);
      if (found) {
        // Scroll inertia keeps the contentOffset moving for ~400-800 ms
        // after the swipe gesture ends. Wait for the list to fully
        // settle, then re-find to get the current coords.
        await sleep(500);
        await ctx.client.call('wait_commit', { maxMs: 2000, stableMs: 350 }).catch(() => undefined);
        const stable = await findOnce(ctx, sel);
        return stable ?? found;
      }
      // Content didn't move → reached the end of the scroll view (or
      // nothing here scrolls). Stop swiping this direction instead of
      // firing the remaining blind swipes.
      const afterHash = await captureHash(ctx);
      if (afterHash && beforeHash && afterHash === beforeHash) break;
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
