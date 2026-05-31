// Outcome of one typed RPC call.
//
// The whole point of this type: distinguish a clean "element not found"
// (a normal, expected domain answer the dylib gives) from an
// infrastructure failure (socket dead, request timeout, malformed
// payload, unknown op). The legacy `.call(op).catch(() => undefined)`
// idiom collapsed both into `undefined`, so a crashed dylib showed up
// in logs as "element not found" — a lie that wasted debugging hours.

export type RpcOutcome<T> =
  | { kind: 'ok'; data: T }
  | { kind: 'not-found' }
  | { kind: 'infra-error'; error: Error };

export function isOk<T>(o: RpcOutcome<T>): o is { kind: 'ok'; data: T } {
  return o.kind === 'ok';
}
