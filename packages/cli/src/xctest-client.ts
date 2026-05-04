/**
 * Ennio XCTest Client
 *
 * TCP / newline-delimited JSON client for the bundled
 * EnnioXCTestRunner.xctest helper. The helper drives all HID writes
 * (tap / typeText / swipe / pressKey / alerts / pasteboard) through XCUI,
 * which is the only sanctioned API that wakes RN's gesture recognizer
 * reliably on iOS 26 + Fabric.
 *
 * Reads stay on the WebSocket-backed EnnioClient (Fabric shadow tree).
 */

import { Socket } from 'node:net';

const DEFAULT_PORT = 9877;
const DEFAULT_HOST = '127.0.0.1';

interface XCTestRequest {
  id: string;
  type: string;
  payload: Record<string, unknown>;
}

interface XCTestResponse {
  id: string;
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

export interface ScreenSize {
  width: number;
  height: number;
  safeAreaTop: number;
  safeAreaBottom: number;
}

export interface FoundElement {
  found: boolean;
  /** XCUI's isHittable — element is on screen and not covered. */
  hittable?: boolean;
  frame?: { x: number; y: number; width: number; height: number };
}

export class XCTestClient {
  private socket: Socket | null = null;
  private buffer = '';
  private pending = new Map<string, { resolve: (r: XCTestResponse) => void; reject: (e: Error) => void }>();
  private messageId = 0;
  private port: number;
  private host: string;
  private connected = false;

  constructor(port: number = DEFAULT_PORT, host: string = DEFAULT_HOST) {
    this.port = port;
    this.host = host;
  }

  async connect(timeoutMs: number = 30_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        await this.connectOnce();
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    throw new Error(`xctest-client: failed to connect to ${this.host}:${this.port} within ${timeoutMs}ms`);
  }

  private connectOnce(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = new Socket();
      const onError = (err: Error) => {
        sock.removeAllListeners();
        sock.destroy();
        reject(err);
      };
      sock.once('error', onError);
      sock.connect(this.port, this.host, () => {
        sock.removeListener('error', onError);
        this.attach(sock);
        resolve();
      });
    });
  }

  private attach(sock: Socket): void {
    this.socket = sock;
    this.connected = true;
    this.buffer = '';

    sock.setNoDelay(true);
    sock.setEncoding('utf8');

    sock.on('data', (chunk: string) => {
      this.buffer += chunk;
      let idx: number;
      while ((idx = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const res = JSON.parse(line) as XCTestResponse;
          const handler = this.pending.get(res.id);
          if (handler) {
            this.pending.delete(res.id);
            handler.resolve(res);
          }
        } catch {
          // malformed line - ignore
        }
      }
    });

    sock.on('close', () => {
      this.connected = false;
      this.socket = null;
      for (const [id, h] of this.pending) {
        h.reject(new Error('xctest-client: connection closed'));
        this.pending.delete(id);
      }
    });

    sock.on('error', () => {
      // close handler will run; nothing else to do here
    });
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  private async send(type: string, payload: Record<string, unknown> = {}): Promise<XCTestResponse> {
    if (!this.socket || !this.connected) {
      // Helper test bundle can die mid-flow if a single XCUI command fails
      // hard (synth event failures kill the whole test session). Try a
      // single transparent reconnect: the helper xcodebuild process may
      // still be alive and have re-bound the port for the next test.
      try {
        await this.connect(8_000);
      } catch {
        throw new Error('xctest-client: not connected');
      }
    }
    const id = String(++this.messageId);
    const req: XCTestRequest = { id, type, payload };
    return new Promise<XCTestResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket!.write(JSON.stringify(req) + '\n', (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`xctest-client: timeout waiting for response to ${type}`));
        }
      }, 30_000);
    });
  }

  private async expectOk(type: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const res = await this.send(type, payload);
    if (!res.ok) {
      throw new Error(`xctest-client: ${type} failed: ${res.error ?? 'unknown error'}`);
    }
    return res.data ?? {};
  }

  // -------- Diagnostics --------

  async ping(): Promise<boolean> {
    const data = await this.expectOk('ping');
    return data.pong === true;
  }

  async getScreenSize(): Promise<ScreenSize> {
    const data = await this.expectOk('getScreenSize');
    return {
      width: Number(data.width),
      height: Number(data.height),
      safeAreaTop: Number(data.safeAreaTop ?? 0),
      safeAreaBottom: Number(data.safeAreaBottom ?? 0),
    };
  }

  // -------- HID actions (normalized 0..1 coords) --------

  async tap(x: number, y: number): Promise<void> {
    await this.expectOk('tap', { x, y });
  }

  async doubleTap(x: number, y: number): Promise<void> {
    await this.expectOk('doubleTap', { x, y });
  }

  async longPress(x: number, y: number, ms: number = 500): Promise<void> {
    await this.expectOk('longPress', { x, y, ms });
  }

  async swipe(fromX: number, fromY: number, toX: number, toY: number, ms: number = 300): Promise<void> {
    await this.expectOk('swipe', { fromX, fromY, toX, toY, ms });
  }

  async back(): Promise<void> {
    await this.expectOk('back');
  }

  // -------- Keyboard --------

  async typeText(text: string): Promise<void> {
    await this.expectOk('typeText', { text });
  }

  async pressKey(name: string): Promise<void> {
    await this.expectOk('pressKey', { name });
  }

  async clearText(): Promise<void> {
    await this.expectOk('clearText');
  }

  async eraseText(count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      await this.pressKey('backspace');
    }
  }

  // -------- Element lookup (for text-only selectors) --------

  async findByLabel(text: string, exact: boolean = false): Promise<FoundElement> {
    const data = await this.expectOk('findByLabel', { text, exact });
    if (data.found !== true) return { found: false };
    const f = data.frame as Record<string, number>;
    return {
      found: true,
      frame: { x: Number(f.x), y: Number(f.y), width: Number(f.width), height: Number(f.height) },
    };
  }

  async findById(id: string): Promise<FoundElement> {
    const data = await this.expectOk('findById', { id });
    if (data.found !== true) return { found: false };
    const f = data.frame as Record<string, number>;
    return {
      found: true,
      hittable: data.hittable === true,
      frame: { x: Number(f.x), y: Number(f.y), width: Number(f.width), height: Number(f.height) },
    };
  }

  async tapById(id: string): Promise<void> {
    await this.expectOk('tapById', { id });
  }

  // -------- Alerts --------

  async tapAlertButton(title: string): Promise<void> {
    await this.expectOk('tapAlertButton', { title });
  }

  async dismissAlert(): Promise<boolean> {
    const data = await this.expectOk('dismissAlert');
    return data.dismissed === true;
  }

  // -------- Pasteboard --------

  async setPasteboard(text: string): Promise<void> {
    await this.expectOk('setPasteboard', { text });
  }

  async getPasteboard(): Promise<string> {
    const data = await this.expectOk('getPasteboard');
    return typeof data.text === 'string' ? data.text : '';
  }

  async paste(): Promise<void> {
    await this.expectOk('paste');
  }

  // -------- Lifecycle --------

  async quit(): Promise<void> {
    try {
      await this.expectOk('quit');
    } catch {
      // helper will close the socket on quit; surface nothing
    } finally {
      this.disconnect();
    }
  }
}
