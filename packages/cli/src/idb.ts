/**
 * idb wrapper — out-of-process HID injection at the simulator's HID
 * layer. Real "finger on screen" tap, no xcodebuild cold-start, ~50ms
 * per action. Coordinates are in logical points (matches Fabric layout).
 */

import { execFile } from 'child_process';

function getUDID(): string | null {
  if (process.env.ENNIO_UDID) return process.env.ENNIO_UDID;
  return null;
}

function run(args: string[], timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = execFile('idb', args, { timeout: timeoutMs }, (err) => {
      if (err) reject(err); else resolve();
    });
    proc.on('error', reject);
  });
}

function withUdid(args: string[]): string[] {
  const udid = getUDID();
  return udid ? ['--udid', udid, ...args] : args;
}

export async function ensureCompanion(): Promise<void> {
  const udid = getUDID();
  if (!udid) return;
  // Best-effort: connect (fast no-op if already connected).
  try {
    await run(['connect', udid], 5_000);
  } catch { /* ignore — companion may already be up */ }
}

export async function tap(x: number, y: number, durationMs?: number): Promise<void> {
  const args = ['ui', 'tap'];
  if (durationMs !== undefined) args.push('--duration', String(durationMs / 1000));
  args.push(...withUdid([String(Math.round(x)), String(Math.round(y))]));
  if (process.env.ENNIO_DEBUG_IDB) console.error(`[idb tap] x=${x} y=${y}`);
  await run(args);
}

export async function swipe(
  x1: number, y1: number,
  x2: number, y2: number,
  durationMs?: number
): Promise<void> {
  const args = ['ui', 'swipe'];
  if (durationMs !== undefined) args.push('--duration', String(durationMs / 1000));
  args.push(...withUdid([
    String(Math.round(x1)), String(Math.round(y1)),
    String(Math.round(x2)), String(Math.round(y2)),
  ]));
  await run(args);
}

export async function typeText(text: string): Promise<void> {
  await run(['ui', 'text', ...withUdid([text])]);
}

export async function pressKey(keyCode: number): Promise<void> {
  await run(['ui', 'key', ...withUdid([String(keyCode)])]);
}
