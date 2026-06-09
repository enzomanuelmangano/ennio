/**
 * `ennio doctor` — pre-flight check of the testbed.
 *
 * Checks, grouped by severity:
 *   FAIL (blocks any run, exit 1):
 *     - Node ≥ 18           (the CLI's runtime floor)
 *     - Xcode / simctl      (simulator control)
 *     - enniohid helper     (in-house HID actuation backend)
 *     - libennio.dylib      (the injected in-app agent must ship/build)
 *   WARN (run can still proceed; exit stays 0):
 *     - Booted simulator    (ennio auto-boots one at test time if absent)
 *     - libennio socket     (only live once an injected app is running, so a
 *                            cold `doctor` legitimately shows it down)
 *
 * Every external command runs argv-style (execFileSync with an args array) —
 * never a string passed to a shell — so a UDID or path can't smuggle in shell
 * metacharacters.
 */

import { execFileSync } from 'child_process';

import type { Flags } from '../cli/args';
import { warmActuator } from '../hid';
import { selectPlatform } from '../platform';
import { EnnioSocketClient } from '../socket-client';
import { getTargetUdid as getBootedSimulatorId, findDylib, ensureBootedSim } from '../sim';

type Severity = 'pass' | 'warn' | 'fail';
type Result = { name: string; severity: Severity; detail: string };

