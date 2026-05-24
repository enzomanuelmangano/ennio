// Device interaction. Single source of truth for taps, swipes,
// keystrokes. Every gesture is dispatched through the in-process
// dylib socket — no external tool-server, no subprocess.
//
// The dylib runs inside the target app (injected via DYLD_INSERT)
// and listens on `/tmp/ennio-control.sock`. The runner opens that
// socket once and shares it with this module via `setDylibClient`.
// Each call here turns into one short JSON request on that same
// connection.
//
// The public surface (tap / swipe / press / typeText / pressKey /
// longPressDrag) is unchanged so callers don't need to migrate; only
// the underlying `callTool` dispatch has been swapped out.

import type { EnnioSocketClient } from './socket-client';
import { IdbGrpcClient } from './idb-grpc';

// =====================================================================
// Shared dylib socket client. Set by the runner once per flow run via
// `setDylibClient`. Every helper below pulls this connection — never
// opens its own — so requests serialise correctly behind any in-flight
// `find_by_*` / `wait_*` calls the runner itself is making.
// =====================================================================

let sharedClient: EnnioSocketClient | null = null;

export function setDylibClient(c: EnnioSocketClient | null): void {
  sharedClient = c;
}

function getDylibClient(): EnnioSocketClient {
  if (!sharedClient) throw new Error('ennio dylib socket not connected');
  return sharedClient;
}

// idb_companion gRPC client, lazy per-UDID. Single persistent
// connection for the CLI's lifetime; the `tap` op internally opens
// a fresh hid stream each call (idb_companion buffers per-session,
// so reusing one stream silently swallows events on iOS 26).
const idbClients = new Map<string, IdbGrpcClient>();

function getIdb(udid: string): IdbGrpcClient {
  let c = idbClients.get(udid);
  if (!c) {
    c = new IdbGrpcClient(udid);
    idbClients.set(udid, c);
  }
  return c;
}

export function closeAllIdbClients(): void {
  for (const c of idbClients.values()) {
    try {
      c.close();
    } catch {
      /* ignore */
    }
  }
  idbClients.clear();
}

const screenSizeCache = new Map<string, { w: number; h: number }>();

async function getScreenSize(udid: string): Promise<{ w: number; h: number }> {
  const cached = screenSizeCache.get(udid);
  if (cached) return cached;
  try {
    const c = getDylibClient();
    const r = await c.call('window_size').catch(() => undefined);
    if (r && r.ok && r.data) {
      const d = r.data as { w: number; h: number };
      if (d.w > 0 && d.h > 0) {
        screenSizeCache.set(udid, d);
        return d;
      }
    }
  } catch {
    /* fall through */
  }
  const fb = { w: 402, h: 874 };
  screenSizeCache.set(udid, fb);
  return fb;
}

function trace(line: string): void {
  process.stderr.write(`${line}\n`);
}

// =====================================================================
// Tool dispatcher — translates the legacy tool-server payload shape
// into dylib socket ops. Keeping the `callTool` shape lets the higher-
// level helpers (tap / swipe / press / typeText / pressKey /
// longPressDrag) stay byte-for-byte the same as the old code; only
// the call sites below need a screen-size to map normalised coords
// back to window-space pixels (which the dylib ops accept).
// =====================================================================

interface CustomEvent {
  type: 'Down' | 'Move' | 'Up';
  x: number;
  y: number;
  delayMs?: number;
}

