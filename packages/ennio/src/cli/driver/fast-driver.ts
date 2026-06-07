// FastDriver — in-process-first GestureDriver. Wraps HidDriver: every
// gesture either runs through a dylib op whose contract is known
// (activation chain, setContentOffset, tap_tab, trigger_refresh) or
// falls back to a real HID touch. Settle budgets are the trimmed,
// event-driven variants.

import { getDylibClient, trace } from '../hid';
import type { EnnioSocketClient } from '../socket-client';

import type { HidDriver } from './hid-driver';
import type { GestureDriver, PreTapSnapshot, SwipeOutcome, TapOptions } from './types';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function bestEffort(
  client: EnnioSocketClient,
  op: string,
  args?: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
  try {
    const r = await client.call(op, args);
    if (r.ok && r.data) return r.data as Record<string, unknown>;
  } catch {
    /* best effort */
  }
  return undefined;
}

export class FastDriver implements GestureDriver {
  readonly name = 'fast' as const;
  // No collapse: in-process activations fire onPress deterministically
  // per call; mixing one HID doubleTap with a follow-up activation has
  // been seen to drop a press (g-switch-stepper).
  readonly collapsesRepeatTaps = false;
  // Wider gate: trimmed post-settle makes this the main defence
  // against tapping a target mid-entrance-animation. Springs have
  // ~30ms-still frames near inflection points; 3×40ms = 120ms window.
  readonly stabilityGateGapMs = 40;

  private hits = 0;
  private fallbacks = 0;

  constructor(private readonly hid: HidDriver) {}

  /**
   * In-process activation with frame-hash verification. The activation
   * chain can over-report (a strategy that fires into a void); a tap
   * whose effect landed changes the visible tree within a frame or
   * two. No change → phantom → real HID tap.
   */
  async tap(udid: string, x: number, y: number, opts?: TapOptions): Promise<void> {
    const holdSec = opts?.holdSec ?? 0.08;
    const intent = opts?.intent ?? 'press';
    const exposed = opts?.exposed ?? true;
    // Real-touch cases: held taps (activation can't hold), focus taps
    // (onPress ≠ becomeFirstResponder — UISearchBar), and unexposed
    // targets (activation hitTest would fire the occluder).
    if (intent !== 'press' || holdSec > 0.2 || !exposed) {
      await this.hid.tap(udid, x, y, opts);
      return;
    }
    const dy = getDylibClient(udid);
    const preR = await bestEffort(dy, 'frame_hash');
    const preHash = typeof preR?.hash === 'string' ? (preR.hash as string) : '';
    let activated = false;
    try {
      const r = await dy.call('activate_at_point', { x: Math.round(x), y: Math.round(y) });
      activated = !!(r.ok && r.data && (r.data as { ok?: boolean }).ok === true);
      if (activated) {
        const via = (r.data as { via?: string }).via;
        trace(`[fast] activate_at_point handled in-process${via ? ` via=${via}` : ''}`);
      } else {
        trace(
          `[fast] activate_at_point declined (${r.ok ? 'ok:false' : (r.err ?? 'no data')}) → HID fallback`,
        );
      }
    } catch (e) {
      trace(
        `[fast] activate_at_point infra error (${e instanceof Error ? e.message : String(e)}) → HID fallback`,
      );
    }
    if (activated) {
      if (!preHash) {
        this.hits++;
        return; // no baseline to verify against — trust the report
      }
      const chg = await bestEffort(dy, 'wait_hash_change', { sinceHash: preHash, maxMs: 400 });
      if (chg?.ok) {
        this.hits++;
        return;
      }
      trace('[fast] activate_at_point phantom (no hash change) → HID fallback');
    }
    this.fallbacks++;
    await this.hid.tap(udid, x, y, opts);
  }

  async doubleTap(udid: string, x: number, y: number): Promise<void> {
    // No in-process double-tap — needs the real tap-gap timing.
    await this.hid.doubleTap(udid, x, y);
  }

