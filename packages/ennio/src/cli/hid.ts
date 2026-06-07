// Low-level gesture transport. Single home for the HID primitives
// and the mode-independent dylib ops (keyboard, AX queries). Holds NO
// mode state — mechanism choice (in-process vs HID) lives in
// driver/ (GestureDriver implementations), which compose these
// primitives.
//
// The dylib runs inside the target app (injected via DYLD_INSERT)
// and listens on a per-UDID Unix socket. EnnioConnection owns that
// socket and registers itself in
// core/active-connections so the helpers below can look up the right
// connection by UDID.
//
// All coordinates are window-space points; helpers normalise to the
// [0,1] space the actuator expects internally.

import { getActiveConnection } from './core/active-connections';
import { EnnioHidClient } from './ennio-hid';
import type { EnnioSocketClient } from './socket-client';

export function getDylibClient(udid: string): EnnioSocketClient {
  return getActiveConnection(udid).socket;
}

// Actuation backend: the in-house host helper (EnnioHidClient → the
// `enniohid` Swift process), which posts real touches into the
// simulator via CoreSimulator Indigo (SimulatorKit SimDeviceLegacyHID
// Client + a vendored MIT Indigo builder). No external daemon. (The
// earlier in-process IOHIDEvent injector — the dylib's hid_* ops — is
// dead: the simulator never dispatches in-process HID; see the trail
// in native-hid/helper/enniohid.swift's header.)
const ennioHidCache = new Map<string, EnnioHidClient>();

interface HidBackend {
  tap(x: number, y: number, holdSec?: number): Promise<void>;
  doubleTap(x: number, y: number): Promise<void>;
  swipe(x1: number, y1: number, x2: number, y2: number, durationSec: number): Promise<void>;
  typeText(text: string): Promise<void>;
}

export function getActuator(udid: string): HidBackend {
  let c = ennioHidCache.get(udid);
  if (!c) {
    c = new EnnioHidClient(udid);
    ennioHidCache.set(udid, c);
  }
  return c;
}

const screenSizeCache = new Map<string, { w: number; h: number }>();