/** Run a command argv-style; return trimmed stdout or null on any failure. */
function tryExec(cmd: string, args: string[], timeoutMs = 5000): string | null {
  try {
    return execFileSync(cmd, args, { stdio: 'pipe', timeout: timeoutMs, encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

function checkNode(): Result {
  const major = parseInt(process.versions.node.split('.')[0], 10) || 0;
  return {
    name: 'Node runtime',
    severity: major >= 18 ? 'pass' : 'fail',
    detail: major >= 18 ? `v${process.versions.node}` : `v${process.versions.node} — need ≥ 18`,
  };
}

function checkXcode(): Result {
  // `xcrun simctl help` proves both that the toolchain is selected and that
  // simctl is callable, without booting anything.
  const ok = tryExec('xcrun', ['simctl', 'help']) !== null;
  const ver = ok ? tryExec('xcodebuild', ['-version']) : null;
  return {
    name: 'Xcode / simctl',
    severity: ok ? 'pass' : 'fail',
    detail: ok
      ? (ver?.split('\n')[0] ?? 'simctl reachable')
      : 'not found — install Xcode and run `xcode-select --switch`',
  };
}

function checkHidHelper(): Result {
  // In-house HID actuation: the enniohid host helper (CoreSimulator
  const candidates = [process.env.ENNIO_HID_HELPER, '/tmp/ennio-build/enniohid'].filter(
    Boolean,
  ) as string[];
  const found = candidates.find((c) => {
    try {
      return tryExec('test', ['-x', c]) !== null;
    } catch {
      return false;
    }
  });
  // findDylib's package also ships prebuilt/enniohid; treat presence of
  // either dev or packaged binary as pass. Best-effort detail.
  if (found) return { name: 'enniohid (in-house HID)', severity: 'pass', detail: found };
  return {
    name: 'enniohid (in-house HID)',
    severity: 'warn',
    detail:
      'helper not found in /tmp/ennio-build or prebuilt/; built from native-hid/helper or shipped in the tarball',
  };
}

function checkDylib(): Result {
  const dylib = findDylib();
  return {
    name: 'libennio.dylib',
    severity: dylib ? 'pass' : 'fail',
    detail:
      dylib ?? 'not found — reinstall the package or build it (set ENNIO_DYLIB_PATH to override)',
  };
}

function checkSim(udid: string | null): Result {
  return {
    name: 'Booted simulator',
    severity: udid ? 'pass' : 'warn',
    detail: udid ? udid : 'none booted — ennio auto-boots one, or set ENNIO_UDID',
  };
}

async function checkSocket(): Promise<Result> {
  const client = new EnnioSocketClient();
  const up = await client.connect();
  if (!up) {
    return {
      name: 'libennio socket',
      severity: 'warn',
      detail:
        'not listening — only live while an injected app is running (normal for a cold check)',
    };
  }
  try {
    const r = await client.call('ping');
    const bootstrap =
      r.ok && r.data ? (r.data as { bootstrap?: string }).bootstrap || 'unknown' : 'unknown';
    return {
      name: 'libennio socket',
      severity: 'pass',
      detail: `connected, bootstrap=${bootstrap}`,
    };
  } catch (e) {
    return {
      name: 'libennio socket',
      severity: 'warn',
      detail: `connected but ping failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  } finally {
    client.close();
  }
}

/**
 * `ennio doctor --smoke <bundleId>` — the end-to-end self-test. Where the
 * static checks confirm the *pieces* are present, this proves the whole
 * chain actually works on this machine + this app: inject the dylib, bring
 * the socket up to bootstrap-ready, read the in-process view tree, and warm
 * the HID actuator. If this passes, a real run will work; if it fails, it
 * fails here with an actionable message instead of mid-flow.
 */
const tag: Record<Severity, string> = { pass: '[PASS]', warn: '[WARN]', fail: '[FAIL]' };

/** Print one result line the instant it's known — streaming, so a hang in
 *  the next step is visible instead of a silent wait. */
function emit(r: Result): Result {
  console.log(`${tag[r.severity]} ${r.name.padEnd(22)} ${r.detail}`);
  return r;
}

/** Bound any step so the smoke ALWAYS reaches a verdict — never hangs.
 *  Rejects with a labelled timeout past `ms`. */
function deadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

async function runSmoke(bundleId: string, platformName: 'ios' | 'android'): Promise<number> {
  const results: Result[] = [];
  const rec = (r: Result): void => {
    results.push(emit(r));
  };

  rec(checkDylib());
  const udid = getBootedSimulatorId() ?? ensureBootedSim();
  rec(checkSim(udid));
  if (!udid) {
    console.log('\n✗ No simulator available — boot one (or set ENNIO_UDID) and retry.');
    return 1;
  }

  const platform = selectPlatform(platformName);
  let connection: { socket: EnnioSocketClient; close(): void } | null = null;
  try {
    // Hard ceiling: injection + socket bootstrap must complete in 30s. A
    // Release build (dylib refuses) or a wedged launch ends here with a
    // verdict, never a silent hang.
    const opened = await deadline(
      platform.connect({ udid, bundleId, dylibPath: process.env.ENNIO_DYLIB_PATH || null }),
      30_000,
      'inject + socket',
    );
    connection = opened.connection;
    rec({ name: 'inject + socket', severity: 'pass', detail: 'dylib loaded, bootstrap ready' });
  } catch (e) {
    rec({
      name: 'inject + socket',
      severity: 'fail',
      detail: e instanceof Error ? e.message.split('\n')[0] : String(e),
    });
    console.log(`\n✗ Could not bring up the in-app agent for ${bundleId}. Most common causes:`);
    console.log('  - the app is not a Debug/dev build (the dylib refuses Release/App Store builds)');
    console.log('  - the bundle id is wrong, or the app is not installed on this simulator');
    console.log('  - an unsupported iOS/RN combination — see the issue tracker');
    return 1;
  }

  try {
    const views = await deadline(connection.socket.call('dump_views'), 8_000, 'dump_views').catch(
      (e: unknown) => ({ ok: false, err: e instanceof Error ? e.message : String(e), data: [] }),
    );
    const n = Array.isArray(views.data) ? views.data.length : 0;
    rec({
      name: 'in-process read',
      severity: views.ok && n > 0 ? 'pass' : 'warn',
      detail: views.ok ? `dump_views returned ${n} elements` : `dump_views failed: ${views.err}`,
    });

    const size = await deadline(connection.socket.call('window_size'), 8_000, 'window_size').catch(
      () => ({ ok: false, data: null }),
    );
    rec({
      name: 'screen geometry',
      severity: size.ok ? 'pass' : 'warn',
      detail: size.ok ? JSON.stringify(size.data) : 'window_size failed',
    });

    try {
      await deadline(warmActuator(udid), 10_000, 'HID actuator');
      rec({ name: 'HID actuator', severity: 'pass', detail: 'enniohid responded' });
    } catch (e) {
      rec({
        name: 'HID actuator',
        severity: 'fail',
        detail: `enniohid did not respond: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  } finally {
    connection.close();
  }

  if (results.some((r) => r.severity === 'fail')) {
    console.log('\n✗ Blocking issue(s) above — ennio will not work reliably here yet.');
    return 1;
  }
  console.log('\n✓ End-to-end smoke passed — inject, read, and actuate all work on this machine.');
  return 0;
}

export async function runDoctorCommand(positional: string[], flags: Flags): Promise<number> {
  if (flags.smoke) {
    const bundleId = positional[0] || process.env.ENNIO_BUNDLE_ID;
    if (!bundleId) {
      console.error('Usage: ennio doctor --smoke <bundleId>');
      console.error('  Runs an end-to-end self-test (inject → read → actuate) against the app.');
      return 1;
    }
    const platformName =
      flags.android || process.env.ENNIO_PLATFORM === 'android' ? 'android' : 'ios';
    return runSmoke(bundleId, platformName);
  }

  const udid = getBootedSimulatorId();

  const results: Result[] = [
    checkNode(),
    checkXcode(),
    checkHidHelper(),
    checkDylib(),
    checkSim(udid),
    await checkSocket(),
  ];

  const tag: Record<Severity, string> = { pass: '[PASS]', warn: '[WARN]', fail: '[FAIL]' };
  for (const r of results) {
    console.log(`${tag[r.severity]} ${r.name.padEnd(22)} ${r.detail}`);
  }

  const failed = results.filter((r) => r.severity === 'fail');
  if (failed.length > 0) {
    console.log('');
    console.log(`✗ ${failed.length} blocking issue(s) — fix the [FAIL] rows above before running.`);
    console.log('  If a row looks wrong rather than a local setup problem, please report it:');
    console.log('  https://github.com/enzomanuelmangano/ennio/issues/new?template=bug_report.yml');
    return 1;
  }
  console.log('');
  console.log('✓ Environment looks good.');
  return 0;
}
