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
import { tap as hidTap } from '../hid';
import { findDylib, getAppContainer, terminateApp } from '../sim';
import { EnnioSocketClient, ennioSocketPath } from '../socket-client';

import { RunContext, sleep } from './context';

// Grant buttons, most-permissive first. We tap the FIRST that exists.
const PERMISSION_GRANT_LABELS = [
  'Allow Full Access',
  'Allow While Using App',
  'Allow Once',
  'Allow',
  'OK',
];
// Distinctly-system button labels — their presence alone confirms a
// system permission sheet (so we don't misfire on an app's own "Allow").
const SYSTEM_DIALOG_MARKERS = [
  'Allow Full Access',
  'Keep Add Only',
  'Limit Access…',
  'Allow While Using App',
  "Don't Allow",
];

interface IdbAxNode {
  AXLabel?: string;
  title?: string;
  frame?: { x: number; y: number; width: number; height: number };
}

/**
 * Dismiss native system permission sheets (Photo Library, notifications,
 * tracking, location). They render in a SEPARATE process, so the in-app
 * dylib is blind to them (find_by_text / top_vc_chain / alert_present
 * all miss). idb's accessibility describe DOES see cross-process windows;
 * we tap the grant button by its frame center via HID (process-agnostic).
 * Returns true if it dismissed at least one. Safe no-op when none present.
 */
export async function dismissPermissionDialogs(udid: string): Promise<boolean> {
  let dismissedAny = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    let out = '';
    try {
      out = execFileSync('idb', ['ui', 'describe-all', '--udid', udid], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        // 128 MB: deep view trees (Bluesky thread screen with 200+
        // reply rows + nav + tab bar) can hit ~40 MB. Previous 32 MB
        // cap silently truncated and we'd miss permission sheets
        // sitting at the end of the buffer.
        maxBuffer: 128 * 1024 * 1024,
      });
      // Detect truncation by checking the tail. `idb ui describe-all`
      // outputs valid JSON; a truncated buffer ends mid-token. If parse
      // fails the catch below returns — log so the user knows.
      if (out.length >= 128 * 1024 * 1024 - 1024) {
        process.stderr.write(
          '   ⚠ idb describe-all output near maxBuffer cap — view tree may be truncated\n',
        );
      }
    } catch {
      return dismissedAny;
    }
    let els: IdbAxNode[];
    try {
      els = JSON.parse(out) as IdbAxNode[];
    } catch {
      return dismissedAny;
    }
    const labelOf = (e: IdbAxNode) => e.AXLabel ?? e.title ?? '';
    const labels = els.map(labelOf);
    // Only act when this really is a system permission sheet: either a
    // request-prompt string or a distinctly-system button is present.
    const looksLikePermission =
      labels.some((l) => /requesting|would like|access to your|access your/i.test(l)) ||
      labels.some((l) => SYSTEM_DIALOG_MARKERS.includes(l));
    if (!looksLikePermission) return dismissedAny;

    let target: { x: number; y: number } | null = null;
    for (const want of PERMISSION_GRANT_LABELS) {
      const el = els.find((e) => labelOf(e) === want && e.frame);
      if (el?.frame) {
        target = { x: el.frame.x + el.frame.width / 2, y: el.frame.y + el.frame.height / 2 };
        break;
      }
    }
    if (!target) return dismissedAny;
    process.stderr.write(
      `[ennio] dismissing system permission dialog → tap (${Math.round(target.x)},${Math.round(target.y)})\n`,
    );
    await hidTap(udid, target.x, target.y);
    dismissedAny = true;
    await sleep(700); // let it dismiss; loop catches a second stacked sheet
  }
  return dismissedAny;
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
  // Full app reset: copy .app → idb uninstall → simctl install → launch.
  // idb uninstall goes through idb_companion's CoreSimulator API which
  // does a proper OS-level app removal (Keychain, UserDefaults, caches,
  // group containers). Plain simctl container wipe or simctl uninstall
  // leaves residual state that causes Expo dev-client apps to hang
  // permanently after login (React navigation stuck in loading state).
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
      execFileSync(
        'sqlite3',
        [
          dbPath,
          `INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version, flags) VALUES (${sqlLiteral(svc)}, ${client}, 0, 2, 4, 1, 0);`,
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
