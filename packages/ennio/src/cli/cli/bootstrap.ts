/**
 * CDP bootstrap: connect to the app's Hermes Inspector via Metro. If
 * the app isn't running (or Metro hasn't picked it up yet), auto-launch
 * on the booted simulator and poll the Inspector endpoint until the
 * JS context appears.
 */

import { EnnioClient } from '../client';
import { getBootedSimulatorId, launchAppOnSimulator } from '../maestro-runner';

// Initial connect probe — Inspector returns HTTP 200 (or refuses) fast
// when Metro is up; longer than 2 s on a cold device is unusual.
const CONNECT_PROBE_TIMEOUT_MS = 2_000;
// Auto-launch poll cadence + total. RN runtime + Hermes Inspector page
// registration takes ~3-6 s on a fresh launch, longer on iOS 26 sims
// the first time after install.
const LAUNCH_POLL_INTERVAL_MS = 500;
const LAUNCH_TIMEOUT_DEFAULT_SEC = 30;

export async function tryConnection(): Promise<EnnioClient | null> {
  const client = new EnnioClient();
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
  /** App ID to auto-launch when Inspector is unreachable. */
  appId?: string;
  /** Total seconds to wait for Inspector after auto-launch. */
  launchTimeoutSec?: number;
  /** Print status lines (default true). */
  verbose?: boolean;
};

export type BootstrapResult =
  | { ok: true; client: EnnioClient; udid: string | null; autoLaunched: boolean }
  | { ok: false; reason: string };

export async function connectOrLaunch(opts: BootstrapOptions): Promise<BootstrapResult> {
  const { appId, launchTimeoutSec = LAUNCH_TIMEOUT_DEFAULT_SEC, verbose = true } = opts;
  let client = await tryConnection();
  if (client) return { ok: true, client, udid: getBootedSimulatorId(), autoLaunched: false };

  const udid = getBootedSimulatorId();
  if (!udid) {
    return {
      ok: false,
      reason:
        `Could not connect to the Hermes Inspector at ${process.env.ENNIO_METRO_URL || 'http://localhost:8081'}.\n` +
        `No booted iOS simulator found. Boot one (xcrun simctl boot <UDID>) or set ENNIO_UDID.`,
    };
  }
  if (!appId) {
    return {
      ok: false,
      reason:
        `Could not connect to the Hermes Inspector.\n` +
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
    client = await tryConnection();
    if (client) return { ok: true, client, udid, autoLaunched: true };
  }
  return {
    ok: false,
    reason:
      `Could not connect to the Hermes Inspector.\n` +
      `Tried auto-launching ${appId}; Inspector never exposed a JS context.\n` +
      `Confirm Metro is running (\`bun start\`) and the app has ennio wired (ENNIO_ENABLED=1 at pod install).`,
  };
}
