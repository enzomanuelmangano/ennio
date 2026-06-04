// HidDriver — the baseline GestureDriver. Every gesture is a real
// IOHIDEvent via the in-house host helper; settle budgets are the
// legacy parity-proven values (moved verbatim from the pre-driver
// commands/handlers/tap.ts and scroll.ts).

import * as hid from '../hid';
import type { EnnioSocketClient } from '../socket-client';

import type { GestureDriver, PreTapSnapshot, SwipeOutcome, TapOptions } from './types';

const POST_TAP_SETTLE_MS = parseInt(process.env.ENNIO_TAP_SETTLE_MS || '800', 10);

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

export class HidDriver implements GestureDriver {
  readonly name = 'hid' as const;
  readonly collapsesRepeatTaps = true;
  readonly stabilityGateGapMs = 10;

  async tap(udid: string, x: number, y: number, opts?: TapOptions): Promise<void> {
    await hid.tap(udid, x, y, opts?.holdSec);
  }

  async doubleTap(udid: string, x: number, y: number): Promise<void> {
    await hid.doubleTap(udid, x, y);
  }

  async press(udid: string, x: number, y: number): Promise<void> {
    await hid.press(udid, x, y);
  }

  async swipe(
    udid: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs: number,
  ): Promise<SwipeOutcome> {
    await hid.swipe(udid, x1, y1, x2, y2, durationMs);
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
    await hid.longPressDrag(udid, x1, y1, x2, y2, holdMs, moveMs);
  }

  async waitTargetSteady(): Promise<boolean> {
    // Baseline uses the legacy CLI-side rect-sampling gate.
    return false;
  }

  async tryTabTap(): Promise<boolean> {
    // Baseline keeps the tab probe in execTapOn's retap loop only.
    return false;
  }

  async tryPullToRefresh(): Promise<boolean> {
    // Baseline pull-to-refresh runs the shared handler path.
    return false;
  }

  /**
   * Legacy post-tap settle, verbatim. Branches on whether an RN commit
   * observer is attached.
   */
  async settleAfterTap(client: EnnioSocketClient, snap: PreTapSnapshot): Promise<void> {
    const { preTapHash, reactAttach, reactSinceMs, nextEditsField } = snap;
    if (reactAttach !== 'none') {
      // Block until the frame hash differs from pre-tap AND no
      // animation is in flight — two coupled signals.
      let committed = false;
      const deadline = Date.now() + 1500;
      while (Date.now() < deadline) {
        const hashData = await bestEffort(client, 'frame_hash');
        const cur = typeof hashData?.hash === 'string' ? (hashData.hash as string) : '';
        if (cur !== preTapHash) {
          const animData = await bestEffort(client, 'animations_active');
          if (!animData?.active) {
            if (nextEditsField) {
              await bestEffort(client, 'wait_react_commit', { sinceMs: reactSinceMs, maxMs: 250 });
            }
            committed = true;
            break;
          }
        }
      }
      if (!committed) {
        // No commit fired — likely a no-op tap; fall back to hash-change.
        await bestEffort(client, 'wait_hash_change', { sinceHash: preTapHash, maxMs: 400 });
      }
      await bestEffort(client, 'wait_commit', { maxMs: 1500, stableMs: 200 });
      return;
    }

    // No observer: event-driven hash-change settle.
    const chg = await bestEffort(client, 'wait_hash_change', {
      sinceHash: preTapHash,
      maxMs: 600,
    });
    if (!chg?.ok) {
      const animData = await bestEffort(client, 'animations_active');
      const settleMs = animData?.active ? POST_TAP_SETTLE_MS : Math.min(POST_TAP_SETTLE_MS, 400);
      await sleep(settleMs);
    }
    await bestEffort(client, 'wait_commit', { maxMs: 800, stableMs: 350 });
    // UIKit-level tail: modal-dismiss / RN-Nav interactive pop
    // transitions that don't fire React commits.
    await bestEffort(client, 'wait_presentation_idle', { maxMs: 500 });
  }

  async settleAfterSwipe(client: EnnioSocketClient, _outcome?: SwipeOutcome): Promise<void> {
    await sleep(500);
    await bestEffort(client, 'wait_commit', { maxMs: 1000, stableMs: 150 });
  }

  async settleScrollStep(client: EnnioSocketClient, _outcome?: SwipeOutcome): Promise<void> {
    await bestEffort(client, 'wait_commit', { maxMs: 2000, stableMs: 300 });
  }

  async settleScrollFound(client: EnnioSocketClient, _noMomentum?: boolean): Promise<void> {
    await sleep(600);
    await bestEffort(client, 'wait_commit', { maxMs: 2000, stableMs: 300 });
  }

  async settleAfterNudge(client: EnnioSocketClient, _outcome?: SwipeOutcome): Promise<void> {
    await sleep(500);
    await bestEffort(client, 'wait_commit', { maxMs: 1500, stableMs: 200 });
  }

  stats(): { hits: number; fallbacks: number } {
    return { hits: 0, fallbacks: 0 };
  }

  resetStats(): void {
    /* no fast-path stats in HID mode */
  }
}
