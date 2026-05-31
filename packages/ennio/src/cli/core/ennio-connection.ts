// Owned resource: dylib Unix socket + RPC layer + idb gRPC HID pool.
//
// Replaces the module-level `sharedClient` / `idbClients` globals in
// hid.ts. A connection is created per flow run, exposes typed access
// to all in-app capabilities (find / tap / settle / system ops), and
// cleans up its sockets + gRPC streams on close().
//
// Construction is cheap; open() is the async step. Pair with a
// try/finally so resources are always released.

import { IdbGrpcClient } from '../idb-grpc';
import { setDylibClient } from '../hid';
import { EnnioSocketClient, ennioSocketPath } from '../socket-client';

export interface EnnioConnectionOptions {
  udid: string;
}

export class EnnioConnection {
  readonly udid: string;
  readonly socketPath: string;
  readonly socket: EnnioSocketClient;
  private idbClients = new Map<string, IdbGrpcClient>();
  private opened = false;
  private closed = false;

  constructor(opts: EnnioConnectionOptions) {
    this.udid = opts.udid;
    this.socketPath = ennioSocketPath(opts.udid);
    this.socket = new EnnioSocketClient(opts.udid);
  }

  /**
   * Open the socket. Returns true on success, false if the dylib
   * listener isn't up yet (caller is responsible for relaunching the
   * app and retrying).
   */
  async open(maxWaitMs = 5_000): Promise<boolean> {
    if (this.opened) return true;
    const ok = await this.socket.connectWithRetry(maxWaitMs);
    if (ok) {
      this.opened = true;
      // Bridge to legacy hid.ts globals until those callers are
      // migrated to use this connection directly.
      setDylibClient(this.socket);
    }
    return ok;
  }

  /**
   * Get (or lazily create) the idb gRPC client for this connection's
   * UDID. Single client per UDID per connection — cleaned up on close.
   */
  idb(): IdbGrpcClient {
    if (this.closed) throw new Error('EnnioConnection used after close()');
    let c = this.idbClients.get(this.udid);
    if (!c) {
      c = new IdbGrpcClient(this.udid);
      this.idbClients.set(this.udid, c);
    }
    return c;
  }

  /**
   * Tear down all resources. Idempotent. Safe in finally blocks.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.close();
    } catch {
      /* ignore */
    }
    for (const c of this.idbClients.values()) {
      try {
        c.close();
      } catch {
        /* ignore */
      }
    }
    this.idbClients.clear();
    setDylibClient(null);
  }

  isOpen(): boolean {
    return this.opened && !this.closed && this.socket.isConnected();
  }
}
