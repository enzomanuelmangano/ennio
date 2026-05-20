/**
 * DYLD-injection bootstrap for the ennio runtime helper.
 *
 * Zero-install path: instead of asking the host app to depend on
 * `@reactiive/ennio` + an Expo config plugin + a rebuild, ennio ships a
 * prebuilt dylib per supported RN version and DYLD_INSERT_LIBRARIES injects
 * it into the host process at launch. The dylib's `+load` swizzles
 * `RCTHost.start`, captures the live `jsi::Runtime`, and installs the same
 * `__ennioDispatch` host function the pod-based path installs.
 *
 * A tiny RN-agnostic shim (`libennio-shim.dylib`) is what we actually set
 * as the simulator's global DYLD_INSERT_LIBRARIES. The shim checks whether
 * the host process is a React Native app (RCTInstance class present) and
 * dlopens the real RN-version-specific dylib only then. This keeps
 * system processes (launchctl, SpringBoard helpers, lsd, etc.) from
 * crashing when they load our dylib globally and find no RN class to bind
 * against.
 */
import { createHash } from 'crypto';
import { execFileSync, execSync } from 'child_process';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

interface PreparedInjection {
  shim: string;
  slice: string;
  rnVersion: string;
}

interface Manifest {
  schema: number;
  shim: { file: string; sha256: string };
  slices: Record<string, { file: string; sha256: string }>;
}

function loadManifest(prebuilt: string): Manifest | null {
  const path = join(prebuilt, 'manifest.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Manifest;
  } catch {
    return null;
  }
}

function sha256Of(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function verifyAgainstManifest(prebuilt: string, file: string, expected: string | undefined): void {
  if (!expected) return; // No manifest entry — skip verification (dev build).
  const actual = sha256Of(file);
  if (actual !== expected) {
    throw new Error(
      `ennio dylib integrity check failed for ${file}. ` +
        `Expected sha256=${expected}, got ${actual}. ` +
        `If you built locally, regenerate the manifest: bash packages/ennio/scripts/regen-manifest.sh. ` +
        `If you got this from npm, the tarball may have been tampered with — refusing to inject.`,
    );
  }
}

function prebuiltDir(): string {
  // dist/cli.js is bundled by esbuild; the prebuilt slices live at
  // packages/ennio/prebuilt/. Resolve relative to this file's location at
  // runtime — works when developing (TS via tsx) and when published.
  const here =
    typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', 'prebuilt'),
    join(here, '..', '..', 'prebuilt'),
    join(here, '..', '..', '..', 'prebuilt'),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(`ennio prebuilt/ directory not found near ${here}`);
}

function readAppRNVersion(appBundlePath: string): string | null {
  // The RN bundle baked into the host app embeds its version in
  // hermes-engine.framework's Info.plist (matches RN's hermes-engine
  // package version) and in MainBundle Info.plist's `RNVersion` key when
  // the host app sets it. Try a few heuristics.
  const candidates = [
    join(appBundlePath, 'Frameworks', 'hermes.framework', 'Info.plist'),
    join(appBundlePath, 'Frameworks', 'hermes-engine.framework', 'Info.plist'),
    join(appBundlePath, 'Info.plist'),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const xml = execFileSync('plutil', ['-convert', 'json', '-o', '-', p], {
        encoding: 'utf-8',
      });
      const parsed = JSON.parse(xml);
      const v = parsed.CFBundleShortVersionString || parsed.RNVersion;
      if (typeof v === 'string') return v;
    } catch {
      /* try next */
    }
  }
  return null;
}

function pickSlice(prebuilt: string, rnVersion: string | null): { path: string; version: string } {
  // Match `libennio-rn<X.Y.Z>-sim.dylib`. Prefer exact patch match, fall
  // back to nearest minor (same X.Y).
  const slices = readdirSync(prebuilt)
    .filter((f) => f.startsWith('libennio-rn') && f.endsWith('-sim.dylib'))
    .map((f) => ({
      file: f,
      version: f.replace(/^libennio-rn/, '').replace(/-sim\.dylib$/, ''),
    }));
  if (slices.length === 0) {
    throw new Error(`No prebuilt ennio dylibs found in ${prebuilt}. Run scripts/build-dylib.sh.`);
  }
  if (rnVersion) {
    const exact = slices.find((s) => s.version === rnVersion);
    if (exact) return { path: join(prebuilt, exact.file), version: exact.version };
    const [maj, min] = rnVersion.split('.');
    const sameMinor = slices.find((s) => {
      const [a, b] = s.version.split('.');
      return a === maj && b === min;
    });
    if (sameMinor) return { path: join(prebuilt, sameMinor.file), version: sameMinor.version };
  }
  // No match — return the most recently modified slice as a best effort.
  const fallback = slices[0]!;
  return { path: join(prebuilt, fallback.file), version: fallback.version };
}

