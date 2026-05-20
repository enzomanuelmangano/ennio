// HID actuation via idb CLI shell-out.
//
// Phase 1 design: keep idb_companion + idb CLI as the HID driver. Each
// tap shells out to `idb ui tap`. Latency is ~250ms per tap (subprocess
// spawn dominates) — acceptable for v0.1 smoke + first real flows.
// Phase 2 will replace this with a SimulatorKit-based helper for
// ~50µs/tap, drop the brew + pip deps.
//
// Coords come from the dylib via socket find_by_testid / find_by_text;
// this module just converts them into idb invocations.

import { execFileSync } from 'node:child_process';

function idb(args: string[]): void {
  execFileSync('idb', args, { stdio: 'pipe' });
}

/**
 * Tap at window-space point (x, y). Pass the simulator UDID via --udid
 * so idb_companion targets the right device.
 */
export function tap(udid: string, x: number, y: number): void {
  // idb accepts ints only. Round to nearest pixel — UIKit hit-test is
  // tolerant of ~1pt offsets.
  //
  // Default --duration 0.1s. Without an explicit duration, idb's tap
  // is essentially instantaneous — touchDown and touchUp at the same
  // mach_absolute_time. React Native Gesture Handler's BaseButton +
  // PressableScale + RNGH's TapGestureRecognizer all need a measurable
  // gap between begin/end to advance their state machine. 0.1s reliably
  // crosses the threshold without making sequential taps feel slow.
  idb([
    'ui',
    'tap',
    '--udid',
    udid,
    '--duration',
    '0.1',
    String(Math.round(x)),
    String(Math.round(y)),
  ]);
}

/**
 * Press a single key by HID keycode. Used for hardware-key sequences
 * the dylib's hardware_key handler doesn't model (mostly: arrow keys,
 * tab, escape).
 */
export function pressKey(udid: string, hidCode: number): void {
  idb(['ui', 'key', '--udid', udid, String(hidCode)]);
}

/**
 * Type a literal string via the host keyboard. idb forwards each char
 * as a keystroke through the sim's hardware-keyboard layer.
 */
export function typeText(udid: string, text: string): void {
  idb(['ui', 'text', '--udid', udid, text]);
}

/**
 * Synthesised swipe from (x1,y1) to (x2,y2) over durationMs.
 */
export function swipe(
  udid: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  durationMs: number,
): void {
  // idb ui swipe takes seconds. Default 0.25s if duration omitted.
  const seconds = durationMs > 0 ? (durationMs / 1000).toFixed(3) : '0.25';
  idb([
    'ui',
    'swipe',
    '--udid',
    udid,
    '--duration',
    seconds,
    String(Math.round(x1)),
    String(Math.round(y1)),
    String(Math.round(x2)),
    String(Math.round(y2)),
  ]);
}
