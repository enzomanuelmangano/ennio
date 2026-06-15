import { describe, it, expect } from 'vitest';

import type { TypedRpcClient } from '../rpc/client';
import type { OpName } from '../rpc/ops';
import type { RpcOutcome } from '../rpc/result';
import {
  afterTap,
  afterTextInput,
  afterPressKey,
  afterNav,
  afterSwipe,
  preSwipe,
  preTapTransition,
  preTapTextDismiss,
  afterLaunch,
  afterFocus,
} from './policies';

// Records the op sequence a policy emits and returns scripted outcomes.
// Policies reach the socket only through rpc.bestEffort, so that's the
// single seam to record. The op SEQUENCE is the determinism contract —
// a dropped/reordered wait changes this list and fails the test.
class MockRpc {
  calls: { op: OpName; args: Record<string, unknown> }[] = [];
  constructor(private responder: (op: OpName, callIdx: number) => RpcOutcome<unknown>) {}
  bestEffort(op: OpName, args: Record<string, unknown>): Promise<RpcOutcome<unknown>> {
    const idx = this.calls.length;
    this.calls.push({ op, args });
    return Promise.resolve(this.responder(op, idx));
  }
  ops(): OpName[] {
    return this.calls.map((c) => c.op);
  }
  asClient(): TypedRpcClient {
    return this as unknown as TypedRpcClient;
  }
}

const ok = <T>(data: T): RpcOutcome<T> => ({ kind: 'ok', data });

// Default responder: hash always differs from 'H1', no animation, all
// waits succeed. Each test overrides only what it needs.
function defaultResponder(op: OpName): RpcOutcome<unknown> {
  switch (op) {
    case 'frame_hash':
      return ok({ hash: 'H2' });
    case 'animations_active':
      return ok({ active: false });
    case 'wait_commit':
    case 'wait_react_commit':
    case 'wait_presentation_idle':
      return ok({ ok: true, elapsedMs: 0 });
    case 'wait_hash_change':
      return ok({ ok: true });
    case 'hide_keyboard':
      return ok({ hidden: true });
    default:
      return ok({});
  }
}

describe('afterTap — React-observer-attached branch', () => {
  it('commits on hash-diff + no animation, no extra wait when next does not edit a field', async () => {
    const rpc = new MockRpc(defaultResponder);
    await afterTap(rpc.asClient(), {
      preTapHash: 'H1',
      reactAttach: 'fabric',
      nextEditsField: false,
    });
    expect(rpc.ops()).toEqual(['frame_hash', 'animations_active', 'wait_commit']);
  });

  it('adds a react-commit wait when the next command edits a field', async () => {
    const rpc = new MockRpc(defaultResponder);
    await afterTap(rpc.asClient(), {
      preTapHash: 'H1',
      reactAttach: 'fabric',
      nextEditsField: true,
    });
    expect(rpc.ops()).toEqual([
      'frame_hash',
      'animations_active',
      'wait_react_commit',
      'wait_commit',
    ]);
  });

  it('falls back to wait_hash_change when no commit is observed', async () => {
    // Hash never differs from preTapHash → loop never commits → fallback.
    const rpc = new MockRpc((op) =>
      op === 'frame_hash' ? ok({ hash: 'H1' }) : defaultResponder(op),
    );
    await afterTap(rpc.asClient(), { preTapHash: 'H1', reactAttach: 'paper' });
    const ops = rpc.ops();
    // ends with the fallback hash-change then the final commit
    expect(ops[ops.length - 2]).toBe('wait_hash_change');
    expect(ops[ops.length - 1]).toBe('wait_commit');
  });
});

describe('afterTap — no-observer branch', () => {
  it('hash changed → final commit + presentation idle (no sleep/anim probe)', async () => {
    const rpc = new MockRpc(defaultResponder);
    await afterTap(rpc.asClient(), { preTapHash: 'H1', reactAttach: 'none' });
    expect(rpc.ops()).toEqual(['wait_hash_change', 'wait_commit', 'wait_presentation_idle']);
  });

  it('hash NOT changed → probes animations, then commit + presentation idle', async () => {
    const rpc = new MockRpc((op) =>
      op === 'wait_hash_change' ? ok({ ok: false }) : defaultResponder(op),
    );
    await afterTap(rpc.asClient(), { preTapHash: 'H1', reactAttach: 'none' });
    expect(rpc.ops()).toEqual([
      'wait_hash_change',
      'animations_active',
      'wait_commit',
      'wait_presentation_idle',
    ]);
  });
});

describe('other policies pin their op sequence', () => {
  it('preTapTransition polls animations once when idle', async () => {
    const rpc = new MockRpc(defaultResponder);
    await preTapTransition(rpc.asClient());
    expect(rpc.ops()).toEqual(['animations_active']);
  });

  it('preTapTextDismiss hides keyboard then commits', async () => {
    const rpc = new MockRpc(defaultResponder);
    await preTapTextDismiss(rpc.asClient());
    expect(rpc.ops()).toEqual(['hide_keyboard', 'wait_commit']);
  });

  it('afterFocus waits a single commit', async () => {
    const rpc = new MockRpc(defaultResponder);
    await afterFocus(rpc.asClient());
    expect(rpc.ops()).toEqual(['wait_commit']);
  });

  it('afterTextInput waits a single commit', async () => {
    const rpc = new MockRpc(defaultResponder);
    await afterTextInput(rpc.asClient());
    expect(rpc.ops()).toEqual(['wait_commit']);
  });

  it('afterPressKey: react-commit then commit (no blind pre-sleep)', async () => {
    const rpc = new MockRpc(defaultResponder);
    await afterPressKey(rpc.asClient());
    expect(rpc.ops()).toEqual(['wait_react_commit', 'wait_commit']);
  });

  it('afterNav polls animations once when idle', async () => {
    const rpc = new MockRpc(defaultResponder);
    await afterNav(rpc.asClient());
    expect(rpc.ops()).toEqual(['animations_active']);
  });

  it('preSwipe: commit then presentation idle', async () => {
    const rpc = new MockRpc(defaultResponder);
    await preSwipe(rpc.asClient());
    expect(rpc.ops()).toEqual(['wait_commit', 'wait_presentation_idle']);
  });

  it('afterSwipe: scroll-idle then commit (signal, not a blind sleep)', async () => {
    const rpc = new MockRpc(defaultResponder);
    await afterSwipe(rpc.asClient());
    expect(rpc.ops()).toEqual(['wait_scroll_idle', 'wait_commit']);
  });

  it('afterLaunch: first-paint commit, react commit, final commit (react ok → no fallback sleep)', async () => {
    const rpc = new MockRpc(defaultResponder);
    await afterLaunch(rpc.asClient());
    expect(rpc.ops()).toEqual(['wait_commit', 'wait_react_commit', 'wait_commit']);
  });
});
