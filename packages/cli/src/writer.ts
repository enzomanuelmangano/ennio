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

  async tap(testID: string): Promise<boolean> {
    const center = await this.layoutCenter({ id: testID });
    if (!center) return false;
    await idb.tap(center.x, center.y);
    return true;
  }
  async tapAt(x: number, y: number): Promise<boolean> {
    await idb.tap(x, y);
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
    // safe-area padding, modal presentations). One round-trip, exact.
    if (selector.id && !selector.text && !selector.point) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r: any = await (this.client as any).send('getViewWindowFrame', { testID: selector.id });
      const data = typeof r?.data === 'string' ? JSON.parse(r.data) : r?.data;
      if (data && data.width > 0 && data.height > 0) {
        if (process.env.ENNIO_DEBUG_IDB) {
          console.error(`[layout] id=${selector.id} → window=(${data.x},${data.y},${data.width},${data.height})`);
        }
        return { x: data.x + data.width / 2, y: data.y + data.height / 2 };
      }
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
    // Scroll = swipe at the viewport centre. Direction inverts because
    // a swipe up = scroll down (content moves up).
    const cx = 200, cy = 450; // safe-area-ish centre for 402x874 sims
    const dx = direction === 'left' ? distance : direction === 'right' ? -distance : 0;
    const dy = direction === 'up' ? distance : direction === 'down' ? -distance : 0;
    await idb.swipe(cx, cy, cx - dx, cy - dy, 200);
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
    return r.success === true;
  }
  async hideKeyboard(): Promise<boolean> {
    const r = await (this.client as any).send('hideKeyboard', {});
    return r.success === true;
  }
  async tapBySelector(selector: Selector): Promise<boolean> {
    const c = await this.layoutCenter(selector);
    if (!c) return false;
    await idb.tap(c.x, c.y);
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
    // UIKit accessibility-label walk first. Tab bars, alert buttons,
    // navigation back buttons, and most native widgets carry a clean
    // accessibilityLabel that matches the user-visible text exactly,
    // so this finds the right one even when the same word appears
    // multiple times in the React tree (e.g. "Cart" in a product card
    // AND in the tab bar). Fabric's text match is a substring scan,
    // so it grabs the first hit regardless of tap-ability.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: any = await (this.client as any).send('getViewWindowFrameByLabel', { text });
    const data = typeof r?.data === 'string' ? JSON.parse(r.data) : r?.data;
    if (data && data.width > 0 && data.height > 0) {
      await idb.tap(data.x + data.width / 2, data.y + data.height / 2);
      return true;
    }
    // Fallback: Fabric shadow tree text match, idb tap at the centre.
    // Used for components that have on-screen text but no
    // accessibilityLabel (custom buttons, decorative cards).
    const c = await this.layoutCenter({ text });
    if (c) {
      await idb.tap(c.x, c.y);
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
