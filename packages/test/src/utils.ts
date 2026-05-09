/**
 * Utility functions for Ennio tests
 */
import { getEnnioModule } from '@ennio/core';
import { element } from './element';

/**
 * Sleep for a given number of milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for an element to exist
 */
export async function waitForElement(
  testID: string,
  options: { timeout?: number; interval?: number } = {},
): Promise<void> {
  const { timeout = 5000, interval = 100 } = options;
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const exists = await element(testID).exists();
    if (exists) return;
    await sleep(interval);
  }

  throw new Error(`[Ennio] Timeout waiting for element with testID: ${testID}`);
}

/**
 * Wait for an element to be visible
 */
export async function waitForVisible(
  testID: string,
  options: { timeout?: number; interval?: number } = {},
): Promise<void> {
  const { timeout = 5000, interval = 100 } = options;
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const visible = await element(testID).isVisible();
    if (visible) return;
    await sleep(interval);
  }

  throw new Error(`[Ennio] Timeout waiting for element to be visible: ${testID}`);
}

/**
 * Wait for an element to disappear
 */
export async function waitForElementToDisappear(
  testID: string,
  options: { timeout?: number; interval?: number } = {},
): Promise<void> {
  const { timeout = 5000, interval = 100 } = options;
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const exists = await element(testID).exists();
    if (!exists) return;
    await sleep(interval);
  }

  throw new Error(`[Ennio] Timeout waiting for element to disappear: ${testID}`);
}

/**
 * Wait for app to be idle (no pending updates)
 */
export async function waitForIdle(_timeout: number = 5000): Promise<void> {
  const ennio = getEnnioModule();
  if (!ennio) {
    throw new Error('[Ennio] Native module not available');
  }

  // For now, just a small delay - could be enhanced with actual idle detection
  await sleep(100);
}

/**
 * Alert handling utilities
 */
export const Alert = {
  /**
   * Check if an alert is currently visible
   */
  async isPresent(): Promise<boolean> {
    const ennio = getEnnioModule();
    if (!ennio) return false;
    return ennio.isAlertPresent();
  },

  /**
   * Get the alert text (title + message)
   */
  async getText(): Promise<string> {
    const ennio = getEnnioModule();
    if (!ennio) return '';
    return ennio.getAlertText();
  },

  /**
   * Get the list of button titles
   */
  async getButtons(): Promise<string[]> {
    const ennio = getEnnioModule();
    if (!ennio) return [];
    return ennio.getAlertButtons();
  },

  /**
   * Tap a button by its text
   */
  async tap(buttonText: string): Promise<void> {
    const ennio = getEnnioModule();
    if (!ennio) {
      throw new Error('[Ennio] Native module not available');
    }
    const success = ennio.tapAlertButton(buttonText);
    if (!success) {
      throw new Error(`[Ennio] Failed to tap alert button: ${buttonText}`);
    }
    await sleep(100);
  },

  /**
   * Dismiss the alert (tap cancel or last button)
   */
  async dismiss(): Promise<void> {
    const ennio = getEnnioModule();
    if (!ennio) {
      throw new Error('[Ennio] Native module not available');
    }
    const success = ennio.dismissAlert();
    if (!success) {
      throw new Error('[Ennio] Failed to dismiss alert');
    }
    await sleep(100);
  },

  /**
   * Wait for an alert to appear
   */
  async waitFor(options: { timeout?: number } = {}): Promise<void> {
    const { timeout = 5000 } = options;
    const start = Date.now();

    while (Date.now() - start < timeout) {
      if (await Alert.isPresent()) return;
      await sleep(100);
    }

    throw new Error('[Ennio] Timeout waiting for alert');
  },
};
