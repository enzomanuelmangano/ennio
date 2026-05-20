// Simulator orchestration helpers for the v2 architecture.
//
// Three jobs:
//   1. Pick the active iOS Simulator UDID (env override or first booted).
//   2. Resolve a bundle id's data container (used to find the dylib
//      socket path — though in v0.1 we use the global /tmp socket).
//   3. Launch / terminate apps with `SIMCTL_CHILD_DYLD_INSERT_LIBRARIES`
//      so the libennio.dylib is injected at attach time.
//
// No XCTest, no WebDriverAgent, no Hermes Inspector page-discovery.

import { execFileSync } from 'node:child_process';

export function getTargetUdid(): string | null {
  if (process.env.ENNIO_UDID) return process.env.ENNIO_UDID;
  try {
    const json = execFileSync('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'], {
      encoding: 'utf-8',
    });
    const data = JSON.parse(json) as {
      devices?: Record<string, { udid: string; state: string }[]>;
    };
    const buckets = data.devices ?? {};
    for (const key of Object.keys(buckets)) {
      for (const d of buckets[key]) {
        if (d.state === 'Booted') return d.udid;
      }
    }
  } catch {
    /* fall through */
  }
  return null;
}

export function terminateApp(udid: string, bundleId: string): void {
  try {
    execFileSync('xcrun', ['simctl', 'terminate', udid, bundleId], { stdio: 'pipe' });
  } catch {
    // App may not be running — that's OK.
  }
}

export function installApp(udid: string, appPath: string): void {
  execFileSync('xcrun', ['simctl', 'install', udid, appPath], { stdio: 'inherit' });
}

/**
 * Launch an app with DYLD_INSERT_LIBRARIES set on the child process only
 * (via SIMCTL_CHILD_*). Avoids polluting launchctl's global env, which
 * would attach the dylib to every subsequent process spawned through
 * launchctl on the sim — including non-iOS-app helpers like
 * proactiveeventtrackerd.
 */
export function launchAppWithDylib(udid: string, bundleId: string, dylibPath: string): void {
  const env = {
    ...process.env,
    SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: dylibPath,
  };
  execFileSync('xcrun', ['simctl', 'launch', '--terminate-running-process', udid, bundleId], {
    env,
    stdio: 'pipe',
  });
}

/**
 * Cold-launch the app without injection — used after a sandbox wipe
 * when we want to verify the app boots cleanly on its own. Not used
 * in the normal flow but handy for diagnostics.
 */
export function launchApp(udid: string, bundleId: string): void {
  execFileSync('xcrun', ['simctl', 'launch', '--terminate-running-process', udid, bundleId], {
    stdio: 'pipe',
  });
}

export function getAppContainer(udid: string, bundleId: string): string | null {
  try {
    const out = execFileSync('xcrun', ['simctl', 'get_app_container', udid, bundleId, 'data'], {
      encoding: 'utf-8',
    });
    return out.trim();
  } catch {
    return null;
  }
}
