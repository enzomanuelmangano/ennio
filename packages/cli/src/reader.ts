/**
 * Reader abstraction
 *
 * Mirror of writer.ts for the read side. Maestro flows do a lot of
 * `assertVisible`/`assertNotVisible`/`waitFor` queries, and the source
 * of truth differs by mode:
 *
 *   - NitroReader   -> in-app Fabric shadow tree (fast, but blind to
 *                       native UI outside React: UITabBar items, system
 *                       date pickers, alert buttons).
 *   - XCTestReader  -> XCUI accessibility tree (covers everything the
 *                       user can see on screen, including native UI;
 *                       slower because of cross-process IPC).
 *   - HybridReader  -> Try Nitro first; fall back to XCUI if the Nitro
 *                       answer is negative. Default for fast mode.
 */

import type { EnnioClient, Selector } from './client';
import type { XCTestClient } from './xctest-client';

export interface Reader {
  /** Element with `testID` exists in the visible UI. */
  existsById(testID: string): Promise<boolean>;
  /** Element with `testID` is on-screen and has non-zero size. */
  isVisibleById(testID: string): Promise<boolean>;
  /** Some element matching the selector exists. */
  existsBySelector(selector: Selector): Promise<boolean>;
  /** Some element matching the selector is on-screen. */
  isVisibleBySelector(selector: Selector): Promise<boolean>;
  /** Native UIAlertController is currently presented. */
  isAlertPresent(): Promise<boolean>;
  /** Alert title + message joined with `\n`. */
  getAlertText(): Promise<string>;
  /** Alert button titles in the order they were defined. */
  getAlertButtons(): Promise<string[]>;
  /** Text content for `testID`, or null if not found / not text. */
  getText(testID: string): Promise<string | null>;
}

// =============================================================
// Nitro reader: Fabric shadow tree only
// =============================================================

export class NitroReader implements Reader {
  constructor(private client: EnnioClient) {}

  existsById(testID: string) {
    return this.client.exists(testID);
  }
  isVisibleById(testID: string) {
    return this.client.isVisible(testID);
  }
  existsBySelector(selector: Selector) {
    return this.client.existsBySelector(selector);
  }
  isVisibleBySelector(selector: Selector) {
    return this.client.isVisibleBySelector(selector);
  }
  isAlertPresent() {
    return this.client.isAlertPresent();
  }
  getAlertText() {
    return this.client.getAlertText();
  }
  getAlertButtons() {
    return this.client.getAlertButtons();
  }
  getText(testID: string) {
    return this.client.getText(testID);
  }
}

// =============================================================
// XCTest reader: XCUI accessibility tree
// =============================================================

export class XCTestReader implements Reader {
  constructor(private xctest: XCTestClient) {}

  async existsById(testID: string) {
    const r = await this.xctest.findById(testID);
    return r.found === true;
  }
  async isVisibleById(testID: string) {
    const r = await this.xctest.findById(testID);
    if (!r.found || !r.frame) return false;
    // hittable (XCUI's "user can actually tap this point") is the
    // right "visible-to-user" signal. A view that's mounted under a
    // modal has frame > 0 but isn't hittable.
    if (r.hittable !== undefined) return r.hittable;
    return r.frame.width > 0 && r.frame.height > 0;
  }
  async existsBySelector(selector: Selector) {
    if (selector.text && typeof selector.text === 'string') {
      const r = await this.xctest.findByLabel(selector.text);
      if (r.found) return true;
    }
    if (selector.id) {
      const r = await this.xctest.findById(selector.id);
      if (r.found) return true;
    }
    return false;
  }
  async isVisibleBySelector(selector: Selector) {
    return this.existsBySelector(selector);
  }
  async isAlertPresent() {
    // XCTest doesn't expose UIAlertController directly; the in-app helper
    // owns this. Always return false here so HybridReader prefers Nitro.
    return false;
  }
  async getAlertText() {
    return '';
  }
  async getAlertButtons() {
    return [];
  }
  async getText(_testID: string) {
    // Could read XCUIElement.value/label; not implemented yet.
    return null;
  }
}

// =============================================================
// Hybrid reader: Nitro first, fall back to XCTest
// =============================================================

export class HybridReader implements Reader {
  constructor(
    private fast: NitroReader,
    private slow: XCTestReader,
    private onFallback?: (op: string, arg: unknown) => void
  ) {}

  private async tryFastThenSlow(
    op: string,
    arg: unknown,
    fastFn: () => Promise<boolean>,
    slowFn: () => Promise<boolean>
  ): Promise<boolean> {
    if (await fastFn()) return true;
    if (this.onFallback) this.onFallback(op, arg);
    return slowFn();
  }

  existsById(testID: string) {
    return this.tryFastThenSlow('existsById', testID, () => this.fast.existsById(testID), () => this.slow.existsById(testID));
  }

  // Visibility-on-screen: Nitro decides quickly (every 30ms during a
  // poll loop) whether the element is in the shadow tree. Only when it
  // says yes do we verify against XCUI's accessibility tree — which
  // can tell whether the element is covered by a Stack-pushed modal
  // (Nitro can't, since both screens are mounted under the same tab).
  // Costs one extra XCUI roundtrip on a positive Nitro result; while
  // polling we stay on the cheap Nitro path.
  async isVisibleById(testID: string) {
    if (await this.fast.isVisibleById(testID)) {
      // Confirm with XCUI when it indexes the element — catches the
      // "tab content mounted under a Stack-pushed modal" false positive.
      const xcuiKnown = await this.slow.existsById(testID);
      if (!xcuiKnown) return true;
      return this.slow.isVisibleById(testID);
    }
    // Nitro says no — element may be native UI (alert buttons, tab bar
    // items) outside Fabric. Probe XCUI as a fallback.
    if (this.onFallback) this.onFallback('isVisibleById', testID);
    return this.slow.isVisibleById(testID);
  }

  existsBySelector(selector: Selector) {
    return this.tryFastThenSlow('existsBySelector', selector, () => this.fast.existsBySelector(selector), () => this.slow.existsBySelector(selector));
  }

  async isVisibleBySelector(selector: Selector) {
    if (await this.fast.isVisibleBySelector(selector)) {
      const xcuiKnown = await this.slow.existsBySelector(selector);
      if (!xcuiKnown) return true;
      return this.slow.isVisibleBySelector(selector);
    }
    if (this.onFallback) this.onFallback('isVisibleBySelector', selector);
    return this.slow.isVisibleBySelector(selector);
  }
  // Alert reads only live in the in-app helper today; no XCUI fallback.
  isAlertPresent() { return this.fast.isAlertPresent(); }
  getAlertText() { return this.fast.getAlertText(); }
  getAlertButtons() { return this.fast.getAlertButtons(); }
  // getText: prefer Nitro; fall back to XCUI label/value if it grows.
  async getText(testID: string) {
    const t = await this.fast.getText(testID);
    if (t !== null) return t;
    return this.slow.getText(testID);
  }
}
