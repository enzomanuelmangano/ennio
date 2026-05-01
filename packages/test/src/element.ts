/**
 * Element API for Tasto - Direct Nitro access, no WebSocket
 *
 * Supports full Maestro selector parity:
 * - Primary: id, text, index, point
 * - State: enabled, checked, focused, selected
 * - Spatial: below, above, leftOf, rightOf
 * - Hierarchical: containsChild, childOf, containsDescendants
 * - Dimensions: width, height, tolerance
 * - Traits: text, long-text, square
 */
import {
  getTastoModule,
  type ElementInfo,
  type ExtendedElementInfo,
  type LayoutMetrics,
  type Selector,
  type TextMatcher,
} from '@tasto/nitro';

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
 * Normalize text selector to TextMatcher format
 */
function normalizeTextSelector(text: string | TextMatcher): TextMatcher {
  if (typeof text === 'string') {
    return { pattern: text, mode: 'exact' };
  }
  return text;
}

/**
 * Convert Selector to JSON string for native layer
 */
function selectorToJson(selector: Selector): string {
  // Deep clone and normalize text selectors
  const normalized: Record<string, unknown> = {};

  if (selector.id !== undefined) normalized.id = selector.id;

  if (selector.text !== undefined) {
    const textMatcher = normalizeTextSelector(selector.text);
    normalized.text = textMatcher.pattern;
    if (textMatcher.mode && textMatcher.mode !== 'exact') {
      normalized.textMatchMode = textMatcher.mode;
    }
  }

  if (selector.index !== undefined) normalized.index = selector.index;

  if (selector.point !== undefined) {
    if (typeof selector.point === 'string') {
      normalized.point = selector.point;
    } else {
      normalized.point = {
        x: selector.point.x,
        y: selector.point.y,
      };
    }
  }

  // State selectors
  if (selector.enabled !== undefined) normalized.enabled = selector.enabled;
  if (selector.checked !== undefined) normalized.checked = selector.checked;
  if (selector.focused !== undefined) normalized.focused = selector.focused;
  if (selector.selected !== undefined) normalized.selected = selector.selected;

  // Spatial selectors (recursive)
  if (selector.below) normalized.below = JSON.parse(selectorToJson(selector.below));
  if (selector.above) normalized.above = JSON.parse(selectorToJson(selector.above));
  if (selector.leftOf) normalized.leftOf = JSON.parse(selectorToJson(selector.leftOf));
  if (selector.rightOf) normalized.rightOf = JSON.parse(selectorToJson(selector.rightOf));

  // Hierarchical selectors
  if (selector.containsChild) {
    normalized.containsChild = JSON.parse(selectorToJson(selector.containsChild));
  }
  if (selector.childOf) {
    normalized.childOf = JSON.parse(selectorToJson(selector.childOf));
  }
  if (selector.containsDescendants) {
    normalized.containsDescendants = selector.containsDescendants.map(
      (s) => JSON.parse(selectorToJson(s))
    );
  }

  // Dimension selectors
  if (selector.width !== undefined) normalized.width = selector.width;
  if (selector.height !== undefined) normalized.height = selector.height;
  if (selector.tolerance !== undefined) normalized.tolerance = selector.tolerance;

  // Trait selectors
  if (selector.traits) normalized.traits = selector.traits;

  return JSON.stringify(normalized);
}

/**
 * Check if selector is simple id-only (for fast path)
 */
function isIdOnlySelector(selector: Selector): boolean {
  const keys = Object.keys(selector);
  return keys.length === 1 && keys[0] === 'id';
}

/**
 * Element class - fluent API for interacting with elements
 *
 * Supports both legacy testID strings and full Maestro selectors:
 *
 * ```typescript
 * // Legacy (testID string)
 * element('my-button').tap()
 *
 * // Full selector
 * element({ text: 'Submit', enabled: true }).tap()
 * element({ id: 'btn', below: { text: 'Header' } }).tap()
 * ```
 */
export class Element {
  private selector: Selector;
  private selectorJson: string;

  constructor(selector: string | Selector) {
    // Normalize string to id selector
    if (typeof selector === 'string') {
      this.selector = { id: selector };
    } else {
      this.selector = selector;
    }
    this.selectorJson = selectorToJson(this.selector);
  }

  /**
   * Get the selector description for error messages
   */
  private getSelectorDescription(): string {
    if (this.selector.id && isIdOnlySelector(this.selector)) {
      return `testID: ${this.selector.id}`;
    }
    return `selector: ${this.selectorJson}`;
  }

