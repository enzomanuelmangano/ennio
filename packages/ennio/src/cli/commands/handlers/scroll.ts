// Scroll + swipe handlers.
//
// scrollUntilVisible: poll-and-swipe until target is visible, with a
// tab-bar-overlap nudge once visible.
// swipe: most complex — handles direction / start+end / from-selector
// forms, pull-to-refresh dedupe, drag-to-sort long-press recognizer.
// scroll: simple direction-based mid-screen swipe.

import { CommandRegistry } from '../../core/command-registry';
import type { MaestroCommand, MaestroSelector } from '../../maestro-parser';
import { normalizeSelector } from '../../maestro-parser';
import { swipe as hidSwipe, longPressDrag as hidLongPressDrag } from '../../hid';
import { DEFAULT_WIN_H, DEFAULT_WIN_W, sleep } from '../../runner/context';
import { resolveRect } from '../../runner/find';
import { isVisible } from '../../runner/visibility';

interface ScrollUntilVisibleCmd {
  scrollUntilVisible:
    | MaestroSelector
    | { element: MaestroSelector; direction?: string; timeout?: number };
}
interface SwipeCmd {
  swipe: {
    direction?: string;
    start?: string | { x: number; y: number };
    end?: string | { x: number; y: number };
    from?: unknown;
    duration?: number;
  };
}
interface ScrollCmd {
  scroll: { direction?: string };
}

function has<T extends string>(
  cmd: MaestroCommand,
  key: T,
): cmd is MaestroCommand & Record<T, unknown> {
  return typeof cmd === 'object' && cmd !== null && key in cmd;
}

