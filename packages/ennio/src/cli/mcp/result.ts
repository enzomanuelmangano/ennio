// The structured result contract every ennio MCP tool returns.
//
// One envelope, always: `{ ok: true, data }` on success or
// `{ ok: false, error: { kind, message } }` otherwise. No tool ever
// returns raw stdout, and no tool throws past this boundary — an
// exception inside a handler is caught and rendered as an `infra` error
// so a misbehaving op can't derail the calling agent.
//
// The `kind` taxonomy mirrors ennio's internal RpcOutcome but is widened
// for the MCP surface:
//   not_found — a clean, expected "the thing isn't there" domain answer.
//               This is NOT a failure; agents branch on it normally.
//   timeout   — a wait/settle budget expired before the condition held.
//   invalid   — the caller's arguments were malformed (bad selector,
//               out-of-range coordinate, unknown option).
//   infra     — the device, socket, or actuator broke. Genuinely wrong.

import type { RpcOutcome } from '../rpc/result';

export type ErrorKind = 'not_found' | 'timeout' | 'invalid' | 'infra';

export type EnnioResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: { kind: ErrorKind; message: string } };

export function ok<T>(data: T): EnnioResult<T> {
  return { ok: true, data };
}

export function err(kind: ErrorKind, message: string): EnnioResult<never> {
  return { ok: false, error: { kind, message } };
}

/**
 * Whether a result should surface to the MCP layer as an *error* turn
 * (`isError: true`). not_found is deliberately excluded: it's a normal
 * answer the agent acts on, not a tool malfunction. Only the three
 * genuine-failure kinds flip the flag.
 */
export function isErrorResult(r: EnnioResult): boolean {
  return !r.ok && r.error.kind !== 'not_found';
}

/** Lift a typed RpcOutcome into the MCP envelope. */
export function fromRpcOutcome<T>(o: RpcOutcome<T>): EnnioResult<T> {
  switch (o.kind) {
    case 'ok':
      return ok(o.data);
    case 'not-found':
      return err('not_found', 'no matching element');
    case 'infra-error':
      return err('infra', o.error.message);
  }
}

/**
 * Map a thrown error from the command pipeline to a result kind. The
 * dylib/runner speak in message strings; this is the single place that
 * classifies them, so the taxonomy stays consistent across every tool.
 */
export function classifyError(e: unknown): EnnioResult<never> {
  const message = e instanceof Error ? e.message : String(e);
  if (/element not found|no match|not visible|not present|no such|no view/i.test(message)) {
    return err('not_found', message);
  }
  if (/timeout|timed out|deadline|budget expired/i.test(message)) {
    return err('timeout', message);
  }
  if (/invalid|malformed|unsupported command|missing .* selector|out of range/i.test(message)) {
    return err('invalid', message);
  }
  return err('infra', message);
}
