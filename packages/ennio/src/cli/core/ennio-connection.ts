// Owned resource: dylib Unix socket + RPC layer.
//
// Replaces the module-level `sharedClient` globals in
// hid.ts. A connection is created per flow run, exposes typed access
// to all in-app capabilities (find / tap / settle / system ops), and
// cleans up its socket on close().
//
// hid.ts now reads from the active-connections registry that this
// class populates on open() and drains on close(). hid.ts itself
// holds zero mutable state.

import { EnnioSocketClient } from '../socket-client';
import type { ConnectTarget } from '../socket-client';

import { registerConnection, unregisterConnection } from './active-connections';

export interface EnnioConnectionOptions {
  udid: string;
  /** Transport endpoint. Defaults to the per-UDID Unix path (iOS). The
   *  Android platform passes a TCP target (adb-forwarded abstract
   *  socket). */
  target?: ConnectTarget;
}

export class EnnioConnection {
  readonly udid: string;
  readonly socket: EnnioSocketClient;
  private opened = false;
  private closed = false;

  constructor(opts: EnnioConnectionOptions) {
    this.udid = opts.udid;
    this.socket = new EnnioSocketClient(opts.target ?? opts.udid);
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
      registerConnection(this);
    }
    return ok;
  }

  /**
   * Tear down all resources. Idempotent. Safe in finally blocks.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    unregisterConnection(this);
    try {
      this.socket.close();
    } catch {
      /* ignore */
    }
  }

  isOpen(): boolean {
    return this.opened && !this.closed && this.socket.isConnected();
  }
}
