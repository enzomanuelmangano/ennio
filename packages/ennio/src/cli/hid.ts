/**
 * Persistent HID daemon client.
 *
 * Spawns `hid-daemon.py` once per session, keeps it alive on stdin/
 * stdout, and dispatches taps/swipes through it. Each call costs a
 * single gRPC RTT to the already-warm idb_companion (~3-8 ms) instead
 * of the ~250 ms python startup tax `idb ui tap` pays per call. ~30
 * taps/flow × ~250 ms saved each = ~7 s/flow.
 *
 * Lifecycle:
 *   - Lazy spawn on first `tap` / `swipe` call.
 *   - One daemon per UDID; reused across the runner's lifetime.
 *   - Cleanly exit on `close()` or process exit (we register a
 *     `process.on('exit')` hook so a crashed Ennio doesn't orphan it).
 *
 * Falls back to throwing on daemon startup failure — callers can drop
 * down to `idb` (python CLI, slower but always available) on error.
 */

import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'child_process';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

interface PendingAck {
  resolve: () => void;
  reject: (e: Error) => void;
}

let cachedDaemon: HidDaemon | null = null;
let exitHookRegistered = false;

function findDaemonScript(): string {
  // dist/cli.js is bundled by esbuild; the python script lives in
  // src/cli/ relative to the package root. Resolve relative to this
  // file's location at runtime — works when developing (TS via tsx)
  // and when published (lib/ + dist/ + src/cli/hid-daemon.py).
  // esbuild inlines `__dirname` so we can rely on it at runtime.
  const here =
    typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'hid-daemon.py'), // dev: src/cli/
    join(here, '..', 'src', 'cli', 'hid-daemon.py'),
    join(here, '..', '..', 'src', 'cli', 'hid-daemon.py'),
    join(here, '..', '..', '..', 'src', 'cli', 'hid-daemon.py'),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(`hid-daemon.py not found near ${here}`);
}

class HidDaemon {
  private proc: ChildProcessWithoutNullStreams;
  private buffer = '';
  private queue: PendingAck[] = [];
  private dead = false;

  constructor(public udid: string) {
    const script = findDaemonScript();
    this.proc = spawn('python3', [script, udid], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk.toString()));
    this.proc.stderr.on('data', (chunk: Buffer) => {
      if (process.env.ENNIO_DEBUG_IDB)
        console.error(`[hid-daemon stderr] ${chunk.toString().trim()}`);
    });
    this.proc.on('exit', (code) => {
      this.dead = true;
      const err = new Error(`hid-daemon exited (code=${code})`);
      while (this.queue.length) this.queue.shift()!.reject(err);
    });
    this.proc.on('error', (e) => {
      this.dead = true;
      while (this.queue.length) this.queue.shift()!.reject(e);
    });
  }

  /** Resolve once the daemon prints `ready` on stdout. Spawn → ready
   *  ~150 ms (python import + grpc channel setup). */
  ready(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject });
    });
  }

  private onStdout(text: string) {
    this.buffer += text;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line === 'ready' || line === 'ok') {
        const handler = this.queue.shift();
        if (handler) handler.resolve();
      } else if (line.startsWith('err ')) {
        const handler = this.queue.shift();
        if (handler) handler.reject(new Error(line.slice(4)));
      } else if (process.env.ENNIO_DEBUG_IDB) {
        console.error(`[hid-daemon unexpected] ${line}`);
      }
    }
  }

  private send(cmd: string): Promise<void> {
    if (this.dead) return Promise.reject(new Error('hid-daemon dead'));
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject });
      this.proc.stdin.write(cmd + '\n');
    });
  }

  tap(x: number, y: number, durationMs: number = 80): Promise<void> {
    return this.send(`tap ${x} ${y} ${durationMs}`);
  }

  swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number = 300): Promise<void> {
    return this.send(`swipe ${x1} ${y1} ${x2} ${y2} ${durationMs}`);
  }

  close(): void {
    if (this.dead) return;
    try {
      this.proc.stdin.write('exit\n');
      this.proc.stdin.end();
    } catch {
      /* daemon already gone */
    }
  }

  isAlive(): boolean {
    return !this.dead;
  }
}

function registerExitHook() {
  if (exitHookRegistered) return;
  exitHookRegistered = true;
  const cleanup = () => {
    if (cachedDaemon) {
      cachedDaemon.close();
      cachedDaemon = null;
    }
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(143);
  });
}

let cachedUDID: string | null = null;
function getUDID(): string | null {
  if (process.env.ENNIO_UDID) return process.env.ENNIO_UDID;
  if (cachedUDID) return cachedUDID;
  try {
    const out = execFileSync('xcrun', ['simctl', 'list', 'devices', 'booted'], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    const m = out.match(/\(([0-9A-F-]{36})\) \(Booted\)/);
    if (m) {
      cachedUDID = m[1];
      return cachedUDID;
    }
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Get (or lazily start) the daemon for the booted simulator. First
 * call blocks ~150 ms on python startup; subsequent calls return the
 * cached instance instantly. Throws if no UDID is available or the
 * daemon failed to start — callers may fall back to spawning `idb`
 * per call.
 */
export async function getHidDaemon(): Promise<HidDaemon> {
  if (cachedDaemon && cachedDaemon.isAlive()) return cachedDaemon;
  const udid = getUDID();
  if (!udid) throw new Error('No booted simulator UDID');
  registerExitHook();
  const d = new HidDaemon(udid);
  await d.ready();
  cachedDaemon = d;
  return d;
}

export async function tap(x: number, y: number, durationMs: number = 80): Promise<void> {
  const d = await getHidDaemon();
  await d.tap(x, y, durationMs);
}

export async function swipe(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  durationMs: number = 300,
): Promise<void> {
  const d = await getHidDaemon();
  await d.swipe(x1, y1, x2, y2, durationMs);
}

export async function ensureCompanion(): Promise<void> {
  // Idempotent — the python daemon detects missing socket and exits
  // with code 3. Caller should run `idb connect <UDID>` once before
  // session start if needed. We don't shell out here on the hot path.
}
