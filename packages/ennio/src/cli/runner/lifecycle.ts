// App lifecycle — launch / relaunch / clearState helpers.
//
// All paths re-inject libennio via SIMCTL_CHILD_DYLD_INSERT_LIBRARIES
// and re-open the Unix-socket against the new PID. The same
// "first-paint" wait pattern (wait_commit + fixed sleep + wait_commit)
// runs after every relaunch so the RN bundle boot + initial layout
// pass completes before the next command tries to find anything.

import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';

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
  // Wipe the app's data container (Library, Documents, tmp, Caches)
  // without uninstalling. Preserves the app binary + entitlements so
  // the Metro dev-client connection survives the relaunch. Matches
  // Maestro's clearState behavior on iOS.
  ctx.client.close();
  terminateApp(ctx.udid, ctx.bundleId);
  await sleep(300);
  const container = getAppContainer(ctx.udid, ctx.bundleId);
  if (container) {
    for (const dir of ['Library', 'Documents', 'tmp', 'Caches']) {
      try {
        rmSync(`${container}/${dir}`, { recursive: true, force: true });
      } catch {
        /* ok */
      }
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