export async function getScreenSize(udid: string): Promise<{ w: number; h: number }> {
  const cached = screenSizeCache.get(udid);
  if (cached) return cached;
  try {
    const c = getDylibClient(udid);
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

export function trace(line: string): void {
  // Gated: HID-level tap/swipe coords are noisy in normal verbose output.
  // Set ENNIO_PHASE_TRACE=1 to enable.
  if (process.env.ENNIO_PHASE_TRACE) process.stderr.write(`${line}\n`);
}

// =====================================================================
// HID primitives — every call dispatches a real IOHIDEvent through
// CoreSimulator. Same touch pipeline as a physical finger.
// =====================================================================

export async function tap(udid: string, x: number, y: number, holdSec?: number): Promise<void> {
  const { w, h } = await getScreenSize(udid);
  const cx = Math.max(0, Math.min(w, x));
  const cy = Math.max(0, Math.min(h, y));
  trace(`[hid] tap px=(${cx.toFixed(1)},${cy.toFixed(1)})${holdSec ? ` hold=${holdSec}s` : ''}`);
  await getActuator(udid).tap(cx, cy, holdSec ?? 0.08);
}

export async function doubleTap(udid: string, x: number, y: number): Promise<void> {
  const { w, h } = await getScreenSize(udid);
  const cx = Math.max(0, Math.min(w, x));
  const cy = Math.max(0, Math.min(h, y));
  trace(`[hid] double-tap px=(${cx.toFixed(1)},${cy.toFixed(1)})`);
  await getActuator(udid).doubleTap(cx, cy);
}

/**
 * Press: Down → ~50 ms hold → Up. Higher reliability for buttons
 * whose gesture-recogniser ignores 0 ms-gap taps as event-loop
 * glitches (Bluesky's "Go back" nav-header back-arrow). Costs ~30 ms
 * more per call than tap() but worth it on targets where the simpler
 * tap() doesn't reliably fire onPress.
 */
export async function press(udid: string, x: number, y: number): Promise<void> {
  const { w, h } = await getScreenSize(udid);
  const cx = Math.max(0, Math.min(w, x));
  const cy = Math.max(0, Math.min(h, y));
  trace(`[hid] press px=(${cx.toFixed(1)},${cy.toFixed(1)})`);
  await getActuator(udid).tap(cx, cy, 0.05);
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
  const clampX = (v: number) => Math.max(0, Math.min(w, v));
  const clampY = (v: number) => Math.max(0, Math.min(h, v));
  const dur = Math.max(50, durationMs || 250);
  trace(
    `[hid] swipe (${x1.toFixed(0)},${y1.toFixed(0)})→(${x2.toFixed(0)},${y2.toFixed(0)}) dur=${dur}`,
  );
  await getActuator(udid).swipe(clampX(x1), clampY(y1), clampX(x2), clampY(y2), dur / 1000);
}

/**
 * Long-press-then-drag. Drag-to-sort list rows (e.g. RNGH
 * draggable-flatlist) only enter drag mode after a long-press
 * threshold — ~400 ms hold without motion. A plain swipe distributes
 * Move events from frame 1 onward, which the recogniser interprets as
 * a scroll, not a sort drag.
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
  const clampX = (v: number) => Math.max(0, Math.min(w, v));
  const clampY = (v: number) => Math.max(0, Math.min(h, v));
  trace(
    `[hid] long-drag (${x1.toFixed(0)},${y1.toFixed(0)})→(${x2.toFixed(0)},${y2.toFixed(0)}) hold=${holdMs} move=${moveMs}`,
  );
  // One slow swipe whose duration covers hold + glide. (The legacy
  // event-sequence path also collapsed to a single swipe with the
  // summed delays — preserved byte-for-byte here.)
  await getActuator(udid).swipe(
    clampX(x1),
    clampY(y1),
    clampX(x2),
    clampY(y2),
    (holdMs + moveMs + 80) / 1000,
  );
}

// =====================================================================
// Mode-independent dylib ops
// =====================================================================

// USB HID usage codes the dylib's `hardware_key` op accepts. Mirror
// the switch in EnnioOps.pressHardwareKey.
const KEY_NAME_TO_HID_USAGE: Record<string, number> = {
  return: 40,
  enter: 40,
  delete: 42,
  backspace: 42,
  space: 44,
};

export async function typeText(udid: string, text: string): Promise<void> {
  trace(`[keyboard] text=${JSON.stringify(text)}`);
  const r = await getDylibClient(udid).call('insert_text', { text });
  if (!r.ok) throw new Error(`insert_text failed: ${r.err ?? 'unknown'}`);
}

export async function pressKey(udid: string, keyName: string): Promise<void> {
  trace(`[keyboard] key=${keyName}`);
  const code = KEY_NAME_TO_HID_USAGE[keyName.toLowerCase()];
  if (code == null) throw new Error(`unsupported key: ${keyName}`);
  const r = await getDylibClient(udid).call('hardware_key', { keyCode: code });
  if (!r.ok) throw new Error(`hardware_key failed: ${r.err ?? 'unknown'}`);
}

export interface AXMatchRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Cross-process AX rect lookup. Backed by the dylib's
 * `find_ax_by_text` op which walks the in-process UIAccessibility
 * tree from every window/scene. Returns a window-space rect.
 */
export async function axTreeSnapshot(udid: string): Promise<string> {
  const c = getDylibClient(udid);
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
  // Single dylib roundtrip — the in-process AX walk is already fast
  // (sub-millisecond). One short retry covers the case where the
  // target's frame is still mid-transition.
  const deadline = Date.now() + 1500;
  const c = getDylibClient(udid);
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

export async function getCachedScreenSize(udid: string): Promise<{ w: number; h: number }> {
  return getScreenSize(udid);
}
