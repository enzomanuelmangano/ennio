/**
 * idb wrapper — out-of-process HID injection at the simulator's HID
 * layer. Real "finger on screen" tap, no xcodebuild cold-start, ~50ms
 * per action. Coordinates are in logical points (matches Fabric layout).
 */

import { execFile, execFileSync } from 'child_process';

function runCapture(args: string[], timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = execFile('idb', args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err); else resolve(String(stdout ?? ''));
    });
    proc.on('error', reject);
  });
}

let cachedUDID: string | null = null;
function getUDID(): string | null {
  if (process.env.ENNIO_UDID) return process.env.ENNIO_UDID;
  if (cachedUDID) return cachedUDID;
  // Auto-detect: pick the first booted iOS Simulator. Without `--udid`
  // idb picks "any companion", which is fine for one booted sim but
  // racy when multiple sims are booted (the wrong target receives the
  // touch and the runner times out). Cache the lookup so we don't
  // shell out per-call.
  try {
    const out = execFileSync('xcrun', ['simctl', 'list', 'devices', 'booted'], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    const match = out.match(/\(([0-9A-F-]{36})\) \(Booted\)/);
    if (match) {
      cachedUDID = match[1];
      return cachedUDID;
    }
  } catch { /* fall through */ }
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

/**
 * Out-of-process accessibility tap. Walks the simulator's whole-OS
 * accessibility tree (`idb ui describe-all`) and taps the centre of the
 * first element whose label / title matches `text`. Necessary for
 * UI that lives outside the app process — SpringBoard system alerts
 * (iOS 26's "Open in <App>?" deep-link confirmation), zeego UIMenu
 * items rendered out-of-process on iOS 18+, system pickers.
 *
 * Returns true on a successful tap, false otherwise.
 */
export async function tapByLabelOOP(text: string): Promise<boolean> {
  if (process.env.ENNIO_DEBUG_IDB) console.error(`[idb OOP] start lookup for '${text}'`);
  // Poll up to ~3s — system alerts (SpringBoard's deep-link confirmation,
  // privacy prompts, system pickers) often render after a brief delay.
  // Cheap to retry: each describe-all is ~200 ms.
  const deadline = Date.now() + 3000;
  let nodes: unknown = null;
  let attempts = 0;
  type Node = { AXLabel?: string; AXTitle?: string; AXValue?: string; frame?: { x: number; y: number; width: number; height: number } };
  const norm = (s: unknown) => (typeof s === 'string' ? s : '').trim();

  while (Date.now() < deadline) {
    attempts++;
    let raw = '';
    try {
      raw = await runCapture(['ui', 'describe-all', ...withUdid([])]);
      nodes = JSON.parse(raw);
    } catch (e) {
      if (process.env.ENNIO_DEBUG_IDB) console.error(`[idb OOP] attempt ${attempts}: ${e}`);
      nodes = null;
    }
    if (!Array.isArray(nodes)) {
      await new Promise((r) => setTimeout(r, 200));
      continue;
    }
    const found = (nodes as Node[]).some((n) =>
      !!n && (norm(n.AXLabel) === text || norm(n.AXTitle) === text || norm(n.AXValue) === text)
    );
    if (process.env.ENNIO_DEBUG_IDB) console.error(`[idb OOP] attempt ${attempts}: ${(nodes as unknown[]).length} nodes, found=${found}`);
    if (found) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!Array.isArray(nodes)) return false;

  let exact: Node | null = null;
  let partial: Node | null = null;
  for (const n of nodes as Node[]) {
    if (!n || typeof n !== 'object' || !n.frame || n.frame.width <= 0 || n.frame.height <= 0) continue;
    const candidates = [norm(n.AXLabel), norm(n.AXTitle), norm(n.AXValue)];
    for (const c of candidates) {
      if (!c) continue;
      if (c === text) { exact = n; break; }
      if (!partial && c.toLowerCase().includes(text.toLowerCase())) partial = n;
    }
    if (exact) break;
  }
  const hit = exact ?? partial;
  if (!hit || !hit.frame) return false;
  const cx = hit.frame.x + hit.frame.width / 2;
  const cy = hit.frame.y + hit.frame.height / 2;
  if (process.env.ENNIO_DEBUG_IDB) {
    console.error(`[idb OOP] '${text}' → (${cx},${cy}) match=${exact ? 'exact' : 'partial'}`);
  }
  await tap(cx, cy, 150);
  return true;
}
