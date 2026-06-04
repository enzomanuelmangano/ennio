import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { tap, doubleTap, swipe, setFastMode, getFastStats, resetFastStats } from './hid';

// Mock the per-UDID connection registry so hid.ts talks to fakes.
// vi.hoisted runs before the hoisted vi.mock factory's lazy evaluation,
// so the fakes exist whichever import executes first.
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
  resetFastStats();
});

afterEach(() => {
  setFastMode(false);
});

describe('hid fast mode — tap', () => {
  it('fast off: tap goes straight to idb HID, no activation op', async () => {
    setFastMode(false);
    stubSocket(() => ({ ok: true, data: { ok: true } }));
    await tap(UDID, 100, 200);
    expect(idbTap).toHaveBeenCalledOnce();
    const gestureOps = socketCall.mock.calls.map((c) => c[0]).filter((o) => o !== 'window_size');
    expect(gestureOps).toEqual([]);
  });

  it('fast on + activate_at_point ok:true → idb not called', async () => {
    setFastMode(true);
    stubSocket(() => ({ ok: true, data: { ok: true } }));
    await tap(UDID, 100, 200);
    expect(idbTap).not.toHaveBeenCalled();
    expect(socketCall).toHaveBeenCalledWith('activate_at_point', { x: 100, y: 200 });
    expect(getFastStats()).toEqual({ hits: 1, fallbacks: 0 });
  });

  it('fast on + activate_at_point ok:false → falls back to idb', async () => {
    setFastMode(true);
    stubSocket(() => ({ ok: true, data: { ok: false } }));
    await tap(UDID, 100, 200);
    expect(idbTap).toHaveBeenCalledOnce();
    expect(getFastStats()).toEqual({ hits: 0, fallbacks: 1 });
  });

  it('fast on + socket error → falls back to idb', async () => {
    setFastMode(true);
    socketCall.mockImplementation(async (op: string) => {
      if (op === 'window_size') return { ok: true, data: { w: 400, h: 800 } };
      throw new Error('socket dead');
    });
    await tap(UDID, 100, 200);
    expect(idbTap).toHaveBeenCalledOnce();
    expect(getFastStats()).toEqual({ hits: 0, fallbacks: 1 });
  });

  it('fast on + held tap (longPress holdSec=0.8) → stays on idb HID', async () => {
    setFastMode(true);
    stubSocket(() => ({ ok: true, data: { ok: true } }));
    await tap(UDID, 100, 200, 0.8);
    expect(idbTap).toHaveBeenCalledWith(100, 200, 0.8);
    const gestureOps = socketCall.mock.calls.map((c) => c[0]).filter((o) => o !== 'window_size');
    expect(gestureOps).toEqual([]);
  });

  it('fast on + doubleTap → stays on idb HID', async () => {
    setFastMode(true);
    stubSocket(() => ({ ok: true, data: { ok: true } }));
    await doubleTap(UDID, 100, 200);
    expect(idbDoubleTap).toHaveBeenCalledOnce();
    const gestureOps = socketCall.mock.calls.map((c) => c[0]).filter((o) => o !== 'window_size');
    expect(gestureOps).toEqual([]);
  });
});

describe('hid fast mode — swipe', () => {
  it('fast on + swipe_points ok:true → idb not called', async () => {
    setFastMode(true);
    stubSocket(() => ({ ok: true, data: { ok: true } }));
    await swipe(UDID, 360, 400, 40, 400, 250);
    expect(idbSwipe).not.toHaveBeenCalled();
    expect(socketCall).toHaveBeenCalledWith('swipe_points', {
      x1: 360,
      y1: 400,
      x2: 40,
      y2: 400,
      durationMs: 250,
    });
    expect(getFastStats()).toEqual({ hits: 1, fallbacks: 0 });
  });

  it('fast on + swipe_points ok:false (non-scroll target) → falls back to idb', async () => {
    setFastMode(true);
    stubSocket(() => ({ ok: true, data: { ok: false } }));
    await swipe(UDID, 360, 440, 40, 440, 250);
    expect(idbSwipe).toHaveBeenCalledOnce();
    expect(getFastStats()).toEqual({ hits: 0, fallbacks: 1 });
  });

  it('fast off: swipe goes straight to idb HID', async () => {
    setFastMode(false);
    stubSocket(() => ({ ok: true, data: { ok: true } }));
    await swipe(UDID, 360, 440, 40, 440, 250);
    expect(idbSwipe).toHaveBeenCalledOnce();
    const gestureOps = socketCall.mock.calls.map((c) => c[0]).filter((o) => o !== 'window_size');
    expect(gestureOps).toEqual([]);
  });
});
