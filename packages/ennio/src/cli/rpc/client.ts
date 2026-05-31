// TypedRpcClient — a thin, validated layer over the raw EnnioSocketClient
// line-JSON transport. Three call styles:
//
//   call(op, args)       -> RpcOutcome<T>  (ok | not-found | infra-error)
//   tryData(op, args)    -> T | null       (null ONLY on not-found; THROWS infra)
//   bestEffort(op, args) -> RpcOutcome<T>  (never throws; logs infra-errors)
//
// `tryData` is the dominant idiom: "give me the rect or null". Unlike the
// legacy `.call(op).catch(() => undefined)`, it does NOT swallow a dead
// socket as a missing element — infra failures throw and surface.

import type { EnnioSocketClient } from '../socket-client';

import { decoders } from './guards';
import type { OpArgs, OpName, OpResult } from './ops';
import type { RpcOutcome } from './result';

/**
 * Classify a dylib error string as "not-found" (a normal domain answer)
 * vs an infra/programming error. Unknown/missing op are programming
 * errors → infra, never not-found.
 */
export function isNotFoundErr(err: string | undefined): boolean {
  if (!err) return false;
  if (/unknown op|missing op|handler threw/i.test(err)) return false;
  return /not found|no match|no element|not visible|not present|no view|no such/i.test(err);
}

type InfraErrorListener = (op: OpName, error: Error) => void;

export class TypedRpcClient {
  constructor(
    private readonly raw: EnnioSocketClient,
    private readonly onInfraError: InfraErrorListener = defaultInfraLog,
  ) {}

  /** The underlying transport — for migration adapters and lifecycle swaps. */
  get socket(): EnnioSocketClient {
    return this.raw;
  }

  async call<K extends OpName>(op: K, args: OpArgs<K>): Promise<RpcOutcome<OpResult<K>>> {
    let resp;
    try {
      resp = await this.raw.call(op, args as Record<string, unknown>);
    } catch (e) {
      return { kind: 'infra-error', error: e instanceof Error ? e : new Error(String(e)) };
    }
    if (!resp.ok) {
      return isNotFoundErr(resp.err)
        ? { kind: 'not-found' }
        : { kind: 'infra-error', error: new Error(resp.err ?? `op ${op} failed`) };
    }
    const decoded = decoders[op](resp.data);
    if (!decoded.ok) {
      return { kind: 'infra-error', error: new Error(`bad ${op} payload: ${decoded.why}`) };
    }
    return { kind: 'ok', data: decoded.value };
  }

  /** Resolve to the data, or null on not-found. Throws on infra-error. */
  async tryData<K extends OpName>(op: K, args: OpArgs<K>): Promise<OpResult<K> | null> {
    const o = await this.call(op, args);
    if (o.kind === 'ok') return o.data;
    if (o.kind === 'not-found') return null;
    throw o.error;
  }

  /**
   * For genuinely fire-and-forget calls (e.g. a trailing settle wait
   * whose failure shouldn't abort the step). Never throws; an
   * infra-error is logged so it's observable rather than silent.
   */
  async bestEffort<K extends OpName>(op: K, args: OpArgs<K>): Promise<RpcOutcome<OpResult<K>>> {
    const o = await this.call(op, args);
    if (o.kind === 'infra-error') this.onInfraError(op, o.error);
    return o;
  }
}

function defaultInfraLog(op: OpName, error: Error): void {
  process.stderr.write(`[ennio][rpc] infra-error on ${op}: ${error.message}\n`);
}
