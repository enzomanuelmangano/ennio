// Unix-domain socket transport.
//
// Parallel to the CDP/Hermes Inspector channel. Used for commands whose
// work happens entirely on the main thread (UIKit) or in thread-safe
// Fabric reads — anything where queueing on the JS thread is pure
// overhead. See `cpp/EnnioControlSocket.cpp` for the server side.
//
// Wire format: newline-delimited JSON, one request per line, response
// returned on the next line. Single persistent connection per CLI run.
// Sequential dispatch — no pipelining yet because the server services
// one client connection at a time.

import { Socket, createConnection } from 'node:net';

import type { EnnioResponse } from './client';

interface PendingRequest {
  resolve(r: EnnioResponse): void;
  reject(e: Error): void;
}

export class EnnioSocketClient {
  private socket: Socket | null = null;
  private buf = '';
  private pending = new Map<string, PendingRequest>();
  private idSeq = 0;
  private socketPath: string | null = null;
  private connecting: Promise<boolean> | null = null;

  /**
   * Discover + connect. Idempotent. Returns true if connected, false if
   * the socket isn't reachable (caller should fall back to CDP).
   *
   * Path convention matches `EnnioControlSocket::computeSocketPath()`:
   * `/tmp/ennio-<bundleId>.sock` on the host. The simulator shares
   * `/tmp` with the host filesystem, so the same path is reachable from
   * both sides. We use `/tmp` rather than the app sandbox tmp because
   * sockaddr_un.sun_path is 104 bytes on macOS and the sandbox path
   * exceeds that limit.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async connect(bundleId: string, _udid?: string): Promise<boolean> {
    if (this.socket && !this.socket.destroyed) return true;
    if (this.connecting) return this.connecting;
    this.connecting = this.doConnect(bundleId).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async doConnect(_bundleId: string): Promise<boolean> {
    this.socketPath = `/tmp/ennio-control.sock`;
    return new Promise<boolean>((resolve) => {
      const s = createConnection(this.socketPath!);
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

  private onData(chunk: Buffer): void {
    this.buf += chunk.toString('utf8');
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      try {
        const resp = JSON.parse(line) as EnnioResponse;
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
   * Send a request, await response. Throws if not connected.
   */
  async send(type: string, payload: Record<string, unknown> = {}): Promise<EnnioResponse> {
    if (!this.socket || this.socket.destroyed) {
      throw new Error('socket not connected');
    }
    const id = `s${++this.idSeq}`;
    // Wire envelope: same keys the CDP path uses. Server reads each via
    // json::parseString, so a flat object works — fields inlined at top
    // level keep `parseString(payload, "name")` happy without a real
    // JSON parser on the C++ side.
    const line =
      JSON.stringify({
        id,
        type,
        ...payload,
      }) + '\n';
    const p = new Promise<EnnioResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket!.write(line, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
    return p;
  }

  isConnected(): boolean {
    return !!this.socket && !this.socket.destroyed;
  }

  close(): void {
    if (this.socket) this.socket.destroy();
    this.socket = null;
  }
}
