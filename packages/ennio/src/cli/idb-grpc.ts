// Direct gRPC client to idb_companion. Replaces the `idb ui tap`
// Python subprocess (~400 ms startup) with a persistent in-process
// gRPC stream to /tmp/idb/<UDID>_companion.sock.
//
// idb_companion exposes a CompanionService with a bidirectional `hid`
// RPC: the client sends HIDEvent messages (HIDPress + HIDDelay + ...);
// the companion injects them as real HID events into the simulator
// via private CoreSimulator APIs. We open the stream once per CLI
// run, batch tap events through it, and tear it down at exit.
//
// Per-tap cost: ~30-50 ms wall (RPC roundtrip), vs ~400 ms for the
// Python CLI. Net suite savings ~350 ms × N taps.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const PROTO_PATH = resolve(__dirname, '..', 'proto', 'idb.proto');

function loadCompanionService(): any {
  if (!existsSync(PROTO_PATH)) {
    throw new Error(`idb.proto not found at ${PROTO_PATH}`);
  }
  const def = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const grpcObj = grpc.loadPackageDefinition(def) as any;
  return grpcObj.idb.CompanionService;
}

export class IdbGrpcClient {
  private client: any;
  private stream: grpc.ClientWritableStream<any> | null = null;
  private streamReadyPromise: Promise<void> | null = null;
  private streamReadyResolve: (() => void) | null = null;
  private closed = false;

  /** Connect to idb_companion at the unix socket for this UDID. */
  constructor(udid: string) {
    const sock = `unix:///tmp/idb/${udid}_companion.sock`;
    const Service = loadCompanionService();
    this.client = new Service(sock, grpc.credentials.createInsecure(), {
      'grpc.max_receive_message_length': 16 * 1024 * 1024,
      'grpc.max_send_message_length': 16 * 1024 * 1024,
    });
  }

  private async ensureStream(): Promise<grpc.ClientWritableStream<any>> {
    if (this.stream) return this.stream;
    return new Promise((resolveStream, reject) => {
      // idb's `hid` RPC is client-streaming: many HIDEvents in, one
      // HIDResponse out at end. We never call .end() during normal
      // operation — keep the stream open for the CLI's lifetime so
      // taps incur zero connection-setup cost.
      this.stream = this.client.hid((err: Error | null) => {
        if (err && !this.closed) {
          // Reset so a subsequent call reopens.
          this.stream = null;
        }
      });
      if (!this.stream) {
        reject(new Error('idb gRPC stream init failed'));
        return;
      }
      this.stream.on('error', () => {
        this.stream = null;
      });
      resolveStream(this.stream);
    });
  }

  /** Tap (down + delay + up) at sim window coordinates. */
  async tap(x: number, y: number, durationSec: number = 0.08): Promise<void> {
    // Open a fresh session per tap. Long-lived streams were observed
    // to deliver HIDEvents that idb_companion's CoreSimulator HID
    // injector silently ignored on iOS 26 — likely because the
    // companion buffers/dedupes events on a per-session basis. The
    // Python idb CLI opens one session per tap (async with
    // self._hid_session()) and that's what works reliably.
    const stream = await this.openFreshStream();
    const writeOne = (msg: object) =>
      new Promise<void>((res, rej) => {
        const ok = stream.write(msg, (err?: Error) => (err ? rej(err) : res()));
        if (!ok) stream.once('drain', () => res());
      });
    const point = { x: Math.round(x), y: Math.round(y) };
    try {
      await writeOne({ press: { action: { touch: { point } }, direction: 'DOWN' } });
      // Client-side sleep between DOWN and UP — matches the idb
      // Python CLI's behavior (asyncio.sleep between sends).
      await new Promise((res) => setTimeout(res, durationSec * 1000));
      await writeOne({ press: { action: { touch: { point } }, direction: 'UP' } });
    } finally {
      // Close the stream so idb_companion flushes the event sequence
      // immediately and registers it as a complete tap with the
      // simulator's HID subsystem.
      try {
        stream.end();
      } catch {
        /* ignore */
      }
    }
  }

  private openFreshStream(): Promise<grpc.ClientWritableStream<any>> {
    return new Promise((resolveStream, reject) => {
      const s = this.client.hid((err: Error | null) => {
        // Server may emit an err on stream end — that's normal.
        void err;
      });
      if (!s) {
        reject(new Error('idb gRPC stream init failed'));
        return;
      }
      s.on('error', () => {
        /* ignore — stream ended */
      });
      resolveStream(s);
    });
  }

  /** Swipe between two points over durationSec. */
  async swipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationSec: number = 0.25,
  ): Promise<void> {
    const stream = await this.ensureStream();
    const writeOne = (msg: object) =>
      new Promise<void>((res, rej) => {
        const ok = stream.write(msg, (err?: Error) => (err ? rej(err) : res()));
        if (!ok) stream.once('drain', () => res());
      });
    await writeOne({
      swipe: {
        start: { x: Math.round(x1), y: Math.round(y1) },
        end: { x: Math.round(x2), y: Math.round(y2) },
        delta: 0,
        duration: durationSec,
      },
    });
  }

  /** Type literal text by mapping each char to a HID keycode press. */
  async typeText(text: string): Promise<void> {
    // idb's CLI typeText goes through the same hid RPC with a per-char
    // sequence. For simple ASCII this is straightforward, but full
    // mapping needs a keymap; keep it as a stub and let the runner
    // fall back to `idb ui text` when needed.
    void text;
    throw new Error('IdbGrpcClient.typeText not implemented');
  }

  close(): void {
    this.closed = true;
    if (this.stream) {
      try {
        this.stream.end();
      } catch {
        /* ignore */
      }
      this.stream = null;
    }
    if (this.client && this.client.close) this.client.close();
  }
}

let g_singleton: IdbGrpcClient | null = null;
let g_singletonUdid: string | null = null;

export function getIdbClient(udid: string): IdbGrpcClient {
  if (g_singleton && g_singletonUdid === udid) return g_singleton;
  if (g_singleton) g_singleton.close();
  g_singleton = new IdbGrpcClient(udid);
  g_singletonUdid = udid;
  return g_singleton;
}
