// App lifecycle — launch / relaunch / clearState helpers.
//
// All paths re-inject libennio via SIMCTL_CHILD_DYLD_INSERT_LIBRARIES
// and re-open the Unix-socket against the new PID. The same
// "first-paint" wait pattern (wait_commit + fixed sleep + wait_commit)
// runs after every relaunch so the RN bundle boot + initial layout
// pass completes before the next command tries to find anything.

import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { diagnoseSocketFailure, throttledAliveProbe } from '../crash-detector';
import { diag } from '../diag';
import { dismissSystemSheet } from '../ennio-ax';
import { warmActuator } from '../hid';
import { findDylib, getAppContainer, setSimLaunchEnv, terminateApp } from '../sim';
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

/**
 * simctl launch arguments the CURRENT app process was started with,
 * per device+bundle. Written by the two real-relaunch paths below; read
 * by the launchApp handler's app-reuse gate. A running process already
 * carries its launch args in the NSUserDefaults arguments domain
 * (process-scoped — survives a data wipe + in-place JS reload), so a
 * launchApp with byte-identical args can take the soft-reset fast path;
 * only DIFFERENT args force a real relaunch. In-memory: valid for the
 * lifetime of this CLI process, which is exactly the window in which a
 * suite reconnects to the same app process between flows.
 */
const lastLaunchArgsByApp = new Map<string, string[]>();

function launchArgsKey(udid: string, bundleId: string): string {
  return `${udid}:${bundleId}`;
}

export function recordLaunchArgs(udid: string, bundleId: string, args: string[]): void {
  lastLaunchArgsByApp.set(launchArgsKey(udid, bundleId), [...args]);
}

export function launchArgsSatisfiedByProcess(
  udid: string,
  bundleId: string,
  args: string[],
): boolean {
  if (args.length === 0) return true;
  const last = lastLaunchArgsByApp.get(launchArgsKey(udid, bundleId));
  return last !== undefined && last.length === args.length && last.every((a, i) => a === args[i]);
}

export async function waitForFirstPaint(client: EnnioSocketClient): Promise<void> {
  // The app is "painted" when React first commits content (post-splash).
  // That commit IS the signal — wait for the EVENT, not a stable window.
  // The old path led with wait_commit(8000, stableMs:250): on a booting
  // app whose splash→content swap keeps the view-hash moving, the 250ms
  // stable window alone burned multiple seconds before the real content
  // was even up. Lead with the commit event; a brief settle then catches
  // the layout tail.
  const r = await client
    .call('wait_react_commit', { sinceMs: 0, maxMs: 8000 })
    .catch(() => undefined);
  const committed = !!(r && r.ok && r.data && (r.data as { ok: boolean }).ok);
  if (committed) {
    // Content rendered — one short stability check for the layout tail.
    await client.call('wait_commit', { maxMs: 1200, stableMs: 150 }).catch(() => undefined);
    return;
  }
  // No RN observer (or it never committed) — fall back to the view-hash
  // stable window, the only signal available.
  await client.call('wait_commit', { maxMs: 5000, stableMs: 250 }).catch(() => undefined);
}

/**
 * Suite-level fast reset (--reuse-app): wipe the app's data sandbox and
 * reload the JS bundle IN PLACE — fresh data + fresh React tree — without
 * a process relaunch. The native dylib + its Unix socket survive a JS
 * reload, so the same client keeps working. This is what makes a suite
 * pay the ~6s app boot ONCE instead of per flow: on a Hermes build the
 * reload re-runs precompiled bytecode against the already-loaded native
 * stack in ~1-2s.
 *
 * Falls back to a full clearState relaunch when the app lacks RN's reload
 * symbol (older / fully bridgeless RN), so behaviour is never worse than
 * the relaunch path — only faster when reload is available.
 */
export async function softResetAndReload(ctx: RunContext): Promise<void> {
  const t0 = Date.now();
  diag('lifecycle', 'softReset:start', { platform: 'ios', bundleId: ctx.bundleId });
  const done = (extra: Record<string, unknown> = {}) =>
    diag('lifecycle', 'softReset:done', { durMs: Date.now() - t0, ...extra });
  const pre = await ctx.client.call('react_commit_ts').catch(() => undefined);
  const since = Number((pre?.data as { ts?: number } | undefined)?.ts ?? 0);
  // Wipe the sandbox first (in-process — it's the app's own container),
  // then reload so the new JS boots against empty storage.
  await ctx.client.call('clear_state').catch(() => undefined);
  const r = await ctx.client.call('reload_rn').catch(() => undefined);
  const ok = !!(r && r.ok && (r.data as { ok?: boolean } | undefined)?.ok);
  if (!ok) {
    // No reload symbol — fall back to the real relaunch.
    done({ fellBackToRelaunch: true });
    await clearStateAndRelaunch(ctx);
    return;
  }
  // The reload tears down and rebuilds the React root; wait for the
  // bundle's first commit after our pre-reload timestamp, then a short
  // stability check for the initial layout.
  await ctx.client
    .call('wait_react_commit', { sinceMs: since, maxMs: 8000 })
    .catch(() => undefined);
  await ctx.client.call('wait_commit', { maxMs: 1500, stableMs: 150 }).catch(() => undefined);
  done({ reloaded: true });
}

