/**
 * Reader abstraction
 *
 * Single backend: NitroReader — every read traverses the in-app Fabric
 * shadow tree via the @ennio/core WebSocket.
 */

import type { EnnioClient, Selector } from './client';

// iPhone 17 Pro logical viewport. Generous-enough for any iPhone tested;
// anything past this is unambiguously off-screen for visibility checks.
const IPHONE_VIEWPORT_WIDTH = 440;
const IPHONE_VIEWPORT_HEIGHT = 956;

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
    // Native `isVisible` uses the real key UIWindow bounds (vs the
    // hardcoded 440×956 we used to do in JS). It must agree with the
    // tap-time viewport gate or scrollUntilVisible exits early on a view
    // that's still offscreen and the subsequent tap fails.
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
