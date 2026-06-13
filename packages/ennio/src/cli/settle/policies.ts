// Named settle policies — the per-command wait sequences lifted out of
// runner/index.ts. Control flow is byte-for-byte the legacy logic; only
// the magic numbers moved (to constants.ts) and the socket calls became
// typed signals. This file IS the determinism contract — settle/
// policies.test.ts pins the op sequence each policy emits so a dropped
// or reordered wait fails CI immediately.

import type { TypedRpcClient } from '../rpc/client';

import { SETTLE } from './constants';
import {
  animationsActive,
  frameHash,
  presentationIdle,
  sleep,
  waitCommit,
  waitHashChange,
  waitReactCommit,
} from './signals';

export interface SettleInput {
  /** Frame hash captured immediately BEFORE the action. */
  preTapHash?: string;
  /** Whether a commit signal is live (drives the afterTap branch).
   *  "universal" on current dylibs (renderer-agnostic CoreAnimation
   *  commit); legacy renderer names tolerated; "none" = no signal. */
  reactAttach?: 'universal' | 'paper' | 'fabric' | 'both' | 'none';
  /** Universal commit ts captured before the action (afterTap nextEditsField wait). */
  reactSinceMs?: number;
  /** True when the NEXT command edits a text field. */
  nextEditsField?: boolean;
}

/**
 * Pre-tap: wait for any UIKit transition (modal dismiss, nav push/pop)
 * to fully end. Signal-based — polls animations_active until the system
 * itself reports no transition in flight; cap for custom transitions.
 */
export async function preTapTransition(rpc: TypedRpcClient): Promise<void> {
  const C = SETTLE.preTap;
  const deadline = Date.now() + C.transitionPollCapMs;
  while (Date.now() < deadline) {
    if (!(await animationsActive(rpc))) break;
    await sleep(C.transitionPollStepMs);
  }
}

/**
 * When the previous step typed/erased text and the next tap targets a
 * non-input, resign first responder so iOS's editing-menu popover
 * clears with the keyboard (else it eats the tap as a dismiss).
 */
export async function preTapTextDismiss(rpc: TypedRpcClient): Promise<void> {
  await rpc.bestEffort('hide_keyboard', {});
  await waitCommit(rpc, SETTLE.preTap.textDismissCommit);
}

/** Post-tap settle. Branches on whether an RN commit observer is attached. */
export async function afterTap(rpc: TypedRpcClient, input: SettleInput = {}): Promise<void> {
  const { preTapHash = '', reactAttach = 'none', reactSinceMs = 0, nextEditsField = false } = input;

  if (reactAttach !== 'none') {
    const C = SETTLE.afterTap;
    // Block until the frame hash differs from pre-tap AND no animation
    // is in flight. Two coupled signals — both must hold to count as
    // committed.
    let committed = false;
    const deadline = Date.now() + C.reactCommitCapMs;
    while (Date.now() < deadline) {
      const cur = await frameHash(rpc);
      if (cur !== preTapHash) {
        if (!(await animationsActive(rpc))) {
          if (nextEditsField) {
            await waitReactCommit(rpc, {
              sinceMs: reactSinceMs,
              maxMs: C.nextEditsFieldCommitMaxMs,
            });
          }
          committed = true;
          break;
        }
      }
    }
    if (!committed) {
      // No commit fired — likely a no-op tap; fall back to hash-change.
      await waitHashChange(rpc, preTapHash, C.fallbackHashChangeMaxMs);
    }
    await waitCommit(rpc, C.finalCommit);
    return;
  }

  // No observer: event-driven hash-change settle.
  const N = SETTLE.afterTapNoObserver;
  const changed = await waitHashChange(rpc, preTapHash, N.hashChangeMaxMs);
  if (!changed) {
    // Full budget only when a transition is in-flight; halve when static.
    const animActive = await animationsActive(rpc);
    await sleep(animActive ? N.settleMsAnimating : N.settleMsStatic);
  }
  await waitCommit(rpc, N.finalCommit);
  await presentationIdle(rpc, N.presentationIdleMaxMs);
}

/** Tap that focused a field in-process — the HID tap was skipped. */
export async function afterFocus(rpc: TypedRpcClient): Promise<void> {
  await waitCommit(rpc, SETTLE.afterFocus.commit);
}

/** Gap between two same-target taps so RN reads them as a double-tap. */
export async function repeatTapGap(): Promise<void> {
  await sleep(SETTLE.repeatTapGapMs);
}

/** After inputText. */
export async function afterTextInput(rpc: TypedRpcClient): Promise<void> {
  await waitCommit(rpc, SETTLE.afterTextInput.commit);
}

/** After pressKey (Enter → submit handler → re-render). */
export async function afterPressKey(rpc: TypedRpcClient): Promise<void> {
  const C = SETTLE.afterPressKey;
  await sleep(C.preSleepMs);
  await waitReactCommit(rpc, { sinceMs: 0, maxMs: C.reactCommitMaxMs });
  await waitCommit(rpc, C.commit);
}

/** After `back`: poll the pop transition to completion. */
export async function afterNav(rpc: TypedRpcClient): Promise<void> {
  const C = SETTLE.afterNav;
  const deadline = Date.now() + C.animationsPollCapMs;
  while (Date.now() < deadline) {
    if (!(await animationsActive(rpc))) break;
    await sleep(C.animationsPollStepMs);
  }
}

/** After hideKeyboard. */
export async function afterHideKeyboard(): Promise<void> {
  await sleep(SETTLE.afterHideKeyboard.sleepMs);
}

/** Before a swipe: let the destination view settle so the gesture lands. */
export async function preSwipe(rpc: TypedRpcClient): Promise<void> {
  await waitCommit(rpc, SETTLE.preSwipe.commit);
  await presentationIdle(rpc, SETTLE.preSwipe.presentationIdleMaxMs);
}

/** After a swipe: let scroll momentum / page-snap settle. */
export async function afterSwipe(rpc: TypedRpcClient): Promise<void> {
  await sleep(SETTLE.afterSwipe.sleepMs);
  await waitCommit(rpc, SETTLE.afterSwipe.commit);
}

/** First paint after launch / relaunch / clearState. */
export async function afterLaunch(rpc: TypedRpcClient): Promise<void> {
  const C = SETTLE.afterLaunch;
  await waitCommit(rpc, C.firstPaintCommit);
  const r = await waitReactCommit(rpc, { sinceMs: 0, maxMs: C.reactCommitMaxMs });
  if (!r.ok) await sleep(C.fallbackSleepMs);
  await waitCommit(rpc, C.finalCommit);
}
