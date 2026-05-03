/**
 * Tasto WebSocket Client
 *
 * Connects directly to the native Tasto WebSocket server
 * running in the app. Works in both debug and release builds.
 *
 * Supports full Maestro selector parity.
 */

const DEFAULT_PORT = 9876;

interface TastoRequest {
  id: string;
  type: string;
  payload: Record<string, unknown>;
}

interface TastoResponse {
  id: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

/**
 * Layout metrics for a UI element
 */
export interface LayoutMetrics {
  x: number;
  y: number;
  width: number;
  height: number;
  screenX: number;
  screenY: number;
}

/**
 * Extended element info with state properties
 */
export interface ExtendedElementInfo {
  testID: string;
  type: string;
  text?: string;
  accessible: boolean;
  enabled: boolean;
  checked: boolean;
  focused: boolean;
  selected: boolean;
  layout: LayoutMetrics;
}

/**
 * Text matching mode for text selectors
 */
export type TextMatchMode = 'exact' | 'contains' | 'regex' | 'startsWith' | 'endsWith';

/**
 * Text matcher configuration
 */
export interface TextMatcher {
  pattern: string;
  mode?: TextMatchMode;
}

/**
 * Point for coordinate-based selection
 */
export interface Point {
  x: number;
  y: number;
  isPercentage?: boolean;
}

/**
 * Trait types for trait-based selection
 */
export type Trait = 'text' | 'long-text' | 'square';

/**
 * Selector - Full Maestro selector parity
 */
export interface Selector {
  // Primary
  id?: string;
  text?: string | TextMatcher;
  index?: number;
  point?: Point | string;

  // State
  enabled?: boolean;
  checked?: boolean;
  focused?: boolean;
  selected?: boolean;

  // Spatial
  below?: Selector;
  above?: Selector;
  leftOf?: Selector;
  rightOf?: Selector;

  // Hierarchical
  containsChild?: Selector;
  childOf?: Selector;
  containsDescendants?: Selector[];

  // Dimensions
  width?: number;
  height?: number;
  tolerance?: number;

  // Traits
  traits?: Trait[];
}

export class TastoClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, { resolve: (r: TastoResponse) => void; reject: (e: Error) => void }>();
  private messageId = 0;
  private port: number;

  constructor(port: number = DEFAULT_PORT) {
    this.port = port;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `ws://localhost:${this.port}`;
      this.ws = new WebSocket(url);

      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error(`Failed to connect to Tasto server on port ${this.port}`));

      this.ws.onmessage = (event) => {
        try {
          const response: TastoResponse = JSON.parse(event.data as string);
          const handler = this.pending.get(response.id);
          if (handler) {
            this.pending.delete(response.id);
            handler.resolve(response);
          }
        } catch {
          // Ignore malformed messages
        }
      };

