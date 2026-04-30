import { getClient, TastoClient } from './client';
import type { ElementInfo, LayoutMetrics, ScrollDirection, TestConfig } from './types';

const DEFAULT_TIMEOUT = 5000;
const DEFAULT_RETRY_DELAY = 100;

let config: TestConfig = {
  defaultTimeout: DEFAULT_TIMEOUT,
  retryCount: 50,
  retryDelay: DEFAULT_RETRY_DELAY,
  verbose: false,
};

/**
 * Configure the test runner
 */
export function configure(options: Partial<TestConfig>): void {
  config = { ...config, ...options };
}

/**
 * Element wrapper for fluent API
 */
export class Element {
  private testID: string;
  private client: TastoClient;

  constructor(testID: string) {
    this.testID = testID;
    this.client = getClient();
  }

  // ============================================
  // Queries
  // ============================================

  /**
   * Check if element exists
   */
  async exists(): Promise<boolean> {
    return this.client.exists(this.testID);
  }

  /**
   * Check if element is visible
   */
  async isVisible(): Promise<boolean> {
    return this.client.isVisible(this.testID);
  }

  /**
   * Get element info
   */
  async getInfo(): Promise<ElementInfo | null> {
    return this.client.findByTestID(this.testID);
  }

  /**
   * Get layout metrics
   */
  async getLayout(): Promise<LayoutMetrics | null> {
    return this.client.getLayoutMetrics(this.testID);
  }

  /**
   * Get text content
   */
  async getText(): Promise<string | null> {
    return this.client.getText(this.testID);
  }

  // ============================================
  // Actions
  // ============================================

  /**
   * Tap on the element
   */
  async tap(): Promise<Element> {
    await this.client.tap(this.testID);
    return this;
  }

  /**
   * Long press on the element
   */
  async longPress(durationMs: number = 500): Promise<Element> {
    await this.client.longPress(this.testID, durationMs);
    return this;
  }

  /**
   * Type text into the element
   */
  async typeText(text: string): Promise<Element> {
    await this.client.typeText(this.testID, text);
    return this;
  }

  /**
   * Clear text from the element
   */
  async clearText(): Promise<Element> {
    await this.client.clearText(this.testID);
    return this;
  }

  /**
   * Replace text in the element
   */
  async replaceText(text: string): Promise<Element> {
    await this.client.replaceText(this.testID, text);
    return this;
  }

  /**
   * Scroll the element (if it's a ScrollView)
   */
  async scroll(deltaX: number, deltaY: number): Promise<Element> {
    await this.client.scroll(this.testID, deltaX, deltaY);
    return this;
  }

  /**
   * Scroll to make a child visible
   */
  async scrollTo(elementTestID: string): Promise<Element> {
    await this.client.scrollTo(this.testID, elementTestID);
    return this;
  }

  /**
   * Scroll to an index (for FlatList)
   */
  async scrollToIndex(index: number): Promise<Element> {
    await this.client.scrollToIndex(this.testID, index);
    return this;
  }

  /**
   * Swipe on the element
   */
  async swipe(direction: ScrollDirection, distance: number = 200): Promise<Element> {
    await this.client.swipe(this.testID, direction, distance);
    return this;
  }

  // ============================================
  // Assertions
  // ============================================

  /**
   * Assert that the element exists
   */
  async toExist(): Promise<Element> {
    const exists = await this.client.exists(this.testID);
    if (!exists) {
      throw new Error(`Element "${this.testID}" does not exist`);
    }
    return this;
  }

  /**
   * Assert that the element does not exist
   */
  async toNotExist(): Promise<Element> {
    const exists = await this.client.exists(this.testID);
    if (exists) {
      throw new Error(`Element "${this.testID}" exists but should not`);
    }
    return this;
  }

  /**
   * Assert that the element is visible
   */
  async toBeVisible(): Promise<Element> {
    const visible = await this.client.isVisible(this.testID);
    if (!visible) {
      throw new Error(`Element "${this.testID}" is not visible`);
    }
    return this;
  }

  /**
   * Assert that the element is not visible
   */
  async toNotBeVisible(): Promise<Element> {
    const visible = await this.client.isVisible(this.testID);
    if (visible) {
      throw new Error(`Element "${this.testID}" is visible but should not be`);
    }
    return this;
  }

  /**
   * Assert that the element has specific text
   */
  async toHaveText(expectedText: string): Promise<Element> {
    const text = await this.client.getText(this.testID);
    if (text !== expectedText) {
      throw new Error(
        `Element "${this.testID}" has text "${text}" but expected "${expectedText}"`
      );
    }
    return this;
  }