function findInstalledAppBundle(udid: string, bundleId: string): string | null {
  try {
    const out = execSync(`xcrun simctl listapps ${udid}`, { encoding: 'utf-8' });
    // The output is a plist; pull the Bundle path with a quick regex
    // instead of dragging in a plist parser for one field.
    const lines = out.split('\n');
    let inside = false;
    for (const line of lines) {
      if (line.includes(`"${bundleId}"`)) inside = true;
      if (inside) {
        const m = line.match(/Bundle\s*=\s*"file:\/\/([^"]+)"/);
        if (m) {
          // Strip trailing slash that the plist URL includes.
          return decodeURIComponent(m[1]!.replace(/\/$/, ''));
        }
      }
    }
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Ensure DYLD_INSERT_LIBRARIES is set on the booted simulator to inject
 * ennio's shim dylib. Idempotent: re-running with the same shim path is
 * a no-op. The shim is RN-agnostic; the real per-RN-version dylib path
 * is passed via the `ENNIO_DYLIB_PATH` env var so the shim knows which
 * slice to dlopen.
 *
 * Returns the resolved paths so the CLI can log them on startup.
 */
export function prepareDylibInjection(udid: string, bundleId: string): PreparedInjection {
  const prebuilt = prebuiltDir();
  const shim = join(prebuilt, 'libennio-shim.dylib');
  if (!existsSync(shim)) {
    throw new Error(`ennio shim missing at ${shim}. Run scripts/build-shim.sh to produce it.`);
  }

  const appBundle = findInstalledAppBundle(udid, bundleId);
  const rnVersion = appBundle ? readAppRNVersion(appBundle) : null;
  const slice = pickSlice(prebuilt, rnVersion);

  // Integrity gate: each shipped dylib has a known SHA-256 recorded in
  // prebuilt/manifest.json. We verify both the shim and the resolved
  // slice before arming DYLD_INSERT_LIBRARIES. A tampered file (anything
  // that doesn't match what CI signed) is refused — the user has to
  // either rebuild + regen the manifest locally or reinstall the package.
  // When no manifest is present (developer rebuild without regen), we
  // skip verification rather than fail loudly; that path is signposted
  // by `regen-manifest.sh`.
  const manifest = loadManifest(prebuilt);
  if (manifest) {
    verifyAgainstManifest(prebuilt, shim, manifest.shim?.sha256);
    const sliceEntry = manifest.slices[slice.version];
    verifyAgainstManifest(prebuilt, slice.path, sliceEntry?.sha256);
  }

  // Set env vars on the simulator's launchctl so any process spawned by
  // SpringBoard (including expo-dev-client deep-link relaunches) inherits
  // them. The shim's three-layer guard (RCTInstance present, bundle id
  // match, no App Store receipt) means setting these globally is safe:
  //   - System daemons load the shim and bail at guard #1.
  //   - Other RN apps the developer launches on the same sim while a
  //     test is mid-flight bail at guard #2 (bundle id mismatch).
  //   - Anything mis-installed as a release binary bails at guard #3.
  execSync(`xcrun simctl spawn ${udid} launchctl setenv DYLD_INSERT_LIBRARIES ${shim}`, {
    stdio: 'pipe',
  });
  execSync(`xcrun simctl spawn ${udid} launchctl setenv ENNIO_DYLIB_PATH ${slice.path}`, {
    stdio: 'pipe',
  });
  // Bundle-id gate: only THIS app, on THIS sim, gets the real dylib.
  execSync(`xcrun simctl spawn ${udid} launchctl setenv ENNIO_TARGET_BUNDLE_ID ${bundleId}`, {
    stdio: 'pipe',
  });

  return { shim, slice: slice.path, rnVersion: slice.version };
}

/**
 * Clear ennio's DYLD injection on the simulator. Call from a CLI cleanup
 * hook so a follow-up `maestro test` doesn't accidentally inherit the
 * injection. Best-effort; failures here aren't fatal.
 */
export function clearDylibInjection(udid: string): void {
  try {
    execSync(`xcrun simctl spawn ${udid} launchctl unsetenv DYLD_INSERT_LIBRARIES`, {
      stdio: 'pipe',
    });
    execSync(`xcrun simctl spawn ${udid} launchctl unsetenv ENNIO_DYLIB_PATH`, {
      stdio: 'pipe',
    });
    execSync(`xcrun simctl spawn ${udid} launchctl unsetenv ENNIO_TARGET_BUNDLE_ID`, {
      stdio: 'pipe',
    });
  } catch {
    /* ignore */
  }
}

/**
 * Register a process-exit cleanup hook so a CLI crash doesn't leave the
 * simulator with `DYLD_INSERT_LIBRARIES` armed pointing at a stale dylib.
 * Idempotent — re-registering is a no-op.
 */
let _exitHookRegistered = false;
export function registerCleanupOnExit(udid: string): void {
  if (_exitHookRegistered) return;
  _exitHookRegistered = true;
  const cleanup = () => clearDylibInjection(udid);
  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(143);
  });
  process.on('uncaughtException', (err) => {
    cleanup();
    console.error(err);
    process.exit(1);
  });
}

// Helper for callers (e.g. the test runner) to print a one-liner about
// the resolved injection on startup. Mirrors the formatting of other
// CLI banner lines.
export function describeInjection(p: PreparedInjection): string {
  return `(ennio injected: rn=${p.rnVersion}, slice=${p.slice.replace(prebuiltDir() + '/', '')})`;
}

// Re-export read for tests / advanced callers.
export { readAppRNVersion, pickSlice, loadManifest, sha256Of };
