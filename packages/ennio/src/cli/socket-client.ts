// Unix-domain socket transport — the primary CLI <-> in-app dylib
// channel for the v2 architecture.
//
// Wire format: line-delimited JSON. One request per line, one response
// per line, with numeric/string id correlation.
//
// Request:   {"id":"r1","op":"find_by_testid","args":{"testID":"foo"}}
// Response:  {"id":"r1","ok":true,"data":{"x":...,"y":...,"w":...,"h":...}}
// Error:     {"id":"r1","ok":false,"err":"testID not found: foo"}
//
// Socket path is per-target: derived from the UDID and pinned via
// ENNIO_SOCKET_PATH on the simulator launchctl env. The host CLI and
// the in-app dylib read the same env var. Falls back to the legacy
// shared path if env is missing (older shims, manual debugging).
//
// Constraints:
// (a) iOS simulator and host share `/tmp`
// (b) sockaddr_un.sun_path is 104 bytes on macOS — keep path short
//     (UDID is 36 chars; "/tmp/ennio-<UDID>.sock" = ~57 chars, fits)
// (c) 0600 perms applied dylib-side so other users can't connect
//
// Single persistent connection per CLI run. Requests pipelined; the
// dylib services them sequentially per connection on a worker thread.

import { Socket, createConnection } from 'node:net';

// Per-request deadline. Long enough for a slow UIView walk on a busy
// device; short enough that a hung handler doesn't deadlock the runner.
const REQUEST_TIMEOUT_MS = 20_000;

const LEGACY_SOCKET_PATH = '/tmp/ennio-control.sock';

/**
 * Compute the per-UDID socket path. Both the dylib and the CLI read
 * ENNIO_SOCKET_PATH; this helper produces the same path the CLI sets
 * on the simulator launchctl env. UDID-keyed so concurrent simulators
 * (or multiple test runners on the same dev box) don't collide.
 */
export function ennioSocketPath(udid?: string): string {
  if (process.env.ENNIO_SOCKET_PATH) return process.env.ENNIO_SOCKET_PATH;
  if (udid) return `/tmp/ennio-${udid}.sock`;
  return LEGACY_SOCKET_PATH;
}

export interface EnnioSocketResponse {
  id: string;
  ok: boolean;
  data?: unknown;
  err?: string;
}

interface PendingRequest {
  resolve(r: EnnioSocketResponse): void;
  reject(e: Error): void;
}

export class EnnioSocketClient {
  private socket: Socket | null = null;
  private buf = '';
  private pending = new Map<string, PendingRequest>();
  private idSeq = 0;
  private connecting: Promise<boolean> | null = null;
  private path: string;

  constructor(udid?: string) {
    this.path = ennioSocketPath(udid);
  }

  /**
   * Open the Unix-socket connection. Idempotent. Returns true on success,
   * false if the dylib hasn't started its listener yet (caller can
   * retry after waiting for the app to launch).
   */
  async connect(): Promise<boolean> {
    if (this.socket && !this.socket.destroyed) return true;
    if (this.connecting) return this.connecting;
    this.connecting = this.doConnect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async doConnect(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const s = createConnection(this.path);
      const onError = () => {
        s.destroy();
        resolve(false);
      };
      s.once('error', onError);
      s.once('connect', () => {
        s.off('error', onError);
        s.on('data', (chunk) => this.onData(chunk));
        s.on('error', (e) => this.onSocketError(e));
        s.on('close', () => this.onClose());
        this.socket = s;
        resolve(true);
      });
    });
  }

  /**
   * Poll-style connect — wait up to `maxWaitMs` for the dylib listener
   * to come up. Used immediately after launching the app, when the
   * socket file may not exist yet.
   */
  async connectWithRetry(maxWaitMs = 10_000): Promise<boolean> {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      if (await this.connect()) return true;
      await new Promise((r) => setTimeout(r, 150));
    }
    return false;
  }

  private onData(chunk: Buffer): void {
    this.buf += chunk.toString('utf8');
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      try {
        const resp = JSON.parse(line) as EnnioSocketResponse;
        const p = this.pending.get(resp.id);
        if (p) {
          this.pending.delete(resp.id);
          p.resolve(resp);
        }
      } catch {
        /* malformed line — drop */
      }
    }
  }

  private onSocketError(e: Error): void {
    for (const [, p] of this.pending) p.reject(e);
    this.pending.clear();
  }

  private onClose(): void {
    this.socket = null;
    const err = new Error('socket closed');
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  /**
   * Dispatch one op. Resolves to the typed response (data depends on
   * op). If the socket is disconnected when the call is made, attempt
   * a single reconnect first — the dylib may have terminated + restored
   * its listener between ops (rare but happens during reload).
   */
  async call(op: string, args: Record<string, unknown> = {}): Promise<EnnioSocketResponse> {
    if (!this.socket || this.socket.destroyed) {
      const reopened = await this.connectWithRetry(5_000);
      if (!reopened) {
        throw new Error('ennio socket not connected');
      }
    }
    const id = `r${++this.idSeq}`;
    const line = JSON.stringify({ id, op, args }) + '\n';
    return new Promise<EnnioSocketResponse>((resolve, reject) => {
      const timer: NodeJS.Timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`socket request timeout: ${op}`));
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
      this.socket!.write(line, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  isConnected(): boolean {
    return !!this.socket && !this.socket.destroyed;
  }

  close(): void {
    if (this.socket) this.socket.destroy();
    this.socket = null;
  }
}
