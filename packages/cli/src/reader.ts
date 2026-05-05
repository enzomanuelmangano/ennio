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
