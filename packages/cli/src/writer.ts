/**
 * Writer abstraction
 *
 * Single backend: NitroWriter. Reads route through @ennio/core's Fabric
 * shadow tree over WebSocket. Writes route through `idb` — real HID
 * injection at the simulator's input layer. The split:
 *   - Nitro answers "where is testID `home-signin-btn`?" → window-coord
 *     centre (x, y).
 *   - idb answers "tap at (x, y)" → real finger touch through HID.
 * One mechanism per concern. ~50 ms per write, ~5 ms per read, no
 * xcodebuild cold-start, no in-app touch synthesis.
 */

import type { EnnioClient, Selector } from './client';
import * as idb from './idb';

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

  private async getSurfaceOffset(): Promise<{ x: number; y: number }> {
    if (this.surfaceOffset) return this.surfaceOffset;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r: any = await (this.client as any).send('getSurfaceOffset', {});
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r: any = await (this.client as any).send('getViewWindowFrame', { testID: '__ennio_screen__' });
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
    // ScrollView) fool the topmost-scrollable heuristic, so use idb
    // gesture swipes for those — the swipe lands wherever the finger
    // is, and UIKit hands it to whichever recogniser claims it. Finger
    // direction inverts vs content direction.
    if (direction === 'left' || direction === 'right') {
      const cx = 200, cy = 450;
      const endX = direction === 'right' ? cx - distance : cx + distance;
      try {
        await idb.swipe(cx, cy, endX, cy, 200);
      } catch { /* best effort */ }
      return;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (this.client as any).send('scroll', { testID, direction, distance });
    } catch { /* best effort */ }
  }

  async tap(testID: string): Promise<boolean> {
    // Direct onPress invocation. The native WebSocketServer forwards
    // this to `@ennio/core`'s in-app JS handler, which walks the React
    // Fiber tree, finds the testID, and calls its onPress prop. Skips
    // iOS HID, gesture coordinator, UIPresentationController gating,
    // and recogniser arming entirely. Library-agnostic — works for any
    // touchable that surfaces an `onPress` prop on its React node
    // (Pressable, TouchableOpacity, RNGH BaseButton, pressto). Returns
    // false when the JS handler isn't connected, the testID isn't in
    // the live fiber tree, or onPress threw — caller falls through to
    // idb HID for native widgets / alert buttons / unmounted views.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const direct: any = await (this.client as any).send('invokeOnPress', { testID });
    if (direct?.success === true) return true;
    const center = await this.layoutCenter({ id: testID });
    if (!center) return false;
    // The fiber walk found the testID but no onPress — typically a
    // TextInput. If a keyboard is up from a previously-focused field,
    // the next idb tap lands on the keyboard window (which sits over
    // the field), focus stays on the prior input, and a subsequent
    // typeText injects characters into the wrong place. Drop the
    // keyboard first so the target field is hit-testable.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (this.client as any).send('hideKeyboard', {});
      await new Promise((r) => setTimeout(r, 120));
    } catch { /* best effort */ }
    const fresh = await this.layoutCenter({ id: testID });
    const target = fresh ?? center;
    await idb.tap(target.x, target.y, 150);
    return true;
  }
  async tapAt(x: number, y: number): Promise<boolean> {
    await idb.tap(x, y, 150);
    return true;
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r: any = await (this.client as any).send('getViewWindowFrame', { testID: selector.id });
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
    const c = await this.layoutCenter({ id: testID });
    if (!c) return false;
    await idb.tap(c.x, c.y);
    await new Promise((r) => setTimeout(r, 80));
    await idb.tap(c.x, c.y);
    return true;
  }
  async longPress(testID: string, durationMs: number): Promise<boolean> {
    const c = await this.layoutCenter({ id: testID });
    if (!c) return false;
    await idb.tap(c.x, c.y, durationMs);
    return true;
  }
  async typeText(testID: string | null, text: string): Promise<boolean> {
    if (testID) {
      const c = await this.layoutCenter({ id: testID });
      if (!c) return false;
      await idb.tap(c.x, c.y);
      await new Promise((r) => setTimeout(r, 100));
    }
    await idb.typeText(text);
    return true;
  }
  async clearText(testID: string): Promise<boolean> {
    if (!(await this.tap(testID))) return false;
    // 100 backspaces is enough for any normal input; idb's key-sequence
    // is faster than typing each backspace as a character.
    for (let i = 0; i < 100; i++) {
      try { await idb.pressKey(42); } catch { break; } // 42 = backspace
    }
    return true;
  }
  async eraseText(testID: string | null, count: number): Promise<boolean> {
    if (testID) {
      const c = await this.layoutCenter({ id: testID });
      if (c) await idb.tap(c.x, c.y);
    }
    for (let i = 0; i < count; i++) await idb.pressKey(42);
    return true;
  }
  async pressKey(_testID: string | null, _keyName: string): Promise<boolean> {
    // Map keyName → HID keycode; not implemented for the migration cut.
    // Most maestro flows use enter/tab/escape — wire up as needed.
    return false;
  }
  async scroll(_testID: string | null, direction: 'up' | 'down' | 'left' | 'right', distance: number): Promise<boolean> {
    // Scroll = swipe at the viewport centre. Finger direction inverts
    // versus content direction: scrolling DOWN (revealing content
    // further down the list) requires swiping the finger UP. Likewise
    // scrolling RIGHT requires swiping LEFT.
    const cx = 200, cy = 450; // safe-area-ish centre for 402x874 sims
    let endX = cx, endY = cy;
    if (direction === 'down') endY = cy - distance;
    else if (direction === 'up') endY = cy + distance;
    else if (direction === 'right') endX = cx - distance;
    else if (direction === 'left') endX = cx + distance;
    await idb.swipe(cx, cy, endX, endY, 200);
    return true;
  }
  async swipe(testID: string | null, direction: 'up' | 'down' | 'left' | 'right', distance: number): Promise<boolean> {
    return this.scroll(testID, direction, distance);
  }
  async scrollTo(scrollViewTestID: string, elementTestID: string): Promise<boolean> {
    const r = await (this.client as any).send('scrollTo', { scrollViewTestID, elementTestID });
    return r.success === true;
  }
  async back(): Promise<boolean> {
    const r = await (this.client as any).send('backGesture', {});
    if (process.env.ENNIO_DEBUG_IDB) console.error(`[back] success=${r?.success}`);
    return r.success === true;
  }
  async hideKeyboard(): Promise<boolean> {
    const r = await (this.client as any).send('hideKeyboard', {});
    return r.success === true;
  }
  async tapBySelector(selector: Selector): Promise<boolean> {
    const c = await this.layoutCenter(selector);
    if (!c) return false;
    await idb.tap(c.x, c.y, 150);
    return true;
  }
  async doubleTapBySelector(selector: Selector): Promise<boolean> {
    const c = await this.layoutCenter(selector);
    if (!c) return false;
    await idb.tap(c.x, c.y);
    await new Promise((r) => setTimeout(r, 80));
    await idb.tap(c.x, c.y);
    return true;
  }
  async longPressBySelector(selector: Selector, durationMs: number): Promise<boolean> {
    const c = await this.layoutCenter(selector);
    if (!c) return false;
    await idb.tap(c.x, c.y, durationMs);
    return true;
  }
  async typeTextBySelector(selector: Selector, text: string): Promise<boolean> {
    const c = await this.layoutCenter(selector);
    if (!c) return false;
    await idb.tap(c.x, c.y);
    await new Promise((r) => setTimeout(r, 100));
    await idb.typeText(text);
    return true;
  }
  async clearTextBySelector(selector: Selector): Promise<boolean> {
    const c = await this.layoutCenter(selector);
    if (!c) return false;
    await idb.tap(c.x, c.y);
    for (let i = 0; i < 100; i++) {
      try { await idb.pressKey(42); } catch { break; }
    }
    return true;
  }
  async tapByText(text: string): Promise<boolean> {
    // expo-router NativeTabs renders tab bar items via UIKit/SwiftUI hosts
    // whose UIView subtree isn't surfaced for accessibility-label walks
    // (UITabBarButton stays opaque). Drive the UITabBarController directly
    // before falling back to coordinate taps.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tab: any = await (this.client as any).send('tapTabByName', { name: text });
    if (process.env.ENNIO_DEBUG_IDB) console.error(`[tapByText] '${text}' tabSwitch=${tab?.success}`);
    if (tab?.success === true) return true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: any = await (this.client as any).send('getViewWindowFrameByLabel', { text });
    const data = typeof r?.data === 'string' ? JSON.parse(r.data) : r?.data;
    if (data && data.width > 0 && data.height > 0) {
      await idb.tap(data.x + data.width / 2, data.y + data.height / 2, 150);
      return true;
    }
    const c = await this.layoutCenter({ text });
    if (c) {
      await idb.tap(c.x, c.y, 150);
      return true;
    }
    return false;
  }
  async tapAlertButton(buttonText: string): Promise<boolean> {
    const r = await (this.client as any).send('tapAlertButton', { buttonText });
    return r.success === true;
  }
  async dismissAlert(): Promise<boolean> {
    const r = await (this.client as any).send('dismissAlert', {});
    return r.success === true;
  }
  async setClipboard(text: string): Promise<boolean> {
    const r = await (this.client as any).send('copyToClipboard', { text });
    return r.success === true;
  }
  async pasteToFocused(): Promise<boolean> {
    const r = await (this.client as any).send('pasteFromClipboard', { testID: '' });
    return r.success === true;
  }
}