  /**
   * Check if element exists in the tree
   */
  async exists(): Promise<boolean> {
    const tasto = getTasto();

    // Fast path for id-only selectors
    if (isIdOnlySelector(this.selector) && this.selector.id) {
      return tasto.exists(this.selector.id);
    }

    return tasto.existsBySelector(this.selectorJson);
  }

  /**
   * Check if element is visible on screen
   */
  async isVisible(): Promise<boolean> {
    const tasto = getTasto();

    if (isIdOnlySelector(this.selector) && this.selector.id) {
      return tasto.isVisible(this.selector.id);
    }

    return tasto.isVisibleBySelector(this.selectorJson);
  }

  /**
   * Get element info
   */
  async getInfo(): Promise<ExtendedElementInfo | null> {
    const tasto = getTasto();

    if (isIdOnlySelector(this.selector) && this.selector.id) {
      const result = tasto.findByTestID(this.selector.id);
      if (result === null || result === undefined) return null;
      // Convert ElementInfo to ExtendedElementInfo with defaults
      const info = result as ElementInfo;
      return {
        ...info,
        checked: false,
        focused: false,
        selected: false,
      };
    }

    const result = tasto.findBySelector(this.selectorJson);
    if (result === null || result === undefined) return null;
    return result as ExtendedElementInfo;
  }

  /**
   * Get layout metrics (position, size)
   */
  async getLayout(): Promise<LayoutMetrics | null> {
    const tasto = getTasto();

    if (isIdOnlySelector(this.selector) && this.selector.id) {
      const result = tasto.getLayoutMetrics(this.selector.id);
      if (result === null || result === undefined) return null;
      return result as LayoutMetrics;
    }

    // For complex selectors, get info and extract layout
    const info = await this.getInfo();
    return info?.layout ?? null;
  }

  /**
   * Get text content
   */
  async getText(): Promise<string | null> {
    const tasto = getTasto();

    if (isIdOnlySelector(this.selector) && this.selector.id) {
      return tasto.getText(this.selector.id);
    }

    return tasto.getTextBySelector(this.selectorJson);
  }

  /**
   * Tap on the element
   */
  async tap(): Promise<void> {
    const tasto = getTasto();
    let success: boolean;

    if (isIdOnlySelector(this.selector) && this.selector.id) {
      success = tasto.tap(this.selector.id);
    } else {
      success = tasto.tapBySelector(this.selectorJson);
    }

    if (!success) {
      throw new Error(`[Tasto] Failed to tap element with ${this.getSelectorDescription()}`);
    }
    await sleep(50);
  }

  /**
   * Long press on the element
   */
  async longPress(duration: number = 500): Promise<void> {
    const tasto = getTasto();
    let success: boolean;

    if (isIdOnlySelector(this.selector) && this.selector.id) {
      success = tasto.longPress(this.selector.id, duration);
    } else {
      success = tasto.longPressBySelector(this.selectorJson, duration);
    }

    if (!success) {
      throw new Error(`[Tasto] Failed to long press element with ${this.getSelectorDescription()}`);
    }
    await sleep(50);
  }

  /**
   * Type text into the element
   */
  async typeText(text: string): Promise<void> {
    const tasto = getTasto();
    let success: boolean;

    if (isIdOnlySelector(this.selector) && this.selector.id) {
      success = tasto.typeText(this.selector.id, text);
    } else {
      success = tasto.typeTextBySelector(this.selectorJson, text);
    }

    if (!success) {
      throw new Error(`[Tasto] Failed to type text into element with ${this.getSelectorDescription()}`);
    }
    await sleep(50);
  }