async function dispatchGestureCustom(udid: string, events: CustomEvent[]): Promise<void> {
  const { w, h } = await getScreenSize(udid);
  const idb = getIdb(udid);
  const downs = events.filter((e) => e.type === 'Down');
  const ups = events.filter((e) => e.type === 'Up');
  const moves = events.filter((e) => e.type === 'Move');
  if (downs.length === 1 && ups.length >= 1) {
    const d = downs[0];
    const u = ups[ups.length - 1];
    const distinctMoves = moves.filter(
      (m) => Math.abs(m.x - d.x) > 0.001 || Math.abs(m.y - d.y) > 0.001,
    );
    if (distinctMoves.length === 0) {
      const holdMs = events.reduce((acc, e) => acc + (e.delayMs ?? 0), 0) || 80;
      trace(`[hid] tap nx=${d.x.toFixed(4)} ny=${d.y.toFixed(4)} hold=${holdMs}`);
      await idb.tap(d.x * w, d.y * h, holdMs / 1000);
      return;
    }
    const dur = events.reduce((acc, e) => acc + (e.delayMs ?? 0), 0) || 250;
    trace(
      `[hid] swipe nx=(${d.x.toFixed(4)},${d.y.toFixed(4)})→(${u.x.toFixed(4)},${u.y.toFixed(4)}) dur=${dur}`,
    );
    await idb.swipe(d.x * w, d.y * h, u.x * w, u.y * h, dur / 1000);
    return;
  }
  throw new Error(
    `gesture-custom shape not supported (down=${downs.length} up=${ups.length} move=${moves.length})`,
  );
}

// USB HID usage codes the dylib's `hardware_key` op accepts. Mirror
// the switch in EnnioOps.pressHardwareKey.
const KEY_NAME_TO_HID_USAGE: Record<string, number> = {
  return: 40,
  enter: 40,
  delete: 42,
  backspace: 42,
  space: 44,
};

export interface AXMatchRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Cross-process AX rect lookup. Backed by the dylib's
 * `find_ax_by_text` op which walks the in-process UIAccessibility
 * tree from every window/scene. Returns a window-space pixel rect
 * compatible with `tap`/`hidTap` callers.
 */
export async function axTreeSnapshot(udid: string): Promise<string> {
  void udid;
  const c = getDylibClient();
  try {
    const r = await c.call('ax_tree_snapshot');
    if (!r.ok || !r.data) return '';
    const d = r.data as { tree?: string };
    return typeof d.tree === 'string' ? d.tree : '';
  } catch {
    return '';
  }
}

export async function axQueryByText(udid: string, text: string): Promise<AXMatchRect | null> {
  void udid;
  // Single dylib roundtrip — the in-process AX walk is already fast
  // (sub-millisecond). One short retry covers the case where the
  // target's frame is still mid-transition.
  const deadline = Date.now() + 1500;
  const c = getDylibClient();
  while (Date.now() < deadline) {
    try {
      const r = await c.call('find_ax_by_text', { text });
      if (r && r.ok && r.data) {
        const d = r.data as { x?: number; y?: number; w?: number; h?: number };
        if (d.x != null && d.y != null && d.w != null && d.h != null) {
          return { x: d.x, y: d.y, w: d.w, h: d.h };
        }
      }
    } catch {
      /* retry */
    }
    if (Date.now() >= deadline) break;
    await new Promise((res) => setTimeout(res, 120));
  }
  return null;
}

/**
 * Convenience accessor mirroring axQueryByText for callers that
 * already have a window size cached.
 */
export async function getCachedScreenSize(udid: string): Promise<{ w: number; h: number }> {
  return getScreenSize(udid);
}

