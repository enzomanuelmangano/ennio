/**
 * `ennio hierarchy` — dump the on-screen element inventory as JSON.
 *
 * Source: the in-app dylib's `dump_views` op (walks the in-process view
 * tree). Each element carries its role/class, testID, accessibility text
 * and value — testID maps to accessibilityIdentifier, so anything here is
 * targetable from a flow. Requires the target app to be running with the
 * dylib injected (run a flow first, or have the app launched by ennio).
 * Pretty-printed to stdout.
 *
 * (Previously called a non-existent `ax_tree_snapshot` op and always
 * returned empty — `dump_views` is the op the dylib actually implements,
 * the same one `ennio mcp`'s ennio_describe reads.)
 */

import { getTargetUdid as getBootedSimulatorId } from '../sim';
import type { Flags } from '../cli/args';
import { EnnioConnection } from '../core/ennio-connection';
import { getScreenSize } from '../hid';
import { describeViews } from '../mcp/describe';

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
    const r = await connection.socket.call('dump_views');
    if (!r.ok) {
      console.error(`dump_views failed: ${r.err ?? 'unknown error'}`);
      return 1;
    }
    const lines = Array.isArray(r.data) ? (r.data as string[]) : [];
    const size = await getScreenSize(udid);
    console.log(JSON.stringify(describeViews(lines, size), null, 2));
    return 0;
  } finally {
    connection.close();
  }
}