  async press(udid: string, x: number, y: number): Promise<void> {
    await this.hid.press(udid, x, y);
  }

  async swipe(
    udid: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs: number,
  ): Promise<SwipeOutcome> {
    const dy = getDylibClient(udid);
    try {
      const r = await dy.call('swipe_points', {
        x1,
        y1,
        x2,
        y2,
        durationMs: durationMs ?? 250,
      });
      const handled = !!(r.ok && r.data && (r.data as { ok?: boolean }).ok === true);
      if (handled) {
        this.hits++;
        trace('[fast] swipe_points handled in-process');
        return { inProcess: true };
      }
      trace(
        `[fast] swipe_points declined (${r.ok ? 'ok:false' : (r.err ?? 'no data')}) → HID fallback`,
      );
    } catch (e) {
      trace(
        `[fast] swipe_points infra error (${e instanceof Error ? e.message : String(e)}) → HID fallback`,
      );
    }
    this.fallbacks++;
    return this.hid.swipe(udid, x1, y1, x2, y2, durationMs);
  }

  async longPressDrag(
    udid: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    holdMs: number,
    moveMs: number,
  ): Promise<void> {
    await this.hid.longPressDrag(udid, x1, y1, x2, y2, holdMs, moveMs);
  }

  /**
   * Signal-based steadiness via wait_view_steady: model frame
   * unchanged across consecutive ~16ms samples (catches Reanimated /
   * per-frame drivers) + no CAAnimations / presentation≈model on the
   * ancestor chain (catches UIKit animations). Replaces the
   * socket-roundtrip rect-sampling guess.
   */
  async waitTargetSteady(
    client: EnnioSocketClient,
    sel: { id?: string; text?: string },
  ): Promise<boolean> {
    if (!sel.id && !sel.text) return false;
    const args: Record<string, unknown> = { maxMs: 800, steadyFrames: 3 };
    if (sel.id) args.testID = sel.id;
    else args.text = sel.text;
    const r = await bestEffort(client, 'wait_view_steady', args);
    return !!r?.ok;
  }

  /**
   * Text matching a tab-bar item → tap_tab. In-process, deterministic,
   * idempotent — re-tapping the CURRENT tab produces zero visual
   * change, which would otherwise trip the phantom detector into a
   * pointless HID redo.
   */
  async tryTabTap(client: EnnioSocketClient, text: string): Promise<boolean> {
    try {
      const f = await client.call('find_tab', { name: text });
      const d = f.ok
        ? (f.data as { present?: boolean; selected?: boolean } | undefined)
        : undefined;
      if (d?.present) {
        // Re-tapping the CURRENT tab has pop-to-root semantics that a
        // synthetic selectedIndex write can't reproduce faithfully —
        // expo-router/RNScreens resync JS navigation state from their
        // own delegate, and a native-only pop leaves JS believing the
        // pushed route is still focused (08-profile: Orders re-rendered
        // back after the pop). Decline; the real HID tap on the tab
        // button drives the framework's own handler.
        if (d.selected) return false;
        const t = await client.call('tap_tab', { name: text });
        if (t.ok && t.data && (t.data as { tapped: boolean }).tapped) {
          this.hits++;
          return true;
        }
      }
    } catch {
      /* fall through */
    }
    return false;
  }

  /**
   * Pull-to-refresh: a setContentOffset jump can't trigger
   * UIRefreshControl (needs a real over-scroll drag + release). Try
   * trigger_refresh (fires beginRefreshing + valueChanged in-process);
   * else mirror the baseline HID over-scroll sequence exactly.
   */
  async tryPullToRefresh(
    client: EnnioSocketClient,
    udid: string,
    from: { x: number; y: number },
    to: { x: number; y: number },
    durationMs: number,
  ): Promise<boolean> {
    const r = await bestEffort(client, 'trigger_refresh', {
      x: Math.round(from.x),
      y: Math.round(from.y),
    });
    if (r?.ok) {
      this.hits++;
      await bestEffort(client, 'wait_commit', { maxMs: 800, stableMs: 100 });
      return true;
    }
    this.fallbacks++;
    await bestEffort(client, 'wait_commit', { maxMs: 2500, stableMs: 350 });
    await bestEffort(client, 'wait_presentation_idle', { maxMs: 800 });
    await this.hid.swipe(udid, from.x, from.y, to.x, to.y, durationMs);
    await sleep(500);
    await bestEffort(client, 'wait_commit', { maxMs: 1000, stableMs: 150 });
    return true;
  }