async function callTool(
  toolName: string,
  payload: Record<string, unknown>,
  _cliArgs: string[],
): Promise<void> {
  const udid = payload.udid as string;
  const dy = getDylibClient();
  if (toolName === 'gesture-tap') {
    const { w, h } = await getScreenSize(udid);
    const nx = payload.x as number;
    const ny = payload.y as number;
    const idb = getIdb(udid);
    if (payload.doubleTap) {
      trace(`[hid] double-tap nx=${nx.toFixed(4)} ny=${ny.toFixed(4)}`);
      await idb.doubleTap(nx * w, ny * h);
      return;
    }
    const holdSec = (payload.holdSec as number | undefined) ?? 0.08;
    trace(`[hid] tap nx=${nx.toFixed(4)} ny=${ny.toFixed(4)} hold=${holdSec}s`);
    await idb.tap(nx * w, ny * h, holdSec);
    return;
  }
  if (toolName === 'gesture-swipe') {
    const { w, h } = await getScreenSize(udid);
    const fromX = (payload.fromX as number) * w;
    const fromY = (payload.fromY as number) * h;
    const toX = (payload.toX as number) * w;
    const toY = (payload.toY as number) * h;
    const durationMs = payload.durationMs as number;
    const idb = getIdb(udid);
    trace(
      `[hid] swipe (${fromX.toFixed(0)},${fromY.toFixed(0)})→(${toX.toFixed(0)},${toY.toFixed(0)}) dur=${durationMs}`,
    );
    await idb.swipe(fromX, fromY, toX, toY, (durationMs ?? 250) / 1000);
    return;
  }
  if (toolName === 'gesture-custom') {
    const events = payload.events as CustomEvent[];
    await dispatchGestureCustom(udid, events);
    return;
  }
  if (toolName === 'keyboard') {
    if (typeof payload.text === 'string') {
      const r = await dy.call('insert_text', { text: payload.text });
      if (!r.ok) throw new Error(`insert_text failed: ${r.err ?? 'unknown'}`);
      return;
    }
    if (typeof payload.key === 'string') {
      const code = KEY_NAME_TO_HID_USAGE[payload.key.toLowerCase()];
      if (code == null) throw new Error(`unsupported key: ${payload.key}`);
      const r = await dy.call('hardware_key', { keyCode: code });
      if (!r.ok) throw new Error(`hardware_key failed: ${r.err ?? 'unknown'}`);
      return;
    }
    throw new Error('keyboard payload requires text or key');
  }
  throw new Error(`unsupported tool: ${toolName}`);
}

export async function tap(udid: string, x: number, y: number, holdSec?: number): Promise<void> {
  const { w, h } = await getScreenSize(udid);
  const nx = Math.max(0, Math.min(1, x / w));
  const ny = Math.max(0, Math.min(1, y / h));
  trace(
    `[hid-tap] px=(${x.toFixed(1)},${y.toFixed(1)}) norm=(${nx.toFixed(4)},${ny.toFixed(4)})${holdSec ? ` hold=${holdSec}s` : ''}`,
  );
  await callTool('gesture-tap', { udid, x: nx, y: ny, ...(holdSec ? { holdSec } : {}) }, [
    'run',
    'gesture-tap',
    '--udid',
    udid,
    '--x',
    String(nx),
    '--y',
    String(ny),
  ]);
}

export async function doubleTap(udid: string, x: number, y: number): Promise<void> {
  const { w, h } = await getScreenSize(udid);
  const nx = Math.max(0, Math.min(1, x / w));
  const ny = Math.max(0, Math.min(1, y / h));
  trace(
    `[hid-double-tap] px=(${x.toFixed(1)},${y.toFixed(1)}) norm=(${nx.toFixed(4)},${ny.toFixed(4)})`,
  );
  await callTool('gesture-tap', { udid, x: nx, y: ny, doubleTap: true }, []);
}

export const tapFast = tap;
export const tapPureFast = tap;
export const tapArgent = tap;

/**
 * Press: Down → ~50 ms hold → Up. Higher reliability for buttons
 * whose gesture-recogniser ignores 0 ms-gap taps as event-loop
 * glitches (Bluesky's "Go back" nav-header back-arrow). Costs ~30 ms
 * more per call than tap() but worth it on targets where the simpler
 * tap() doesn't reliably fire onPress.
 */
export async function press(udid: string, x: number, y: number): Promise<void> {
  const { w, h } = await getScreenSize(udid);
  const nx = Math.max(0, Math.min(1, x / w));
  const ny = Math.max(0, Math.min(1, y / h));
  trace(
    `[hid-press] px=(${x.toFixed(1)},${y.toFixed(1)}) norm=(${nx.toFixed(4)},${ny.toFixed(4)})`,
  );
  const events = [
    { type: 'Down' as const, x: nx, y: ny },
    { type: 'Up' as const, x: nx, y: ny, delayMs: 50 },
  ];
  await callTool('gesture-custom', { udid, events }, [
    'run',
    'gesture-custom',
    '--udid',
    udid,
    '--events-json',
    JSON.stringify(events),
  ]);
}

