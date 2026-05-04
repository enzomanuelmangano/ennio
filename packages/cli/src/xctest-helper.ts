/**
 * Ennio XCTest Helper Lifecycle
 *
 * Spawns the bundled EnnioXCTestRunner.xctest helper via
 * `xcodebuild test-without-building` and waits for it to bind the TCP
 * action port (9877). Reuses an already-running helper if the port is
 * already bound — avoids paying the XCTest cold-start cost on every CLI
 * invocation while iterating.
 *
 * Requires `xcodebuild build-for-testing -scheme EnnioXCTestRunner` to
 * have been run once for the user's workspace. The expo-plugin handles
 * scheme registration; the prebuild step is a one-shot per workspace.
 */

import { spawn, execSync, type ChildProcess } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { resolve, join } from 'path';
import { Socket } from 'node:net';

const HELPER_PORT = 9877;
const SCHEME = 'EnnioXCTestRunner';
const TEST_TARGET = 'EnnioXCTestRunner/EnnioActionsTest/test_runActionServer';

export interface HelperHandle {
  port: number;
  proc: ChildProcess | null;
  preExisting: boolean;
  daemonized?: boolean;
}

export async function isPortBound(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((res) => {
    const s = new Socket();
    let settled = false;
    const finish = (v: boolean) => {
      if (settled) return;
      settled = true;
      s.destroy();
      res(v);
    };
    s.once('connect', () => finish(true));
    s.once('error', () => finish(false));
    s.connect(port, host);
  });
}

export const HELPER_TCP_PORT = HELPER_PORT;

function findWorkspace(): string {
  if (process.env.ENNIO_XCWORKSPACE) return process.env.ENNIO_XCWORKSPACE;
  const candidates = ['example/ios', 'ios'];
  for (const dir of candidates) {
    const full = resolve(dir);
    if (existsSync(full)) {
      const ws = readdirSync(full).find((f) => f.endsWith('.xcworkspace'));
      if (ws) return join(full, ws);
    }
  }
  throw new Error('xctest-helper: no .xcworkspace found (set ENNIO_XCWORKSPACE)');
}

function getUDID(): string {
  if (process.env.ENNIO_UDID) return process.env.ENNIO_UDID;
  const out = execSync('xcrun simctl list devices booted -j', { encoding: 'utf-8' });
  const data = JSON.parse(out);
  for (const arr of Object.values(data.devices) as Array<Array<{ udid: string; state: string }>>) {
    for (const d of arr) {
      if (d.state === 'Booted') return d.udid;
    }
  }
  throw new Error('xctest-helper: no booted iOS simulator');
}

function getBundleId(): string {
  return process.env.ENNIO_BUNDLE_ID ?? 'com.ennio.example';
}

export async function launchHelper(opts: { verbose?: boolean; detach?: boolean } = {}): Promise<HelperHandle> {
  const verbose = opts.verbose ?? false;
  const detach = opts.detach ?? false;
  if (await isPortBound(HELPER_PORT)) {
    if (verbose) console.log(`(xctest-helper: already running on :${HELPER_PORT})`);
    return { port: HELPER_PORT, proc: null, preExisting: true };
  }

  const ws = findWorkspace();
  const udid = getUDID();
  const bundleId = getBundleId();
  const args = [
    'test-without-building',
    '-workspace', ws,
    '-scheme', SCHEME,
    '-destination', `id=${udid}`,
    `-only-testing:${TEST_TARGET}`,
  ];
  const env = {
    ...process.env,
    ENNIO_BUNDLE_ID: bundleId,
    ENNIO_XCTEST_PORT: String(HELPER_PORT),
  };
  if (verbose) console.log(`(xctest-helper: spawning xcodebuild ${args.join(' ')})`);
  const proc = spawn('xcodebuild', args, {
    env,
    // Detached daemon: own session group + ignore stdio so the helper
    // outlives the spawning CLI and tail-runs without blocking.
    stdio: detach ? 'ignore' : (verbose ? 'inherit' : 'ignore'),
    detached: detach,
  });
  if (detach) proc.unref();

  const start = Date.now();
  const TIMEOUT_MS = 60_000;
  while (Date.now() - start < TIMEOUT_MS) {
    if (proc.exitCode !== null) {
      throw new Error(`xctest-helper: xcodebuild exited early (code=${proc.exitCode})`);
    }
    if (await isPortBound(HELPER_PORT)) {
      if (verbose) console.log(`(xctest-helper: bound :${HELPER_PORT} after ${Date.now() - start}ms)`);
      return { port: HELPER_PORT, proc, preExisting: false, daemonized: detach };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  try { proc.kill('SIGTERM'); } catch { /* noop */ }
  throw new Error(`xctest-helper: timed out waiting for TCP :${HELPER_PORT} to bind`);
}

/**
 * Find and SIGTERM any xcodebuild test process bound to HELPER_PORT.
 * Used by `ennio stop` to take down a daemonized helper from a
 * different CLI invocation. Returns the killed PIDs (empty if none).
 */
export function killHelperDaemon(): number[] {
  const killed: number[] = [];
  try {
    // lsof -t prints PIDs only.
    const out = execSync(`lsof -nP -tiTCP:${HELPER_PORT} 2>/dev/null || true`, { encoding: 'utf-8' });
    const pids = out.split(/\s+/).map((s) => parseInt(s, 10)).filter((n) => Number.isFinite(n) && n > 0);
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGTERM');
        killed.push(pid);
      } catch { /* already gone */ }
    }
  } catch { /* lsof not available; nothing to do */ }
  return killed;
}

export async function teardownHelper(h: HelperHandle): Promise<void> {
  if (!h.proc || h.preExisting || h.daemonized) return;
  if (h.proc.exitCode !== null) return;
  // After the helper receives `quit`, xcodebuild's test session finishes
  // gracefully and the process exits on its own. SIGTERM during that
  // window can crash the simulator session and leave it shutdown. Wait
  // up to 10s for natural exit; only force-kill if it hangs.
  const proc = h.proc;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (proc.exitCode === null) {
        try { proc.kill('SIGTERM'); } catch { /* noop */ }
      }
      resolve();
    }, 10_000);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
