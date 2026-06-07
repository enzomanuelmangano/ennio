// Simulator orchestration helpers for the v2 architecture.
//
// Four jobs:
//   1. Pick the active iOS Simulator UDID (env override or first booted;
//      auto-boot the first sim if none is booted).
//   2. Resolve a bundle id's data container.
//   3. Launch / terminate apps with `SIMCTL_CHILD_DYLD_INSERT_LIBRARIES`
//      so the libennio.dylib is injected at attach time.
//   4. Locate the prebuilt libennio.dylib that ships with the package.
//
// No XCTest, no WebDriverAgent, no Hermes Inspector page-discovery.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

/**
 * Turn on the simulator's accessibility automation server. SwiftUI (and
 * some UIKit) build their accessibility tree LAZILY — only once an
 * accessibility client is active. With it off, a SwiftUI screen (e.g.
 * iOS Settings) exposes NOTHING to an in-process walk: the rows are
 * drawn, not UILabels, and no a11y nodes exist yet. Flipping this on
 * makes SwiftUI materialize its tree, which ennio's in-process
 * find_ax_by_text then reads directly (~50ms) — no XCUITest.
 * Idempotent + best-effort; runs once per flow.
 */
export function enableAccessibility(udid: string): void {
  const set = (key: string) => {
    try {
      execFileSync(
        'xcrun',
        ['simctl', 'spawn', udid, 'defaults', 'write', 'com.apple.Accessibility', key, '-int', '1'],
        { stdio: 'pipe' },
      );
    } catch {
      /* best effort */
    }
  };
  set('ApplicationAccessibilityEnabled');
  set('AccessibilityEnabled');
  // Poke the a11y caches so already-running apps rebuild their tree
  // without needing a relaunch.
  for (const note of ['com.apple.accessibility.cache.ax', 'com.apple.accessibility.cache.app.ax']) {
    try {
      execFileSync('xcrun', ['simctl', 'spawn', udid, 'notifyutil', '-p', note], { stdio: 'pipe' });
    } catch {
      /* best effort */
    }
  }
}

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

export function uninstallApp(udid: string, bundleId: string): void {
  try {
    execFileSync('xcrun', ['simctl', 'uninstall', udid, bundleId], { stdio: 'pipe' });
  } catch {
    // App may not be installed.
  }
}

export function getAppBundlePath(udid: string, bundleId: string): string | null {
  try {
    const out = execFileSync('xcrun', ['simctl', 'get_app_container', udid, bundleId, 'app'], {
      encoding: 'utf-8',
    });
    return out.trim();
  } catch {
    return null;
  }
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

/**
 * Locate the libennio.dylib that ships with the package. Search order:
 *   1. ENNIO_DYLIB_PATH env var (explicit override)
 *   2. /tmp/ennio-build/libennio.dylib (local dev build)
 *   3. <package>/prebuilt/libennio.dylib (npm tarball)
 *   4. <package>/dist/libennio.dylib (alternative install)
 *
 * Returns null if nothing is found — caller surfaces an actionable
 * message to the user.
 */
export function findDylib(): string | null {
  if (process.env.ENNIO_DYLIB_PATH) {
    return existsSync(process.env.ENNIO_DYLIB_PATH) ? process.env.ENNIO_DYLIB_PATH : null;
  }
  const candidates: string[] = [
    '/tmp/ennio-build/libennio.dylib',
    // The CLI is bundled to dist/cli.js, so __dirname at runtime is the
    // dist directory. Walk up to package root.
    resolve(dirname(__filename), '..', 'prebuilt', 'libennio.dylib'),
    resolve(dirname(__filename), '..', 'libennio.dylib'),
    resolve(dirname(__filename), 'libennio.dylib'),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    verifyDylibIntegrity(p);
    return p;
  }
  return null;
}

/**
 * Verify a prebuilt artifact's SHA-256 against the manifest.json
 * sitting next to it, when one exists. Scope is deliberate:
 *
 *   - <pkg>/prebuilt/ artifacts ship WITH a manifest — a hash mismatch
 *     means a corrupted install or a tampered binary we're about to
 *     inject into the user's app (dylib) or spawn on the host (hid).
 *     Refuse loudly.
 *   - /tmp/ennio-build (local dev builds) and explicit env-var
 *     overrides have no manifest next to them — nothing to check,
 *     returns silently.
 *
 * `key` selects the manifest entry: 'dylib' | 'hid' | 'shim'.
 * Exported for tests.
 */
export function verifyPrebuiltIntegrity(
  artifactPath: string,
  key: 'dylib' | 'hid' | 'shim' = 'dylib',
  manifestPath?: string,
): void {
  const manifest = manifestPath ?? join(dirname(artifactPath), 'manifest.json');
  if (!existsSync(manifest)) return;
  let expected: string | undefined;
  try {
    const parsed = JSON.parse(readFileSync(manifest, 'utf-8')) as Record<
      string,
      { file?: string; sha256?: string } | undefined
    >;
    expected = parsed[key]?.sha256;
  } catch {
    return; // unreadable manifest — don't block on our own packaging bug
  }
  if (!expected) return;
  const actual = createHash('sha256').update(readFileSync(artifactPath)).digest('hex');
  if (actual !== expected) {
    throw new Error(
      `${key} artifact SHA-256 mismatch at ${artifactPath}\n` +
        `  expected ${expected}\n  actual   ${actual}\n` +
        'The prebuilt artifact does not match the package manifest — corrupted ' +
        'install or tampered binary. Reinstall @reactiive/ennio. ' +
        'To use a custom build instead, set ENNIO_DYLIB_PATH / ENNIO_HID_HELPER.',
    );
  }
}

/** Back-compat alias for the dylib-specific call sites/tests. */
export function verifyDylibIntegrity(dylibPath: string, manifestPath?: string): void {
  verifyPrebuiltIntegrity(dylibPath, 'dylib', manifestPath);
}

/**
 * Boot the first non-booted iOS Simulator if none is currently booted.
 * Used so users don't have to manually `xcrun simctl boot ...` before
 * running tests. Returns the UDID of the booted (or already-booted)
 * device, or null if no sims exist.
 */
export function ensureBootedSim(): string | null {
  const already = getTargetUdid();
  if (already) return already;
  try {
    const json = execFileSync('xcrun', ['simctl', 'list', 'devices', 'available', '-j'], {
      encoding: 'utf-8',
    });
    const data = JSON.parse(json) as {
      devices?: Record<string, { udid: string; state: string; name: string }[]>;
    };
    const buckets = data.devices ?? {};
    // Prefer iPhone runtimes from the latest iOS available.
    const runtimes = Object.keys(buckets).sort().reverse();
    for (const r of runtimes) {
      for (const d of buckets[r]) {
        if (d.name.startsWith('iPhone') && d.state !== 'Booted') {
          execFileSync('xcrun', ['simctl', 'boot', d.udid], { stdio: 'pipe' });
          return d.udid;
        }
      }
    }
  } catch {
    /* fall through */
  }
  return null;
}

// Silence unused-import warning for the alternate path resolver.
void join;
