/**
 * Ennio WebSocket Client
 *
 * Connects directly to the native Ennio WebSocket server running in the
 * app. Works in both debug and release builds. Reads (queries, selectors,
 * alert state, synchronization) and writes (taps, swipes, typeText, …)
 * both flow through this single channel — the writer goes via NitroWriter
 * which forwards command names to the in-app dispatch table over WS.
 */

import WebSocket from 'ws';
import { selectorToJson } from './selector';

const DEFAULT_PORT = 9876;
// Per-request hard cap. Long enough for an asset-heavy assertVisible
// after a launchApp; short enough that a hung WS doesn't deadlock the
// runner indefinitely. Cancelled if a reconnect succeeds first.
const REQUEST_TIMEOUT_MS = 30_000;
// Reconnect window when the WS drops mid-request (Metro reload, sim
// hiccup). 6 s covers a JS bundle reload; longer would compete with
// the request timeout above.
const RECONNECT_TIMEOUT_MS = 6_000;

interface EnnioRequest {
  id: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface EnnioResponse {
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
  private pending = new Map<
    string,
    {
      resolve: (r: EnnioResponse) => void;
      reject: (e: Error) => void;
      timeoutHandle?: ReturnType<typeof setTimeout>;
    }
  >();
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
      this.ws.onerror = () =>
        reject(new Error(`Failed to connect to Ennio server on port ${this.port}`));

      this.ws.onmessage = (event) => {
        try {
          const response: EnnioResponse = JSON.parse(event.data as string);
          const handler = this.pending.get(response.id);
          if (handler) {
            this.pending.delete(response.id);
            if (handler.timeoutHandle) clearTimeout(handler.timeoutHandle);
            handler.resolve(response);
          }
        } catch {
          // Malformed message — drop. Timeout will fire if no valid reply follows.
        }
      };

      this.ws.onclose = () => {
        for (const [id, handler] of this.pending) {
          if (handler.timeoutHandle) clearTimeout(handler.timeoutHandle);
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
  async reconnect(maxWaitMs: number = RECONNECT_TIMEOUT_MS): Promise<boolean> {
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

  /**
   * Public escape hatch for callers that need a command type not yet
   * wrapped in a typed method (NitroWriter forwards arbitrary command
   * names from the maestro-runner dispatch chain). Prefer adding a typed
   * wrapper here when a use site stabilizes — direct send leaves the
   * payload schema untyped, so typos surface only at runtime.
   */
  async send(type: string, payload: Record<string, unknown> = {}): Promise<EnnioResponse> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Best-effort transparent reconnect on cold/dropped socket. If the
      // app is up but rebound after a JS reload, this picks the connection
      // back up without forcing the runner to fail mid-flow.
      const ok = await this.reconnect(RECONNECT_TIMEOUT_MS);
      if (!ok) throw new Error('Not connected to Ennio server');
    }

    const id = String(++this.messageId);
    const request: EnnioRequest = { id, type, payload };

    return new Promise((resolve, reject) => {
      // On `Connection closed` we reconnect and re-send; the recursive
      // send installs its own fresh timeout, so the outer timeout below
      // must be cleared first or it'll fire while the re-send is still
      // in flight and produce a spurious "Request timeout".
      const wrappedReject = async (e: Error) => {
        const entry = this.pending.get(id);
        if (entry?.timeoutHandle) clearTimeout(entry.timeoutHandle);
        if (e.message === 'Connection closed') {
          const ok = await this.reconnect(RECONNECT_TIMEOUT_MS);
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

      const timeoutHandle = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Request timeout: ${type}`));
        }
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject: wrappedReject, timeoutHandle });
      this.ws!.send(JSON.stringify(request));
    });
  }

  // Element queries
  //
  // Native side embeds raw JSON literals into `Response::toJSON`'s data
  // field via string concatenation (no extra escaping), so a C++ handler
  // emitting `r.data = "true"` lands here as a parsed JS boolean — not
  // the string "true". Stripping the historical `=== 'true'` defensive
  // branches now to surface any genuine string-bool drift loudly via a
  // type mismatch.
  async exists(testID: string): Promise<boolean> {
    const response = await this.send('exists', { testID });
    return response.data === true;
  }

  async isVisible(testID: string): Promise<boolean> {
    const response = await this.send('isVisible', { testID });
    return response.data === true;
  }

  /**
   * True when the testID's UIView (or any ancestor) is a UIButton with
   * `menu` set + `showsMenuAsPrimaryAction` (zeego DropdownMenu /
   * react-native-ios-context-menu). The tap dispatcher routes these via
   * idb HID — programmatic UIControl actions don't open UIMenu.
   */
  async isMenuTriggerAncestor(testID: string): Promise<boolean> {
    const response = await this.send('isMenuTriggerAncestor', { testID });
    return response.data === true;
  }

  /**
   * Wipe the app's sandbox (Library/, Documents/, tmp/) in-process. Works
   * identically on Simulator and physical device — no host filesystem
   * access. Caller restarts the app to drop in-memory state.
   */
  async clearAppData(): Promise<boolean> {
    const response = await this.send('clearAppData', {});
    return response?.success === true;
  }

  async getText(testID: string): Promise<string | null> {
    const response = await this.send('getText', { testID });
    if (response.data == null) return null;
    return typeof response.data === 'string' ? response.data : null;
  }

  /**
   * UIKit-frame visibility check. Reader uses this instead of the
   * Fabric-shadow `isVisible` because shadow node coords are surface-
   * relative; Stack-pushed screens have a non-window-origin surface and
   * the shadow comparison rejects elements that are clearly on screen.
   */
  async getViewWindowFrame(
    testID: string,
  ): Promise<{ x: number; y: number; width: number; height: number } | null> {
    const response = await this.send('getViewWindowFrame', { testID });
    if (!response.success || !response.data || typeof response.data !== 'object') return null;
    const r = response.data as { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
    if (
      typeof r.x !== 'number' ||
      typeof r.y !== 'number' ||
      typeof r.width !== 'number' ||
      typeof r.height !== 'number'
    )
      return null;
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }

  // Synchronization
  async waitForIdle(timeout: number = 5000): Promise<boolean> {
    const response = await this.send('waitForIdle', { timeout });
    return response.success;
  }

  async synchronize(): Promise<void> {
    await this.send('synchronize', {});
  }

  /**
   * Block until React fires the next onCommitFiberRoot, capped at
   * maxMs. Returns { commit: true, elapsedMs } on early-wake or
   * { commit: false, elapsedMs: ~maxMs } on timeout. Used to replace
   * blind sleep settles in the runner — cap is the safety floor.
   */
  async waitForCommit(maxMs: number = 200): Promise<{ commit: boolean; elapsedMs: number }> {
    const response = await this.send('waitForCommit', { maxMs });
    if (typeof response.data === 'object' && response.data !== null) {
      const d = response.data as { commit?: unknown; elapsedMs?: unknown };
      return {
        commit: d.commit === true,
        elapsedMs: typeof d.elapsedMs === 'number' ? d.elapsedMs : maxMs,
      };
    }
    return { commit: false, elapsedMs: maxMs };
  }

  // Alert handling (read-only)
  async isAlertPresent(): Promise<boolean> {
    const response = await this.send('isAlertPresent', {});
    return response.data === true;
  }

  async getAlertText(): Promise<string> {
    const response = await this.send('getAlertText', {});
    return typeof response.data === 'string' ? response.data : '';
  }

  async getAlertButtons(): Promise<string[]> {
    const response = await this.send('getAlertButtons', {});
    return Array.isArray(response.data) ? response.data : [];
  }

  // ============================================
  // Selector-based Methods (Full Maestro Parity)
  // ============================================

  async findBySelector(selector: Selector): Promise<ExtendedElementInfo | null> {
    const selectorJson = selectorToJson(selector);
    const response = await this.send('findBySelector', { selector: selectorJson });

    if (!response.success || response.data == null) return null;
    return response.data as ExtendedElementInfo;
  }

  /**
   * Find all elements by selector
   */
  async findAllBySelector(selector: Selector): Promise<ExtendedElementInfo[]> {
    const selectorJson = selectorToJson(selector);
    const response = await this.send('findAllBySelector', { selector: selectorJson });

    if (!response.success || !Array.isArray(response.data)) return [];
    return response.data as ExtendedElementInfo[];
  }

  /**
   * Check if element exists by selector
   */
  async existsBySelector(selector: Selector): Promise<boolean> {
    const selectorJson = selectorToJson(selector);
    const response = await this.send('existsBySelector', { selector: selectorJson });
    return response.data === true;
  }

  /**
   * Get text from element by selector
   */
  async getTextBySelector(selector: Selector): Promise<string | null> {
    const selectorJson = selectorToJson(selector);
    const response = await this.send('getTextBySelector', { selector: selectorJson });

    if (response.data == null) return null;
    return typeof response.data === 'string' ? response.data : null;
  }

  /**
   * Check if element is visible by selector
   */
  async isVisibleBySelector(selector: Selector): Promise<boolean> {
    const selectorJson = selectorToJson(selector);
    const response = await this.send('isVisibleBySelector', { selector: selectorJson });
    return response.data === true;
  }
}
