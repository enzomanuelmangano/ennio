// Settle signals — typed, single-purpose reads over the TypedRpcClient.
// Policies compose these instead of poking the socket directly. Each
// signal is best-effort: an infra-error during settle is logged (by the
// client) and degrades to a safe default rather than aborting the step,
// because a settle wait that can't reach the dylib is not the same as a
// test assertion failing.

import { sleep } from '../runner/context';
import type { TypedRpcClient } from '../rpc/client';

export { sleep };

/** Current visible-view-tree frame hash, or '' if unavailable. */
export async function frameHash(rpc: TypedRpcClient): Promise<string> {
  const o = await rpc.bestEffort('frame_hash', {});
  return o.kind === 'ok' ? o.data.hash : '';
}

export interface ReactAttachState {
  ts: number;
  attach: 'paper' | 'fabric' | 'both' | 'none';
}

/** React commit timestamp + which observer is attached. */
export async function reactObserver(rpc: TypedRpcClient): Promise<ReactAttachState> {
  const o = await rpc.bestEffort('react_commit_ts', {});
  if (o.kind !== 'ok') return { ts: 0, attach: 'none' };
  const ts = typeof o.data.ts === 'number' ? o.data.ts : parseInt(String(o.data.ts), 10) || 0;
  return { ts, attach: o.data.attach };
}

/** Is any UIViewController in the chain mid-transition? */
export async function animationsActive(rpc: TypedRpcClient): Promise<boolean> {
  const o = await rpc.bestEffort('animations_active', {});
  return o.kind === 'ok' ? o.data.active : false;
}

/** Wait for frame-hash stability (CADisplayLink ticker inside the dylib). */
export async function waitCommit(
  rpc: TypedRpcClient,
  budget: { maxMs: number; stableMs: number },
): Promise<boolean> {
  const o = await rpc.bestEffort('wait_commit', budget);
  return o.kind === 'ok' ? o.data.ok : false;
}

/** Wait for the next React commit after `sinceMs`. */
export async function waitReactCommit(
  rpc: TypedRpcClient,
  budget: { sinceMs: number; maxMs: number },
): Promise<{ ok: boolean; elapsedMs: number }> {
  const o = await rpc.bestEffort('wait_react_commit', budget);
  return o.kind === 'ok'
    ? { ok: o.data.ok, elapsedMs: o.data.elapsedMs ?? 0 }
    : { ok: false, elapsedMs: 0 };
}

/** Wait until the frame hash differs from `sinceHash`. */
export async function waitHashChange(
  rpc: TypedRpcClient,
  sinceHash: string,
  maxMs: number,
): Promise<boolean> {
  const o = await rpc.bestEffort('wait_hash_change', { sinceHash, maxMs });
  return o.kind === 'ok' ? o.data.ok : false;
}

/** Wait until no presentation/dismiss transition is in flight. */
export async function presentationIdle(rpc: TypedRpcClient, maxMs: number): Promise<void> {
  await rpc.bestEffort('wait_presentation_idle', { maxMs });
}
