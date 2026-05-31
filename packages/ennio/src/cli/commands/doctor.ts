/**
 * `ennio doctor` — pre-flight check of the testbed.
 *
 * Checks, grouped by severity:
 *   FAIL (blocks any run, exit 1):
 *     - Node ≥ 18           (the CLI's runtime floor)
 *     - Xcode / simctl      (simulator control)
 *     - idb on PATH         (HID actuation backend)
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
import { EnnioSocketClient } from '../socket-client';
import { getTargetUdid as getBootedSimulatorId, findDylib } from '../sim';

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

function checkIdb(udid: string | null): Result {
  const path = tryExec('which', ['idb']);
  if (!path) {
    return {
      name: 'idb',
      severity: 'fail',
      detail:
        'not on PATH — install with `brew tap facebook/fb && brew install idb-companion` + `pipx install fb-idb`',
    };
  }
  // idb is present → actuation backend exists. Target reachability is
  // best-effort detail only: the companion spawns lazily at first HID event,
  // so a "no targets yet" here is NOT a failure (the old check false-negatived
  // exactly here). `idb list-targets` takes no udid, so nothing to inject.
  const targets = tryExec('idb', ['list-targets'], 5000);
  let detail = 'on PATH';
  if (targets !== null && udid) {
    detail = targets.includes(udid)
      ? `on PATH; target ${udid} visible`
      : 'on PATH; target not yet connected (auto-connects at run)';
  }
  return { name: 'idb', severity: 'pass', detail };
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

export async function runDoctorCommand(_positional: string[], _flags: Flags): Promise<number> {
  const udid = getBootedSimulatorId();

  const results: Result[] = [
    checkNode(),
    checkXcode(),
    checkIdb(udid),
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
    return 1;
  }
  console.log('');
  console.log('✓ Environment looks good.');
  return 0;
}