  /**
   * Assert that the element contains specific text
   */
  async toContainText(substring: string): Promise<Element> {
    const text = await this.client.getText(this.testID);
    if (!text || !text.includes(substring)) {
      throw new Error(
        `Element "${this.testID}" does not contain text "${substring}". Actual: "${text}"`
      );
    }
    return this;
  }
}

/**
 * Create an element wrapper for the given testID
 */
export function element(testID: string): Element {
  return new Element(testID);
}

/**
 * Wait for a condition to be true
 */
export async function waitFor(
  condition: () => Promise<Element> | Promise<boolean>,
  options: { timeout?: number; interval?: number } = {}
): Promise<void> {
  const timeout = options.timeout ?? config.defaultTimeout ?? DEFAULT_TIMEOUT;
  const interval = options.interval ?? config.retryDelay ?? DEFAULT_RETRY_DELAY;
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    try {
      const result = await condition();
      // If condition returns true or an Element (truthy), we're done
      if (result) {
        return;
      }
    } catch {
      // Condition threw, keep retrying
    }

    await sleep(interval);
  }

  throw new Error(`waitFor timed out after ${timeout}ms`);
}

/**
 * Wait for an element to exist
 */
export async function waitForElement(
  testID: string,
  options: { timeout?: number } = {}
): Promise<Element> {
  const elem = element(testID);
  await waitFor(async () => {
    await elem.toExist();
    return true;
  }, options);
  return elem;
}

/**
 * Wait for an element to be visible
 */
export async function waitForVisible(
  testID: string,
  options: { timeout?: number } = {}
): Promise<Element> {
  const elem = element(testID);
  await waitFor(async () => {
    await elem.toBeVisible();
    return true;
  }, options);
  return elem;
}

/**
 * Wait for an element to not exist
 */
export async function waitForNotExist(
  testID: string,
  options: { timeout?: number } = {}
): Promise<void> {
  await waitFor(async () => {
    const exists = await getClient().exists(testID);
    return !exists;
  }, options);
}

/**
 * Wait for an element to not be visible
 */
export async function waitForNotVisible(
  testID: string,
  options: { timeout?: number } = {}
): Promise<void> {
  await waitFor(async () => {
    const visible = await getClient().isVisible(testID);
    return !visible;
  }, options);
}

/**
 * Synchronize with the app
 */
export async function synchronize(): Promise<void> {
  await getClient().synchronize();
}

/**
 * Wait for idle state
 */
export async function waitForIdle(timeoutMs?: number): Promise<void> {
  await getClient().waitForIdle(timeoutMs ?? config.defaultTimeout ?? DEFAULT_TIMEOUT);
}

/**
 * Sleep for a specified duration
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Expect helper for assertions
 */
export function expect(testID: string): Element {
  return element(testID);
}

// ============================================
// Alert/Modal API
// ============================================

/**
 * Check if an alert is currently present
 */
export async function isAlertPresent(): Promise<boolean> {
  return getClient().isAlertPresent();
}

/**
 * Get the text of the current alert (title + message)
 */
export async function getAlertText(): Promise<string> {
  return getClient().getAlertText();
}

/**
 * Get the button titles of the current alert
 */
export async function getAlertButtons(): Promise<string[]> {
  return getClient().getAlertButtons();
}

/**
 * Tap an alert button by its text
 */
export async function tapAlertButton(buttonText: string): Promise<void> {
  await getClient().tapAlertButton(buttonText);
}

/**
 * Dismiss the current alert
 */
export async function dismissAlert(): Promise<void> {
  await getClient().dismissAlert();
}

/**
 * Wait for an alert to appear
 */
export async function waitForAlert(options: { timeout?: number } = {}): Promise<void> {
  await waitFor(async () => {
    const present = await isAlertPresent();
    return present;
  }, options);
}

/**
 * Alert helper class for fluent API
 */
export class Alert {
  /**
   * Check if alert is present
   */
  static async isPresent(): Promise<boolean> {
    return isAlertPresent();
  }

  /**
   * Get alert text
   */
  static async getText(): Promise<string> {
    return getAlertText();
  }

  /**
   * Get alert buttons
   */
  static async getButtons(): Promise<string[]> {
    return getAlertButtons();
  }

  /**
   * Tap a button on the alert
   */
  static async tap(buttonText: string): Promise<void> {
    return tapAlertButton(buttonText);
  }

  /**
   * Dismiss the alert
   */
  static async dismiss(): Promise<void> {
    return dismissAlert();
  }

  /**
   * Wait for alert to appear
   */
  static async waitFor(options?: { timeout?: number }): Promise<void> {
    return waitForAlert(options);
  }
}
