import { describe, it, expect, vi } from 'vitest';

import type { EnnioSocketClient, EnnioSocketResponse } from '../socket-client';
import { TypedRpcClient, isNotFoundErr } from './client';

// Minimal fake transport: scripts the next raw response, or throws.
function fakeSocket(
  next: () => EnnioSocketResponse | Promise<EnnioSocketResponse>,
): EnnioSocketClient {
  return {
    call: () => Promise.resolve().then(next),
  } as unknown as EnnioSocketClient;
}

describe('isNotFoundErr', () => {
  it('treats element-not-found vocabulary as not-found', () => {
    for (const e of [
      'testID not found: foo',
      'no match for text "X"',
      'element not found',
      'not visible',
      'no such view',
    ]) {
      expect(isNotFoundErr(e)).toBe(true);
    }
  });

  it('treats protocol/programming errors as NOT not-found (→ infra)', () => {
    for (const e of ['unknown op: bogus', 'missing op', 'handler threw unknown exception', '']) {
      expect(isNotFoundErr(e)).toBe(false);
    }
    expect(isNotFoundErr(undefined)).toBe(false);
  });
});

describe('TypedRpcClient.call', () => {
  it('returns ok with validated data', async () => {
    const rpc = new TypedRpcClient(
      fakeSocket(() => ({ id: 'r1', ok: true, data: { x: 1, y: 2, w: 3, h: 4 } })),
    );
    const o = await rpc.call('find_by_testid', { testID: 'a' });
    expect(o).toEqual({ kind: 'ok', data: { x: 1, y: 2, w: 3, h: 4 } });
  });

  it('flags a structurally bad payload as infra-error, not ok', async () => {
    const rpc = new TypedRpcClient(
      fakeSocket(() => ({ id: 'r1', ok: true, data: { x: 'nope', y: 2, w: 3, h: 4 } })),
    );
    const o = await rpc.call('find_by_testid', { testID: 'a' });
    expect(o.kind).toBe('infra-error');
    if (o.kind === 'infra-error') expect(o.error.message).toMatch(/bad find_by_testid payload/);
  });

  it('maps a not-found dylib error to not-found', async () => {
    const rpc = new TypedRpcClient(
      fakeSocket(() => ({ id: 'r1', ok: false, err: 'testID not found: a' })),
    );
    expect((await rpc.call('find_by_testid', { testID: 'a' })).kind).toBe('not-found');
  });

  it('maps an unknown-op error to infra-error', async () => {
    const rpc = new TypedRpcClient(fakeSocket(() => ({ id: 'r1', ok: false, err: 'unknown op: x' })));
    expect((await rpc.call('find_by_testid', { testID: 'a' })).kind).toBe('infra-error');
  });

  it('maps a thrown transport error (dead socket) to infra-error', async () => {
    const rpc = new TypedRpcClient(
      fakeSocket(() => {
        throw new Error('ennio socket not connected');
      }),
    );
    const o = await rpc.call('frame_hash', {});
    expect(o.kind).toBe('infra-error');
    if (o.kind === 'infra-error') expect(o.error.message).toMatch(/not connected/);
  });
});

describe('TypedRpcClient.tryData', () => {
  it('returns data on ok', async () => {
    const rpc = new TypedRpcClient(fakeSocket(() => ({ id: 'r', ok: true, data: { hash: 'abc' } })));
    expect(await rpc.tryData('frame_hash', {})).toEqual({ hash: 'abc' });
  });

  it('returns null on not-found', async () => {
    const rpc = new TypedRpcClient(fakeSocket(() => ({ id: 'r', ok: false, err: 'not found' })));
    expect(await rpc.tryData('find_by_testid', { testID: 'a' })).toBeNull();
  });

  it('THROWS on infra-error (does not masquerade as not-found)', async () => {
    const rpc = new TypedRpcClient(
      fakeSocket(() => {
        throw new Error('socket closed');
      }),
    );
    await expect(rpc.tryData('find_by_testid', { testID: 'a' })).rejects.toThrow('socket closed');
  });
});

describe('TypedRpcClient.bestEffort', () => {
  it('never throws and logs infra-errors via the listener', async () => {
    const onInfra = vi.fn();
    const rpc = new TypedRpcClient(
      fakeSocket(() => {
        throw new Error('boom');
      }),
      onInfra,
    );
    const o = await rpc.bestEffort('wait_commit', { maxMs: 100, stableMs: 10 });
    expect(o.kind).toBe('infra-error');
    expect(onInfra).toHaveBeenCalledOnce();
    expect(onInfra.mock.calls[0][0]).toBe('wait_commit');
  });

  it('does not log on a clean not-found', async () => {
    const onInfra = vi.fn();
    const rpc = new TypedRpcClient(fakeSocket(() => ({ id: 'r', ok: false, err: 'not found' })), onInfra);
    await rpc.bestEffort('visible', { testID: 'a' });
    expect(onInfra).not.toHaveBeenCalled();
  });
});
