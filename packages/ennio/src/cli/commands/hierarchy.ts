/**
 * `ennio hierarchy` — dump the on-screen accessibility tree.
 *
 * Source: `idb ui describe-all` (OS-wide a11y, not Fabric-internal). This
 * matches what's reachable to selectors — testID maps to
 * accessibilityIdentifier, so anything visible here is targetable from a
 * flow. Pretty-printed JSON to stdout; redirect with `> tree.json` to save.
 *
 * Why not dump Fabric directly? `findAllBySelector` exists but there's no
 * server-side root-walk command, and accessibility tree is the actual
 * resolution surface for tap/assert. If/when a `dumpHierarchy` Nitro
 * method lands, swap the body — flag stays the same.
 */

import { execFileSync } from 'child_process';
import { getTargetUdid as getBootedSimulatorId } from '../sim';
import type { Flags } from '../cli/args';

export function runHierarchyCommand(_positional: string[], _flags: Flags): number {
  const udid = getBootedSimulatorId();
  if (!udid) {
    console.error('No booted iOS simulator found. Boot one or set ENNIO_UDID.');
    return 1;
  }
  let raw: string;
  try {
    raw = execFileSync('idb', ['ui', 'describe-all', '--udid', udid], {
      encoding: 'utf-8',
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (e) {
    console.error(`idb describe-all failed: ${(e as Error).message}`);
    console.error('Confirm idb_companion is connected: idb connect <UDID>');
    return 1;
  }
  try {
    const parsed = JSON.parse(raw);
    console.log(JSON.stringify(parsed, null, 2));
  } catch {
    // Not valid JSON — print raw so user can still see what they got.
    console.log(raw);
  }
  return 0;
}
