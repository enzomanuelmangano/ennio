/**
 * `ennio hierarchy` — dump the on-screen accessibility tree.
 *
 * Source: the in-app dylib's `ax_tree_snapshot` op (walks the in-process
 * UIAccessibility tree from every window/scene). This matches what's
 * reachable to selectors — testID maps to accessibilityIdentifier, so
 * anything visible here is targetable from a flow. Requires the target
 * app to be running with the dylib injected (run a flow first, or have
 * the app launched by ennio). Pretty-printed to stdout.
 */

import { getTargetUdid as getBootedSimulatorId } from '../sim';
import type { Flags } from '../cli/args';
import { EnnioConnection } from '../core/ennio-connection';
import { axTreeSnapshot } from '../hid';

export async function runHierarchyCommand(_positional: string[], _flags: Flags): Promise<number> {
  const udid = getBootedSimulatorId();
  if (!udid) {
    console.error('No booted iOS simulator found. Boot one or set ENNIO_UDID.');
    return 1;
  }
  const connection = new EnnioConnection({ udid });
  try {
    if (!(await connection.open(2_000))) {
      console.error(
        'No ennio dylib socket on this simulator. Launch the app via `ennio test` ' +
          'first (the dylib is injected at launch), then re-run hierarchy.',
      );
      return 1;
    }
    const tree = await axTreeSnapshot(udid);
    if (!tree) {
      console.error('ax_tree_snapshot returned empty — app may still be launching.');
      return 1;
    }
    try {
      console.log(JSON.stringify(JSON.parse(tree), null, 2));
    } catch {
      console.log(tree);
    }
    return 0;
  } finally {
    connection.close();
  }
}
