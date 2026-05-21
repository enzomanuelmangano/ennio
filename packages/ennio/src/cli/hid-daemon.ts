// Persistent HID daemon client.
//
// Spawns hid-daemon.py once per session and dispatches taps / swipes /
// keys / text via stdin lines. Each call is one gRPC RTT to the
// already-warm idb_companion (~3-8 ms). Without the daemon, every tap
// shells `idb ui tap` which spawns python + builds a new gRPC channel
// (~250 ms). ~18 taps / flow × 245 ms saved = ~4.5 s / flow.
//
// Lifecycle:
//   - Lazy spawn on first call.
//   - One daemon per UDID; reused across the runner's lifetime.
//   - Cleanly exit on close() or process exit.
//
// Wire protocol — see hid-daemon.py header.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// idb's CLI is a shebang script — it bakes the exact python interpreter
// that has the `idb` module installed (typically /opt/homebrew/opt/
// python@3.13/bin/python3.13 on Apple Silicon brew). Generic `python3`
// in PATH almost never has fb-idb installed. Read the shebang line off
// the idb script so our daemon runs in the same interpreter.
function resolveIdbPython(): string {
  const candidates = ['/opt/homebrew/bin/idb', '/usr/local/bin/idb'];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const head = readFileSync(path, 'utf8').split('\n', 1)[0];
      if (head.startsWith('#!') && head.includes('python')) {
        return head.slice(2).trim();
      }
    } catch {
      /* try next */
    }
  }
  // Final fallback — `python3` from PATH. Will likely fail with
  // ModuleNotFoundError if fb-idb isn't installed there, and the
  // daemon spawn will reject. tapFast then drops to idb CLI subprocess.
  return 'python3';
}

interface PendingAck {
  resolve(): void;
  reject(e: Error): void;
}

let cachedDaemon: HidDaemon | null = null;
let cachedUdid: string | null = null;
let exitHookRegistered = false;

function findDaemonScript(): string {
  // The python script lives in src/cli/ in source form. Bundled CLI
  // sits in dist/cli.js; published package keeps src/cli/ alongside.
  const here = __dirname;
  const candidates = [
    join(here, 'hid-daemon.py'),                       // dev source layout
    join(here, '..', 'src', 'cli', 'hid-daemon.py'),   // dist/ + src/cli/
    join(here, '..', '..', 'src', 'cli', 'hid-daemon.py'),
    join(here, '..', '..', '..', 'src', 'cli', 'hid-daemon.py'),
    join(here, '..', '..', '..', 'packages', 'ennio', 'src', 'cli', 'hid-daemon.py'),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(`hid-daemon.py not found near ${here}`);
}

class HidDaemon {
  private proc: ChildProcessWithoutNullStreams;
  private buffer = '';
  private queue: PendingAck[] = [];
  private dead = false;

  constructor(public readonly udid: string) {
    const script = findDaemonScript();
    const python = resolveIdbPython();
    this.proc = spawn(python, [script, udid], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk.toString()));
    this.proc.stderr.on('data', (chunk: Buffer) => {
      if (process.env.ENNIO_DEBUG_HID)
        process.stderr.write(`[hid-daemon stderr] ${chunk.toString().trim()}\n`);
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

  /** Resolves when daemon prints `ready` (~150 ms — python import +
   *  gRPC channel build). */
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
      } else if (process.env.ENNIO_DEBUG_HID) {
        process.stderr.write(`[hid-daemon unexpected] ${line}\n`);
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
    return this.send(`tap ${Math.round(x)} ${Math.round(y)} ${durationMs}`);
  }

  swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number = 300): Promise<void> {
    return this.send(`swipe ${x1} ${y1} ${x2} ${y2} ${durationMs}`);
  }

  key(keyCode: number): Promise<void> {
    return this.send(`key ${keyCode}`);
  }

  keyRepeat(keyCode: number, count: number): Promise<void> {
    if (count <= 0) return Promise.resolve();
    return this.send(`keyrep ${keyCode} ${count}`);
  }

  text(text: string): Promise<void> {
    if (!text) return Promise.resolve();
    return this.send(`text ${JSON.stringify(text)}`);
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

/** Get-or-spawn the daemon for `udid`. First call blocks ~150 ms on
 *  python startup; subsequent calls return the cached instance. */
export async function getHidDaemon(udid: string): Promise<HidDaemon> {
  if (cachedDaemon && cachedUdid === udid && cachedDaemon.isAlive()) return cachedDaemon;
  if (cachedDaemon) {
    cachedDaemon.close();
    cachedDaemon = null;
  }
  registerExitHook();
  const d = new HidDaemon(udid);
  await d.ready();
  cachedDaemon = d;
  cachedUdid = udid;
  return d;
}

export type { HidDaemon };
