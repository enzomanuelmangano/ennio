/**
 * Element API for Tasto - Direct Nitro access, no WebSocket
 */
import { getTastoModule, type ElementInfo, type LayoutMetrics } from '@tasto/nitro';

// Get the Nitro module directly
const getTasto = () => {
  const tasto = getTastoModule();
  if (!tasto) {
    throw new Error('[Tasto] Native module not available. Make sure @tasto/nitro is properly installed.');
  }
  return tasto;
};

// Helper to wait
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Element class - fluent API for interacting with elements
 */
export class Element {
  constructor(private testID: string) {}

  /**
   * Check if element exists in the tree
   */
  async exists(): Promise<boolean> {
    const tasto = getTasto();
    return tasto.exists(this.testID);
  }

  /**
   * Check if element is visible on screen
   */
  async isVisible(): Promise<boolean> {
    const tasto = getTasto();
    return tasto.isVisible(this.testID);
  }

  /**
   * Get element info
   */
  async getInfo(): Promise<ElementInfo | null> {
    const tasto = getTasto();
    const result = tasto.findByTestID(this.testID);
    if (result === null || result === undefined) return null;
    return result as ElementInfo;
  }

  /**
   * Get layout metrics (position, size)
   */
  async getLayout(): Promise<LayoutMetrics | null> {
    const tasto = getTasto();
    const result = tasto.getLayoutMetrics(this.testID);
    if (result === null || result === undefined) return null;
    return result as LayoutMetrics;
  }

  /**
   * Get text content
   */
  async getText(): Promise<string> {
    const tasto = getTasto();
    return tasto.getText(this.testID);
  }

  /**
   * Tap on the element
   */
  async tap(): Promise<void> {
    const tasto = getTasto();
    const success = tasto.tap(this.testID);
    if (!success) {
      throw new Error(`[Tasto] Failed to tap element with testID: ${this.testID}`);
    }
    // Small delay for UI to update
    await sleep(50);
  }

  /**
   * Long press on the element
   */
  async longPress(duration: number = 500): Promise<void> {
    const tasto = getTasto();
    const success = tasto.longPress(this.testID, duration);
    if (!success) {
      throw new Error(`[Tasto] Failed to long press element with testID: ${this.testID}`);
    }
    await sleep(50);
  }

  /**
   * Type text into the element
   */
  async typeText(text: string): Promise<void> {
    const tasto = getTasto();
    const success = tasto.typeText(this.testID, text);
    if (!success) {
      throw new Error(`[Tasto] Failed to type text into element with testID: ${this.testID}`);
    }
    await sleep(50);
  }

  /**
   * Clear text from the element
   */
  async clearText(): Promise<void> {
    const tasto = getTasto();
    const success = tasto.clearText(this.testID);
    if (!success) {
      throw new Error(`[Tasto] Failed to clear text from element with testID: ${this.testID}`);
    }
    await sleep(50);
  }

  /**
   * Replace text in the element
   */
  async replaceText(text: string): Promise<void> {
    await this.clearText();
    await this.typeText(text);
  }

  /**
   * Scroll the element
   */
  async scroll(direction: 'up' | 'down' | 'left' | 'right', amount: number = 200): Promise<void> {
    const tasto = getTasto();
    const success = tasto.scroll(this.testID, direction, amount);
    if (!success) {
      throw new Error(`[Tasto] Failed to scroll element with testID: ${this.testID}`);
    }
    await sleep(100);
  }

  /**
   * Scroll to specific offset
   */
  async scrollTo(x: number, y: number): Promise<void> {
    const tasto = getTasto();
    const success = tasto.scrollTo(this.testID, x, y);
    if (!success) {
      throw new Error(`[Tasto] Failed to scroll to offset for element with testID: ${this.testID}`);
    }
    await sleep(100);
  }

  /**
   * Assert element is visible
   */
  async toBeVisible(): Promise<void> {
    const visible = await this.isVisible();
    if (!visible) {
      throw new Error(`[Tasto] Expected element with testID "${this.testID}" to be visible`);
    }
  }

  /**
   * Assert element exists
   */
  async toExist(): Promise<void> {
    const exists = await this.exists();
    if (!exists) {
      throw new Error(`[Tasto] Expected element with testID "${this.testID}" to exist`);
    }
  }

  /**
   * Assert element has text
   */
  async toHaveText(expected: string): Promise<void> {
    const text = await this.getText();
    if (text !== expected) {
      throw new Error(`[Tasto] Expected element "${this.testID}" to have text "${expected}", got "${text}"`);
    }
  }
}

/**
 * Create an element selector
 */
export function element(testID: string): Element {
  return new Element(testID);
}
