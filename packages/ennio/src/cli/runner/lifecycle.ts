// App lifecycle — launch / relaunch / clearState helpers.
//
// All paths re-inject libennio via SIMCTL_CHILD_DYLD_INSERT_LIBRARIES
// and re-open the Unix-socket against the new PID. The same
// "first-paint" wait pattern (wait_commit + fixed sleep + wait_commit)
// runs after every relaunch so the RN bundle boot + initial layout
// pass completes before the next command tries to find anything.

import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { diagnoseSocketFailure } from '../crash-detector';
import { dismissSystemSheet } from '../ennio-ax';
import { findDylib, getAppContainer, terminateApp } from '../sim';
import { EnnioSocketClient, ennioSocketPath } from '../socket-client';

import { RunContext, sleep } from './context';

/**
 * System permission sheets (Photo Library, notifications, tracking,
 * location) and SpringBoard confirmations render in a SEPARATE process,
 * so neither the in-app dylib nor the in-house host HID can introspect
 * them. We read them out of Simulator.app's macOS AX tree via the
 * `ennioax` helper (see ennio-ax.ts) and clear them with a real HID tap
 * on the permissive button. Soft-fails to false when the AX helper is
 * unavailable (e.g. headless CI with no Simulator.app) — callers treat
 * that as "nothing to dismiss".
 */
export async function dismissPermissionDialogs(udid: string): Promise<boolean> {
  return dismissSystemSheet(udid).catch(() => false);
}

export async function waitForFirstPaint(client: EnnioSocketClient): Promise<void> {
  await client.call('wait_commit', { maxMs: 8000, stableMs: 250 }).catch(() => undefined);
  // Wait for the first React commit instead of a fixed 2s sleep.
  // Falls back to 2s if no React observer is attached.
  const r = await client
    .call('wait_react_commit', { sinceMs: 0, maxMs: 2000 })
    .catch(() => undefined);
  const committed = !!(r && r.ok && r.data && (r.data as { ok: boolean }).ok);
  if (!committed) {
    await sleep(2000);
  }
  await client.call('wait_commit', { maxMs: 3000, stableMs: 300 }).catch(() => undefined);
}

/// Re-launch the app with DYLD inject and re-open the control socket.
/// Used after a stopApp/killApp followed by launchApp — the original
/// process is dead, but the YAML expects a fresh app instance.
export async function relaunchAndReconnect(
  ctx: RunContext,
  launchArgs: string[] = [],
): Promise<void> {
  ctx.client.close();
  // Make sure the previous process is fully gone before we launch
  // again — simctl launch can otherwise attach to the still-shutting
  // -down PID and lose the dylib.
  terminateApp(ctx.udid, ctx.bundleId);
  await sleep(300);
  if (!ctx.dylibPath) {
    const auto = findDylib();
    if (!auto) {
      throw new Error(
        'launchApp after killApp requires libennio.dylib — none found. Set ENNIO_DYLIB_PATH.',
      );
    }
    ctx.dylibPath = auto;
  }
  // Set ENNIO_SOCKET_PATH on the simulator launchctl env (SIMCTL_CHILD_*
  // only forwards DYLD_* and a few known prefixes; arbitrary names are
  // dropped). Per-UDID path, sim-wide scope, not a secret.
  execFileSync(
    'xcrun',
    [
      'simctl',
      'spawn',
      ctx.udid,
      'launchctl',
      'setenv',
      'ENNIO_SOCKET_PATH',
      ennioSocketPath(ctx.udid),
    ],
    { stdio: 'pipe' },
  );
  const launchedAt = Date.now();
  execFileSync(
    'xcrun',
    ['simctl', 'launch', '--terminate-running-process', ctx.udid, ctx.bundleId, ...launchArgs],
    {
      env: { ...process.env, SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: ctx.dylibPath },
      stdio: 'pipe',
    },
  );
  const reopen = new EnnioSocketClient(ctx.udid);
  if (!(await reopen.connectWithRetry(15_000))) {
    const diagnosis = diagnoseSocketFailure(ctx.udid, ctx.bundleId, launchedAt);
    throw new Error(
      'socket reconnect failed after launchApp' + (diagnosis ? `\n${diagnosis}` : ''),
    );
  }
  ctx.client = reopen;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const r = await reopen.call('ping');
      const ready = r.ok && r.data && (r.data as { bootstrap?: string }).bootstrap === 'ready';
      if (ready) break;
    } catch {
      /* try again */
    }
    await sleep(100);
  }
  await waitForFirstPaint(reopen);
}

