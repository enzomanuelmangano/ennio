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
import { DEFAULT_WIN_H, DEFAULT_WIN_W, interpolateSelector, sleep } from '../../runner/context';
import { resolveRect } from '../../runner/find';
import { isVisible } from '../../runner/visibility';

interface ScrollUntilVisibleCmd {
  scrollUntilVisible:
    | MaestroSelector
    | {
        element: MaestroSelector;
        direction?: string;
        timeout?: number;
        // Accepted for Maestro parity; advisory (speed) or no-op
        // (visibilityPercentage — ennio asserts real on-screen visibility).
        speed?: number;
        visibilityPercentage?: number;
      };
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
      const arg = interpolateSelector(cmd.scrollUntilVisible, ctx);
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
      const isFastDriver = ctx.driver.name === 'fast';
      // True only after a swipe that ran in-process (instant, no
      // momentum). Deliberately false before the first swipe: the
      // found-branch's settle also guards against the PREVIOUS
      // command's animation tail (tab-entry transition) — skipping it
      // fired the tab-bar nudge mid-transition and scrolled nothing
      // (g-pan).
      let noMomentum = false;
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (await isVisible(ctx, target)) {
          await ctx.driver.settleScrollFound(ctx.client, noMomentum);
          // Fast + id targets: replace the geometry-threshold nudges
          // with scroll_to — UIKit's scrollRectToVisible plus the
          // occlusion-aware correction loop in the dylib. Idempotent
          // when the target is already fully visible; deterministic
          // placement when an exact-jump swipe parked it on the
          // visibility boundary or under floating chrome. Tap-time
          // exposure self-heal covers anything that shifts after this.
          if (isFastDriver && target.id) {
            await ctx.client.call('scroll_to', { elementTestID: target.id }).catch(() => undefined);
            await ctx.client
              .call('wait_commit', { maxMs: 600, stableMs: 100 })
              .catch(() => undefined);
            return;
          }
          const rect = await resolveRect(ctx, target);
          if (rect && rect.y + rect.h / 2 > TAB_BAR_THRESHOLD) {
            let nudgeOutcome = { inProcess: true };
            if (dir === 'DOWN') {
              nudgeOutcome = await ctx.driver.swipe(
                ctx.udid,
                SWIPE_CENTER_X,
                SWIPE_CENTER_Y + NUDGE_DISTANCE / 2,
                SWIPE_CENTER_X,
                SWIPE_CENTER_Y - NUDGE_DISTANCE / 2,
                250,
              );
            } else if (dir === 'UP') {
              nudgeOutcome = await ctx.driver.swipe(
                ctx.udid,
                SWIPE_CENTER_X,
                SWIPE_CENTER_Y - NUDGE_DISTANCE / 2,
                SWIPE_CENTER_X,
                SWIPE_CENTER_Y + NUDGE_DISTANCE / 2,
                250,
              );
            }
            await ctx.driver.settleAfterNudge(ctx.client, nudgeOutcome);
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
        const outcome = await ctx.driver.swipe(ctx.udid, x1, y1, x2, y2, 250);
        noMomentum = outcome.inProcess;
        await ctx.driver.settleScrollStep(ctx.client, outcome);
      }
      throw new Error(`scrollUntilVisible: target never visible within ${timeout}ms`);
    },
  );

  registry.register(
    (c): c is MaestroCommand & SwipeCmd => has(c, 'swipe'),
    async (cmd, { ctx }) => {
      const sw = cmd.swipe;
      // Pre-swipe scroll-idle gate. A swipe fired before a pager/
      // scrollview is interactive (e.g. the first carousel swipe right
      // after launchApp, before the onboarding pager mounts) is
      // swallowed — the gesture lands on a still-animating or
      // not-yet-ready surface and the page doesn't advance. ennio's
      // fast actuation hits this where Maestro's gRPC latency didn't.
      // Soft cap; continuous scrollers fall through.
      await ctx.client.call('wait_scroll_idle', { maxMs: 1200 }).catch(() => undefined);
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
        // Firing mechanism is a driver decision: fast tries the
        // in-process trigger_refresh (a setContentOffset jump can't
        // produce the over-scroll drag UIRefreshControl needs), with
        // a real HID drag as fallback; baseline declines and runs the
        // shared path below.
        if (await ctx.driver.tryPullToRefresh(ctx.client, ctx.udid, from, to, sw.duration ?? 400)) {
          return;
        }
      }
      // Drag-to-sort: RN draggable-flatlist needs a ~500 ms hold before
      // drag mode. Long-press-then-drag fires when YAML provides
      // `from: <selector>`.
      const usingSelectorFrom = !!(sw.from && typeof sw.from === 'object');
      if (usingSelectorFrom) {
        const totalDur = sw.duration ?? 1000;
        const holdMs = 800;
        const moveMs = Math.max(500, totalDur - holdMs);
        await ctx.driver.longPressDrag(ctx.udid, from.x, from.y, to.x, to.y, holdMs, moveMs);
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
      await ctx.client.call('wait_commit', { maxMs: 2500, stableMs: 350 }).catch(() => undefined);
      await ctx.client.call('wait_presentation_idle', { maxMs: 800 }).catch(() => undefined);
      // Maestro default swipe is 400 ms. Directional swipes (no
      // explicit coords) are usually navigational — a carousel page
      // turn, a tab change. A fast HID swipe fired in rapid succession
      // (onboarding pagers: swipe → waitForAnimationToEnd → swipe) can
      // be dropped if the previous page glide hadn't committed: the
      // gesture lands mid-transition and the pager ignores it. Verify
      // the screen actually changed; if not, the swipe was a no-op —
      // wait for scroll-idle and fire once more. Guarded to the
      // directional, no-coordinate form so explicit-coordinate swipes
      // (drag-to-dismiss, precise drags) are untouched.
      const verifyAdvance = !sw.start && !sw.end && !!sw.direction;
      const durMs = sw.duration ?? 400;
      const preSwipeHash = verifyAdvance
        ? ((await ctx.client.call('frame_hash').catch(() => undefined))?.data as { hash?: string })
            ?.hash
        : undefined;
      let outcome = await ctx.driver.swipe(ctx.udid, from.x, from.y, to.x, to.y, durMs);
      await ctx.driver.settleAfterSwipe(ctx.client, outcome);
      if (verifyAdvance && preSwipeHash !== undefined) {
        const postHash = (
          (await ctx.client.call('frame_hash').catch(() => undefined))?.data as { hash?: string }
        )?.hash;
        if (postHash !== undefined && postHash === preSwipeHash) {
          // No change — the swipe was swallowed. Let any in-flight
          // glide settle, then retry exactly once.
          await ctx.client.call('wait_scroll_idle', { maxMs: 1200 }).catch(() => undefined);
          outcome = await ctx.driver.swipe(ctx.udid, from.x, from.y, to.x, to.y, durMs);
          await ctx.driver.settleAfterSwipe(ctx.client, outcome);
        }
      }
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
      const outcome = await ctx.driver.swipe(ctx.udid, x1, y1, x2, y2, 250);
      if (outcome.inProcess) {
        await ctx.client.call('wait_commit', { maxMs: 500, stableMs: 100 }).catch(() => undefined);
      } else {
        await sleep(400);
      }
    },
  );
}
