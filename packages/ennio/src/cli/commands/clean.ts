/**
 * `ennio clean [bundleId]` — tidy ennio's on-screen overlays.
 *
 * ennio's dylib paints transient instrumentation into the target app —
 * the show-touches indicators/trails and the "E2E" debug banner. Those
 * are torn down on a clean run exit, but when a run aborts (crash,
 * timeout, error) the teardown can be skipped and the overlays stay
 * painted on the still-running app. This verb wipes them on demand.
 *
 * It does the minimum and nothing else:
 *   * WARM ATTACH — reuses the already-running, already-injected app.
 *     Never relaunches, never clearState: app and data stay exactly as
 *     they are. (That's the distinction from `restart-app`, which kills
 *     and relaunches the process.) If the app isn't running there's
 *     nothing to clean — that's an error, not a cold launch.
 *   * ONE OP — sends `clear_overlays` over the control socket and prints
 *     a one-line summary.
 *
 *   exit 0  overlays cleared
 *   exit 1  attach failed, no app running, several apps (ambiguous), or
 *           the op did not confirm
 *
 * The default bundleId is the app already open on the booted simulator;
 * several running apps is an error listing the candidates, never a guess
 * — same resolution as `improvise`.
 */

import type { Flags } from '../cli/args';
import { EnnioMcpSession } from '../mcp/session';
import { selectPlatform } from '../platform';
import { getTargetUdid } from '../sim';

import { runningApps } from './improvise';

export async function runCleanCommand(positional: string[], flags: Flags): Promise<number> {
  let bundleId = positional[0];

  // Default to the app already open on the booted simulator. Mirrors
  // improvise: exactly one running non-system app → use it; none → error
  // (nothing to clean); several → error listing the candidates rather
  // than guessing which one to touch.
  if (!bundleId) {
    const udid = getTargetUdid();
    if (!udid) {
      console.error('no booted simulator found — boot one or pass a bundleId');
      return 1;
    }
    const apps = runningApps(udid);
    if (apps.length === 1) {
      bundleId = apps[0];
      console.error(`[clean] target: ${bundleId} (app open on the simulator)`);
    } else if (apps.length === 0) {
      console.error('no app running on the simulator — nothing to clean');
      return 1;
    } else {
      console.error(
        `several apps running — pass one explicitly:\n  ${apps
          .map((a) => `ennio clean ${a}`)
          .join('\n  ')}`,
      );
      return 1;
    }
  }

  const session = new EnnioMcpSession({
    platform: selectPlatform(flags.android ? 'android' : 'ios'),
    inProcessTap: false,
    safeMode: flags.safeMode,
  });
  try {
    // Warm attach: connect to the running app with the dylib already
    // injected. attach() never clearState and never relaunches a live
    // app — the screen and data are left untouched.
    const attached = await session.attach(bundleId);
    if (!attached.ok) {
      console.error(`attach failed: ${attached.error.message}`);
      return 1;
    }
    const cleared = await session.clearOverlays();
    if (!cleared) {
      console.error(`CLEAN ${bundleId} — could not clear overlays (app may be unresponsive)`);
      return 1;
    }
    console.log(`CLEAN ${bundleId} — overlays cleared`);
    return 0;
  } finally {
    session.close();
  }
}