export function registerScrollHandlers(registry: CommandRegistry): void {
  registry.register(
    (c): c is MaestroCommand & ScrollUntilVisibleCmd => has(c, 'scrollUntilVisible'),
    async (cmd, { ctx }) => {
      const arg = cmd.scrollUntilVisible;
      const target = 'element' in arg ? arg.element : (arg as MaestroSelector);
      const dir = ('direction' in arg && arg.direction ? arg.direction : 'DOWN').toUpperCase();
      const timeout = ('timeout' in arg && arg.timeout) || 15000;
      const wsz = await ctx.client.call('window_size').catch(() => undefined);
      const wd = (wsz?.data as { w?: number; h?: number }) ?? {};
      const winW = wd.w ?? DEFAULT_WIN_W;
      const winH = wd.h ?? DEFAULT_WIN_H;
      const SWIPE_CENTER_X = Math.round(winW / 2);
      // Below vertical midpoint to avoid the nav-bar header area.
      const SWIPE_CENTER_Y = Math.round(winH / 2);
      // ~30% of screen per swipe — enough scroll without overshoot.
      const SWIPE_DISTANCE = Math.round((winH * 3) / 10);
      // Small push to move element above the tab bar.
      const NUDGE_DISTANCE = Math.round(winH / 6);
      // Bottom 20% of screen overlaps with the tab bar.
      const TAB_BAR_THRESHOLD = (winH * 4) / 5;
      // Fast mode: swipes handled in-process are setContentOffset
      // jumps — no momentum to wait out, so the fixed sleeps drop and
      // the stable windows shrink. HID-fallback swipes keep the full
      // settle (real deceleration). `lastSwipeInProc` tracks which
      // path the most recent swipe took.
      const F = !!ctx.fast;
      // True when there is no scroll momentum in flight: before any
      // swipe, or after an in-process (instant) one.
      let lastSwipeInProc = true;
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (await isVisible(ctx, target)) {
          const quick = F && lastSwipeInProc;
          if (!quick) await sleep(600);
          await ctx.client
            .call(
              'wait_commit',
              quick ? { maxMs: 800, stableMs: 100 } : { maxMs: 2000, stableMs: 300 },
            )
            .catch(() => undefined);
          const rect = await resolveRect(ctx, target);
          if (rect && rect.y + rect.h / 2 > TAB_BAR_THRESHOLD) {
            let nudgeInProc = true;
            if (dir === 'DOWN') {
              nudgeInProc = await hidSwipe(
                ctx.udid,
                SWIPE_CENTER_X,
                SWIPE_CENTER_Y + NUDGE_DISTANCE / 2,
                SWIPE_CENTER_X,
                SWIPE_CENTER_Y - NUDGE_DISTANCE / 2,
                250,
              );
            } else if (dir === 'UP') {
              nudgeInProc = await hidSwipe(
                ctx.udid,
                SWIPE_CENTER_X,
                SWIPE_CENTER_Y - NUDGE_DISTANCE / 2,
                SWIPE_CENTER_X,
                SWIPE_CENTER_Y + NUDGE_DISTANCE / 2,
                250,
              );
            }
            const quickNudge = F && nudgeInProc;
            if (!quickNudge) await sleep(500);
            await ctx.client
              .call(
                'wait_commit',
                quickNudge ? { maxMs: 600, stableMs: 100 } : { maxMs: 1500, stableMs: 200 },
              )
              .catch(() => undefined);
          }
          return;
        }
        const dist = SWIPE_DISTANCE;
        let x1 = SWIPE_CENTER_X,
          y1 = SWIPE_CENTER_Y,
          x2 = SWIPE_CENTER_X,
          y2 = SWIPE_CENTER_Y;
        if (dir === 'DOWN') {
          y1 = SWIPE_CENTER_Y + dist / 2;
          y2 = SWIPE_CENTER_Y - dist / 2;
        } else if (dir === 'UP') {
          y1 = SWIPE_CENTER_Y - dist / 2;
          y2 = SWIPE_CENTER_Y + dist / 2;
        } else if (dir === 'LEFT') {
          x1 = SWIPE_CENTER_X + dist / 2;
          x2 = SWIPE_CENTER_X - dist / 2;
        } else if (dir === 'RIGHT') {
          x1 = SWIPE_CENTER_X - dist / 2;
          x2 = SWIPE_CENTER_X + dist / 2;
        }
        lastSwipeInProc = await hidSwipe(ctx.udid, x1, y1, x2, y2, 250);
        const quick = F && lastSwipeInProc;
        await ctx.client
          .call('wait_commit', quick ? { maxMs: 800, stableMs: 100 } : { maxMs: 2000, stableMs: 300 })
          .catch(() => undefined);
      }
      throw new Error(`scrollUntilVisible: target never visible within ${timeout}ms`);
    },
  );

  registry.register(
    (c): c is MaestroCommand & SwipeCmd => has(c, 'swipe'),
    async (cmd, { ctx }) => {
      const sw = cmd.swipe;
      // Query real device dims so `%` coords land on actual pixels —
      // hardcoded 390×844 was 12-30 pt off on iPhone 17 Pro / Air / iPad.
      const sizeResp = await ctx.client.call('window_size').catch(() => undefined);
      const sizeData = (sizeResp?.data as { w?: number; h?: number }) ?? {};
      const winW = sizeData.w && sizeData.w > 0 ? sizeData.w : 390;
      const winH = sizeData.h && sizeData.h > 0 ? sizeData.h : 844;
      const parseCoord = (
        val: string | { x: number; y: number } | undefined,
        fallback: { x: number; y: number },
      ): { x: number; y: number } => {
        if (!val) return fallback;
        if (typeof val === 'string') {
          const [xs, ys] = val.split(',').map((p) => p.trim());
          let x = parseFloat(xs);
          let y = parseFloat(ys);
          if (xs.endsWith('%') || (x <= 1 && xs.length > 0)) x = (x > 1 ? x / 100 : x) * winW;
          if (ys.endsWith('%') || (y <= 1 && ys.length > 0)) y = (y > 1 ? y / 100 : y) * winH;
          return { x, y };
        }
        return val;
      };
      let from = { x: winW / 2, y: winH / 2 };
      let to = { x: winW / 2, y: winH / 2 };
      // Maestro idiom: `from: <selector>` resolves the selector and
      // uses its centre as the drag start. Row-spacing detection looks
      // for a sibling instance with the same testID so dist is measured
      // live (works on any draggable-flatlist row height).
      let rowSpacing: number | null = null;
      if (sw.from && typeof sw.from === 'object') {
        const fromSel = normalizeSelector(sw.from as MaestroSelector);
        const rect = await resolveRect(ctx, fromSel);
        if (rect) {
          from = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
        }
        if (fromSel.id) {
          const second = await ctx.client
            .call('find_by_testid_nth', { testID: fromSel.id, index: 1 })
            .catch(() => undefined);
          if (second && second.ok && second.data) {
            const sd = second.data as { y: number; h: number };
            const r0Center = rect ? rect.y + rect.h / 2 : null;
            const r1Center = sd.y + sd.h / 2;
            if (r0Center !== null) rowSpacing = Math.abs(r1Center - r0Center);
          }
        }
      }
      if (sw.start || sw.end) {
        from = parseCoord(sw.start, from);
        to = parseCoord(sw.end, to);
      } else if (sw.direction) {
        const d = sw.direction.toUpperCase();
        const usingSelectorFrom = !!(sw.from && typeof sw.from === 'object');
        // Drag dist = measured row spacing × 1.6. Margin against
        // rounding without overshooting two rows.
        const dist = rowSpacing ? Math.round(rowSpacing * 1.6) : 160;
        if (usingSelectorFrom) {
          if (d === 'DOWN') to = { x: from.x, y: from.y + dist };
          else if (d === 'UP') to = { x: from.x, y: from.y - dist };
          else if (d === 'LEFT') to = { x: from.x - dist, y: from.y };
          else if (d === 'RIGHT') to = { x: from.x + dist, y: from.y };
        } else {
          // No selector — full-screen swing. 700 pt covers a bottom-
          // sheet drag-to-dismiss with margin for tab/page scrolls.
          const full = 700;
          if (d === 'DOWN') {
            // Start ABOVE the sheet's grab handle (y~80 on iOS 26
            // UISheetPresentationController) so drag-to-dismiss wins
            // over the inner scroll view's eat-as-content-scroll.
            from = { x: winW / 2, y: 60 };
            to = { x: winW / 2, y: 60 + full };
          } else if (d === 'UP') {
            from = { x: winW / 2, y: winH - 120 };
            to = { x: winW / 2, y: winH - 120 - full };
          } else if (d === 'LEFT') {
            from = { x: winW - 40, y: winH / 2 };
            to = { x: winW - 40 - full, y: winH / 2 };
          } else if (d === 'RIGHT') {
            from = { x: 40, y: winH / 2 };
            to = { x: 40 + full, y: winH / 2 };
          }
        }
      }
      // Pull-to-refresh dedupe: skip if a UIRefreshControl is already
      // spinning. Without this, a YAML "warm-up + trigger" pattern
      // fires onRefresh twice.
      const dy = to.y - from.y;
      const dx = Math.abs(to.x - from.x);
      const isPullToRefresh = dy > 100 && dx < 40 && from.y < winH * 0.4;
      if (isPullToRefresh) {
        const now = Date.now();
        try {
          const r = await ctx.client.call('is_refreshing', {
            x: Math.round(from.x),
            y: Math.round(from.y),
          });
          if (r.ok && r.data && (r.data as { refreshing: boolean }).refreshing) {
            ctx.lastRefreshAtMs = now;
            await sleep(200);
            return;
          }
        } catch {
          /* fall through */
        }
        if (ctx.lastRefreshAtMs && now - ctx.lastRefreshAtMs < 3000) {
          await sleep(200);
          return;
        }
        ctx.lastRefreshAtMs = now;
      }
      // Drag-to-sort: RN draggable-flatlist needs a ~500 ms hold before
      // drag mode. Long-press-then-drag fires when YAML provides
      // `from: <selector>`.
      const usingSelectorFrom = !!(sw.from && typeof sw.from === 'object');
      if (usingSelectorFrom) {
        const totalDur = sw.duration ?? 1000;
        const holdMs = 800;
        const moveMs = Math.max(500, totalDur - holdMs);
        await hidLongPressDrag(ctx.udid, from.x, from.y, to.x, to.y, holdMs, moveMs);
        await sleep(500);
        await ctx.client.call('wait_commit', { maxMs: 1000, stableMs: 150 }).catch(() => undefined);
        return;
      }
      // Pre-swipe settle: wait for animation to end so the gesture
      // lands on a stable target (RN-Nav push spring, FlatList layout,
      // expo-router tab change). stableMs 350 / maxMs 2500 covers
      // the typical worst case. NOT trimmed in fast mode — this wait
      // is what makes the gesture (and the in-process hitTest) land on
      // the right scroll view; firing early just downgrades the swipe
      // to a momentum HID fallback that costs more than the wait.
      const F = !!ctx.fast;
      await ctx.client.call('wait_commit', { maxMs: 2500, stableMs: 350 }).catch(() => undefined);
      await ctx.client.call('wait_presentation_idle', { maxMs: 800 }).catch(() => undefined);
      // Maestro default swipe is 400 ms.
      const inProc = await hidSwipe(ctx.udid, from.x, from.y, to.x, to.y, sw.duration ?? 400);
      // Trim the post-swipe settle only when the swipe ran in-process
      // (instant setContentOffset, no momentum). An HID-fallback swipe
      // has real deceleration the find would otherwise race against.
      const quick = F && inProc;
      if (!quick) await sleep(500);
      await ctx.client
        .call('wait_commit', quick ? { maxMs: 600, stableMs: 100 } : { maxMs: 1000, stableMs: 150 })
        .catch(() => undefined);
    },
  );

  registry.register(
    (c): c is MaestroCommand & ScrollCmd => has(c, 'scroll'),
    async (cmd, { ctx }) => {
      const dir = (cmd.scroll.direction || 'DOWN').toLowerCase();
      // Centre swipe approximation. Window size assumed 390x844.
      const cx = 195;
      const cy = 422;
      const dist = 300;
      let x1 = cx,
        y1 = cy,
        x2 = cx,
        y2 = cy;
      if (dir === 'down') {
        y1 = cy + dist / 2;
        y2 = cy - dist / 2;
      } else if (dir === 'up') {
        y1 = cy - dist / 2;
        y2 = cy + dist / 2;
      } else if (dir === 'left') {
        x1 = cx + dist / 2;
        x2 = cx - dist / 2;
      } else if (dir === 'right') {
        x1 = cx - dist / 2;
        x2 = cx + dist / 2;
      }
      const inProc = await hidSwipe(ctx.udid, x1, y1, x2, y2, 250);
      if (ctx.fast && inProc) {
        await ctx.client.call('wait_commit', { maxMs: 500, stableMs: 100 }).catch(() => undefined);
      } else {
        await sleep(400);
      }
    },
  );
}
