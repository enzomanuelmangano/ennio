/**
 * Ennio CDP Client
 *
 * Drives the in-app dispatcher via Hermes Inspector — no custom WS
 * server in the app. Connects to Metro's Inspector page at
 * `ws://localhost:8081/inspector?device=…&page=…`, then for every
 * `send(type, payload)`:
 *
 *   1. Generates a unique token.
 *   2. Evaluates `__ennioDispatch(type, payloadJson, token)` via
 *      `Runtime.evaluate`. The host function (installed by
 *      HybridEnnio::nativeBootstrap) spawns a background worker and
 *      returns immediately — JS thread stays free to advance React
 *      commits while the worker runs.
 *   3. Polls `globalThis.__ennioResults[token]` until present, then
 *      parses + returns the Response.
 *
 * Why the async/poll dance instead of awaiting the host function?
 * `waitForCommit` (and any handler that needs React to progress)
 * would deadlock if `__ennioDispatch` blocked the JS thread —
 * commits run on the JS thread we'd be blocking. The poll loop keeps
 * the JS thread free; commits fire; the worker thread's cv wakes;
 * the result lands on globalThis; CLI reads it next tick.
 */

import WebSocket from 'ws';
import { selectorToJson } from './selector';
import { EnnioSocketClient } from './socket-client';

const METRO_BASE = process.env.ENNIO_METRO_URL || 'http://localhost:8081';
// Per-request hard cap. Long enough for an asset-heavy assertVisible
// after a launchApp; short enough that a hung Inspector eval doesn't
// deadlock the runner.
const REQUEST_TIMEOUT_MS = 30_000;
// Reconnect window when the Inspector WS drops mid-request (Metro
// reload, sim hiccup). 6 s covers a JS bundle reload.
const RECONNECT_TIMEOUT_MS = 6_000;
// Result-poll interval for the slow path (`waitForCommit` /
// `waitForIdle`). Fast handlers return inline from `__ennioDispatch`
// — no polling at all. 15 ms keeps the loop tight while leaving the
// JS thread enough idle to run React commits we're waiting on.
const POLL_INTERVAL_MS = 15;

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

interface CdpPage {
  id: string;
  title: string;
  description: string;
  appId?: string;
  webSocketDebuggerUrl: string;
}

interface CdpResponse {
  id: number;
  result?: {
    result?: { type: string; value?: unknown; description?: string };
    exceptionDetails?: { text: string; exception?: { description?: string } };
  };
  error?: { message: string };
}

// Handlers safe to route through the Unix-domain control socket. These
// touch only UIKit (main thread) or thread-safe Fabric reads — no JS
// thread state. Sending them via CDP would queue behind whatever React
// work is in flight on the JS thread; the socket bypasses that queue
// entirely. Everything else stays on CDP.
const SOCKET_FAST_OPS = new Set<string>([
  'tapTabByName',
  'isAlertPresent',
  // `writer.layoutCenter` polls getViewWindowFrame up to 30 times
  // per id-tap, plus an occasional scrollTo when the element is
  // off-screen. Routing both through the socket bypasses the
  // JS-thread queue that previously paced each iteration.
  'getViewWindowFrame',
  'scrollTo',
  'selectPickerValueByLabel',
  'setSearchBarText',
  'appendSearchBarText',
  'eraseSearchBarText',
  'focusSearchBar',
  'ping',
]);

export class EnnioClient {
  private ws: WebSocket | null = null;
  private pending = new Map<
    number,
    { resolve: (r: CdpResponse) => void; reject: (e: Error) => void }
  >();
  private rpcId = 0;
  private tokenSeq = 0;
  private debuggerUrl: string | null = null;
  private socketClient: EnnioSocketClient | null = null;

