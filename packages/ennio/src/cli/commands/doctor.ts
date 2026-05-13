/**
 * `ennio doctor` — diagnose the testbed.
 *
 * Checks, in order:
 *   1. Booted iOS simulator (or ENNIO_UDID)
 *   2. idb_companion connected (used for HID actuation + a11y fallbacks)
 *   3. Hermes Inspector reachable (Metro on :8081, app exposes JS context)
 *
 * Each check prints `[PASS]` / `[FAIL]` + a one-line cause. Exit code is
 * 0 only when every check passes.
 */

import { execSync } from 'child_process';
import { getBootedSimulatorId } from '../maestro-runner';
import { tryConnection } from '../cli/bootstrap';
import type { Flags } from '../cli/args';

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

  const client = await tryConnection();
  results.push({
    name: 'Hermes Inspector',
    ok: !!client,
    detail: client
      ? 'connected'
      : 'no JS context — launch the app, confirm Metro is running + ennio wired (ENNIO_ENABLED=1)',
  });
  if (client) client.disconnect();

  for (const r of results) {
    const tag = r.ok ? '[PASS]' : '[FAIL]';
    console.log(`${tag} ${r.name.padEnd(22)} ${r.detail}`);
  }
  return results.every((r) => r.ok) ? 0 : 1;
}
