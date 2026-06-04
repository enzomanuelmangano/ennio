// In-house HID client — drop-in replacement for IdbGrpcClient's
// actuation surface (tap / doubleTap / swipe). Drives the `enniohid`
// host helper: a persistent Swift process that posts real touches into
// the simulator via CoreSimulator Indigo (SimulatorKit
// SimDeviceLegacyHIDClient + a vendored MIT Indigo message builder).
// Same mechanism idb uses, owned by us — no daemon, no fb-idb, no grpc.
//
// One helper process per UDID, spawned lazily, fed newline commands:
//   down <nx> <ny> | move <nx> <ny> | up <nx> <ny> | ping | quit
// Coordinates are normalized [0,1], top-left origin. Each command
// replies "ok\n". Coordinates IN to this client are window-space
// pixels (matching IdbGrpcClient); normalized here via screen size.

import { spawnSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { getScreenSize, trace } from './hid';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let cachedDeveloperDir: string | null = null;
function developerDir(): string {
  if (cachedDeveloperDir) return cachedDeveloperDir;
  try {
    cachedDeveloperDir = spawnSync('xcode-select', ['-p'], { encoding: 'utf8' }).stdout.trim();
  } catch {
    cachedDeveloperDir = '/Applications/Xcode.app/Contents/Developer';
  }
  return cachedDeveloperDir || '/Applications/Xcode.app/Contents/Developer';
}

/** Locate the prebuilt `enniohid` helper. Dev build first, then pkg. */
function findHelper(): string {
  const candidates = [
    process.env.ENNIO_HID_HELPER,
    '/tmp/ennio-build/enniohid',
    join(dirname(__dirname), 'prebuilt', 'enniohid'),
    join(dirname(__dirname), '..', 'prebuilt', 'enniohid'),
  ].filter(Boolean) as string[];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(
    'enniohid helper not found (looked in /tmp/ennio-build and prebuilt/). ' +
      'Set ENNIO_HID_HELPER or build native-hid/helper.',
  );
}

/** Owns one persistent enniohid child + a serialized command queue. */
class HelperProcess {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private buf = '';
  private waiters: ((line: string) => void)[] = [];

  constructor(private readonly udid: string) {}

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      const bin = findHelper();
      trace(`[enniohid] spawning helper ${bin} for ${this.udid}`);
      const proc = spawn(bin, [this.udid], {
        env: { ...process.env, DEVELOPER_DIR: developerDir() },
      });
      this.proc = proc;
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk: string) => this.onData(chunk));
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (d: string) => {
        if (process.env.ENNIO_PHASE_TRACE) process.stderr.write(`[enniohid] ${d}`);
      });
      proc.on('error', reject);
      proc.on('exit', (code) => {
        this.proc = null;
        this.ready = null;
        if (process.env.ENNIO_PHASE_TRACE)
          process.stderr.write(`[enniohid] helper exited ${code}\n`);
      });
      // First "ready" line resolves startup.
      this.waiters.push((line) => {
        if (line === 'ready') resolve();
        else reject(new Error(`enniohid unexpected first line: ${line}`));
      });
    });
    return this.ready;
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      const w = this.waiters.shift();
      if (w) w(line);
    }
  }

  /** Send one command, await its single-line reply. */
  async cmd(line: string): Promise<string> {
    await this.start();
    const proc = this.proc;
    if (!proc) throw new Error('enniohid helper not running');
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`enniohid timeout: ${line}`)), 5000);
      this.waiters.push((reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      proc.stdin.write(line + '\n');
    });
  }

  close(): void {
    if (this.proc) {
      try {
        this.proc.stdin.write('quit\n');
      } catch {
        /* ignore */
      }
      this.proc.kill();
      this.proc = null;
      this.ready = null;
    }
  }
}

const helpers = new Map<string, HelperProcess>();
function helperFor(udid: string): HelperProcess {
  let h = helpers.get(udid);
  if (!h) {
    h = new HelperProcess(udid);
    helpers.set(udid, h);
  }
  return h;
}

/** Stop every spawned helper (called on CLI teardown). */
export function shutdownEnnioHid(): void {
  for (const h of helpers.values()) h.close();
  helpers.clear();
}

// Never leave a helper process behind.
for (const sig of ['exit', 'SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => shutdownEnnioHid());
}

export class EnnioHidClient {
  private readonly h: HelperProcess;
  constructor(private readonly udid: string) {
    this.h = helperFor(udid);
  }

  private async norm(x: number, y: number): Promise<{ nx: number; ny: number }> {
    const { w, h } = await getScreenSize(this.udid);
    return {
      nx: Math.max(0, Math.min(1, x / w)),
      ny: Math.max(0, Math.min(1, y / h)),
    };
  }

  /** Single tap: Down → hold → Up at the same point. */
  async tap(x: number, y: number, holdSec = 0.05): Promise<void> {
    const { nx, ny } = await this.norm(x, y);
    trace(`[enniohid] tap n=(${nx.toFixed(4)},${ny.toFixed(4)}) hold=${holdSec}s`);
    await this.h.cmd(`down ${nx} ${ny}`);
    await sleep(Math.max(20, holdSec * 1000));
    await this.h.cmd(`up ${nx} ${ny}`);
  }

  /** Double tap with a tight gap (inside UITap's ~350ms window). */
  async doubleTap(x: number, y: number): Promise<void> {
    const { nx, ny } = await this.norm(x, y);
    trace(`[enniohid] double-tap n=(${nx.toFixed(4)},${ny.toFixed(4)})`);
    await this.h.cmd(`down ${nx} ${ny}`);
    await sleep(40);
    await this.h.cmd(`up ${nx} ${ny}`);
    await sleep(90);
    await this.h.cmd(`down ${nx} ${ny}`);
    await sleep(40);
    await this.h.cmd(`up ${nx} ${ny}`);
  }

  /** Swipe: Down, interpolated Moves over the duration, Up. */
  async swipe(x1: number, y1: number, x2: number, y2: number, durationSec: number): Promise<void> {
    const from = await this.norm(x1, y1);
    const to = await this.norm(x2, y2);
    const durMs = Math.max(50, durationSec * 1000);
    const steps = Math.max(8, Math.round(durMs / 16));
    const stepMs = durMs / steps;
    trace(
      `[enniohid] swipe n=(${from.nx.toFixed(4)},${from.ny.toFixed(4)})→(${to.nx.toFixed(4)},${to.ny.toFixed(4)}) dur=${durMs}`,
    );
    await this.h.cmd(`down ${from.nx} ${from.ny}`);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      await this.h.cmd(
        `move ${from.nx + (to.nx - from.nx) * t} ${from.ny + (to.ny - from.ny) * t}`,
      );
      await sleep(stepMs);
    }
    await this.h.cmd(`up ${to.nx} ${to.ny}`);
  }
}
