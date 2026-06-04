import { describe, it, expect, vi, beforeEach } from 'vitest';

import { FastDriver, HidDriver, createDriver } from './driver';
import type { EnnioSocketClient } from './socket-client';

// Mock the per-UDID connection registry so the drivers talk to fakes.
const { socketCall, idbTap, idbDoubleTap, idbSwipe } = vi.hoisted(() => ({
  socketCall: vi.fn(),
  idbTap: vi.fn(async () => {}),
  idbDoubleTap: vi.fn(async () => {}),
  idbSwipe: vi.fn(async () => {}),
}));

vi.mock('./core/active-connections', () => ({
  getActiveConnection: () => ({
    socket: { call: socketCall },
    idb: () => ({ tap: idbTap, doubleTap: idbDoubleTap, swipe: idbSwipe }),
  }),
}));

const UDID = 'TEST-UDID';
const client = { call: socketCall } as unknown as EnnioSocketClient;

/** socket.call stub: window_size always answers; gesture ops per `gesture`. */
function stubSocket(gesture: (op: string) => { ok: boolean; data?: unknown; err?: string }) {
  socketCall.mockImplementation(async (op: string) => {
    if (op === 'window_size') return { ok: true, data: { w: 400, h: 800 } };
    return gesture(op);
  });
}

beforeEach(() => {
  socketCall.mockReset();
  idbTap.mockClear();
  idbDoubleTap.mockClear();
  idbSwipe.mockClear();
});

describe('createDriver', () => {
  it('returns HidDriver for baseline, FastDriver for fast', () => {
    expect(createDriver(false).name).toBe('hid');
    expect(createDriver(true).name).toBe('fast');
  });
});

describe('HidDriver', () => {
  it('tap goes straight to idb, no dylib gesture ops', async () => {
    stubSocket(() => ({ ok: true, data: { ok: true } }));
    await new HidDriver().tap(UDID, 100, 200);
    expect(idbTap).toHaveBeenCalledOnce();
    const gestureOps = socketCall.mock.calls.map((c) => c[0]).filter((o) => o !== 'window_size');
    expect(gestureOps).toEqual([]);
  });

  it('swipe reports inProcess=false', async () => {
    stubSocket(() => ({ ok: true, data: { ok: true } }));
    const out = await new HidDriver().swipe(UDID, 360, 400, 40, 400, 250);
    expect(idbSwipe).toHaveBeenCalledOnce();
    expect(out.inProcess).toBe(false);
  });
});