/// Re-launch the app with DYLD inject and re-open the control socket.
/// Used after a stopApp/killApp followed by launchApp — the original
/// process is dead, but the YAML expects a fresh app instance.
export async function relaunchAndReconnect(
  ctx: RunContext,
  launchArgs: string[] = [],
): Promise<void> {
  const t0 = Date.now();
  diag('lifecycle', 'relaunch:start', { platform: 'ios', bundleId: ctx.bundleId });
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
  // Propagate --no-animations (sticky launchctl env; set OR clear so a
  // prior run can't leak it). Source of truth: the CLI's process env.
  setSimLaunchEnv(ctx.udid, 'ENNIO_NO_ANIMATIONS', process.env.ENNIO_NO_ANIMATIONS === '1');
  setSimLaunchEnv(ctx.udid, 'ENNIO_SHOW_TOUCHES', process.env.ENNIO_SHOW_TOUCHES === '1');
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
  reopen.aliveProbe = throttledAliveProbe(ctx.udid, ctx.bundleId);
  if (!(await reopen.connectWithRetry(15_000))) {
    const diagnosis = diagnoseSocketFailure(ctx.udid, ctx.bundleId, launchedAt);
    throw new Error(
      'socket reconnect failed after launchApp' + (diagnosis ? `\n${diagnosis}` : ''),
    );
  }
  ctx.client = reopen;
  recordLaunchArgs(ctx.udid, ctx.bundleId, launchArgs);
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
  void warmActuator(ctx.udid);
  await waitForFirstPaint(reopen);
  diag('lifecycle', 'relaunch:done', { platform: 'ios', durMs: Date.now() - t0 });
}

export async function clearStateAndRelaunch(
  ctx: RunContext,
  launchArgs: string[] = [],
): Promise<void> {
  const t0 = Date.now();
  diag('lifecycle', 'clearState', { platform: 'ios', bundleId: ctx.bundleId });
  // App reset. Default fast path: wipe the data container in place and
  // relaunch the SAME install — no uninstall/reinstall. The reinstall
  // (copy .app → uninstall → install, with two 1s settles) cost ~8-10s
  // per flow and its only extra over a data wipe is an OS-level Keychain
  // / group-container reset. Most flows only need fresh UserDefaults +
  // sandbox files, which the wipe gives. Keychain-sensitive flows (a
  // session persisted in the keychain) opt into the full reinstall with
  // ENNIO_FULL_CLEARSTATE=1.
  const fullReinstall = process.env.ENNIO_FULL_CLEARSTATE === '1';
  ctx.client.close();
  // Remove stale socket so the new process binds cleanly.
  try {
    rmSync(ennioSocketPath(ctx.udid), { force: true });
  } catch {
    /* ok */
  }

  // Grab the installed .app bundle path BEFORE any teardown.
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

  if (fullReinstall && appBundle) {
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
  } else if (appBundle) {
    // Fast path: wipe the data sandbox in place. The app is terminated,
    // so the container is quiescent; iOS recreates Library/Caches,
    // Library/Preferences, etc. on the next launch. Wipe the CONTENTS of
    // Documents / Library / tmp rather than the dirs themselves so the
    // container's own permissions/structure stay intact.
    let dataContainer: string | null = null;
    try {
      dataContainer = execFileSync(
        'xcrun',
        ['simctl', 'get_app_container', ctx.udid, ctx.bundleId, 'data'],
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      ).trim();
    } catch {
      /* no data container yet — nothing to wipe */
    }
    if (dataContainer) {
      for (const sub of ['Documents', 'Library', 'tmp']) {
        const dir = join(dataContainer, sub);
        try {
          for (const entry of readdirSync(dir)) {
            rmSync(join(dir, entry), { recursive: true, force: true });
          }
        } catch {
          /* dir may not exist; iOS recreates on launch */
        }
      }
    }
  }

  // Permission re-grant is ONLY needed after a full reinstall — the
  // uninstall wipes TCC. The fast data-wipe path leaves TCC intact, so
  // the grant + tccd kickstart below (a system-wide daemon restart,
  // ~1-2s) would be pure per-flow overhead. Skip it entirely there.
  if (fullReinstall) {
    // Re-grant permissions wiped by the uninstall. simctl privacy grant
    // sets most permissions, but grants photo access as "limited"
    // (auth=3) on iOS 26. Override via TCC sqlite AFTER simctl to force
    // full access.
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
  // Propagate --no-animations (sticky launchctl env; set OR clear so a
  // prior run can't leak it). Source of truth: the CLI's process env.
  setSimLaunchEnv(ctx.udid, 'ENNIO_NO_ANIMATIONS', process.env.ENNIO_NO_ANIMATIONS === '1');
  setSimLaunchEnv(ctx.udid, 'ENNIO_SHOW_TOUCHES', process.env.ENNIO_SHOW_TOUCHES === '1');
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
  reopen.aliveProbe = throttledAliveProbe(ctx.udid, ctx.bundleId);
  if (!(await reopen.connectWithRetry(15_000))) {
    const diagnosis = diagnoseSocketFailure(ctx.udid, ctx.bundleId, launchedAt);
    throw new Error(
      'socket reconnect failed after clearState relaunch' + (diagnosis ? `\n${diagnosis}` : ''),
    );
  }
  ctx.client = reopen;
  recordLaunchArgs(ctx.udid, ctx.bundleId, launchArgs);
  getAppContainer(ctx.udid, ctx.bundleId);
  // Pre-spawn the HID helper in the background — it arms while the app
  // finishes booting, so the first real gesture doesn't pay the ~700ms
  // spawn (observed as a slow first nav tap).
  void warmActuator(ctx.udid);
  // Settle on the SIGNAL (first React commit + layout tail), not a fixed
  // pause — callers previously stacked a blind POST_LAUNCH_SETTLE_MS on
  // top of this return, which both under-waits a slow boot and
  // over-waits a fast one.
  await waitForFirstPaint(reopen);
  diag('lifecycle', 'clearState:done', {
    platform: 'ios',
    durMs: Date.now() - t0,
    mode: fullReinstall ? 'reinstall' : 'wipe',
  });
}
