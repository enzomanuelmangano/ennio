/**
 * `ennio doctor` — diagnose the testbed.
 *
 * Checks, in order:
 *   1. Booted iOS simulator (or ENNIO_UDID)
 *   2. idb_companion connected (used for HID actuation in Phase 1)
 *   3. libennio.dylib socket reachable at /tmp/ennio-control.sock
 *      (the in-app dylib listener — bootstrap-ready iff a real iOS app
 *      launched it via SIMCTL_CHILD_DYLD_INSERT_LIBRARIES or Pod link)
 */

import { execSync } from 'child_process';

import type { Flags } from '../cli/args';
import { EnnioSocketClient } from '../socket-client';
import { getTargetUdid as getBootedSimulatorId } from '../sim';

type Result = { name: string; ok: boolean; detail: string };

export async function runDoctorCommand(_positional: string[], _flags: Flags): Promise<number> {
  const results: Result[] = [];

  const udid = getBootedSimulatorId();
  results.push({
    name: 'Booted simulator',
    ok: !!udid,
    detail: udid ? udid : 'none — boot one with `xcrun simctl boot <UDID>` or set ENNIO_UDID',
  });

  let idbOk = false;
  let idbDetail = 'idb not on PATH';
  try {
    execSync('which idb', { stdio: 'pipe' });
    if (udid) {
      try {
        execSync(`idb --udid ${udid} list-targets`, { stdio: 'pipe', timeout: 5000 });
        idbOk = true;
        idbDetail = 'reachable';
      } catch {
        idbDetail = 'connect with `idb connect <UDID>`';
      }
    } else {
      idbDetail = 'no booted sim — skipping';
    }
  } catch {
    /* idb missing */
  }
  results.push({ name: 'idb_companion', ok: idbOk, detail: idbDetail });

  const client = new EnnioSocketClient();
  const socketUp = await client.connect();
  let socketDetail = 'not listening — launch the target app with libennio injected';
  if (socketUp) {
    try {
      const r = await client.call('ping');
      const bootstrap =
        r.ok && r.data ? (r.data as { bootstrap?: string }).bootstrap || 'unknown' : 'unknown';
      socketDetail = `connected, bootstrap=${bootstrap}`;
    } catch (e) {
      socketDetail = `connected but ping failed: ${e instanceof Error ? e.message : String(e)}`;
    }
    client.close();
  }
  results.push({ name: 'libennio socket', ok: socketUp, detail: socketDetail });

  for (const r of results) {
    const tag = r.ok ? '[PASS]' : '[FAIL]';
    console.log(`${tag} ${r.name.padEnd(22)} ${r.detail}`);
  }
  return results.every((r) => r.ok) ? 0 : 1;
}
