/**
 * CDP bootstrap: connect to the app's Hermes Inspector via Metro. If
 * the app isn't running (or Metro hasn't picked it up yet), auto-launch
 * on the booted simulator and poll the Inspector endpoint until the
 * JS context appears.
 */

import { EnnioClient, METRO_BASE } from '../client';
import { describeInjection, prepareDylibInjection, registerCleanupOnExit } from '../dylib';
import {
  deepLinkExpoDevClient,
  detectExpoDevClientScheme,
  getBootedSimulatorId,
  launchAppOnSimulator,
} from '../maestro-runner';

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
  // DYLD injection: arm the simulator's launchctl env BEFORE we launch
  // the app. Without it the host process loads no ennio dylib and the
  // first CDP eval against `__ennioDispatch` would fail. The shim is
  // RN-agnostic; the real per-RN-version dylib only loads when the host
  // process is actually a React Native app.
  let injection: ReturnType<typeof prepareDylibInjection> | null = null;
  if (process.env.ENNIO_DISABLE_DYLIB !== '1') {
    try {
      injection = prepareDylibInjection(udid, appId);
      registerCleanupOnExit(udid);
      if (verbose) console.log(describeInjection(injection));
    } catch (e) {
      if (verbose) console.log(`(ennio dylib injection skipped: ${(e as Error).message})`);
    }
  }

  // Auto-detect expo-dev-client. A plain `simctl launch` of a dev-client
  // build lands on the "DEVELOPMENT SERVERS" picker (no JS context) and
  // the Inspector poll below would just time out. Deep-link past the
  // picker via `<scheme>://expo-development-client/?url=<metro>` so the
  // bundle loads directly.
  const devClientScheme = detectExpoDevClientScheme(udid, appId);
  if (verbose) {
    console.log(
      `(App not running — launching ${appId} on ${udid.slice(0, 8)}${
        devClientScheme ? ` via ${devClientScheme} → ${METRO_BASE}` : ''
      }…)`,
    );
  }
  try {
    if (devClientScheme) {
      deepLinkExpoDevClient(udid, devClientScheme, METRO_BASE);
    } else {
      launchAppOnSimulator(udid, appId);
    }
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
      `Confirm Metro is running (\`bun start\` or \`npx expo start\`) and the app is a Debug build with @reactiive/ennio-expo-plugin installed.`,
  };
}