export async function clearStateAndRelaunch(
  ctx: RunContext,
  launchArgs: string[] = [],
): Promise<void> {
  // Full app reset: copy .app → simctl uninstall → simctl install → launch.
  ctx.client.close();
  // Remove stale socket so the new process binds cleanly.
  try {
    rmSync(ennioSocketPath(ctx.udid), { force: true });
  } catch {
    /* ok */
  }

  // Grab the installed .app bundle path BEFORE uninstalling.
  let appBundle: string | null = null;
  try {
    appBundle = execFileSync(
      'xcrun',
      ['simctl', 'get_app_container', ctx.udid, ctx.bundleId, 'app'],
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();
  } catch {
    /* app not installed */
  }

  // Terminate via simctl (app may not be running — terminateApp swallows that).
  terminateApp(ctx.udid, ctx.bundleId);

  if (appBundle) {
    const tmp = mkdtempSync(join(tmpdir(), 'ennio-cs-'));
    const copy = join(tmp, 'App.app');
    cpSync(appBundle, copy, { recursive: true });

    // Uninstall via simctl for an OS-level reset (Keychain, UserDefaults,
    // caches, group containers).
    execFileSync('xcrun', ['simctl', 'uninstall', ctx.udid, ctx.bundleId], { stdio: 'pipe' });
    await sleep(1000);

    // Reinstall via simctl.
    execFileSync('xcrun', ['simctl', 'install', ctx.udid, copy], { stdio: 'pipe' });
    await sleep(1000);
  }

  // Re-grant permissions wiped by the uninstall. simctl privacy grant
  // sets most permissions, but grants photo access as "limited" (auth=3)
  // on iOS 26. Override via TCC sqlite AFTER simctl to force full access.
  try {
    execFileSync('xcrun', ['simctl', 'privacy', ctx.udid, 'grant', 'all', ctx.bundleId], {
      stdio: 'pipe',
    });
  } catch {
    /* privacy grant not available on older Xcode */
  }
  await sleep(300);
  // Override photo access to full (auth_value=2). simctl grants limited
  // (auth_value=3) on iOS 26 which shows a "Limited Access" picker.
  try {
    const homePath = process.env.HOME || '';
    const dbPath = join(
      homePath,
      'Library/Developer/CoreSimulator/Devices',
      ctx.udid,
      'data/Library/TCC/TCC.db',
    );
    const services = [
      'kTCCServicePhotoLibrary',
      'kTCCServicePhotos',
      'kTCCServicePhotosAdd',
      'kTCCServiceCamera',
      'kTCCServiceMicrophone',
    ];
    // SQLite string-literal escaping: double any single quote. bundleId
    // is attacker-controllable in principle (it comes from the flow's
    // appId), so escape it rather than interpolate raw — otherwise a
    // crafted appId could break out of the literal into arbitrary SQL.
    const sqlLiteral = (s: string) => `'${s.replace(/'/g, "''")}'`;
    const client = sqlLiteral(ctx.bundleId);
    for (const svc of services) {
      // Row shape matters: write what iOS itself writes when the user
      // taps "Allow Full Access" (observed on iOS 18.2:
      // auth_value=2, auth_reason=2 /user consent/, auth_version=2,
      // flags=16). The previous auth_version=1/flags=0 row was ignored
      // by tccd and the Photos limited-access upgrade prompt appeared
      // anyway — which only an on-screen Simulator window (ennioax)
      // could dismiss, breaking headless runs.
      execFileSync(
        'sqlite3',
        [
          dbPath,
          `INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version, flags) VALUES (${sqlLiteral(svc)}, ${client}, 0, 2, 2, 2, 16);`,
        ],
        { stdio: 'pipe' },
      );
    }
    // tccd caches the DB in memory — a direct sqlite write is invisible
    // to the running daemon until it restarts. Kickstart it so the next
    // permission query re-reads our rows; launchd respawns it instantly.
    execFileSync(
      'xcrun',
      ['simctl', 'spawn', ctx.udid, 'launchctl', 'kickstart', '-k', 'system/com.apple.tccd'],
      { stdio: 'pipe' },
    );
  } catch {
    /* TCC direct grant failed */
  }

  if (!ctx.dylibPath) {
    const auto = findDylib();
    if (!auto) {
      throw new Error(
        'clearState relaunch requires libennio.dylib — none found in default paths. Set ENNIO_DYLIB_PATH.',
      );
    }
    ctx.dylibPath = auto;
  }
  // Set ENNIO_SOCKET_PATH on the simulator launchctl env (SIMCTL_CHILD_*
  // only forwards DYLD_* and a few known prefixes; arbitrary names are
  // dropped). Per-UDID path, sim-wide scope, not a secret.
  execFileSync(
    'xcrun',
    [
      'simctl',
      'spawn',
      ctx.udid,
      'launchctl',
      'setenv',
      'ENNIO_SOCKET_PATH',
      ennioSocketPath(ctx.udid),
    ],
    { stdio: 'pipe' },
  );
  const launchedAt = Date.now();
  execFileSync(
    'xcrun',
    ['simctl', 'launch', '--terminate-running-process', ctx.udid, ctx.bundleId, ...launchArgs],
    {
      env: { ...process.env, SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: ctx.dylibPath },
      stdio: 'pipe',
    },
  );
  const reopen = new EnnioSocketClient(ctx.udid);
  if (!(await reopen.connectWithRetry(15_000))) {
    const diagnosis = diagnoseSocketFailure(ctx.udid, ctx.bundleId, launchedAt);
    throw new Error(
      'socket reconnect failed after clearState relaunch' + (diagnosis ? `\n${diagnosis}` : ''),
    );
  }
  ctx.client = reopen;
  getAppContainer(ctx.udid, ctx.bundleId);
}
