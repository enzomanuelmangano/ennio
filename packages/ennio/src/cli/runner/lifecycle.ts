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

import { findDylib, getAppContainer, terminateApp } from '../sim';
import { EnnioSocketClient } from '../socket-client';

import { RunContext, sleep } from './context';

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
  execFileSync(
    'xcrun',
    ['simctl', 'launch', '--terminate-running-process', ctx.udid, ctx.bundleId, ...launchArgs],
    {
      env: { ...process.env, SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: ctx.dylibPath },
      stdio: 'pipe',
    },
  );
  const reopen = new EnnioSocketClient();
  if (!(await reopen.connectWithRetry(15_000))) {
    throw new Error('socket reconnect failed after launchApp');
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
  // Full app reset: copy .app → idb uninstall → simctl install → launch.
  // idb uninstall goes through idb_companion's CoreSimulator API which
  // does a proper OS-level app removal (Keychain, UserDefaults, caches,
  // group containers). Plain simctl container wipe or simctl uninstall
  // leaves residual state that causes Expo dev-client apps to hang
  // permanently after login (React navigation stuck in loading state).
  ctx.client.close();
  // Remove stale socket so the new process binds cleanly.
  try {
    rmSync('/tmp/ennio-control.sock', { force: true });
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

  // Terminate via idb (goes through idb_companion).
  try {
    execFileSync('idb', ['terminate', ctx.bundleId, '--udid', ctx.udid], { stdio: 'pipe' });
  } catch {
    // App may not be running.
    terminateApp(ctx.udid, ctx.bundleId);
  }

  if (appBundle) {
    const tmp = mkdtempSync(join(tmpdir(), 'ennio-cs-'));
    const copy = join(tmp, 'App.app');
    cpSync(appBundle, copy, { recursive: true });

    // Uninstall via idb for a proper OS-level reset.
    try {
      execFileSync('idb', ['uninstall', ctx.bundleId, '--udid', ctx.udid], { stdio: 'pipe' });
    } catch {
      execFileSync('xcrun', ['simctl', 'uninstall', ctx.udid, ctx.bundleId], { stdio: 'pipe' });
    }
    await sleep(1000);

    // Reinstall via simctl.
    execFileSync('xcrun', ['simctl', 'install', ctx.udid, copy], { stdio: 'pipe' });
    await sleep(1000);
  }

  // Re-grant permissions wiped by the uninstall. simctl privacy grant
  // covers most services, but iOS 26's Photo Library "full access"
  // requires a direct TCC insert for kTCCServicePhotoLibrary.
  try {
    execFileSync('xcrun', ['simctl', 'privacy', ctx.udid, 'grant', 'all', ctx.bundleId], {
      stdio: 'pipe',
    });
  } catch {
    /* privacy grant not available on older Xcode */
  }
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
    for (const svc of services) {
      execFileSync(
        'sqlite3',
        [
          dbPath,
          `INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version, flags) VALUES ('${svc}', '${ctx.bundleId}', 0, 2, 4, 1, 0);`,
        ],
        { stdio: 'pipe' },
      );
    }
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
  execFileSync(
    'xcrun',
    ['simctl', 'launch', '--terminate-running-process', ctx.udid, ctx.bundleId, ...launchArgs],
    {
      env: { ...process.env, SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: ctx.dylibPath },
      stdio: 'pipe',
    },
  );
  const reopen = new EnnioSocketClient();
  if (!(await reopen.connectWithRetry(15_000))) {
    throw new Error('socket reconnect failed after clearState relaunch');
  }
  ctx.client = reopen;
  getAppContainer(ctx.udid, ctx.bundleId);
}
