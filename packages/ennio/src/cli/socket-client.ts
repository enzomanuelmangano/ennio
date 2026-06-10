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

/**
 * Where to dial the in-app agent. iOS speaks over a Unix-domain socket
 * the simulator shares with the host via /tmp; Android speaks over a TCP
 * port `adb forward` bridges to the device's abstract socket. The
 * transport is the only platform difference at this layer — everything
 * above (framing, op dispatch) is identical.
 */
export type ConnectTarget = { kind: 'unix'; path: string } | { kind: 'tcp'; port: number };

export class EnnioSocketClient {
  private socket: Socket | null = null;
  private buf = '';
  private pending = new Map<string, PendingRequest>();
  private idSeq = 0;
  private connecting: Promise<boolean> | null = null;
  private target: ConnectTarget;

  /**
   * Optional process-liveness probe, installed by the owner that knows
   * the target app (EnnioConnection wires a throttled isAppRunning).
   * When it reports the process gone, every retry ladder short-circuits
   * immediately: a crashed app cannot come back on its own, and waiting
   * out reconnect budgets turns one crash into minutes of hang per op
   * (measured: a crash-on-boot app cost 3-11min per flow, 112min over a
   * 21-flow suite).
   */
  aliveProbe: (() => boolean) | null = null;

  private appDead(): boolean {
    try {
      return this.aliveProbe ? !this.aliveProbe() : false;
    } catch {
      return false; // probe failure must never fabricate a crash
    }
  }

  /**
   * Accepts either a UDID (iOS legacy — resolves to the per-target Unix
   * path) or an explicit ConnectTarget (Android passes a TCP port). The
   * UDID overload keeps the many `new EnnioSocketClient(ctx.udid)` call
   * sites in the iOS lifecycle untouched.
   */
  constructor(udidOrTarget?: string | ConnectTarget) {
    this.target =
      typeof udidOrTarget === 'object' && udidOrTarget !== null
        ? udidOrTarget
        : { kind: 'unix', path: ennioSocketPath(udidOrTarget) };
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
      const s =
        this.target.kind === 'tcp'
          ? createConnection({ port: this.target.port, host: '127.0.0.1' })
          : createConnection(this.target.path);
      const onError = () => {
        s.destroy();
        resolve(false);
      };
      s.once('error', onError);
      s.once('connect', () => {
        s.off('error', onError);
        s.on('data', (chunk) => this.onData(chunk));
        s.on('error', (e) => this.onSocketError(e));
        s.on('close', (hadError) => this.onClose(hadError));
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
      // Dead process → the listener is never coming up; stop waiting.
      if (this.appDead()) return false;
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

  private onClose(hadError?: boolean): void {
    if (process.env.ENNIO_DEBUG) {
      const tgt = this.target.kind === 'tcp' ? `tcp:${this.target.port}` : this.target.path;
      process.stderr.write(
        `[sock] close ${tgt} pending=${this.pending.size} hadError=${!!hadError}\n`,
      );
    }
    this.socket = null;
    const err = new Error('socket closed');
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  /**
   * Dispatch one op. Resolves to the typed response (data depends on
   * op). Absorbs a transient socket drop: a freshly relaunched app
   * (post-clearState) can close the first accepted connection while its
   * agent thread settles, so a single mid-flight close triggers one
   * reconnect + resend. The ops affected are early, idempotent reads
   * (find / hash / hide_keyboard / back), so a resend is safe.
   */
  async call(op: string, args: Record<string, unknown> = {}): Promise<EnnioSocketResponse> {
    let lastErr: unknown;
    // A freshly relaunched app (post-clearState) can leave a short-lived
    // "zombie" socket: an intermittent wrap.sh throwaway process binds
    // @ennio, then dies, and every connection cleanly FINs (no response)
    // until the real app reclaims the abstract socket (~1-2s). Reconnect
    // and retry across that window. The affected ops are early, idempotent
    // reads/navigation (find / hash / hide_keyboard / back), so resending
    // is safe.
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        return await this.callOnce(op, args);
      } catch (e) {
        lastErr = e;
        const msg = e instanceof Error ? e.message : String(e);
        if (!/socket closed|socket request timeout|ennio socket not connected/.test(msg)) {
          throw e;
        }
        // A dead process can't reconnect — fail the op NOW so the caller
        // can diagnose the crash, instead of grinding the retry ladder.
        if (this.appDead()) {
          throw new Error('ennio socket not connected (app process is gone)');
        }
        this.close();
        await new Promise((r) => setTimeout(r, 150));
        await this.connectWithRetry(3_000);
      }
    }
    throw lastErr;
  }

  private async callOnce(op: string, args: Record<string, unknown>): Promise<EnnioSocketResponse> {
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
