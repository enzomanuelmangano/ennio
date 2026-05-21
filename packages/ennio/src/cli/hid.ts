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

import { getHidDaemon } from './hid-daemon';
import { getIdbClient } from './idb-grpc';

function idb(args: string[]): void {
  execFileSync('idb', args, { stdio: 'pipe' });
}

/**
 * Fast async tap via persistent gRPC stream to idb_companion. Avoids
 * the ~250 ms Python subprocess spawn that `idb ui tap` pays per tap
 * — the stream stays open for the CLI lifetime so each tap is one
 * gRPC roundtrip (~30-50 ms wall).
 *
 * Falls back to the sync idb CLI path if the gRPC client errors.
 */
export async function tapFast(
  udid: string,
  x: number,
  y: number,
  durationSec: number = 0.15,
): Promise<void> {
  // Persistent hid-daemon.py: one-time ~150 ms spawn cost, then each
  // tap is ~3-8 ms (gRPC RTT to already-warm idb_companion). Beats
  // both the per-tap CLI subprocess (~250 ms) and our broken
  // bidi-stream gRPC client. Falls back to idb CLI if the daemon
  // can't start (python missing, idb_companion socket absent, etc.) —
  // correctness over speed.
  try {
    const d = await getHidDaemon(udid);
    await d.tap(x, y, Math.round(durationSec * 1000));
    return;
  } catch (err) {
    process.stderr.write(`[ennio] hid-daemon fallback to CLI: ${String(err)}\n`);
  }
  void getIdbClient;
  idb([
    'ui',
    'tap',
    '--udid',
    udid,
    '--duration',
    String(durationSec),
    String(Math.round(x)),
    String(Math.round(y)),
  ]);
}

/**
 * Tap at window-space point (x, y). Pass the simulator UDID via --udid
 * so idb_companion targets the right device.
 */
export function tap(udid: string, x: number, y: number, durationSec: number = 0.2): void {
  // idb accepts ints only. Round to nearest pixel — UIKit hit-test is
  // tolerant of ~1pt offsets.
  //
  // Default --duration 0.15s. Without an explicit duration, idb's tap
  // is essentially instantaneous — touchDown and touchUp at the same
  // mach_absolute_time. React Native Gesture Handler's BaseButton +
  // PressableScale + RNGH's TapGestureRecognizer all need a measurable
  // gap between begin/end to advance their state machine. 0.1s passes
  // most controls but iOS-26 sim list-item Pressables (FlashList rows,
  // gauntlet tiles) reject the tap; 0.15s clears them consistently
  // without making sequential taps feel slow.
  idb([
    'ui',
    'tap',
    '--udid',
    udid,
    '--duration',
    String(durationSec),
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