export async function swipe(
  udid: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  durationMs: number,
): Promise<void> {
  const { w, h } = await getScreenSize(udid);
  const fromX = Math.max(0, Math.min(1, x1 / w));
  const fromY = Math.max(0, Math.min(1, y1 / h));
  const toX = Math.max(0, Math.min(1, x2 / w));
  const toY = Math.max(0, Math.min(1, y2 / h));
  const dur = Math.max(50, durationMs || 250);
  trace(
    `[hid-swipe] from=(${x1.toFixed(0)},${y1.toFixed(0)}) to=(${x2.toFixed(0)},${y2.toFixed(0)}) dur=${dur}`,
  );
  await callTool('gesture-swipe', { udid, fromX, fromY, toX, toY, durationMs: dur }, [
    'run',
    'gesture-swipe',
    '--udid',
    udid,
    '--fromX',
    String(fromX),
    '--fromY',
    String(fromY),
    '--toX',
    String(toX),
    '--toY',
    String(toY),
    '--durationMs',
    String(dur),
  ]);
}

/**
 * Long-press-then-drag. Drag-to-sort list rows (e.g. RNGH
 * draggable-flatlist) only enter drag mode after a long-press
 * threshold — ~400 ms hold without motion. A plain swipe with
 * gesture-swipe distributes Move events from frame 1 onward, which
 * the recogniser interprets as a scroll, not a sort drag.
 *
 * Construct the gesture explicitly: Down at start, hold stationary
 * for `holdMs`, then interpolate Move events over `moveMs` to the
 * end coordinate, Up at end.
 */
export async function longPressDrag(
  udid: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  holdMs: number,
  moveMs: number,
): Promise<void> {
  const { w, h } = await getScreenSize(udid);
  const norm = (px: number, dim: number) => Math.max(0, Math.min(1, px / dim));
  const fromX = norm(x1, w);
  const fromY = norm(y1, h);
  const toX = norm(x2, w);
  const toY = norm(y2, h);
  trace(
    `[hid-long-drag] from=(${x1.toFixed(0)},${y1.toFixed(0)}) to=(${x2.toFixed(0)},${y2.toFixed(0)}) hold=${holdMs} move=${moveMs}`,
  );
  // Event sequence: Down → stationary Move stack (drives hold timer
  // without changing position) → keyframe Move sequence to target →
  // Up. interpolate inserts intermediate frames between adjacent
  // keyframes for a smooth glide.
  const events: {
    type: 'Down' | 'Move' | 'Up';
    x: number;
    y: number;
    delayMs?: number;
  }[] = [];
  events.push({ type: 'Down', x: fromX, y: fromY });
  // Hold stationary: emit Move events at the same point with
  // cumulative delays summing to holdMs. The recogniser sees the
  // touch held in place long enough to trip the long-press detector.
  const holdSlices = 4;
  for (let i = 0; i < holdSlices; i++) {
    events.push({ type: 'Move', x: fromX, y: fromY, delayMs: Math.round(holdMs / holdSlices) });
  }
  // Glide to target.
  const moveSlices = 8;
  for (let i = 1; i <= moveSlices; i++) {
    const t = i / moveSlices;
    events.push({
      type: 'Move',
      x: fromX + (toX - fromX) * t,
      y: fromY + (toY - fromY) * t,
      delayMs: Math.round(moveMs / moveSlices),
    });
  }
  events.push({ type: 'Up', x: toX, y: toY, delayMs: 80 });
  await callTool('gesture-custom', { udid, events, interpolate: 4 }, [
    'run',
    'gesture-custom',
    '--udid',
    udid,
    '--events-json',
    JSON.stringify(events),
    '--interpolate',
    '4',
  ]);
}

export async function typeText(udid: string, text: string): Promise<void> {
  trace(`[hid-keyboard] text=${JSON.stringify(text)}`);
  await callTool('keyboard', { udid, text }, ['run', 'keyboard', '--udid', udid, '--text', text]);
}

export async function pressKey(udid: string, keyName: string): Promise<void> {
  trace(`[hid-keyboard] key=${keyName}`);
  await callTool('keyboard', { udid, key: keyName }, [
    'run',
    'keyboard',
    '--udid',
    udid,
    '--key',
    keyName,
  ]);
}