  /**
   * Clear text from the element
   */
  async clearText(): Promise<void> {
    const tasto = getTasto();
    let success: boolean;

    if (isIdOnlySelector(this.selector) && this.selector.id) {
      success = tasto.clearText(this.selector.id);
    } else {
      success = tasto.clearTextBySelector(this.selectorJson);
    }

    if (!success) {
      throw new Error(`[Tasto] Failed to clear text from element with ${this.getSelectorDescription()}`);
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

    // Scroll requires testID - get it from element info
    let testID: string | undefined = this.selector.id;

    if (!testID || !isIdOnlySelector(this.selector)) {
      const info = await this.getInfo();
      testID = info?.testID;
    }

    if (!testID) {
      throw new Error(`[Tasto] Cannot scroll element without testID: ${this.getSelectorDescription()}`);
    }

    const deltaX = direction === 'left' ? -amount : direction === 'right' ? amount : 0;
    const deltaY = direction === 'up' ? -amount : direction === 'down' ? amount : 0;

    const success = tasto.scroll(testID, deltaX, deltaY);
    if (!success) {
      throw new Error(`[Tasto] Failed to scroll element with ${this.getSelectorDescription()}`);
    }
    await sleep(100);
  }

  /**
   * Scroll to make child element visible
   */
  async scrollTo(childSelector: string | Selector): Promise<void> {
    const tasto = getTasto();

    // scrollTo requires testIDs
    let scrollViewTestID: string | undefined = this.selector.id;
    if (!scrollViewTestID || !isIdOnlySelector(this.selector)) {
      const info = await this.getInfo();
      scrollViewTestID = info?.testID;
    }

    let childTestID: string;
    if (typeof childSelector === 'string') {
      childTestID = childSelector;
    } else {
      const childElement = new Element(childSelector);
      const childInfo = await childElement.getInfo();
      childTestID = childInfo?.testID ?? '';
    }

    if (!scrollViewTestID || !childTestID) {
      throw new Error(`[Tasto] scrollTo requires both elements to have testIDs`);
    }

    const success = tasto.scrollTo(scrollViewTestID, childTestID);
    if (!success) {
      throw new Error(`[Tasto] Failed to scroll to element`);
    }
    await sleep(100);
  }

  /**
   * Assert element is visible
   */
  async toBeVisible(): Promise<void> {
    const visible = await this.isVisible();
    if (!visible) {
      throw new Error(`[Tasto] Expected element with ${this.getSelectorDescription()} to be visible`);
    }
  }

  /**
   * Assert element exists
   */
  async toExist(): Promise<void> {
    const exists = await this.exists();
    if (!exists) {
      throw new Error(`[Tasto] Expected element with ${this.getSelectorDescription()} to exist`);
    }
  }

  /**
   * Assert element has text
   */
  async toHaveText(expected: string): Promise<void> {
    const text = await this.getText();
    if (text !== expected) {
      throw new Error(
        `[Tasto] Expected element with ${this.getSelectorDescription()} to have text "${expected}", got "${text}"`
      );
    }
  }

  /**
   * Assert element has text containing substring
   */
  async toContainText(substring: string): Promise<void> {
    const text = await this.getText();
    if (!text || !text.includes(substring)) {
      throw new Error(
        `[Tasto] Expected element with ${this.getSelectorDescription()} to contain text "${substring}", got "${text}"`
      );
    }
  }

  /**
   * Assert element is enabled
   */
  async toBeEnabled(): Promise<void> {
    const info = await this.getInfo();
    if (!info?.enabled) {
      throw new Error(`[Tasto] Expected element with ${this.getSelectorDescription()} to be enabled`);
    }
  }

  /**
   * Assert element is disabled
   */
  async toBeDisabled(): Promise<void> {
    const info = await this.getInfo();
    if (info?.enabled !== false) {
      throw new Error(`[Tasto] Expected element with ${this.getSelectorDescription()} to be disabled`);
    }
  }

  /**
   * Assert element is checked
   */
  async toBeChecked(): Promise<void> {
    const info = await this.getInfo();
    if (!info?.checked) {
      throw new Error(`[Tasto] Expected element with ${this.getSelectorDescription()} to be checked`);
    }
  }

  /**
   * Assert element is selected
   */
  async toBeSelected(): Promise<void> {
    const info = await this.getInfo();
    if (!info?.selected) {
      throw new Error(`[Tasto] Expected element with ${this.getSelectorDescription()} to be selected`);
    }
  }
}

/**
 * Create an element selector
 *
 * Supports both legacy testID strings and full Maestro selectors:
 *
 * @example
 * // Legacy - select by testID
 * element('my-button').tap()
 *
 * @example
 * // By text
 * element({ text: 'Submit' }).tap()
 *
 * @example
 * // By text with regex
 * element({ text: { pattern: '.*Login.*', mode: 'regex' } }).tap()
 *
 * @example
 * // Combined selectors
 * element({ text: 'OK', enabled: true }).tap()
 *
 * @example
 * // Spatial selectors
 * element({ text: 'Save', below: { id: 'form-header' } }).tap()
 *
 * @example
 * // Hierarchical selectors
 * element({ containsChild: { text: 'Price' } }).tap()
 *
 * @example
 * // Index selector (nth match)
 * element({ text: 'Item', index: 2 }).tap()  // Third matching element
 */
export function element(selector: string | Selector): Element {
  return new Element(selector);
}

/**
 * Helper to find all elements matching a selector
 *
 * @example
 * const items = await elements({ text: 'Item' });
 * console.log(`Found ${items.length} items`);
 */
export async function elements(selector: string | Selector): Promise<ExtendedElementInfo[]> {
  const tasto = getTasto();

  const selectorObj: Selector = typeof selector === 'string' ? { id: selector } : selector;
  const selectorJson = selectorToJson(selectorObj);

  return tasto.findAllBySelector(selectorJson);
}