describe('FastDriver tap', () => {
  function makeFast(): FastDriver {
    return new FastDriver(new HidDriver());
  }

  it('activation ok + hash change → idb not called', async () => {
    stubSocket((op) => {
      if (op === 'frame_hash') return { ok: true, data: { hash: 'AAA' } };
      if (op === 'activate_at_point') return { ok: true, data: { ok: true, via: 'uicontrol' } };
      if (op === 'wait_hash_change') return { ok: true, data: { ok: true } };
      return { ok: false };
    });
    const d = makeFast();
    await d.tap(UDID, 100, 200);
    expect(idbTap).not.toHaveBeenCalled();
    expect(socketCall).toHaveBeenCalledWith('activate_at_point', { x: 100, y: 200 });
    expect(d.stats()).toEqual({ hits: 1, fallbacks: 0 });
  });

  it('activation declined → idb fallback', async () => {
    stubSocket((op) => {
      if (op === 'frame_hash') return { ok: true, data: { hash: 'AAA' } };
      if (op === 'activate_at_point') return { ok: true, data: { ok: false } };
      return { ok: false };
    });
    const d = makeFast();
    await d.tap(UDID, 100, 200);
    expect(idbTap).toHaveBeenCalledOnce();
    expect(d.stats()).toEqual({ hits: 0, fallbacks: 1 });
  });

  it('phantom activation (no hash change) → idb fallback', async () => {
    stubSocket((op) => {
      if (op === 'frame_hash') return { ok: true, data: { hash: 'AAA' } };
      if (op === 'activate_at_point') return { ok: true, data: { ok: true } };
      if (op === 'wait_hash_change') return { ok: true, data: { ok: false } };
      return { ok: false };
    });
    const d = makeFast();
    await d.tap(UDID, 100, 200);
    expect(idbTap).toHaveBeenCalledOnce();
    expect(d.stats()).toEqual({ hits: 0, fallbacks: 1 });
  });

  it('socket error → idb fallback', async () => {
    socketCall.mockImplementation(async (op: string) => {
      if (op === 'window_size') return { ok: true, data: { w: 400, h: 800 } };
      if (op === 'frame_hash') return { ok: true, data: { hash: 'AAA' } };
      throw new Error('socket dead');
    });
    const d = makeFast();
    await d.tap(UDID, 100, 200);
    expect(idbTap).toHaveBeenCalledOnce();
    expect(d.stats()).toEqual({ hits: 0, fallbacks: 1 });
  });

  it('focus intent → real touch, no activation attempt', async () => {
    stubSocket(() => ({ ok: true, data: { ok: true } }));
    await makeFast().tap(UDID, 100, 200, { intent: 'focus' });
    expect(idbTap).toHaveBeenCalledOnce();
    const gestureOps = socketCall.mock.calls.map((c) => c[0]).filter((o) => o !== 'window_size');
    expect(gestureOps).toEqual([]);
  });

  it('held tap (longPress) → real touch', async () => {
    stubSocket(() => ({ ok: true, data: { ok: true } }));
    await makeFast().tap(UDID, 100, 200, { intent: 'longPress', holdSec: 0.8 });
    expect(idbTap).toHaveBeenCalledWith(100, 200, 0.8);
  });

  it('unexposed target → real touch (activation would hit the occluder)', async () => {
    stubSocket(() => ({ ok: true, data: { ok: true } }));
    await makeFast().tap(UDID, 100, 200, { exposed: false });
    expect(idbTap).toHaveBeenCalledOnce();
    const gestureOps = socketCall.mock.calls.map((c) => c[0]).filter((o) => o !== 'window_size');
    expect(gestureOps).toEqual([]);
  });

  it('doubleTap always real (needs the tap-gap timing)', async () => {
    stubSocket(() => ({ ok: true, data: { ok: true } }));
    await makeFast().doubleTap(UDID, 100, 200);
    expect(idbDoubleTap).toHaveBeenCalledOnce();
  });
});

describe('FastDriver swipe', () => {
  it('swipe_points ok → inProcess, idb not called', async () => {
    stubSocket((op) => {
      if (op === 'swipe_points') return { ok: true, data: { ok: true } };
      return { ok: false };
    });
    const d = new FastDriver(new HidDriver());
    const out = await d.swipe(UDID, 360, 400, 40, 400, 250);
    expect(out.inProcess).toBe(true);
    expect(idbSwipe).not.toHaveBeenCalled();
    expect(socketCall).toHaveBeenCalledWith('swipe_points', {
      x1: 360,
      y1: 400,
      x2: 40,
      y2: 400,
      durationMs: 250,
    });
  });

  it('swipe_points declined (non-scroll target) → idb fallback, inProcess=false', async () => {
    stubSocket((op) => {
      if (op === 'swipe_points') return { ok: true, data: { ok: false } };
      return { ok: false };
    });
    const d = new FastDriver(new HidDriver());
    const out = await d.swipe(UDID, 360, 400, 40, 400, 250);
    expect(out.inProcess).toBe(false);
    expect(idbSwipe).toHaveBeenCalledOnce();
  });
});

describe('FastDriver tab routing', () => {
  it('routes a tab-name text tap through tap_tab', async () => {
    stubSocket((op) => {
      if (op === 'find_tab') return { ok: true, data: { present: true } };
      if (op === 'tap_tab') return { ok: true, data: { tapped: true } };
      return { ok: false };
    });
    const d = new FastDriver(new HidDriver());
    expect(await d.tryTabTap(client, 'Cart')).toBe(true);
  });

  it('declines when no matching tab', async () => {
    stubSocket((op) => {
      if (op === 'find_tab') return { ok: true, data: { present: false } };
      return { ok: false };
    });
    const d = new FastDriver(new HidDriver());
    expect(await d.tryTabTap(client, 'Nope')).toBe(false);
  });

  it('HidDriver never routes tab taps', async () => {
    expect(await new HidDriver().tryTabTap()).toBe(false);
  });
});
