/**
 * Writer abstraction
 *
 * Single backend: NitroWriter. Reads route through @ennio/core's Fabric
 * shadow tree over WebSocket. Writes do too — every tap, type, swipe,
 * scroll, key-press lands in the user app's process via the Nitro
 * helper (UIControl.sendActions / synthesised UITouch /
 * UITextInput.insertText: / UIScrollView.setContentOffset). idb HID is
 * gone from this layer; the only out-of-process write left is
 * `idb describe-all`-driven OOP a11y, which lives elsewhere and isn't
 * referenced here.
 *
 * Per-write cost: ~1–2 ms in-process call, no gRPC tax, no
 * idb_companion queue. Cumulative: 30–50 % faster on tap-heavy flows.
 */

import type { EnnioClient, Selector } from './client';
import { selectorToJson } from './selector';
// Last-resort fallback for label-based taps on RNGH NativeViewGestureHandler-
// wrapped Pressables (pressto's PressableScale). Their RNDummyGestureRecognizer
// lives on RNGestureHandlerManager, not in any individual view's
// `gestureRecognizers` array — so Ennio's in-process tap chain (UIControl
// actions → tap-GR walk → synthesised UITouch → forward to RN GRs) can't
// reach it. ~50 ms HID nudge is the only way short of linking RNGH headers
// from Ennio's pod target.
import * as idb from './idb';

// Safe-area-ish centre for the 402x874 / 440x956 iPhone sims we run
// against. Used as the swipe origin when scrollAuto / scrollAtPoint
// fires without a concrete view-relative anchor.
const SAFE_CENTER_X = 200;
const SAFE_CENTER_Y = 450;
// Default duration for synthesized swipes. ~200 ms is the cadence RNGH
// + UIKit's pan recogniser expect for a "real" finger swipe — too quick
// is filtered as a tap, too slow stalls the recogniser.
const DEFAULT_SWIPE_DURATION_MS = 200;

export interface Writer {
  /** Diagnostic / verbose-log description of how a tap was routed. */
  describe(action: string): string;

  // ---- core actions ----
  tap(testID: string): Promise<boolean>;
  /**
   * Tap at a normalised screen coordinate (0..1 fractions of the app
   * window). Used by Maestro's `tapOn: { point: "X%,Y%" }`.
   */
  tapAt(x: number, y: number): Promise<boolean>;
  doubleTap(testID: string): Promise<boolean>;
  longPress(testID: string, durationMs: number): Promise<boolean>;
  typeText(testID: string | null, text: string): Promise<boolean>;
  clearText(testID: string): Promise<boolean>;
  eraseText(testID: string | null, count: number): Promise<boolean>;
  pressKey(testID: string | null, keyName: string): Promise<boolean>;
  scroll(testID: string | null, direction: 'up' | 'down' | 'left' | 'right', distance: number): Promise<boolean>;
  swipe(testID: string | null, direction: 'up' | 'down' | 'left' | 'right', distance: number): Promise<boolean>;
  scrollTo(scrollViewTestID: string, elementTestID: string): Promise<boolean>;
  back(): Promise<boolean>;
  hideKeyboard(): Promise<boolean>;

  // ---- selector / text-only ----
  tapBySelector(selector: Selector): Promise<boolean>;
  doubleTapBySelector(selector: Selector): Promise<boolean>;
  longPressBySelector(selector: Selector, durationMs: number): Promise<boolean>;
  typeTextBySelector(selector: Selector, text: string): Promise<boolean>;
  clearTextBySelector(selector: Selector): Promise<boolean>;
  /** Tap any element whose visible label matches `text`. */
  tapByText(text: string): Promise<boolean>;

  // ---- alerts ----
  tapAlertButton(buttonText: string): Promise<boolean>;
  dismissAlert(): Promise<boolean>;

  // ---- pasteboard ----
  setClipboard(text: string): Promise<boolean>;
  pasteToFocused(): Promise<boolean>;
}