/**
 * Encode a Maestro selector for the in-app SelectorParser. Strips
 * undefined keys so the native side parses cleanly.
 */
function selectorToJson(selector: Selector): string {
  const out: Record<string, unknown> = {};
  if (selector.id !== undefined) out.id = selector.id;
  if (selector.text !== undefined) {
    if (typeof selector.text === 'string') {
      out.text = selector.text;
    } else {
      out.text = selector.text.pattern;
      if (selector.text.mode && selector.text.mode !== 'exact') {
        out.textMatchMode = selector.text.mode;
      }
    }
  }
  if (selector.index !== undefined) out.index = selector.index;
  if (selector.point !== undefined) {
    out.point = typeof selector.point === 'string'
      ? selector.point
      : { x: selector.point.x, y: selector.point.y };
  }
  if (selector.enabled !== undefined) out.enabled = selector.enabled;
  if (selector.checked !== undefined) out.checked = selector.checked;
  if (selector.focused !== undefined) out.focused = selector.focused;
  if (selector.selected !== undefined) out.selected = selector.selected;
  if (selector.below) out.below = JSON.parse(selectorToJson(selector.below));
  if (selector.above) out.above = JSON.parse(selectorToJson(selector.above));
  if (selector.leftOf) out.leftOf = JSON.parse(selectorToJson(selector.leftOf));
  if (selector.rightOf) out.rightOf = JSON.parse(selectorToJson(selector.rightOf));
  if (selector.containsChild) out.containsChild = JSON.parse(selectorToJson(selector.containsChild));
  if (selector.childOf) out.childOf = JSON.parse(selectorToJson(selector.childOf));
  if (selector.containsDescendants) out.containsDescendants = selector.containsDescendants.map((s) => JSON.parse(selectorToJson(s)));
  if (selector.width !== undefined) out.width = selector.width;
  if (selector.height !== undefined) out.height = selector.height;
  if (selector.tolerance !== undefined) out.tolerance = selector.tolerance;
  if (selector.traits) out.traits = selector.traits;
  return JSON.stringify(out);
}
