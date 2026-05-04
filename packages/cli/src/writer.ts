/**
 * Writer abstraction
 *
 * The maestro runner doesn't care HOW a tap or a typeText reaches the app —
 * it just needs a target identified by a Maestro selector or a coordinate.
 * Two implementations follow:
 *
 *   - NitroWriter (--fast)    -> dispatches every action to the in-app
 *                                @ennio/core module over the WebSocket.
 *                                Uses accessibilityActivate / UITextInput /
 *                                UIScrollView APIs in-process. ~5ms per call.
 *
 *   - XCTestWriter (--stable) -> dispatches every action to the bundled
 *                                EnnioXCTestRunner.xctest helper over TCP.
 *                                Uses XCUI HID injection. ~30ms per call.
 *                                Reliable for gesture-handler-driven flows.
 */

import type { EnnioClient, Selector } from './client';
import type { XCTestClient, ScreenSize } from './xctest-client';

export interface Writer {
  /**
   * What kind of writer this is. The runner uses the kind to enable
   * mode-specific shortcuts (e.g. coord resolution against XCUI).
   */
  readonly mode: 'fast' | 'stable';

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
  /** Tap any element whose visible label matches `text` (covers iOS native tab bar items). */
  tapByText(text: string): Promise<boolean>;

  // ---- alerts ----
  tapAlertButton(buttonText: string): Promise<boolean>;
  dismissAlert(): Promise<boolean>;

  // ---- pasteboard ----
  setClipboard(text: string): Promise<boolean>;
  pasteToFocused(): Promise<boolean>;
}

// =============================================================
// Fast writer: in-app via Nitro WebSocket
// =============================================================

export class NitroWriter implements Writer {
  readonly mode = 'fast' as const;
  constructor(private client: EnnioClient) {}

  describe(action: string): string {
    return `nitro ${action}`;
  }

