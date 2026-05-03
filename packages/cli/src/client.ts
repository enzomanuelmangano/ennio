/**
 * Ennio WebSocket Client
 *
 * Connects directly to the native Ennio WebSocket server
 * running in the app. Works in both debug and release builds.
 *
 * Read-only surface: queries, selectors, alert state, and synchronization.
 * Write/HID operations live in the XCTest helper (see xctest-client.ts).
 */

const DEFAULT_PORT = 9876;

interface EnnioRequest {
  id: string;
  type: string;
  payload: Record<string, unknown>;
}

interface EnnioResponse {
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

export class EnnioClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, { resolve: (r: EnnioResponse) => void; reject: (e: Error) => void }>();
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
      this.ws.onerror = () => reject(new Error(`Failed to connect to Ennio server on port ${this.port}`));

      this.ws.onmessage = (event) => {
        try {
          const response: EnnioResponse = JSON.parse(event.data as string);
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

  /**
   * Try to re-establish the WebSocket connection. Used after a transient
   * drop (RN bundle reload, sim hiccup). Polls until the app rebinds the
   * WS server, up to ~6s.
   */
  async reconnect(maxWaitMs: number = 6000): Promise<boolean> {
    this.disconnect();
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      try {
        await this.connect();
        return true;
      } catch {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    return false;
  }

  private async send(type: string, payload: Record<string, unknown> = {}): Promise<EnnioResponse> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Best-effort transparent reconnect on cold/dropped socket. If the
      // app is up but rebound after a JS reload, this picks the connection
      // back up without forcing the runner to fail mid-flow.
      const ok = await this.reconnect(6000);
      if (!ok) throw new Error('Not connected to Ennio server');
    }

    const id = String(++this.messageId);
    const request: EnnioRequest = { id, type, payload };

    return new Promise((resolve, reject) => {
      // Retry once on transient WS close: the JS bundle reload during
      // normal RN dev cycles or simulator hiccups can drop the socket
      // mid-request. Reconnect and re-send before bubbling the error.
      const wrappedReject = async (e: Error) => {
        if (e.message === 'Connection closed') {
          const ok = await this.reconnect(6000);
          if (ok) {
            try {
              const res = await this.send(type, payload);
              resolve(res);
              return;
            } catch (e2) {
              reject(e2 as Error);
              return;
            }
          }
        }
        reject(e);
      };
      this.pending.set(id, { resolve, reject: wrappedReject });
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

  // Alert handling (read-only)
  async isAlertPresent(): Promise<boolean> {
    const response = await this.send('isAlertPresent', {});
    return response.data === true || response.data === 'true';
  }

  async getAlertText(): Promise<string> {
    const response = await this.send('getAlertText', {});
    return typeof response.data === 'string' ? response.data.replace(/^"|"$/g, '') : '';
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
}
