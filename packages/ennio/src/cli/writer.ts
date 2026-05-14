/**
 * Writer abstraction
 *
 * Single backend: NitroWriter. Reads route through ennio's Fabric
 * shadow tree via the JSI `__ennioDispatch` host function over Hermes
 * Inspector CDP. Writes (tap/swipe) drive **real CoreSimulator touches**
 * — the hot path goes through the persistent HID daemon (Python over a
 * Unix socket → gRPC → idb_companion → CoreSimulator IOHID, ~5 ms per
 * call). Cold fallback: spawn `idb ui tap` per call (~250 ms). Last
 * resort: in-app synthetic UITouch dispatch via the Nitro helper.
 *
 * Text input + native gestures (key-press, scroll, sendActions) still
 * land in the user app's process via the Nitro helper — there's no idb
 * primitive for them.
 */

import type { EnnioClient, Selector } from './client';
// Last-resort fallback for label-based taps on RNGH NativeViewGestureHandler-
// wrapped Pressables (pressto's PressableScale). Their RNDummyGestureRecognizer
// lives on RNGestureHandlerManager, not in any individual view's
// `gestureRecognizers` array — so Ennio's in-process tap chain (UIControl
// actions → tap-GR walk → synthesised UITouch → forward to RN GRs) can't
// reach it. ~50 ms HID nudge is the only way short of linking RNGH headers
// from Ennio's pod target.
import * as idb from './idb';
import * as hid from './hid';
import * as hierarchy from './hierarchy';

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
  scroll(
    testID: string | null,
    direction: 'up' | 'down' | 'left' | 'right',
    distance: number,
  ): Promise<boolean>;
  swipe(
    testID: string | null,
    direction: 'up' | 'down' | 'left' | 'right',
    distance: number,
  ): Promise<boolean>;
  /**
   * Raw window-coord swipe. Routes through idb HID (real iOS touches
   * the simulator's pan recogniser actually honours); falls back to
   * synthesised UITouch via Nitro when idb is unavailable.
   */
  swipeAt(x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<boolean>;
  /** Key window size in window-coord points (cached after first call). */
  getScreenSize(): Promise<{ width: number; height: number }>;
  /**
   * Drop the cached window size + surface offset. Call after any event
   * that can rotate, resize, or remount the key window (orientation
   * change, `launchApp`, `clearState`). Without this the next tap math
   * uses stale dimensions and lands off-target.
   */
  invalidateViewportCache(): void;
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
  tapByText(text: string, opts?: { fast?: boolean }): Promise<boolean>;

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
   * HID tap with hot-fallback. Tries the persistent python daemon
   * (~5 ms per call) first; on any failure (no companion, daemon
   * crashed) drops back to spawning `idb ui tap` per call (~250 ms,
   * always works). Same wire format either way — both ultimately
   * speak gRPC to idb_companion.
   */
  private async hidTap(x: number, y: number, durationMs: number): Promise<void> {
    try {
      await hid.tap(x, y, durationMs);
      if (process.env.ENNIO_DEBUG_IDB)
        console.error(`[hidTap] daemon ok (${x},${y},${durationMs}ms)`);
      return;
    } catch (e) {
      if (process.env.ENNIO_DEBUG_IDB)
        console.error(`[hidTap] daemon FAILED, fallback: ${(e as Error).message}`);
    }
    await idb.ensureCompanion();
    await idb.tap(x, y, durationMs);
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
  private async swipeAtPoints(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs: number,
  ): Promise<boolean> {
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
    } catch {
      /* fall through */
    }
    this.surfaceOffset = { x: 0, y: 0 };
    return this.surfaceOffset;
  }

  private screenSize: { width: number; height: number } | null = null;
  async getScreenSize(): Promise<{ width: number; height: number }> {
    if (this.screenSize) return this.screenSize;
    try {
      const r = await this.send('getKeyWindowSize', {});
      const data = typeof r?.data === 'string' ? JSON.parse(r.data) : r?.data;
      if (data && data.width > 0 && data.height > 0) {
        this.screenSize = { width: data.width, height: data.height };
        return this.screenSize;
      }
    } catch {
      /* fall through */
    }
    // Last-resort sentinel only — large enough that any real iPhone Pro
    // Max viewport (~440×956) still falls inside the on-screen gate.
    this.screenSize = { width: 480, height: 1024 };
    return this.screenSize;
  }

  invalidateViewportCache(): void {
    this.screenSize = null;
    this.surfaceOffset = null;
  }

  private async scrollAuto(
    direction: 'up' | 'down' | 'left' | 'right',
    distance: number,
    testID = '',
  ): Promise<void> {
    // Vertical scrolls work well via Nitro (it walks up to find the
    // enclosing UIScrollView and adjusts contentOffset). Horizontal
    // scrolls inside a vertical-host page (featured carousel under a
    // ScrollView) fool the topmost-scrollable heuristic, so use a
    // synthesised swipe at the centre — UIKit hands it to whichever
    // recogniser claims it. Maestro convention: `LEFT` is finger
    // right→left (advance to next page); `RIGHT` is left→right.
    if (direction === 'left' || direction === 'right') {
      // Use opposite-edge start + opposite-edge end to maximise travel
      // and stay inside the window. A swipe with negative endpoints
      // (e.g. start 200, end -200 on a 420-wide window) is silently
      // dropped by UIKit because the second touch lands off-screen,
      // never reaches the responder, and the pan recogniser bails.
      const startX =
        direction === 'left' ? Math.round(SAFE_CENTER_X * 1.75) : Math.round(SAFE_CENTER_X * 0.25);
      const endX =
        direction === 'left' ? Math.round(SAFE_CENTER_X * 0.25) : Math.round(SAFE_CENTER_X * 1.75);
      try {
        await this.swipeAtPoints(
          startX,
          SAFE_CENTER_Y,
          endX,
          SAFE_CENTER_Y,
          DEFAULT_SWIPE_DURATION_MS,
        );
      } catch {
        /* best effort */
      }
      return;
    }
    try {
      await this.send('scroll', { testID, direction, distance });
    } catch {
      /* best effort */
    }
  }

  async tap(testID: string): Promise<boolean> {
    // Batched JSI prepare: stable-coord poll + auto-scroll + UIMenu
    // check in one CDP round trip. ~5-10× fewer round trips than the
    // old CLI-side layoutCenter loop. Actuation stays on idb HID —
    // UITouch synth misfires on RNGH-wrapped components (PressableScale,
    // RNBetterTapGestureRecognizer state machine).
    const screen = await this.getScreenSize();
    let center: { x: number; y: number };
    let isMenu = false;
    try {
      const r = await this.send('prepareTap', {
        testID,
        screenW: screen.width,
        screenH: screen.height,
      });
      if (!r?.success) return false;
      const data =
        typeof r.data === 'string' ? JSON.parse(r.data) : (r.data as Record<string, unknown>);
      if (!data || typeof data.x !== 'number' || typeof data.y !== 'number') return false;
      center = { x: data.x as number, y: data.y as number };
      isMenu = data.isMenu === true;
      if (process.env.ENNIO_DEBUG_TAP) {
        console.error(
          `[ennio tap] id=${testID} → (${center.x.toFixed(1)}, ${center.y.toFixed(1)}) menu=${isMenu}`,
        );
      }
    } catch {
      return false;
    }
    // Actuation: persistent HID daemon (python idb client over a
    // pre-warmed gRPC channel to idb_companion). Real CoreSimulator
    // touch event — same wire format as `idb ui tap` — minus the
    // ~250 ms python startup we'd pay per call. Falls back to
    // spawning `idb` if the daemon is unavailable.
    try {
      // 120 ms tap duration matches what an average human-finger tap
      // looks like on the simulator's IOHID layer. Shorter durations
      // (~80 ms) work for plain Pressable but Pressto's
      // PressableScale uses a Reanimated worklet whose pressIn →
      // pressOut state machine wants more time to register; the
      // delta is visible specifically on RN's `<Modal/>`-presented
      // buttons where the dismiss never fires on the short tap.
      await this.hidTap(center.x, center.y, isMenu ? 150 : 120);
    } catch {
      return false;
    }
    if (isMenu) {
      await new Promise((r) => setTimeout(r, 250));
    }
    return true;
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
      // Brief retry only for the window=nil race (view in Fabric tree but
      // not yet attached to a window — happens on the first tap after a
      // layout-causing prop update). NO auto-scroll: parity with Maestro
      // / XCUI, where `tapOn id: X` refuses to find an off-screen element
      // and the caller must `scrollUntilVisible` first. Auto-scrolling
      // here masked legitimate flow bugs (off-screen taps that a real
      // finger could never deliver) and let Ennio pass flows that
      // Maestro correctly failed.
      // Wait for the UIView's window-frame to be STABLE across two
      // consecutive reads (~50 ms apart) WITH centre inside the visible
      // viewport. Stability tolerance is 2 px. If the element is found
      // but off-screen, drive a scrollTo to bring it into view —
      // Maestro/XCUI does this implicitly via scrollToVisible, so for
      // parity we do the same; users get to write yaml without
      // boilerplate scroll commands before every off-screen tap.
      let lastCoord: { x: number; y: number } | null = null;
      let lastOnScreen = false;
      let didScroll = false;
      for (let i = 0; i < 30; i++) {
        const r = await this.send('getViewWindowFrame', { testID: selector.id });
        const data = typeof r?.data === 'string' ? JSON.parse(r.data) : r?.data;
        if (data && data.width > 0 && data.height > 0) {
          const cx = data.x + data.width / 2;
          const cy = data.y + data.height / 2;
          const onScreen = cx >= 0 && cx <= screen.width && cy >= 0 && cy <= screen.height;
          if (!onScreen) {
            if (!didScroll) {
              // Off-screen — scrollIntoView via enclosing UIScrollView
              // (Maestro parity). Native scrollTo walks up to find the
              // scroll view, sets contentOffset to put the element in
              // viewport. Only attempt once; if it still doesn't help
              // the caller needs a real scrollUntilVisible.
              didScroll = true;
              try {
                await this.send('scrollTo', {
                  scrollViewTestID: '',
                  elementTestID: selector.id,
                });
              } catch {
                /* best effort */
              }
              await new Promise((res) => setTimeout(res, 200));
              continue;
            }
            return null;
          }
          if (lastCoord && Math.abs(lastCoord.x - cx) < 2 && Math.abs(lastCoord.y - cy) < 2) {
            if (process.env.ENNIO_DEBUG_IDB) {
              console.error(
                `[layout] id=${selector.id} stable → window=(${data.x},${data.y},${data.width},${data.height}) iter=${i}`,
              );
            }
            return { x: cx, y: cy };
          }
          lastCoord = { x: cx, y: cy };
          lastOnScreen = true;
        }
        await new Promise((res) => setTimeout(res, 50));
      }
      return lastOnScreen ? lastCoord : null;
    }
    // Compound / text-only selectors: walk the Fabric shadow tree, then
    // add the React surface's window offset.
    const found = await this.client.findBySelector(selector);
    const layout = (
      found as
        | { layout?: { screenX: number; screenY: number; width: number; height: number } }
        | null
        | undefined
    )?.layout;
    if (!layout || layout.width <= 0 || layout.height <= 0) return null;
    const offset = await this.getSurfaceOffset();
    if (process.env.ENNIO_DEBUG_IDB) {
      console.error(
        `[layout] ${JSON.stringify(selector)} → frame=(${layout.screenX},${layout.screenY},${layout.width},${layout.height}) offset=(${offset.x},${offset.y})`,
      );
    }
    return {
      x: layout.screenX + layout.width / 2 + offset.x,
      y: layout.screenY + layout.height / 2 + offset.y,
    };
  }
  async doubleTap(testID: string): Promise<boolean> {
    // Two real iOS HID taps with the inter-tap gap UIKit's
    // tap-count recogniser expects (~120 ms). Same path as tap() —
    // real touches drive gesture recognizers; no JSI shortcut.
    const c = await this.layoutCenter({ id: testID });
    if (!c) return false;
    await this.hidTap(c.x, c.y, 50);
    await new Promise((r) => setTimeout(r, 120));
    await this.hidTap(c.x, c.y, 50);
    await new Promise((r) => setTimeout(r, 100));
    return true;
  }
  async longPress(testID: string, durationMs: number): Promise<boolean> {
    // Real iOS HID touch with extended press duration. Drives
    // UILongPressGestureRecognizer + RNGH long-press handlers the same
    // way a real finger does. No JSI shortcut — fiber-dispatch onPress
    // bypasses gesture state machines and silently masks layout bugs.
    const c = await this.layoutCenter({ id: testID });
    if (!c) return false;
    await this.hidTap(c.x, c.y, durationMs);
    await new Promise((r) => setTimeout(r, 100));
    return true;
  }
  async typeText(testID: string | null, text: string): Promise<boolean> {
    // Focus the target first (real HID tap → first-responder). Then
    // dispatch the text either via idb's keyboard injection (real
    // keystrokes, fires onChangeText per char, validators see input
    // as a user would) or via pasteboard (whole-string commit, no
    // per-key fidelity, but reliable for any character).
    //
    // idb's `ui text` drives the simulator's IOHID layer with US-
    // layout assumptions; characters that need the Shift modifier
    // (`@`, `?`, `&`, etc.) come out wrong on layouts where those
    // glyphs sit elsewhere. Detect those and switch to the
    // pasteboard path so RHF/zod/etc see the actual text we asked
    // for. Plain ASCII letters/digits/space/`.,_-` stay on the
    // keyboard path so per-char validators still fire.
    if (testID) {
      const c = await this.layoutCenter({ id: testID });
      if (!c) return false;
      await this.hidTap(c.x, c.y, 50);
      await this.client.waitForCommit(200);
    }
    const keyboardSafe = /^[a-zA-Z0-9 .,_\-+/=:;]*$/.test(text);
    if (!keyboardSafe) {
      // Pasteboard path: drop the string onto the system pasteboard
      // then ask native to read it back and dispatch via insertText:
      // on the testID-bearing input. insertText: doesn't depend on
      // keyboard layout, so `@`, `?`, etc. land as themselves.
      // Requires a testID for the destination — without one, we
      // can't address an input. Fall through to the idb path in
      // that case (best-effort).
      if (testID) {
        await this.setClipboard(text);
        await this.send('pasteFromClipboard', { testID });
        await new Promise((r) => setTimeout(r, 100));
        return true;
      }
    }
    await idb.ensureCompanion();
    await idb.typeText(text);
    await new Promise((r) => setTimeout(r, 100));
    return true;
  }
  async clearText(testID: string): Promise<boolean> {
    // Focus + select-all + delete via HID. Roughly equivalent to
    // Nitro's clearText but uses real keystrokes for parity with
    // Maestro semantics.
    const c = await this.layoutCenter({ id: testID });
    if (!c) return false;
    await this.hidTap(c.x, c.y, 50);
    await this.client.waitForCommit(200);
    // Erase up to 100 chars — large enough for typical form fields.
    for (let i = 0; i < 100; i++) {
      await idb.pressKey(42);
    }
    await new Promise((r) => setTimeout(r, 100));
    return true;
  }
  async eraseText(testID: string | null, count: number): Promise<boolean> {
    // Real backspace via idb HID, count times. Focus the field first
    // if a testID was given.
    if (testID) {
      const c = await this.layoutCenter({ id: testID });
      if (!c) return false;
      await this.hidTap(c.x, c.y, 50);
      await this.client.waitForCommit(200);
    }
    await idb.ensureCompanion();
    for (let i = 0; i < count; i++) {
      await idb.pressKey(42);
    }
    await new Promise((r) => setTimeout(r, 100));
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
    await idb.ensureCompanion();
    await idb.pressKey(code);
    await this.client.waitForCommit(200);
    return true;
  }
  async scroll(
    testID: string | null,
    direction: 'up' | 'down' | 'left' | 'right',
    distance: number,
  ): Promise<boolean> {
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
    // Horizontal: drive idb HID directly. Synthesised UITouches aren't
    // recognised by RN's RCTScrollView pan gesture (the React-side
    // offset state re-syncs immediately after a setContentOffset) so
    // paged carousels never advance. idb injects real iOS touches at
    // the simulator level, the pan recogniser sees them, and the page
    // snaps as it would for a real finger.
    // Maestro convention: `direction: LEFT` is finger right→left
    // (advance to next page); `RIGHT` is left→right.
    // Drive idb HID for horizontal swipes. Synthesised UITouch
    // sequences don't reliably reach RCTScrollView's pan recogniser
    // (RN re-syncs contentOffset to React state immediately after
    // direct setContentOffset, and the synth Began→Moved→Ended path
    // doesn't fire the recogniser's state machine for paging-enabled
    // scrollers). idb routes through the simulator's IOHID layer so
    // the recogniser sees real touches and the page snaps.
    const screen = await this.getScreenSize();
    const startX = direction === 'left' ? screen.width - 40 : 40;
    const endX = direction === 'left' ? 40 : screen.width - 40;
    const midY = SAFE_CENTER_Y;
    try {
      await idb.swipe(startX, midY, endX, midY, DEFAULT_SWIPE_DURATION_MS);
      return true;
    } catch {
      /* fall back to synthesised UITouch path below */
    }
    let endXSynth = SAFE_CENTER_X;
    if (direction === 'right') endXSynth = SAFE_CENTER_X + distance;
    else if (direction === 'left') endXSynth = SAFE_CENTER_X - distance;
    return this.swipeAtPoints(
      SAFE_CENTER_X,
      SAFE_CENTER_Y,
      endXSynth,
      SAFE_CENTER_Y,
      DEFAULT_SWIPE_DURATION_MS,
    );
  }
  async swipe(
    testID: string | null,
    direction: 'up' | 'down' | 'left' | 'right',
    distance: number,
  ): Promise<boolean> {
    return this.scroll(testID, direction, distance);
  }
  async swipeAt(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs: number,
  ): Promise<boolean> {
    if (process.env.ENNIO_DEBUG_IDB)
      console.error(`[swipeAt] (${x1},${y1})→(${x2},${y2}) ${durationMs}ms`);
    // Hot path: persistent HID daemon over the pre-warmed gRPC channel
    // to idb_companion (~5 ms). Mirrors hidTap; avoids the ~250 ms
    // `idb ui swipe` fork-per-call. Fall back to spawning `idb` if the
    // daemon is unavailable, then to in-app UITouchPhaseMoved dispatch.
    try {
      await hid.swipe(x1, y1, x2, y2, durationMs);
      return true;
    } catch (e) {
      if (process.env.ENNIO_DEBUG_IDB)
        console.error(`[swipeAt] daemon failed: ${(e as Error).message}, fallback`);
    }
    try {
      await idb.swipe(x1, y1, x2, y2, durationMs);
      return true;
    } catch (e) {
      if (process.env.ENNIO_DEBUG_IDB)
        console.error(`[swipeAt] idb failed: ${(e as Error).message}, fallback`);
    }
    return this.swipeAtPoints(x1, y1, x2, y2, durationMs);
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
  async tapByText(text: string, opts: { fast?: boolean } = {}): Promise<boolean> {
    // Maestro-parity tap-by-text: locate via the iOS accessibility tree
    // (catches UITabBar / UIAlert / out-of-process UIMenu items the
    // React fiber tree never sees) AND the React fiber tree (catches
    // labelled views inside the app process). Tap the resolved coord
    // via idb HID — real touch, real hit-test, real responder chain.
    await idb.ensureCompanion();
    // 1) UITabBarController shortcut FIRST. When the text matches a
    //    tab name, this is unambiguous and fast — switches the active
    //    tab directly. Avoids the failure mode where AX-label search
    //    latches onto stale "Cart" header text in a stack-pushed
    //    screen of an inactive tab (cart tab keeps its UIViews mounted
    //    behind the Products tab; their AX labels stay queryable but
    //    tapping them does nothing).
    const tab = await this.send('tapTabByName', { name: text });
    if (tab?.success === true) {
      // Minimal settle — prepareTap on the next tap does its own
      // stable-coord + hit-test verify polling so it can wait out the
      // first-commit gap on the destination tab.
      await new Promise((r) => setTimeout(r, 100));
      return true;
    }
    // 2) Accessibility-label query inside the app's UIView tree (incl.
    //    UITabBarButton labels — expo-router NativeTabs route through
    //    UIKit hosts that surface their tab title as the AX label).
    const r = await this.send('getViewWindowFrameByLabel', { text });
    const data = typeof r?.data === 'string' ? JSON.parse(r.data) : r?.data;
    if (data && data.width > 0 && data.height > 0) {
      const cx = data.x + data.width / 2;
      const cy = data.y + data.height / 2;
      await this.hidTap(cx, cy, 50);
      await new Promise((r) => setTimeout(r, 100));
      return true;
    }
    // 3) Fiber-text walk — for elements whose label is JSX text but
    //    whose accessibilityLabel isn't set on the host view.
    const c = await this.layoutCenter({ text });
    if (c) {
      await this.hidTap(c.x, c.y, 50);
      await new Promise((r) => setTimeout(r, 100));
      return true;
    }
    // Tiers 4-5 are expensive (~3 s idb describe-all + ~10-20 s
    // maestro hierarchy/WDA). Skip them for `optional` taps where the
    // caller already accepts failure — burning 20 s on every probe
    // tap that's expected to miss is the slowest single line in any
    // flow that uses `optional: true` as a feature-detect.
    if (opts.fast) return false;
    // 4) Out-of-process accessibility tree (idb describe-all) — broken
    //    on iOS 26, kept for older sims as a last resort.
    try {
      if (await idb.tapByLabelOOP(text)) {
        await new Promise((r) => setTimeout(r, 100));
        return true;
      }
    } catch {
      /* best effort */
    }
    // 5) iOS-26 AX-tree fallback via maestro hierarchy → WebDriverAgent.
    //    Slow (~1-2 s) but the only working path for native UIMenu
    //    items (zeego DropdownMenu choices), system pickers, and
    //    SpringBoard alerts on iOS 26. Drops out once idb_companion
    //    or a bundled WDA helper supports iOS 26 directly.
    try {
      const h = await hierarchy.findByText(text);
      if (h) {
        await this.hidTap(h.cx, h.cy, 50);
        await new Promise((r) => setTimeout(r, 100));
        return true;
      }
    } catch {
      /* best effort */
    }
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