  async tap(testID: string): Promise<boolean> {
    const r = await (this.client as any).send('tap', { testID });
    return r.success === true;
  }
  async tapAt(x: number, y: number): Promise<boolean> {
    // Nitro doesn't synthesize HID events at arbitrary screen coords —
    // its tap path resolves a testID to a UIView and calls
    // accessibilityActivate. Coordinate taps must go through XCUI.
    const r = await (this.client as any).send('tapAtPoint', { x, y });
    return r.success === true;
  }
  async doubleTap(testID: string): Promise<boolean> {
    const r = await (this.client as any).send('doubleTap', { testID });
    return r.success === true;
  }
  async longPress(testID: string, durationMs: number): Promise<boolean> {
    const r = await (this.client as any).send('longPress', { testID, duration: durationMs });
    return r.success === true;
  }
  async typeText(testID: string | null, text: string): Promise<boolean> {
    const r = await (this.client as any).send('typeText', { testID: testID ?? '', text });
    return r.success === true;
  }
  async clearText(testID: string): Promise<boolean> {
    const r = await (this.client as any).send('clearText', { testID });
    return r.success === true;
  }
  async eraseText(testID: string | null, count: number): Promise<boolean> {
    const r = await (this.client as any).send('eraseText', { testID: testID ?? '', count });
    return r.success === true;
  }
  async pressKey(testID: string | null, keyName: string): Promise<boolean> {
    const r = await (this.client as any).send('pressKey', { testID: testID ?? '', keyName });
    return r.success === true;
  }
  async scroll(testID: string | null, direction: 'up' | 'down' | 'left' | 'right', distance: number): Promise<boolean> {
    const r = await (this.client as any).send('scroll', { testID: testID ?? '', direction, distance });
    return r.success === true;
  }
  async swipe(testID: string | null, direction: 'up' | 'down' | 'left' | 'right', distance: number): Promise<boolean> {
    const r = await (this.client as any).send('swipe', { testID: testID ?? '', direction, distance });
    return r.success === true;
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
    const r = await (this.client as any).send('tapBySelector', { selector: selectorToJson(selector) });
    return r.success === true;
  }
  async doubleTapBySelector(selector: Selector): Promise<boolean> {
    const r = await (this.client as any).send('doubleTapBySelector', { selector: selectorToJson(selector) });
    return r.success === true;
  }
  async longPressBySelector(selector: Selector, durationMs: number): Promise<boolean> {
    const r = await (this.client as any).send('longPressBySelector', {
      selector: selectorToJson(selector),
      duration: durationMs,
    });
    return r.success === true;
  }
  async typeTextBySelector(selector: Selector, text: string): Promise<boolean> {
    const r = await (this.client as any).send('typeTextBySelector', {
      selector: selectorToJson(selector),
      text,
    });
    return r.success === true;
  }
  async clearTextBySelector(selector: Selector): Promise<boolean> {
    const r = await (this.client as any).send('clearTextBySelector', { selector: selectorToJson(selector) });
    return r.success === true;
  }
  async tapByText(text: string): Promise<boolean> {
    // Try the Fabric shadow tree first (covers Pressable / Touchable* with
    // matching text content), then fall back to a UIKit accessibility
    // walk via tapByLabel — that's how we hit native UITabBar items,
    // alert buttons, system sheets, etc.
    if (await this.tapBySelector({ text })) return true;
    const r = await (this.client as any).send('tapByLabel', { text });
    return r.success === true;
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

// =============================================================
// Stable writer: out-of-process via XCTest helper
// =============================================================

export interface StableContext {
  /** Resolve a testID to absolute window-coords via XCUI findById. */
  resolveByIdViaXCUI(testID: string): Promise<{ x: number; y: number; width: number; height: number } | null>;
  /** Resolve a label to absolute window-coords via XCUI findByLabel. */
  resolveByLabel(text: string): Promise<{ x: number; y: number; width: number; height: number } | null>;
  /** Read screen / safe-area metadata once and cache. */
  getScreen(): Promise<ScreenSize>;
  /** Fabric layout (React-surface coords + safe-area inset added in caller). */
  getLayoutMetrics(testID: string): Promise<{ x: number; y: number; width: number; height: number; screenX: number; screenY: number } | null>;
  /** Nitro selector → element info (for compound id+state lookups). */
  findBySelectorLayout(selector: Selector): Promise<{ x: number; y: number; width: number; height: number; screenX: number; screenY: number } | null>;
  /**
   * In-app keyboard dismiss via Nitro. XCTest runs in a separate
   * process so its UIApplication.shared cannot reach the user app's
   * responder chain. RN TextInputs ignore tap-outside, so we route
   * the dismiss through Nitro's resignFirstResponder helper.
   */
  hideKeyboardViaNitro(): Promise<boolean>;
}

export class XCTestWriter implements Writer {
  readonly mode = 'stable' as const;
  constructor(private xctest: XCTestClient, private ctx: StableContext) {}

  describe(action: string): string {
    return `xcui ${action}`;
  }

  async tapAt(x: number, y: number): Promise<boolean> {
    await this.xctest.tap(x, y);
    return true;
  }

  // Tap-by-id flow: prefer XCUI findById (uses hittablePoint on the
  // matched accessible element); fall back to Fabric layout + safe-area
  // adjusted coord tap.
  async tap(testID: string): Promise<boolean> {
    try {
      await this.xctest.tapById(testID);
      return true;
    } catch {
      const coords = await this.coordsFromFabric(testID);
      if (!coords) return false;
      await this.xctest.tap(coords.x, coords.y);
      return true;
    }
  }
  async doubleTap(testID: string): Promise<boolean> {
    const c = await this.coords(testID);
    if (!c) return false;
    await this.xctest.doubleTap(c.x, c.y);
    return true;
  }
  async longPress(testID: string, durationMs: number): Promise<boolean> {
    const c = await this.coords(testID);
    if (!c) return false;
    await this.xctest.longPress(c.x, c.y, durationMs);
    return true;
  }
  async typeText(_testID: string | null, text: string): Promise<boolean> {
    await this.xctest.typeText(text);
    return true;
  }
  async clearText(testID: string): Promise<boolean> {
    if (!(await this.tap(testID))) return false;
    for (let i = 0; i < 100; i++) {
      try { await this.xctest.pressKey('backspace'); } catch { break; }
    }
    return true;
  }
  async eraseText(_testID: string | null, count: number): Promise<boolean> {
    for (let i = 0; i < count; i++) {
      try { await this.xctest.pressKey('backspace'); } catch { return i > 0; }
    }
    return true;
  }
  async pressKey(_testID: string | null, keyName: string): Promise<boolean> {
    await this.xctest.pressKey(keyName);
    return true;
  }
  async scroll(_testID: string | null, direction: 'up' | 'down' | 'left' | 'right', distance: number): Promise<boolean> {
    const screen = await this.ctx.getScreen();
    const cx = 0.5;
    const cy = 0.5;
    const dx = (direction === 'left' ? distance : direction === 'right' ? -distance : 0) / screen.width;
    const dy = (direction === 'up' ? distance : direction === 'down' ? -distance : 0) / screen.height;
    await this.xctest.swipe(cx, cy, clamp(cx + dx), clamp(cy + dy), 250);
    return true;
  }
  async swipe(testID: string | null, direction: 'up' | 'down' | 'left' | 'right', distance: number): Promise<boolean> {
    return this.scroll(testID, direction, distance);
  }
  async scrollTo(_scrollViewTestID: string, elementTestID: string): Promise<boolean> {
    // XCUI's tapById scrolls the element into view internally; reuse to
    // bring the element above the keyboard / fold. We don't actually tap.
    // Simplest path: call findById which makes the element key-visible.
    const f = await this.ctx.resolveByIdViaXCUI(elementTestID);
    return f != null;
  }
  async back(): Promise<boolean> {
    await this.xctest.back();
    return true;
  }
  async hideKeyboard(): Promise<boolean> {
    return this.ctx.hideKeyboardViaNitro();
  }
  async tapBySelector(selector: Selector): Promise<boolean> {
    if (selector.text && !selector.id) {
      const t = typeof selector.text === 'string' ? selector.text : selector.text.pattern;
      return this.tapByText(t);
    }
    if (selector.id && !selector.text) return this.tap(selector.id);
    const layout = await this.ctx.findBySelectorLayout(selector);
    if (!layout) return false;
    const screen = await this.ctx.getScreen();
    const cx = (layout.screenX + layout.width / 2) / screen.width;
    const cy = (layout.screenY + layout.height / 2 + screen.safeAreaTop) / screen.height;
    await this.xctest.tap(cx, cy);
    return true;
  }
  async doubleTapBySelector(selector: Selector): Promise<boolean> {
    if (selector.id && !selector.text) return this.doubleTap(selector.id);
    return false;
  }
  async longPressBySelector(selector: Selector, durationMs: number): Promise<boolean> {
    if (selector.id && !selector.text) return this.longPress(selector.id, durationMs);
    return false;
  }
  async typeTextBySelector(selector: Selector, text: string): Promise<boolean> {
    if (selector.id) {
      if (!(await this.tap(selector.id))) return false;
    } else if (selector.text) {
      const t = typeof selector.text === 'string' ? selector.text : selector.text.pattern;
      if (!(await this.tapByText(t))) return false;
    }
    await this.xctest.typeText(text);
    return true;
  }
  async clearTextBySelector(selector: Selector): Promise<boolean> {
    if (selector.id) return this.clearText(selector.id);
    return false;
  }
  async tapByText(text: string): Promise<boolean> {
    // Use XCUI's element-relative tap (tapByLabel resolves to a Button or
    // Text and calls el.tap()). Coord-only taps at the static text's frame
    // center sometimes miss the Pressable's onPress, even when the touch
    // is within the wrapper's bounds.
    try {
      await this.xctest.tapByLabel(text, false);
      return true;
    } catch {
      return false;
    }
  }
  async tapAlertButton(buttonText: string): Promise<boolean> {
    await this.xctest.tapAlertButton(buttonText);
    return true;
  }
  async dismissAlert(): Promise<boolean> {
    await this.xctest.dismissAlert();
    return true;
  }
  async setClipboard(text: string): Promise<boolean> {
    await this.xctest.setPasteboard(text);
    return true;
  }
  async pasteToFocused(): Promise<boolean> {
    await this.xctest.paste();
    return true;
  }

  private async coords(testID: string): Promise<{ x: number; y: number } | null> {
    const xcui = await this.ctx.resolveByIdViaXCUI(testID);
    const screen = await this.ctx.getScreen();
    if (xcui) {
      return {
        x: (xcui.x + xcui.width / 2) / screen.width,
        y: (xcui.y + xcui.height / 2) / screen.height,
      };
    }
    return this.coordsFromFabric(testID);
  }

  private async coordsFromFabric(testID: string): Promise<{ x: number; y: number } | null> {
    const layout = await this.ctx.getLayoutMetrics(testID);
    if (!layout) return null;
    const screen = await this.ctx.getScreen();
    return {
      x: (layout.screenX + layout.width / 2) / screen.width,
      y: (layout.screenY + layout.height / 2 + screen.safeAreaTop) / screen.height,
    };
  }
}

function clamp(n: number): number {
  return Math.max(0.02, Math.min(0.98, n));
}

// =============================================================
// Hybrid writer: try fast Nitro first, fall back to XCTest helper
//
// Most production flows touch only Pressable / TextInput / ScrollView /
// alert / native-tab paths the in-app fast writer can handle. The few
// gestures it can't (RNGH pan/pinch/swipe-to-dismiss, deep modal taps,
// freshly-mounted views before the touch handler attaches) silently
// escalate to XCUI HID injection — slower but bulletproof. Verbose
// output flags every fallback so flaky targets are obvious.
// =============================================================

export class HybridWriter implements Writer {
  readonly mode = 'fast' as const;
  private lastUsed: 'nitro' | 'xctest' = 'nitro';

  constructor(
    private fast: NitroWriter,
    private slow: XCTestWriter,
    private slowCtx: StableContext,
    private onFallback?: (op: string, selector: unknown) => void
  ) {}

  describe(action: string): string {
    return this.lastUsed === 'nitro' ? `nitro ${action}` : `xctest-fallback ${action}`;
  }

  private async tryFastThenSlow<T extends unknown[]>(
    op: string,
    selectorForLog: unknown,
    fastFn: () => Promise<boolean>,
    slowFn: () => Promise<boolean>,
    ..._args: T
  ): Promise<boolean> {
    if (await fastFn()) {
      this.lastUsed = 'nitro';
      return true;
    }
    if (this.onFallback) this.onFallback(op, selectorForLog);
    const ok = await slowFn();
    this.lastUsed = ok ? 'xctest' : 'nitro';
    return ok;
  }

  tap(testID: string) {
    return this.tryFastThenSlow('tap', { id: testID }, () => this.fast.tap(testID), () => this.slow.tap(testID));
  }
  tapAt(x: number, y: number) {
    // Fast (Nitro) has no HID at-coord path; go straight to XCUI.
    return this.slow.tapAt(x, y);
  }
  doubleTap(testID: string) {
    return this.tryFastThenSlow('doubleTap', { id: testID }, () => this.fast.doubleTap(testID), () => this.slow.doubleTap(testID));
  }
  longPress(testID: string, durationMs: number) {
    return this.tryFastThenSlow('longPress', { id: testID }, () => this.fast.longPress(testID, durationMs), () => this.slow.longPress(testID, durationMs));
  }
  typeText(testID: string | null, text: string) {
    return this.tryFastThenSlow('typeText', { id: testID, text }, () => this.fast.typeText(testID, text), () => this.slow.typeText(testID, text));
  }
  clearText(testID: string) {
    return this.tryFastThenSlow('clearText', { id: testID }, () => this.fast.clearText(testID), () => this.slow.clearText(testID));
  }
  eraseText(testID: string | null, count: number) {
    return this.tryFastThenSlow('eraseText', { id: testID, count }, () => this.fast.eraseText(testID, count), () => this.slow.eraseText(testID, count));
  }
  pressKey(testID: string | null, keyName: string) {
    return this.tryFastThenSlow('pressKey', { keyName }, () => this.fast.pressKey(testID, keyName), () => this.slow.pressKey(testID, keyName));
  }
  scroll(testID: string | null, direction: 'up' | 'down' | 'left' | 'right', distance: number) {
    return this.tryFastThenSlow('scroll', { direction }, () => this.fast.scroll(testID, direction, distance), () => this.slow.scroll(testID, direction, distance));
  }
  swipe(testID: string | null, direction: 'up' | 'down' | 'left' | 'right', distance: number) {
    return this.tryFastThenSlow('swipe', { direction }, () => this.fast.swipe(testID, direction, distance), () => this.slow.swipe(testID, direction, distance));
  }
  scrollTo(scrollViewTestID: string, elementTestID: string) {
    return this.tryFastThenSlow('scrollTo', { id: elementTestID }, () => this.fast.scrollTo(scrollViewTestID, elementTestID), () => this.slow.scrollTo(scrollViewTestID, elementTestID));
  }
  back() {
    return this.tryFastThenSlow('back', null, () => this.fast.back(), () => this.slow.back());
  }
  hideKeyboard() {
    return this.tryFastThenSlow('hideKeyboard', null, () => this.fast.hideKeyboard(), () => this.slow.hideKeyboard());
  }
  tapBySelector(selector: Selector) {
    return this.tryFastThenSlow('tapBySelector', selector, () => this.fast.tapBySelector(selector), () => this.slow.tapBySelector(selector));
  }
  doubleTapBySelector(selector: Selector) {
    return this.tryFastThenSlow('doubleTapBySelector', selector, () => this.fast.doubleTapBySelector(selector), () => this.slow.doubleTapBySelector(selector));
  }
  longPressBySelector(selector: Selector, durationMs: number) {
    return this.tryFastThenSlow('longPressBySelector', selector, () => this.fast.longPressBySelector(selector, durationMs), () => this.slow.longPressBySelector(selector, durationMs));
  }
  typeTextBySelector(selector: Selector, text: string) {
    return this.tryFastThenSlow('typeTextBySelector', selector, () => this.fast.typeTextBySelector(selector, text), () => this.slow.typeTextBySelector(selector, text));
  }
  clearTextBySelector(selector: Selector) {
    return this.tryFastThenSlow('clearTextBySelector', selector, () => this.fast.clearTextBySelector(selector), () => this.slow.clearTextBySelector(selector));
  }
  tapByText(text: string) {
    // Nitro fast-path: in-app C++ EventDispatcher walks the Fabric shadow
    // tree, finds the matching node, walks up to the nearest View with a
    // TouchEventEmitter, and dispatches a synthetic touchStart + touchEnd
    // through RN's responder chain. Pressability fires onPress in ~1ms.
    // Falls back to XCUI HID injection only when no Fabric node matches
    // (native tab-bar items, system alert buttons).
    return this.tryFastThenSlow(
      'tapByText',
      { text },
      () => this.fast.tapByText(text),
      () => this.slow.tapByText(text),
    );
  }
  tapAlertButton(buttonText: string) {
    return this.tryFastThenSlow('tapAlertButton', { text: buttonText }, () => this.fast.tapAlertButton(buttonText), () => this.slow.tapAlertButton(buttonText));
  }
  dismissAlert() {
    return this.tryFastThenSlow('dismissAlert', null, () => this.fast.dismissAlert(), () => this.slow.dismissAlert());
  }
  setClipboard(text: string) {
    return this.tryFastThenSlow('setClipboard', null, () => this.fast.setClipboard(text), () => this.slow.setClipboard(text));
  }
  pasteToFocused() {
    return this.tryFastThenSlow('pasteToFocused', null, () => this.fast.pasteToFocused(), () => this.slow.pasteToFocused());
  }
}

// Mirror of EnnioClient.selectorToJson; lifted here so writer.ts has
// no concrete EnnioClient dependency on its own selector encoder.
function selectorToJson(selector: Selector): string {
  // Strip undefined keys so the native side parses cleanly.
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