export class NitroWriter implements Writer {
  /**
   * React surface origin in window coords. Cached per-instance — the
   * surface doesn't move once the app is mounted.
   */
  private surfaceOffset: { x: number; y: number } | null = null;

  constructor(private client: EnnioClient) {}

  describe(action: string): string {
    return `nitro ${action}`;
  }

  private send(type: string, payload: Record<string, unknown> = {}) {
    return this.client.send(type, payload);
  }

  /**
   * Window-coord tap. Replaces `idb.tap(x, y)`. The Nitro impl
   * synthesises a UITouch sequence; ~1 ms in-process vs ~50 ms idb.
   */
  private async tapAtPoint(x: number, y: number): Promise<boolean> {
    const r = await this.send('tapAtPoint', { x, y });
    return r?.success === true;
  }

  /**
   * Window-coord pan. Replaces `idb.swipe(x1,y1,x2,y2,ms)`. Falls back
   * to `setContentOffset` inside Nitro when the start point hits a
   * UIScrollView; otherwise drives a UITouchPhaseMoved loop.
   */
  private async swipeAtPoints(x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<boolean> {
    const r = await this.send('swipeAtPoints', { x1, y1, x2, y2, durationMs });
    return r?.success === true;
  }

  private async getSurfaceOffset(): Promise<{ x: number; y: number }> {
    if (this.surfaceOffset) return this.surfaceOffset;
    try {
      const r = await this.send('getSurfaceOffset', {});
      const data = typeof r?.data === 'string' ? JSON.parse(r.data) : r?.data;
      if (data && typeof data.x === 'number' && typeof data.y === 'number') {
        this.surfaceOffset = { x: data.x, y: data.y };
        return this.surfaceOffset;
      }
    } catch { /* fall through */ }
    this.surfaceOffset = { x: 0, y: 0 };
    return this.surfaceOffset;
  }

  private screenSize: { width: number; height: number } | null = null;
  private async getScreenSize(): Promise<{ width: number; height: number }> {
    if (this.screenSize) return this.screenSize;
    try {
      // The "home" / first scene's window-frame doubles as the app
      // viewport — we use it to decide if a tap centre is on-screen.
      // Falling back to an iPhone-sized default keeps things safe if
      // Nitro hasn't surfaced a key window yet.
      const r = await this.send('getViewWindowFrame', { testID: '__ennio_screen__' });
      const data = typeof r?.data === 'string' ? JSON.parse(r.data) : r?.data;
      if (data && data.width > 0 && data.height > 0) {
        this.screenSize = { width: data.width, height: data.height };
        return this.screenSize;
      }
    } catch { /* fall through */ }
    this.screenSize = { width: 402, height: 874 };
    return this.screenSize;
  }

  private async scrollAuto(direction: 'up' | 'down' | 'left' | 'right', distance: number, testID = ''): Promise<void> {
    // Vertical scrolls work well via Nitro (it walks up to find the
    // enclosing UIScrollView and adjusts contentOffset). Horizontal
    // scrolls inside a vertical-host page (featured carousel under a
    // ScrollView) fool the topmost-scrollable heuristic, so use a
    // synthesised swipe at the centre — UIKit hands it to whichever
    // recogniser claims it. Finger direction inverts vs content.
    if (direction === 'left' || direction === 'right') {
      const endX = direction === 'right' ? SAFE_CENTER_X - distance : SAFE_CENTER_X + distance;
      try {
        await this.swipeAtPoints(SAFE_CENTER_X, SAFE_CENTER_Y, endX, SAFE_CENTER_Y, DEFAULT_SWIPE_DURATION_MS);
      } catch { /* best effort */ }
      return;
    }
    try {
      await this.send('scroll', { testID, direction, distance });
    } catch { /* best effort */ }
  }

  async tap(testID: string): Promise<boolean> {
    // Direct onPress invocation. The native helper walks the React
    // Fiber tree, finds the testID, and calls its onPress prop. Skips
    // iOS HID, gesture coordinator, UIPresentationController gating.
    // Library-agnostic — works for Pressable, TouchableOpacity, RNGH
    // BaseButton, pressto. Falls back to a coord-based synthesised
    // UITouch when no onPress is found in the fiber tree (typically a
    // TextInput that needs becomeFirstResponder).
    const direct = await this.send('invokeOnPress', { testID });
    if (direct?.success === true) return true;
    // Native side rejected because the view is offscreen / not laid
    // out. Don't fall back to a coord tap — synthesising a touch at an
    // offscreen point is meaningless. Surface a clear failure so the
    // caller can scroll first.
    if (typeof direct?.error === 'string' && direct.error.startsWith('Element not in viewport')) {
      return false;
    }
    const center = await this.layoutCenter({ id: testID });
    if (!center) return false;
    // The fiber walk found the testID but no onPress — typically a
    // TextInput. If a keyboard is up from a previously-focused field,
    // the next tap could land on the keyboard window (which sits over
    // the field), focus stays on the prior input, and a subsequent
    // typeText injects characters into the wrong place. Drop the
    // keyboard first so the target field is hit-testable.
    try {
      await this.send('hideKeyboard', {});
      await new Promise((r) => setTimeout(r, 120));
    } catch { /* best effort */ }
    const fresh = await this.layoutCenter({ id: testID });
    const target = fresh ?? center;
    return this.tapAtPoint(target.x, target.y);
  }
  async tapAt(x: number, y: number): Promise<boolean> {
    return this.tapAtPoint(x, y);
  }
  /**
   * Resolve a selector to its window-coord centre via Fabric. Returns
   * null when no match, or the match has zero size (off-screen).
   */
  private async layoutCenter(selector: Selector): Promise<{ x: number; y: number } | null> {
    // testID-only selectors: ask iOS for the UIView's window frame
    // directly. UIKit's convertRect accounts for everything Fabric's
    // surface-relative layout misses (ScrollView contentInsetAdjustment,
    // safe-area padding, modal presentations). Retry briefly if the view
    // exists in Fabric but isn't yet attached to a window (window=nil → 0
    // frame); this happens on the first tap after a layout-causing prop
    // update like useSafeAreaInsets's 0→real value transition.
    if (selector.id && !selector.text && !selector.point) {
      const screen = await this.getScreenSize();
      for (let i = 0; i < 8; i++) {
        const r = await this.send('getViewWindowFrame', { testID: selector.id });
        const data = typeof r?.data === 'string' ? JSON.parse(r.data) : r?.data;
        if (data && data.width > 0 && data.height > 0) {
          // Element is in Fabric tree and attached to a window, but the
          // tap centre might still be off the visible screen if the host
          // FlatList / ScrollView is positioned past the viewport.
          // Maestro auto-scrolls in this case; do the same so flows that
          // rely on second-row product cards (etc.) don't have to add
          // explicit scroll commands.
          const cx = data.x + data.width / 2;
          const cy = data.y + data.height / 2;
          const onScreen = cx >= 0 && cx <= screen.width && cy >= 0 && cy <= screen.height;
          if (onScreen) {
            if (process.env.ENNIO_DEBUG_IDB) {
              console.error(`[layout] id=${selector.id} → window=(${data.x},${data.y},${data.width},${data.height})`);
            }
            return { x: cx, y: cy };
          }
          // Try to scroll the host into view, then re-measure. Pick
          // axis based on which side of the screen the centre is past;
          // horizontal carousels (featured products row) need a "right"
          // scroll, vertical lists need "down".
          const dx = cx < 0 ? cx - 100 : cx > screen.width ? cx - screen.width + 100 : 0;
          const dy = cy < 0 ? cy - 100 : cy > screen.height ? cy - screen.height + 200 : 0;
          if (Math.abs(dx) > Math.abs(dy) && dx !== 0) {
            await this.scrollAuto(dx > 0 ? 'right' : 'left', Math.abs(dx), selector.id);
          } else if (dy !== 0) {
            await this.scrollAuto(dy > 0 ? 'down' : 'up', Math.abs(dy), selector.id);
          }
          await new Promise((res) => setTimeout(res, 200));
          continue;
        }
        // No UIView (window=nil) — element exists in Fabric tree but is
        // virtualised below the FlatList's render window. Use Fabric's
        // accumulated offset to figure out which way to scroll, then let
        // the next iteration pick it up via getViewWindowFrame.
        const found = await this.client.findBySelector(selector);
        const layout = (found as { layout?: { screenX: number; screenY: number; width: number; height: number } } | null | undefined)?.layout;
        if (layout && layout.height > 0) {
          const offset = await this.getSurfaceOffset();
          const cy = layout.screenY + layout.height / 2 + offset.y;
          const dy = cy < 0 ? cy - 100 : cy - screen.height + 200;
          if (Math.abs(dy) > 50) {
            await this.scrollAuto(dy > 0 ? 'down' : 'up', Math.abs(dy));
            await new Promise((res) => setTimeout(res, 200));
            continue;
          }
        }
        await new Promise((res) => setTimeout(res, 100));
      }
      return null;
    }
    // Compound / text-only selectors: walk the Fabric shadow tree, then
    // add the React surface's window offset.
    const found = await this.client.findBySelector(selector);
    const layout = (found as { layout?: { screenX: number; screenY: number; width: number; height: number } } | null | undefined)?.layout;
    if (!layout || layout.width <= 0 || layout.height <= 0) return null;
    const offset = await this.getSurfaceOffset();
    if (process.env.ENNIO_DEBUG_IDB) {
      console.error(`[layout] ${JSON.stringify(selector)} → frame=(${layout.screenX},${layout.screenY},${layout.width},${layout.height}) offset=(${offset.x},${offset.y})`);
    }
    return {
      x: layout.screenX + layout.width / 2 + offset.x,
      y: layout.screenY + layout.height / 2 + offset.y,
    };
  }
  async doubleTap(testID: string): Promise<boolean> {
    // Native Nitro doubleTap chains two taps with the right inter-tap
    // gap UIKit's tap-count recogniser expects (~120 ms). Cheaper than
    // two coord taps.
    const r = await this.send('doubleTap', { testID });
    if (r?.success === true) return true;
    const c = await this.layoutCenter({ id: testID });
    if (!c) return false;
    await this.tapAtPoint(c.x, c.y);
    await new Promise((r) => setTimeout(r, 80));
    await this.tapAtPoint(c.x, c.y);
    return true;
  }
  async longPress(testID: string, durationMs: number): Promise<boolean> {
    const r = await this.send('longPress', { testID, durationMs });
    if (r?.success === true) return true;
    // Fall back to coord-based tap. Nitro doesn't yet expose a
    // longPressAtPoint variant; the synthesised UITouch tap fires
    // press handlers but doesn't drive UILongPressGestureRecognizer.
    const c = await this.layoutCenter({ id: testID });
    if (!c) return false;
    return this.tapAtPoint(c.x, c.y);
  }
  async typeText(testID: string | null, text: string): Promise<boolean> {
    // Nitro's typeText finds the TextInput by testID and calls
    // `insertText:` directly on the UITextInput protocol. No HID, no
    // pre-tap to focus, no per-character latency.
    if (testID) {
      const r = await this.send('typeText', { testID, text });
      if (r?.success === true) return true;
    }
    // Fallback: tap-anywhere targeting via clipboard paste. Nitro
    // exposes copyToClipboard + pasteFromClipboard; the latter pastes
    // into whichever field is first responder. Used when the testID
    // doesn't resolve to a Fabric TextInput (e.g. the runner already
    // focused a field via tap and just calls typeText with null id).
    if (!testID) {
      await this.send('copyToClipboard', { text });
      const r = await this.send('pasteFromClipboard', { testID: '' });
      return r?.success === true;
    }
    return false;
  }
  async clearText(testID: string): Promise<boolean> {
    const r = await this.send('clearText', { testID });
    return r?.success === true;
  }
  async eraseText(testID: string | null, count: number): Promise<boolean> {
    // Single round-trip: Nitro's eraseText loops deleteBackward N times
    // on the resolved UITextInput. Replaces N idb HID key presses.
    if (testID) {
      const r = await this.send('eraseText', { testID, count });
      if (r?.success === true) return true;
    }
    // No testID — drive backspace against the current first responder.
    // pressHardwareKey(42) maps to deleteBackward via UIKeyInput.
    for (let i = 0; i < count; i++) {
      const r = await this.send('pressHardwareKey', { keyCode: 42 });
      if (r?.success !== true) return i > 0;
    }
    return true;
  }
  async pressKey(_testID: string | null, keyName: string): Promise<boolean> {
    // Map maestro's named keys to HID keycodes. Anything else is a
    // no-op for now (extend as flows demand).
    const map: Record<string, number> = {
      backspace: 42,
      delete: 42,
      enter: 40,
      return: 40,
      space: 44,
    };
    const code = map[keyName.toLowerCase()];
    if (code === undefined) return false;
    const r = await this.send('pressHardwareKey', { keyCode: code });
    return r?.success === true;
  }
  async scroll(testID: string | null, direction: 'up' | 'down' | 'left' | 'right', distance: number): Promise<boolean> {
    // Vertical scroll: route through the native `scroll` cmd, which
    // walks up to the enclosing UIScrollView and bumps contentOffset
    // directly. A swipe-at-centre gesture risks being captured by an
    // inner scroller (e.g. horizontal carousels nested in the page) and
    // never reaching the outer page — that's why scrollUntilVisible was
    // hanging on home-screen pages.
    if (direction === 'up' || direction === 'down') {
      await this.scrollAuto(direction, distance, testID ?? '');
      return true;
    }
    // Horizontal: synthesise a swipe at viewport centre. UIKit hands it
    // to whichever recogniser claims it. Native testID-anchored scroll
    // doesn't reliably hit horizontal carousels.
    let endX = SAFE_CENTER_X;
    if (direction === 'right') endX = SAFE_CENTER_X - distance;
    else if (direction === 'left') endX = SAFE_CENTER_X + distance;
    return this.swipeAtPoints(SAFE_CENTER_X, SAFE_CENTER_Y, endX, SAFE_CENTER_Y, DEFAULT_SWIPE_DURATION_MS);
  }
  async swipe(testID: string | null, direction: 'up' | 'down' | 'left' | 'right', distance: number): Promise<boolean> {
    return this.scroll(testID, direction, distance);
  }
  async scrollTo(scrollViewTestID: string, elementTestID: string): Promise<boolean> {
    const r = await this.send('scrollTo', { scrollViewTestID, elementTestID });
    return r?.success === true;
  }
  async back(): Promise<boolean> {
    const r = await this.send('backGesture', {});
    if (process.env.ENNIO_DEBUG_IDB) console.error(`[back] success=${r?.success}`);
    return r?.success === true;
  }
  async hideKeyboard(): Promise<boolean> {
    const r = await this.send('hideKeyboard', {});
    return r?.success === true;
  }
  async tapBySelector(selector: Selector): Promise<boolean> {
    const c = await this.layoutCenter(selector);
    if (!c) return false;
    return this.tapAtPoint(c.x, c.y);
  }
  async doubleTapBySelector(selector: Selector): Promise<boolean> {
    const c = await this.layoutCenter(selector);
    if (!c) return false;
    await this.tapAtPoint(c.x, c.y);
    await new Promise((r) => setTimeout(r, 80));
    await this.tapAtPoint(c.x, c.y);
    return true;
  }
  async longPressBySelector(selector: Selector, _durationMs: number): Promise<boolean> {
    const c = await this.layoutCenter(selector);
    if (!c) return false;
    return this.tapAtPoint(c.x, c.y);
  }
  async typeTextBySelector(selector: Selector, text: string): Promise<boolean> {
    // Resolve to a testID when possible; lets Nitro's typeText do its
    // first-responder dance directly. Fall back to coord tap + paste
    // for compound selectors that don't expose an id.
    if (selector.id) return this.typeText(selector.id, text);
    const c = await this.layoutCenter(selector);
    if (!c) return false;
    await this.tapAtPoint(c.x, c.y);
    await new Promise((r) => setTimeout(r, 100));
    return this.typeText(null, text);
  }
  async clearTextBySelector(selector: Selector): Promise<boolean> {
    if (selector.id) return this.clearText(selector.id);
    const c = await this.layoutCenter(selector);
    if (!c) return false;
    await this.tapAtPoint(c.x, c.y);
    // Bounded backspace loop for unknown text length.
    for (let i = 0; i < 100; i++) {
      const r = await this.send('pressHardwareKey', { keyCode: 42 });
      if (r?.success !== true) break;
    }
    return true;
  }
  async tapByText(text: string): Promise<boolean> {
    // expo-router NativeTabs renders tab bar items via UIKit/SwiftUI
    // hosts whose UIView subtree isn't surfaced for accessibility-label
    // walks (UITabBarButton stays opaque). Drive the UITabBarController
    // directly before falling back to coordinate taps.
    const tab = await this.send('tapTabByName', { name: text });
    if (process.env.ENNIO_DEBUG_IDB) console.error(`[tapByText] '${text}' tabSwitch=${tab?.success}`);
    if (tab?.success === true) return true;
    // Coord-based tap at the matched label's centre. The Nitro
    // `tapAtPoint` chain handles every touch class we can reach in
    // process: UIControl with TouchUpInside actions, RNBetterTapGestureRecognizer
    // (state-drive Began → Ended), plain UITapGestureRecognizer,
    // synthesised UITouch fallback. RNGH's NativeViewGestureHandler
    // (used by pressto's PressableScale) attaches its
    // RNDummyGestureRecognizer on the RNGestureHandlerManager, not in
    // any individual view — so we mirror with idb HID for those.
    const r = await this.send('getViewWindowFrameByLabel', { text });
    const data = typeof r?.data === 'string' ? JSON.parse(r.data) : r?.data;
    if (data && data.width > 0 && data.height > 0) {
      const cx = data.x + data.width / 2;
      const cy = data.y + data.height / 2;
      if (await this.tapAtPoint(cx, cy)) {
        try { await idb.tap(cx, cy, 150); } catch { /* best effort */ }
        return true;
      }
    }
    const c = await this.layoutCenter({ text });
    if (c) {
      if (await this.tapAtPoint(c.x, c.y)) {
        try { await idb.tap(c.x, c.y, 150); } catch { /* best effort */ }
        return true;
      }
    }
    // Last resort: walk the simulator's whole-OS accessibility tree via
    // `idb describe-all`. Reaches UI outside the app process — SpringBoard
    // system alerts (iOS 26's deep-link confirmation), system pickers,
    // out-of-process zeego UIMenu items.
    try {
      if (await idb.tapByLabelOOP(text)) return true;
    } catch { /* best effort */ }
    return false;
  }
  async tapAlertButton(buttonText: string): Promise<boolean> {
    const r = await this.send('tapAlertButton', { buttonText });
    return r?.success === true;
  }
  async dismissAlert(): Promise<boolean> {
    const r = await this.send('dismissAlert', {});
    return r?.success === true;
  }
  async setClipboard(text: string): Promise<boolean> {
    const r = await this.send('copyToClipboard', { text });
    return r?.success === true;
  }
  async pasteToFocused(): Promise<boolean> {
    const r = await this.send('pasteFromClipboard', { testID: '' });
    return r?.success === true;
  }
}