  /**
   * Discover Metro Inspector pages, pick the JS context. Bridgeless
   * apps expose two pages — "Bridgeless [C++ connection]" (Hermes JS
   * runtime — what we want) and "UI [C++ connection]" (RN UI thread,
   * no globals).
   */
  private async discoverPage(): Promise<string> {
    const res = await fetch(`${METRO_BASE}/json`);
    if (!res.ok) throw new Error(`Metro /json: HTTP ${res.status}`);
    const pages = (await res.json()) as CdpPage[];
    const js = pages.find(
      (p) =>
        /bridgeless|jscontext|hermes/i.test(p.description) ||
        /bridgeless|jscontext|hermes/i.test(p.title),
    );
    const pick = js || pages[0];
    if (!pick?.webSocketDebuggerUrl) {
      throw new Error('No Inspector pages found on Metro (is the app running?)');
    }
    return pick.webSocketDebuggerUrl;
  }

  async connect(): Promise<void> {
    if (!this.debuggerUrl) {
      this.debuggerUrl = await this.discoverPage();
    }
    return new Promise((resolve, reject) => {
      const url = this.debuggerUrl!;
      this.ws = new WebSocket(url);

      this.ws.onopen = async () => {
        try {
          await this.cdpCall('Runtime.enable', {});
          // Re-install the React commit-hook patch every time we
          // connect. The pod's `+load` eval can race React's devtools-
          // hook binding (hook may not be `function` at app-boot time),
          // leaving `__ennio_native_onCommit` orphaned and `waitForCommit`
          // permanently timing out. Idempotent — sees the JSI host fn
          // already installed on globalThis and just wraps the current
          // onCommitFiberRoot.
          await this.cdpCall('Runtime.evaluate', {
            expression: `(function(){
  var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook || typeof hook.onCommitFiberRoot !== 'function') return false;
  if (hook.__ennioPatched) return true;
  var original = hook.onCommitFiberRoot.bind(hook);
  hook.onCommitFiberRoot = function(r, root, p, e) {
    try { original(r, root, p, e); } catch(_) {}
    if (typeof globalThis.__ennio_native_onCommit === 'function') {
      try { globalThis.__ennio_native_onCommit(); } catch(_) {}
    }
  };
  hook.__ennioPatched = true;
  return true;
})()`,
            returnByValue: true,
          });
          resolve();
        } catch (e) {
          reject(e as Error);
        }
      };
      this.ws.onerror = () => reject(new Error(`Failed to connect to Hermes Inspector at ${url}`));

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string) as CdpResponse;
          if (typeof msg.id === 'number') {
            const handler = this.pending.get(msg.id);
            if (handler) {
              this.pending.delete(msg.id);
              handler.resolve(msg);
            }
          }
        } catch {
          /* drop malformed */
        }
      };

