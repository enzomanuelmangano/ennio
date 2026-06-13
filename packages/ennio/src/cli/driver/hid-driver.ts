// HidDriver — the baseline GestureDriver. Every gesture is a real
// IOHIDEvent via the in-house host helper; settle budgets are the
// legacy parity-proven values (moved verbatim from the pre-driver
// commands/handlers/tap.ts and scroll.ts).

import * as hid from '../hid';
import type { EnnioSocketClient } from '../socket-client';

import type { GestureDriver, PreTapSnapshot, SwipeOutcome, TapOptions } from './types';

const POST_TAP_SETTLE_MS = parseInt(process.env.ENNIO_TAP_SETTLE_MS || '800', 10);

// Post-swipe settle budgets. Defaults are the parity-proven e2e values; a
// pre-commit pause plus a frame-stability wait so the next assertion reads
// a settled screen. Fast, high-throughput callers (the MCP loop, a game
// agent) that read state immediately after every swipe don't need the
// conservative budget — they can trim it via env. Lower bound is 0.
// Opt-in post-tap presentation-begin grace window (see settleAfterTap).
// 0 (default) = disabled; CI sets ~800ms to absorb VM scheduling lag
// between a dismiss and the chained present.
const PRESENT_GRACE_MS = parseInt(process.env.ENNIO_PRESENT_GRACE_MS ?? '0', 10) || 0;

const SWIPE_SETTLE_PAUSE_MS = parseInt(process.env.ENNIO_SWIPE_SETTLE_MS ?? '500', 10);
const SWIPE_SETTLE_MAX_MS = parseInt(process.env.ENNIO_SWIPE_COMMIT_MAX_MS ?? '1000', 10);
const SWIPE_SETTLE_STABLE_MS = parseInt(process.env.ENNIO_SWIPE_COMMIT_STABLE_MS ?? '150', 10);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Sub-phase timing for the settle legs, same wire format as the runner's
// timedAsync ("[phase] <name> <ms>") so one parser reads both.
const PHASE_TRACE = process.env.ENNIO_PHASE_TRACE === '1';
async function tracedLeg<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (!PHASE_TRACE) return fn();
  const t0 = Date.now();
  try {
    return await fn();
  } finally {
    process.stderr.write(`[phase] ${name} ${Date.now() - t0}ms\n`);
  }
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
      await tracedLeg('settle.hashAnimLoop', async () => {
        const deadline = Date.now() + 1500;
        while (Date.now() < deadline) {
          const hashData = await bestEffort(client, 'frame_hash');
          const cur = typeof hashData?.hash === 'string' ? (hashData.hash as string) : '';
          if (cur !== preTapHash) {
            const animData = await bestEffort(client, 'animations_active');
            if (!animData?.active) {
              if (nextEditsField) {
                await bestEffort(client, 'wait_react_commit', {
                  sinceMs: reactSinceMs,
                  maxMs: 250,
                });
              }
              committed = true;
              break;
            }
          }
          // Pace the poll — without this the loop saturates the control
          // socket with back-to-back frame_hash round-trips (hundreds per
          // tap on a slow commit). 30ms ≈ two display frames.
          await sleep(30);
        }
      });
      if (!committed) {
        // No commit fired — likely a no-op tap; fall back to hash-change.
        await tracedLeg('settle.noCommitHashFallback', () =>
          bestEffort(client, 'wait_hash_change', { sinceHash: preTapHash, maxMs: 400 }),
        );
      }
      // Dismissal-payload settle: when the tap kicked off a VC
      // dismissal (cropper "Done", sheet row), the dismissal's PAYLOAD
      // often lands as a react commit AFTER the transition ends —
      // bsky's avatar crop delivers the image to JS ~1-2 s
      // post-dismissal, and a Save fired before that commit silently
      // drops the avatar. Chain the signals: only when a presentation
      // transition was actually in flight (presentation-idle had to
      // wait), also wait for the next react commit since the tap.
      // Zero cost on the common no-transition path.
      const pi = await tracedLeg('settle.presentationIdle', () =>
        bestEffort(client, 'wait_presentation_idle', { maxMs: 1500 }),
      );
      let transitionWaitMs = Number((pi as { elapsedMs?: number } | undefined)?.elapsedMs ?? 0);
      // Presentation-begin grace (opt-in, ENNIO_PRESENT_GRACE_MS): on a
      // slow host (CI VM) a tap that chains DISMISS -> PRESENT (menu item
      // opening a composer) can be probed in the dead gap between the two
      // — presentation looks idle, the settle exits, and the next step
      // types into a screen whose new VC hasn't mounted yet. When no
      // transition was observed, poll briefly for one to START; the
      // moment it does, hand back to the normal presentation-idle +
      // react-commit chain.
      if (transitionWaitMs <= 50 && PRESENT_GRACE_MS > 0) {
        await tracedLeg('settle.presentGrace', async () => {
          const deadline = Date.now() + PRESENT_GRACE_MS;
          while (Date.now() < deadline) {
            const probe = await bestEffort(client, 'wait_presentation_idle', { maxMs: 60 });
            const waited = Number((probe as { elapsedMs?: number } | undefined)?.elapsedMs ?? 0);
            if (waited > 30) {
              // A transition started (and may still be running) — wait it
              // out fully, then treat it like the normal post-transition
              // case below. Force past the >50 gate: the observed probe
              // wait can legitimately be 31-50ms while the transition is
              // real (we caught its tail end).
              await bestEffort(client, 'wait_presentation_idle', { maxMs: 1500 });
              transitionWaitMs = Math.max(waited, 51);
              return;
            }
            await sleep(60);
          }
        });
      }
      if (transitionWaitMs > 50) {
        await tracedLeg('settle.postTransitionReactCommit', () =>
          bestEffort(client, 'wait_react_commit', { sinceMs: reactSinceMs, maxMs: 2500 }),
        );
      }
      // On the committed + no-transition path, hashAnimLoop has already
      // confirmed the frame-hash changed and animations are idle, so the
      // full 200ms stability window is mostly redundant tail latency
      // (~200ms/tap; wait_commit is the single largest socket cost in the
      // suite). Trim it to 140ms there; keep the full 200ms for a real
      // transition or the uncertain no-commit case.
      const finalStableMs = transitionWaitMs > 50 || !committed ? 200 : 140;
      await tracedLeg('settle.finalWaitCommit', () =>
        bestEffort(client, 'wait_commit', { maxMs: 1500, stableMs: finalStableMs }),
      );
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
    if (SWIPE_SETTLE_PAUSE_MS > 0) await sleep(SWIPE_SETTLE_PAUSE_MS);
    await bestEffort(client, 'wait_commit', {
      maxMs: SWIPE_SETTLE_MAX_MS,
      stableMs: SWIPE_SETTLE_STABLE_MS,
    });
  }

  async settleScrollStep(client: EnnioSocketClient, _outcome?: SwipeOutcome): Promise<void> {
    // Intermediate scroll step: the loop re-checks visibility and swipes
    // again, so the list only needs to settle enough to read the next
    // position — not the full 300ms stability the FOUND settle uses. A
    // shorter window cuts ~200ms off every scroll swipe across the
    // scroll-to-find flows; an under-settled read just triggers another
    // swipe (the loop is self-correcting) and tap-time exposure self-heal
    // covers the final placement.
    await bestEffort(client, 'wait_commit', { maxMs: 1200, stableMs: 120 });
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
