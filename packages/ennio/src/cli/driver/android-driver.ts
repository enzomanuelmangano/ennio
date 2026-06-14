// AndroidDriver — the in-process gesture driver. Every tap/swipe is a
// MotionEvent dispatched inside the app by the EnnioAgent (the Android
// equivalent of iOS in-process activation), sent over the control socket.
// There is no host HID helper and no HID-vs-fast split: synthesized
// MotionEvents go through the same input pipeline RN/RNGH read.
//
// Settle is hash-based throughout: Android has no RN-commit observer, so
// the driver waits on frame-hash change + stability (the OnPreDrawListener
// signal the agent maintains), mirroring HidDriver's no-observer branch.

import { getDylibClient } from '../hid';
import type { EnnioSocketClient } from '../socket-client';

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

export class AndroidDriver implements GestureDriver {
  readonly name = 'android' as const;
  // RN's double-tap window doesn't apply to MotionEvent dispatch the way
  // the HID tap-gap does; keep consecutive taps distinct.
  readonly collapsesRepeatTaps = false;
  // In-process MotionEvent dispatch at the exposed target's coords —
  // onPress fires synchronously, no physical miss. The self-heal retap
  // would only double-fire it.
  readonly deterministicTaps = true;
  // The agent owns the pre-draw frame hash, so the CLI-side stability gate
  // can sample wide.
  readonly stabilityGateGapMs = 16;

  async tap(udid: string, x: number, y: number, opts?: TapOptions): Promise<void> {
    await getDylibClient(udid).call('tap', { x, y, holdMs: (opts?.holdSec ?? 0.06) * 1000 });
  }

  async doubleTap(udid: string, x: number, y: number): Promise<void> {
    await getDylibClient(udid).call('double_tap', { x, y });
  }

  async press(udid: string, x: number, y: number): Promise<void> {
    await getDylibClient(udid).call('tap', { x, y, holdMs: 50 });
  }

  async swipe(
    udid: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs: number,
  ): Promise<SwipeOutcome> {
    await getDylibClient(udid).call('swipe', {
      x1,
      y1,
      x2,
      y2,
      durMs: Math.max(50, durationMs || 250),
    });
    return { inProcess: false };
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
    await getDylibClient(udid).call('long_press_drag', { x1, y1, x2, y2, holdMs, moveMs });
  }

  async waitTargetSteady(): Promise<boolean> {
    // No dedicated steadiness op yet — caller runs its rect-sampling gate.
    return false;
  }

  /**
   * Route a text tap that names a native bottom-tab through the agent's
   * tap_tab op (performClick on the Material BottomNavigationItemView).
   * Far more reliable than a MotionEvent at the item centre, and
   * idempotent on the current tab. Returns false when the text doesn't
   * name a tab, so the normal find→tap path still runs for everything else.
   */
  async tryTabTap(client: EnnioSocketClient, text: string): Promise<boolean> {
    const r = await client.call('tap_tab', { name: text }).catch(() => undefined);
    return !!(r && r.ok && r.data && (r.data as { tapped?: boolean }).tapped);
  }

  async tryPullToRefresh(): Promise<boolean> {
    return false;
  }

  async settleAfterTap(client: EnnioSocketClient, snap: PreTapSnapshot): Promise<void> {
    const changed = await bestEffort(client, 'wait_hash_change', {
      sinceHash: snap.preTapHash,
      maxMs: 700,
    });
    if (!changed?.ok) {
      const anim = await bestEffort(client, 'animations_active');
      await sleep(anim?.active ? 400 : 150);
    }
    await bestEffort(client, 'wait_commit', { maxMs: 1000, stableMs: 150 });
  }

  async settleAfterSwipe(client: EnnioSocketClient): Promise<void> {
    await sleep(250);
    await bestEffort(client, 'wait_commit', { maxMs: 1200, stableMs: 150 });
  }

  async settleScrollStep(client: EnnioSocketClient): Promise<void> {
    await bestEffort(client, 'wait_commit', { maxMs: 1500, stableMs: 200 });
  }

  async settleScrollFound(client: EnnioSocketClient): Promise<void> {
    await sleep(300);
    await bestEffort(client, 'wait_commit', { maxMs: 1500, stableMs: 200 });
  }

  async settleAfterNudge(client: EnnioSocketClient): Promise<void> {
    await sleep(250);
    await bestEffort(client, 'wait_commit', { maxMs: 1200, stableMs: 150 });
  }

  stats(): { hits: number; fallbacks: number } {
    return { hits: 0, fallbacks: 0 };
  }

  resetStats(): void {
    /* no fast-path stats */
  }
}
