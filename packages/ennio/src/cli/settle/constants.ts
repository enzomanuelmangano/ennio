// Settle timing — the single home for the wait/settle magic numbers
// that were previously scattered inline across runner/index.ts. Each
// value keeps the justification that earned it (these encode real
// flake fixes; see the per-field comments). Env overrides preserved.
//
// The "wait budgets" (DEFAULT_WAIT_MS, POST_TAP_SETTLE_MS, window
// fallbacks, …) still live in runner/context.ts and are re-exported
// here so callers have one import for all settle timing.

import { POST_TAP_SETTLE_MS } from '../runner/context';

export {
  DEFAULT_WAIT_MS,
  POLL_MS,
  FIND_DEADLINE_DEFAULT_MS,
  DEFAULT_WIN_W,
  DEFAULT_WIN_H,
  POST_TAP_SETTLE_MS,
  POST_LAUNCH_SETTLE_MS,
} from '../runner/context';

// When --no-animations is active, UI state settles immediately after
// React commits (no transition tails). Tighten the stability windows
// so we don't wait 200-350 ms for a hash that's already been quiet
// for the past 50 ms.
const noAnimations = process.env.ENNIO_NO_ANIMATIONS === '1';

/**
 * Policy-level settle constants. Values are byte-identical to the inline
 * numbers in the legacy runner so the extracted policies preserve
 * behavior exactly. Tuning happens only AFTER parity is proven.
 */
export const SETTLE = {
  /** Pre-tap: wait for any in-flight UIKit transition to end. */
  preTap: {
    // Poll animations_active until no VC in the chain is transitioning.
    transitionPollCapMs: 1500,
    transitionPollStepMs: 20,
    // When the previous step typed text, resign first responder so the
    // iOS editing-menu popover clears before the next non-input tap.
    textDismissCommit: { maxMs: 1500, stableMs: 200 },
  },

  /** Post-tap settle, React-observer-attached path. */
  afterTap: {
    // Block until the frame hash differs AND no animation is in flight.
    reactCommitCapMs: 1500,
    // When the next op edits a field, also wait one React commit.
    nextEditsFieldCommitMaxMs: 250,
    // No commit fired → fall back to a hash-change signal.
    fallbackHashChangeMaxMs: 400,
    // Smooth the transition tail.
    finalCommit: { maxMs: 1500, stableMs: 200 },
  },

  /** Post-tap settle, NO React observer attached (event-driven hash). */
  afterTapNoObserver: {
    hashChangeMaxMs: 600,
    // If hash didn't change: full budget only when animating, else half.
    settleMsAnimating: POST_TAP_SETTLE_MS,
    settleMsStatic: Math.min(POST_TAP_SETTLE_MS, 400),
    // With --no-animations, layout quiesces almost immediately after the
    // React commit. 150 ms stable window is sufficient vs 350 ms with
    // live transitions.
    finalCommit: { maxMs: noAnimations ? 500 : 800, stableMs: noAnimations ? 150 : 350 },
    presentationIdleMaxMs: 500,
  },

  /** Tap that focuses a text field in-process (skips the HID tap). */
  afterFocus: { commit: { maxMs: 1000, stableMs: 200 } },

  /** Gap between two same-target taps so they register as a double-tap. */
  repeatTapGapMs: 120,

  /** After inputText: catch the post-insert layout + onChangeText commit. */
  afterTextInput: { commit: { maxMs: 500, stableMs: 80 } },

  /** After pressKey (Enter often triggers a submit → re-render). */
  afterPressKey: { preSleepMs: 80, reactCommitMaxMs: 800, commit: { maxMs: 1500, stableMs: 150 } },

  /** After `back`: poll the pop transition to completion. */
  afterNav: { animationsPollCapMs: 800, animationsPollStepMs: 20 },

  /** After hideKeyboard. */
  afterHideKeyboard: { sleepMs: 150 },

  /** Around a swipe gesture. */
  preSwipe: { commit: { maxMs: 2500, stableMs: 350 }, presentationIdleMaxMs: 800 },
  afterSwipe: { sleepMs: 500, commit: { maxMs: 1000, stableMs: 150 } },

  /** First paint after launch / relaunch / clearState. */
  afterLaunch: {
    firstPaintCommit: { maxMs: 8000, stableMs: 250 },
    reactCommitMaxMs: 2000,
    fallbackSleepMs: 2000,
    finalCommit: { maxMs: 3000, stableMs: 300 },
  },

  /** waitForAnimationToEnd: race transitionCoordinator vs hash-quiet. */
  waitForAnimationToEnd: {
    defaultTimeoutMs: 600,
    hashQuietMs: 80,
    pollStepMs: 20,
    crossProcessDismissCapMs: 2500,
    crossProcessPollStepMs: 80,
  },
};