      this.ws.onclose = () => {
        for (const [id, h] of this.pending) {
          h.reject(new Error('Connection closed'));
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
    this.disconnectSocket();
  }

  async reconnect(maxWaitMs: number = RECONNECT_TIMEOUT_MS): Promise<boolean> {
    this.disconnect();
    // Re-discover the page — the device id changes after Metro restart.
    this.debuggerUrl = null;
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
   * Raw CDP JSON-RPC call. Resolves with the full envelope so callers
   * can inspect `error` / `exceptionDetails` directly. Per-request
   * timeout matches the outer `send()` timeout.
   */
  private cdpCall(method: string, params: Record<string, unknown>): Promise<CdpResponse> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Inspector socket not open'));
    }
    const id = ++this.rpcId;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws!.send(payload);
    });
  }

  /**
   * `Runtime.evaluate` with `returnByValue: true`. Throws on
   * `exceptionDetails` (eval threw inside the runtime — usually a
   * caller bug worth surfacing loudly).
   */
  private async eval(expression: string): Promise<unknown> {
    const r = await this.cdpCall('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: false,
      replMode: false,
    });
    if (r.error) throw new Error(`CDP error: ${r.error.message}`);
    const ex = r.result?.exceptionDetails;
    if (ex) {
      throw new Error(`Eval threw: ${ex.exception?.description || ex.text}`);
    }
    return r.result?.result?.value;
  }

  /**
   * Public escape hatch — every typed wrapper below delegates here.
   * Two-phase: post via `__ennioDispatch`, then poll the result slot
   * until the in-app worker writes a response or the timeout expires.
   */
  /**
   * Discover + connect the Unix-domain control socket for this app.
   * Idempotent. Safe to call after every launchApp / clearState — the
   * underlying client retries discovery and re-opens the socket against
   * the new app process.
   */
  async ensureSocketConnected(bundleId: string, udid?: string): Promise<boolean> {
    if (!this.socketClient) this.socketClient = new EnnioSocketClient();
    const ok = await this.socketClient.connect(bundleId, udid);
    if (process.env.ENNIO_DEBUG_SOCKET) {
      process.stderr.write(`[socket] ensureSocketConnected(${bundleId}) -> ${ok}\n`);
    }
    return ok;
  }

  /**
   * Tear down the socket alongside the CDP WebSocket. Called from
   * `disconnect()` so launchApp / clearState restart cleanly.
   */
  private disconnectSocket(): void {
    if (this.socketClient) {
      this.socketClient.close();
      this.socketClient = null;
    }
  }

  async send(type: string, payload: Record<string, unknown> = {}): Promise<EnnioResponse> {
    // Fast path: route handlers that don't need the JS thread through
    // the Unix-domain socket. Skips CDP entirely → not blocked by
    // ongoing React work on the JS thread.
    if (SOCKET_FAST_OPS.has(type) && this.socketClient?.isConnected()) {
      if (process.env.ENNIO_DEBUG_SOCKET) {
        process.stderr.write(`[socket] route ${type}\n`);
      }
      try {
        const t0 = Date.now();
        const r = await this.socketClient.send(type, payload);
        if (process.env.ENNIO_DEBUG_SOCKET) {
          process.stderr.write(`[socket] ${type} done in ${Date.now() - t0}ms\n`);
        }
        return r;
      } catch {
        // Socket dropped mid-flight (app crashed, etc.) — fall through
        // to CDP. The next ensureSocketConnected() will try to re-attach.
        if (process.env.ENNIO_DEBUG_SOCKET) {
          process.stderr.write(`[socket] ${type} threw, falling back to CDP\n`);
        }
      }
    } else if (SOCKET_FAST_OPS.has(type) && process.env.ENNIO_DEBUG_SOCKET) {
      process.stderr.write(
        `[socket] ${type} NOT routed (connected=${this.socketClient?.isConnected()})\n`,
      );
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      const ok = await this.reconnect(RECONNECT_TIMEOUT_MS);
      if (!ok) throw new Error('Not connected to Hermes Inspector');
    }

    const token = `e${++this.tokenSeq}`;
    const typeLit = JSON.stringify(type);
    const payloadLit = JSON.stringify(JSON.stringify(payload));
    const tokenLit = JSON.stringify(token);

    // Phase 1 — dispatch. Fast handlers return the JSON string
    // directly (worker ran inline on the JS thread). Slow handlers
    // (`waitForCommit`, `waitForIdle`) return `undefined` — they
    // scheduled a background worker that will write the result into
    // `globalThis.__ennioResults[token]` once the React event we're
    // waiting on fires. CLI distinguishes by null/string.
    const direct = await this.eval(`__ennioDispatch(${typeLit}, ${payloadLit}, ${tokenLit})`);
    if (typeof direct === 'string') {
      return JSON.parse(direct) as EnnioResponse;
    }

    // Phase 2 — poll. Slot eventually holds a JSON string (Response
    // serialised by Protocol.cpp).
    const start = Date.now();
    const pollExpr = `(()=>{const v=globalThis.__ennioResults&&globalThis.__ennioResults[${tokenLit}];if(v!==undefined){delete globalThis.__ennioResults[${tokenLit}];}return v===undefined?null:v;})()`;
    while (Date.now() - start < REQUEST_TIMEOUT_MS) {
      const value = await this.eval(pollExpr);
      if (value != null) {
        return JSON.parse(value as string) as EnnioResponse;
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    try {
      await this.eval(
        `(()=>{if(globalThis.__ennioResults){delete globalThis.__ennioResults[${tokenLit}];}})()`,
      );
    } catch {
      /* best effort */
    }
    throw new Error(`Request timeout: ${type}`);
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
