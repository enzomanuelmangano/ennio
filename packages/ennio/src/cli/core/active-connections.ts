// Per-UDID connection registry. Populated by EnnioConnection on open(),
// drained on close(). hid.ts uses this to find the socket + idb client
// for the UDID a gesture targets — replaces the old free-floating
// `sharedClient` / `idbClients` module globals.
//
// The registry IS still process-scoped state, but its lifetime is
// owned by EnnioConnection: every entry has exactly one owner that
// removes itself on close. hid.ts is now read-only against this map.

import type { IdbGrpcClient } from '../idb-grpc';
import type { EnnioSocketClient } from '../socket-client';

export interface ActiveConnection {
  udid: string;
  socket: EnnioSocketClient;
  idb(): IdbGrpcClient;
}

const byUdid = new Map<string, ActiveConnection>();

export function registerConnection(c: ActiveConnection): void {
  byUdid.set(c.udid, c);
}

export function unregisterConnection(c: ActiveConnection): void {
  // Only remove if still pointing at this same instance — guards
  // against a stale unregister wiping a freshly-opened replacement.
  if (byUdid.get(c.udid) === c) byUdid.delete(c.udid);
}

export function getActiveConnection(udid: string): ActiveConnection {
  const c = byUdid.get(udid);
  if (!c) throw new Error(`no active ennio connection for udid ${udid}`);
  return c;
}

export function hasActiveConnection(udid: string): boolean {
  return byUdid.has(udid);
}
