// GestureDriver — the mode abstraction. Handlers and the tap pipeline
// express INTENT (tap to press, tap to focus, swipe, settle after X);
// the driver picks the MECHANISM (in-process dylib op vs idb HID) and
// owns the settle budgets that go with it.
//
// Two implementations:
//   HidDriver  — baseline. Every gesture is a real IOHIDEvent via idb;
//                settle budgets are the legacy, parity-proven values.
//   FastDriver — in-process first (activation chain, setContentOffset,
//                tap_tab, trigger_refresh), wraps HidDriver for
//                per-gesture fallback; trimmed event-driven settle.
//
// This replaces the scattered `if (ctx.fast)` checks: mode is decided
// once (EnnioRunner constructs the driver), behavior differences live
// side-by-side in the two driver classes.

import type { EnnioSocketClient } from '../socket-client';

/** Why this tap is happening — drives mechanism choice. */
export type TapIntent =
  | 'press' // fire the target's press handler
  | 'focus' // must deliver real first-responder focus (next cmd types)
  | 'longPress'; // held touch, needs real timing

export interface TapOptions {
  intent?: TapIntent;
  /** Seconds to hold (longPress). Default ~0.08. */
  holdSec?: number;
  /**
   * The exposure check confirmed hit-testing at the target's center
   * lands inside the target's subtree. When false, in-process
   * activation would fire the OCCLUDER — drivers must use a real
   * touch. Defaults to true (callers that didn't check).
   */
  exposed?: boolean;
}

export interface SwipeOutcome {
  /** True when handled in-process (setContentOffset — no momentum). */
  inProcess: boolean;
}

/** Inputs the post-tap settle needs, captured BEFORE the tap. */
export interface PreTapSnapshot {
  preTapHash: string;
  reactAttach: 'paper' | 'fabric' | 'both' | 'none';
  reactSinceMs: number;
  nextEditsField: boolean;
}

export interface GestureDriver {
  readonly name: 'hid' | 'fast';

  /**
   * Whether two consecutive same-target tapOns should collapse into a
   * single HID double-tap (works around HID tap-gap landing inside
   * RN's double-tap window; unnecessary and harmful for in-process
   * activation).
   */
  readonly collapsesRepeatTaps: boolean;

  /**
   * Sample spacing for the position-stability gate in execTapOn.
   * Wider in fast mode: trimmed post-settle makes the gate the main
   * defence against tapping mid-entrance-animation.
   */
  readonly stabilityGateGapMs: number;

  // ── primitives ────────────────────────────────────────────────────
  tap(udid: string, x: number, y: number, opts?: TapOptions): Promise<void>;
  doubleTap(udid: string, x: number, y: number): Promise<void>;
  /** Down → ~50ms hold → Up. Reliability primitive for picky targets. */
  press(udid: string, x: number, y: number): Promise<void>;
  swipe(
    udid: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs: number,
  ): Promise<SwipeOutcome>;
  longPressDrag(
    udid: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    holdMs: number,
    moveMs: number,
  ): Promise<void>;

  // ── routing ───────────────────────────────────────────────────────
  /**
   * Text-selector tap that matches a tab-bar item. Fast routes through
   * tap_tab (in-process, idempotent on the current tab); HID declines
   * so the normal find→tap path runs.
   */
  tryTabTap(client: EnnioSocketClient, text: string): Promise<boolean>;
  /**
   * Pull-to-refresh firing mechanism. Returns true when fully handled
   * (including settle); false → caller runs the shared baseline path.
   */
  tryPullToRefresh(
    client: EnnioSocketClient,
    udid: string,
    from: { x: number; y: number },
    to: { x: number; y: number },
    durationMs: number,
  ): Promise<boolean>;

  // ── settle policies ───────────────────────────────────────────────
  settleAfterTap(client: EnnioSocketClient, snap: PreTapSnapshot): Promise<void>;
  settleAfterSwipe(client: EnnioSocketClient, outcome: SwipeOutcome): Promise<void>;
  /** scrollUntilVisible: after each probing swipe. */
  settleScrollStep(client: EnnioSocketClient, outcome: SwipeOutcome): Promise<void>;
  /** scrollUntilVisible: target became visible (noMomentum = last swipe in-process or none). */
  settleScrollFound(client: EnnioSocketClient, noMomentum: boolean): Promise<void>;
  /** scrollUntilVisible: after the tab-bar/header nudge swipe. */
  settleAfterNudge(client: EnnioSocketClient, outcome: SwipeOutcome): Promise<void>;

  // ── stats ─────────────────────────────────────────────────────────
  stats(): { hits: number; fallbacks: number };
  resetStats(): void;
}