      this.ws.onclose = () => {
        // Reject all pending requests
        for (const [id, handler] of this.pending) {
          handler.reject(new Error('Connection closed'));
          this.pending.delete(id);
        }
      };
    });
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private async send(type: string, payload: Record<string, unknown> = {}): Promise<TastoResponse> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected to Tasto server');
    }

    const id = String(++this.messageId);
    const request: TastoRequest = { id, type, payload };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify(request));

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Request timeout: ${type}`));
        }
      }, 30000);
    });
  }

  // Element queries
  async exists(testID: string): Promise<boolean> {
    const response = await this.send('exists', { testID });
    return response.data === true || response.data === 'true';
  }

  async isVisible(testID: string): Promise<boolean> {
    const response = await this.send('isVisible', { testID });
    return response.data === true || response.data === 'true';
  }

  async getText(testID: string): Promise<string | null> {
    const response = await this.send('getText', { testID });
    if (response.data === null || response.data === 'null') return null;
    return typeof response.data === 'string' ? response.data.replace(/^"|"$/g, '') : null;
  }

  // Actions
  async tap(testID: string): Promise<boolean> {
    const response = await this.send('tap', { testID });
    return response.success;
  }

  async typeText(testID: string, text: string): Promise<boolean> {
    const response = await this.send('typeText', { testID, text });
    return response.success;
  }

  async clearText(testID: string): Promise<boolean> {
    const response = await this.send('clearText', { testID });
    return response.success;
  }

  async scroll(testID: string, direction: string, amount: number): Promise<boolean> {
    const deltaX = direction === 'left' ? -amount : direction === 'right' ? amount : 0;
    const deltaY = direction === 'up' ? -amount : direction === 'down' ? amount : 0;
    const response = await this.send('scroll', { testID, deltaX, deltaY });
    return response.success;
  }

  async longPress(testID: string, duration: number = 500): Promise<boolean> {
    const response = await this.send('longPress', { testID, duration });
    return response.success;
  }

  async doubleTap(testID: string): Promise<boolean> {
    const response = await this.send('doubleTap', { testID });
    return response.success;
  }

  async getElementInfo(testID: string): Promise<ExtendedElementInfo | null> {
    const response = await this.send('getElementInfo', { testID });
    if (!response.success || !response.data) return null;
    return (typeof response.data === 'string' ? JSON.parse(response.data) : response.data) as ExtendedElementInfo;
  }

  // Synchronization
  async waitForIdle(timeout: number = 5000): Promise<boolean> {
    const response = await this.send('waitForIdle', { timeout });
    return response.success;
  }

  async synchronize(): Promise<void> {
    await this.send('synchronize', {});
  }

  // Alert handling
  async isAlertPresent(): Promise<boolean> {
    const response = await this.send('isAlertPresent', {});
    return response.data === true || response.data === 'true';
  }

  async getAlertText(): Promise<string> {
    const response = await this.send('getAlertText', {});
    return typeof response.data === 'string' ? response.data.replace(/^"|"$/g, '') : '';
  }

  async tapAlertButton(buttonText: string): Promise<boolean> {
    const response = await this.send('tapAlertButton', { buttonText });
    return response.success;
  }

  async dismissAlert(): Promise<boolean> {
    const response = await this.send('dismissAlert', {});
    return response.success;
  }

  async getAlertButtons(): Promise<string[]> {
    const response = await this.send('getAlertButtons', {});
    if (!response.success || !response.data) return [];
    try {
      const buttons = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
      return Array.isArray(buttons) ? buttons : [];
    } catch {
      return [];
    }
  }

  // ============================================
  // Selector-based Methods (Full Maestro Parity)
  // ============================================

  /**
   * Convert selector to JSON string for native layer
   */
  private selectorToJson(selector: Selector): string {
    const normalized: Record<string, unknown> = {};

    if (selector.id !== undefined) normalized.id = selector.id;

    if (selector.text !== undefined) {
      if (typeof selector.text === 'string') {
        normalized.text = selector.text;
      } else {
        normalized.text = selector.text.pattern;
        if (selector.text.mode && selector.text.mode !== 'exact') {
          normalized.textMatchMode = selector.text.mode;
        }
      }
    }

    if (selector.index !== undefined) normalized.index = selector.index;
    if (selector.point !== undefined) {
      normalized.point = typeof selector.point === 'string'
        ? selector.point
        : { x: selector.point.x, y: selector.point.y };
    }

    // State
    if (selector.enabled !== undefined) normalized.enabled = selector.enabled;
    if (selector.checked !== undefined) normalized.checked = selector.checked;
    if (selector.focused !== undefined) normalized.focused = selector.focused;
    if (selector.selected !== undefined) normalized.selected = selector.selected;

    // Spatial (recursive)
    if (selector.below) normalized.below = JSON.parse(this.selectorToJson(selector.below));
    if (selector.above) normalized.above = JSON.parse(this.selectorToJson(selector.above));
    if (selector.leftOf) normalized.leftOf = JSON.parse(this.selectorToJson(selector.leftOf));
    if (selector.rightOf) normalized.rightOf = JSON.parse(this.selectorToJson(selector.rightOf));

    // Hierarchical
    if (selector.containsChild) {
      normalized.containsChild = JSON.parse(this.selectorToJson(selector.containsChild));
    }
    if (selector.childOf) {
      normalized.childOf = JSON.parse(this.selectorToJson(selector.childOf));
    }
    if (selector.containsDescendants) {
      normalized.containsDescendants = selector.containsDescendants.map(
        (s) => JSON.parse(this.selectorToJson(s))
      );
    }

    // Dimensions
    if (selector.width !== undefined) normalized.width = selector.width;
    if (selector.height !== undefined) normalized.height = selector.height;
    if (selector.tolerance !== undefined) normalized.tolerance = selector.tolerance;

    // Traits
    if (selector.traits) normalized.traits = selector.traits;

    return JSON.stringify(normalized);
  }

  /**
   * Find element by selector
   */
  async findBySelector(selector: Selector): Promise<ExtendedElementInfo | null> {
    const selectorJson = this.selectorToJson(selector);
    const response = await this.send('findBySelector', { selector: selectorJson });

    if (!response.success || response.data === null || response.data === 'null') {
      return null;
    }

    if (typeof response.data === 'string') {
      return JSON.parse(response.data);
    }

    return response.data as ExtendedElementInfo;
  }

  /**
   * Find all elements by selector
   */
  async findAllBySelector(selector: Selector): Promise<ExtendedElementInfo[]> {
    const selectorJson = this.selectorToJson(selector);
    const response = await this.send('findAllBySelector', { selector: selectorJson });

    if (!response.success || !response.data) {
      return [];
    }

    if (typeof response.data === 'string') {
      return JSON.parse(response.data);
    }

    return response.data as ExtendedElementInfo[];
  }

  /**
   * Check if element exists by selector
   */
  async existsBySelector(selector: Selector): Promise<boolean> {
    const selectorJson = this.selectorToJson(selector);
    const response = await this.send('existsBySelector', { selector: selectorJson });
    return response.data === true || response.data === 'true';
  }

  /**
   * Tap element by selector
   */
  async tapBySelector(selector: Selector): Promise<boolean> {
    const selectorJson = this.selectorToJson(selector);
    const response = await this.send('tapBySelector', { selector: selectorJson });
    return response.success;
  }

  /**
   * Type text into element by selector
   */
  async typeTextBySelector(selector: Selector, text: string): Promise<boolean> {
    const selectorJson = this.selectorToJson(selector);
    const response = await this.send('typeTextBySelector', { selector: selectorJson, text });
    return response.success;
  }

  /**
   * Clear text from element by selector
   */
  async clearTextBySelector(selector: Selector): Promise<boolean> {
    const selectorJson = this.selectorToJson(selector);
    const response = await this.send('clearTextBySelector', { selector: selectorJson });
    return response.success;
  }

  /**
   * Long press element by selector
   */
  async longPressBySelector(selector: Selector, duration: number = 500): Promise<boolean> {
    const selectorJson = this.selectorToJson(selector);
    const response = await this.send('longPressBySelector', { selector: selectorJson, duration });
    return response.success;
  }

  /**
   * Double tap element by selector
   */
  async doubleTapBySelector(selector: Selector): Promise<boolean> {
    const selectorJson = this.selectorToJson(selector);
    const response = await this.send('doubleTapBySelector', { selector: selectorJson });
    return response.success;
  }

  /**
   * Get text from element by selector
   */
  async getTextBySelector(selector: Selector): Promise<string | null> {
    const selectorJson = this.selectorToJson(selector);
    const response = await this.send('getTextBySelector', { selector: selectorJson });

    if (response.data === null || response.data === 'null') {
      return null;
    }

    return typeof response.data === 'string' ? response.data.replace(/^"|"$/g, '') : null;
  }

  /**
   * Check if element is visible by selector
   */
  async isVisibleBySelector(selector: Selector): Promise<boolean> {
    const selectorJson = this.selectorToJson(selector);
    const response = await this.send('isVisibleBySelector', { selector: selectorJson });
    return response.data === true || response.data === 'true';
  }

  // ============================================
  // Keyboard Handling
  // ============================================

  /**
   * Hide the keyboard by resigning first responder
   */
  async hideKeyboard(): Promise<boolean> {
    const response = await this.send('hideKeyboard', {});
    return response.success;
  }

  /**
   * Erase text by sending backspace key events
   * @param count Number of characters to erase
   */
  async eraseText(count: number): Promise<boolean> {
    const response = await this.send('eraseText', { count });
    return response.success;
  }

  /**
   * Press a key by name (e.g., "Enter", "Tab", "Escape")
   * @param keyName The key to press
   */
  async pressKey(keyName: string): Promise<boolean> {
    const response = await this.send('pressKey', { keyName });
    return response.success;
  }

  // ============================================
  // Clipboard Handling
  // ============================================

  /**
   * Copy text to clipboard
   * @param text Text to copy
   */
  async copyToClipboard(text: string): Promise<boolean> {
    const response = await this.send('copyToClipboard', { text });
    return response.success;
  }

  /**
   * Paste from clipboard into the focused text field
   */
  async pasteFromClipboard(): Promise<boolean> {
    const response = await this.send('pasteFromClipboard', {});
    return response.success;
  }

  /**
   * Get current clipboard contents
   */
  async getClipboardText(): Promise<string> {
    const response = await this.send('getClipboardText', {});
    return typeof response.data === 'string' ? response.data.replace(/^"|"$/g, '') : '';
  }

  // ============================================
  // Device Control
  // ============================================

  /**
   * Set device orientation
   * @param orientation 0=portrait, 1=portraitUpsideDown, 2=landscapeLeft, 3=landscapeRight
   */
  async setOrientation(orientation: number): Promise<boolean> {
    const response = await this.send('setOrientation', { orientation });
    return response.success;
  }

  /**
   * Perform a swipe gesture between coordinates
   */
  async swipeCoordinates(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    durationMs: number = 300
  ): Promise<boolean> {
    const response = await this.send('swipeCoordinates', {
      startX,
      startY,
      endX,
      endY,
      durationMs,
    });
    return response.success;
  }

  /**
   * Simulate back gesture (swipe from left edge on iOS)
   */
  async backGesture(): Promise<boolean> {
    const response = await this.send('backGesture', {});
    return response.success;
  }
}
