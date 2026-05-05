/**
 * Reader abstraction
 *
 * Single backend: NitroReader — every read traverses the in-app Fabric
 * shadow tree via the @ennio/core WebSocket. No XCTest, no XCUI.
 */

import type { EnnioClient, Selector } from './client';

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

export class NitroReader implements Reader {
  constructor(private client: EnnioClient) {}

  existsById(testID: string) {
    return this.client.exists(testID);
  }
  async isVisibleById(testID: string) {
    // Fabric's isVisible compares the shadow node's screenX/Y (offset
    // inside the React surface) against a hardcoded screen size — when
    // the element lives in a Stack-pushed screen its surface origin
    // differs from the window's, and the comparison rejects elements
    // that are clearly on screen. Trust UIKit's window-frame instead.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: any = await (this.client as any).send('getViewWindowFrame', { testID });
    const data = typeof r?.data === 'string' ? JSON.parse(r.data) : r?.data;
    if (!data || data.width <= 0 || data.height <= 0) return false;
    // iPhone 17 Pro logical viewport. Generous-enough for any iPhone
    // tested; anything past this is unambiguously off-screen.
    const w = 440, h = 956;
    if (data.x + data.width < 0 || data.y + data.height < 0) return false;
    if (data.x > w || data.y > h) return false;
    return true;
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