  /**
   * Event-driven post-tap settle. wait_hash_change returns the instant
   * the visible tree differs (the tap's effect landed); a tight commit
   * cap smooths mid-layout reads. Animation tails are absorbed by the
   * NEXT command's own guards (pre-tap animations poll, stability
   * gate, assert polling). On screens with perpetual animation the
   * hash never stabilises, so a long stable window would just burn its
   * full budget.
   */
  async settleAfterTap(client: EnnioSocketClient, snap: PreTapSnapshot): Promise<void> {
    await bestEffort(client, 'wait_hash_change', { sinceHash: snap.preTapHash, maxMs: 500 });
    if (snap.nextEditsField) {
      await bestEffort(client, 'wait_react_commit', { sinceMs: snap.reactSinceMs, maxMs: 250 });
    }
    // Dismissal-payload settle: when the tap kicked off a VC dismissal
    // (cropper "Done", sheet row), the dismissal's PAYLOAD often lands
    // as a react commit AFTER the transition ends — bsky's avatar crop
    // delivers the image to JS ~1-2 s post-dismissal, and a Save fired
    // before that commit silently drops the avatar. Chain the signals:
    // only when a presentation transition was actually in flight
    // (presentation-idle had to wait), also wait for the next react
    // commit since the tap. Zero cost on the common no-transition path.
    const pi = await bestEffort(client, 'wait_presentation_idle', { maxMs: 1500 });
    const transitionWaitMs = Number((pi as { elapsedMs?: number } | undefined)?.elapsedMs ?? 0);
    if (transitionWaitMs > 50) {
      await bestEffort(client, 'wait_react_commit', { sinceMs: snap.reactSinceMs, maxMs: 2500 });
    }
    await bestEffort(client, 'wait_commit', { maxMs: 250, stableMs: 60 });
  }

  async settleAfterSwipe(client: EnnioSocketClient, outcome: SwipeOutcome): Promise<void> {
    if (!outcome.inProcess) {
      // Real momentum to wait out.
      await this.hid.settleAfterSwipe(client, outcome);
      return;
    }
    await bestEffort(client, 'wait_commit', { maxMs: 600, stableMs: 100 });
  }

  async settleScrollStep(client: EnnioSocketClient, outcome: SwipeOutcome): Promise<void> {
    if (!outcome.inProcess) {
      await this.hid.settleScrollStep(client, outcome);
      return;
    }
    await bestEffort(client, 'wait_commit', { maxMs: 800, stableMs: 100 });
  }

  async settleScrollFound(client: EnnioSocketClient, noMomentum: boolean): Promise<void> {
    if (!noMomentum) {
      await this.hid.settleScrollFound(client, noMomentum);
      return;
    }
    await bestEffort(client, 'wait_commit', { maxMs: 800, stableMs: 100 });
  }

  async settleAfterNudge(client: EnnioSocketClient, outcome: SwipeOutcome): Promise<void> {
    if (!outcome.inProcess) {
      await this.hid.settleAfterNudge(client, outcome);
      return;
    }
    await bestEffort(client, 'wait_commit', { maxMs: 600, stableMs: 100 });
  }

  stats(): { hits: number; fallbacks: number } {
    return { hits: this.hits, fallbacks: this.fallbacks };
  }

  resetStats(): void {
    this.hits = 0;
    this.fallbacks = 0;
  }
}
