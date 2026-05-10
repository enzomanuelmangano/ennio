/**
 * WS bootstrap: connect to in-app @ennio/core. If the app isn't running,
 * auto-launch it on the booted simulator (mirrors maestro's `launchApp`
 * UX — user shouldn't have to launch the app by hand before invoking).
 */

import { EnnioClient } from '../client';
import { getBootedSimulatorId, launchAppOnSimulator } from '../maestro-runner';

export const DEFAULT_WS_PORT = 9876;
// Initial connect probe — short, since "no listener" returns ECONNREFUSED
// fast on a local socket. We retry-poll separately after auto-launch.
const CONNECT_PROBE_TIMEOUT_MS = 2_000;
// Auto-launch poll cadence + total. RN bridge + Nitro WS bind takes
// ~3-6 s on a fresh launch; longer on iOS 26 Sims (Metro bundle
// download + JS init can stretch to 10-15 s on the first launch
// after install).
const LAUNCH_POLL_INTERVAL_MS = 500;
const LAUNCH_TIMEOUT_DEFAULT_SEC = 30;

export async function tryWebSocketConnection(port: number): Promise<EnnioClient | null> {
  const client = new EnnioClient(port);
  try {
    await Promise.race([
      client.connect(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), CONNECT_PROBE_TIMEOUT_MS),
      ),
    ]);
    return client;
  } catch {
    return null;
  }
}

export type BootstrapOptions = {
  port: number;
  /** App ID to auto-launch when WS is unreachable. */
  appId?: string;
  /** Total seconds to wait for WS after auto-launch. */
  launchTimeoutSec?: number;
  /** Print status lines (default true). */
  verbose?: boolean;
};

export type BootstrapResult =
  | { ok: true; client: EnnioClient; udid: string | null; autoLaunched: boolean }
  | { ok: false; reason: string };

export async function connectOrLaunch(opts: BootstrapOptions): Promise<BootstrapResult> {
  const { port, appId, launchTimeoutSec = LAUNCH_TIMEOUT_DEFAULT_SEC, verbose = true } = opts;
  let client = await tryWebSocketConnection(port);
  if (client) return { ok: true, client, udid: getBootedSimulatorId(), autoLaunched: false };

  const udid = getBootedSimulatorId();
  if (!udid) {
    return {
      ok: false,
      reason:
        `Could not connect to the in-app Ennio server on port ${port}.\n` +
        `No booted iOS simulator found. Boot one (xcrun simctl boot <UDID>) or set ENNIO_UDID.`,
    };
  }
  if (!appId) {
    return {
      ok: false,
      reason:
        `Could not connect to the in-app Ennio server on port ${port}.\n` +
        `No appId available to auto-launch — pass --app=<bundleId> or include \`appId:\` in the YAML.`,
    };
  }
  if (verbose) console.log(`(App not running — launching ${appId} on ${udid.slice(0, 8)}…)`);
  try {
    launchAppOnSimulator(udid, appId);
  } catch (e) {
    return { ok: false, reason: `Failed to launch ${appId}: ${(e as Error).message}` };
  }
  const deadline = Date.now() + launchTimeoutSec * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, LAUNCH_POLL_INTERVAL_MS));
    client = await tryWebSocketConnection(port);
    if (client) return { ok: true, client, udid, autoLaunched: true };
  }
  return {
    ok: false,
    reason:
      `Could not connect to the in-app Ennio server on port ${port}.\n` +
      `Tried auto-launching ${appId}; WebSocket never bound.\n` +
      `Confirm the app has @ennio/core wired and ENNIO_ENABLED=1 in pod install.`,
  };
}
