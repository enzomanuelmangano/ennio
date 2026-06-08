// adb helpers — the Android analogue of sim.ts. Picks the target serial,
// sets up the abstract-socket port forward the CLI uses to reach the
// in-app EnnioAgent, and drives app lifecycle (launch / clear-data /
// terminate) via `adb shell`.
//
// Transport model: the agent binds a LocalServerSocket in the abstract
// namespace named "ennio". `adb forward tcp:0 localabstract:ennio`
// allocates a host TCP port that routes to it; the CLI's socket client
// connects to 127.0.0.1:<port>. The forward survives app restarts (it
// targets the abstract name, which the new process re-binds), so we set
// it up once per session and reconnect the TCP client after each launch.

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const ABSTRACT_SOCKET_NAME = 'ennio';

function adb(
  serial: string | undefined,
  args: string[],
  opts: { encoding?: 'utf-8' } = {},
): string {
  const full = serial ? ['-s', serial, ...args] : args;
  return execFileSync('adb', full, {
    encoding: opts.encoding ?? 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as string;
}

/** Pick the target adb serial: ENNIO_UDID override, else first online device. */
export function getAndroidSerial(): string | null {
  if (process.env.ENNIO_UDID) return process.env.ENNIO_UDID;
  try {
    const out = execFileSync('adb', ['devices'], { encoding: 'utf-8' });
    for (const line of out.split('\n').slice(1)) {
      const [serial, state] = line.trim().split(/\s+/);
      if (serial && state === 'device') return serial;
    }
  } catch {
    /* adb not installed / no devices */
  }
  return null;
}

/**
 * Establish the abstract-socket forward and return the allocated host
 * TCP port. Idempotent-ish: a fresh `forward tcp:0` allocates a new port
 * each call, so callers should set it up once and cache the port.
 */
export function setupForward(serial: string): number {
  const out = adb(serial, ['forward', 'tcp:0', `localabstract:${ABSTRACT_SOCKET_NAME}`]).trim();
  const port = parseInt(out, 10);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`adb forward returned unexpected output: "${out}"`);
  }
  return port;
}

export function removeForward(serial: string, port: number): void {
  try {
    adb(serial, ['forward', '--remove', `tcp:${port}`]);
  } catch {
    /* already gone */
  }
}

/** Launch the app's default launcher activity. monkey is the most robust
 *  cross-app way to start the LAUNCHER intent without knowing the
 *  activity class name. */
export function launchAndroidApp(serial: string, pkg: string): void {
  // Prefer explicit component (faster, no monkey noise); fall back to monkey.
  try {
    adb(serial, [
      'shell',
      'am',
      'start',
      '-n',
      `${pkg}/.MainActivity`,
      '-a',
      'android.intent.action.MAIN',
    ]);
    return;
  } catch {
    /* component name may differ — fall back */
  }
  adb(serial, ['shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1']);
}

/** Resolve the app's pid, polling up to maxMs for the process to appear after
 *  a launch (each `pidof` round-trip is ~50ms, which paces the loop). Returns
 *  null if it never starts. */
export function waitForAppPid(serial: string, pkg: string, maxMs = 8000): string | null {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const pid = adb(serial, ['shell', 'pidof', pkg]).trim().split(/\s+/)[0];
      if (pid && /^\d+$/.test(pid)) return pid;
    } catch {
      /* not up yet */
    }
  }
  return null;
}

/** The device's primary ABI (e.g. arm64-v8a, x86_64) — selects the matching
 *  prebuilt agent .so. */
export function getDeviceAbi(serial: string): string {
  return adb(serial, ['shell', 'getprop', 'ro.product.cpu.abi']).trim();
}

/** Push the host agent .so to a device-global scratch path. SELinux lets an
 *  app READ /data/local/tmp (so it can be copied into the app sandbox) but NOT
 *  map it executable — hence the later run-as copy into code_cache. */
export function pushAgentToTmp(serial: string, hostSoPath: string): string {
  const remote = '/data/local/tmp/libennio.so';
  adb(serial, ['push', hostSoPath, remote]);
  return remote;
}

/**
 * Deterministically inject the agent into a running app — the wrap.sh-free
 * replacement for the racy LD_PRELOAD path. App-agnostic: works on ANY app in
 * a debuggable context (a debuggable build, or any app on a userdebug
 * device/emulator), with NO modification or repackaging of the target.
 *
 * Mechanism (the same one Android Studio's profiler uses):
 *   1. run-as <pkg> copies the .so from /data/local/tmp into the app's OWN
 *      code_cache — the app can map-execute from its sandbox, but not from
 *      /data/local/tmp (SELinux W^X).
 *   2. `am attach-agent <pid> <code_cache path>` — the ART runtime dlopens it
 *      and calls Agent_OnAttach with the live VM. No shell wrapper, no seccomp
 *      setgid (SIGSYS) race, no zombie socket: the attach either loads the
 *      agent or errors loudly.
 *
 * The full code_cache path is used (not a bare soname) because the target app
 * has no libennio.so in its linker namespace; the path is /data/data/<pkg>/…
 * which, unlike the /data/app/~~<base64>==/ install dir, contains no "=" for
 * the am argument parser to truncate.
 */
export function stageAndAttachAgent(
  serial: string,
  pkg: string,
  pid: string,
  tmpSoPath: string,
): void {
  const codeCache = `/data/data/${pkg}/code_cache/libennio.so`;
  // Pass the run-as body as ONE shell string: `adb shell` joins argv with
  // spaces and the device shell re-parses, so the && chain and the sh -c
  // script must be a single quoted token or mkdir/cp/chmod get split apart.
  const stage =
    `run-as ${pkg} sh -c 'mkdir -p code_cache && ` +
    `cp ${tmpSoPath} code_cache/libennio.so && ` +
    `chmod 700 code_cache/libennio.so'`;
  adb(serial, ['shell', stage]);
  adb(serial, ['shell', 'am', 'attach-agent', pid, codeCache]);
}

/** Wipe app data (UserDefaults / files / databases). Android's `pm clear`
 *  is the equivalent of the iOS data-container wipe. */
export function clearAppData(serial: string, pkg: string): void {
  adb(serial, ['shell', 'pm', 'clear', pkg]);
}

export function terminateAndroidApp(serial: string, pkg: string): void {
  try {
    adb(serial, ['shell', 'am', 'force-stop', pkg]);
  } catch {
    /* not running */
  }
}

export function isAppInstalled(serial: string, pkg: string): boolean {
  try {
    const out = adb(serial, ['shell', 'pm', 'list', 'packages', pkg]);
    return out.includes(`package:${pkg}`);
  } catch {
    return false;
  }
}

export function installApk(serial: string, apkPath: string): void {
  adb(serial, ['install', '-r', '-g', apkPath]);
}

/** Open a deep link via the VIEW intent. */
export function openAndroidUrl(serial: string, pkg: string, url: string): void {
  adb(serial, ['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', url, pkg]);
}

/** Inject a system BACK key — the real OS back path. Needed to pop a
 *  poppable native-stack screen whose back is owned by the API 33+
 *  predictive-back OnBackInvokedDispatcher, which no in-process call can
 *  trigger. The agent gates this to poppable screens so it never exits the
 *  app at a navigation root. */
export function pressHardwareBack(serial: string): void {
  adb(serial, ['shell', 'input', 'keyevent', 'KEYCODE_BACK']);
}

/** Grant all runtime permissions declared by the app (best-effort). */
export function grantAllPermissions(serial: string, pkg: string): void {
  // Common runtime perms the example might prompt for; ignore failures
  // for perms the app didn't declare.
  const perms = [
    'android.permission.POST_NOTIFICATIONS',
    'android.permission.ACCESS_FINE_LOCATION',
    'android.permission.CAMERA',
    'android.permission.READ_MEDIA_IMAGES',
  ];
  for (const p of perms) {
    try {
      adb(serial, ['shell', 'pm', 'grant', pkg, p]);
    } catch {
      /* not declared */
    }
  }
}

/** Capture a PNG screenshot to `path` via `screencap` (stdout is the raw
 *  PNG; exec-out avoids the CRLF mangling `adb shell` would inflict). */
export function screenshot(serial: string, path: string): void {
  const png = execFileSync('adb', ['-s', serial, 'exec-out', 'screencap', '-p'], {
    maxBuffer: 64 * 1024 * 1024,
  }) as Buffer;
  writeFileSync(path, png);
}

/** Set the system clipboard (best-effort; the `cmd clipboard` service
 *  isn't available on every image). */
export function setClipboard(serial: string, text: string): void {
  try {
    adb(serial, ['shell', 'cmd', 'clipboard', 'set-text', text]);
  } catch {
    /* clipboard service unavailable — skip */
  }
}

export function getClipboard(serial: string): string {
  try {
    return adb(serial, ['shell', 'cmd', 'clipboard', 'get-text']).trim();
  } catch {
    return '';
  }
}

/** Disable system animations for speed (the Android equivalent of
 *  --no-animations; far cleaner than the iOS swizzle). */
export function setNoAnimations(serial: string, on: boolean): void {
  const scale = on ? '0' : '1';
  for (const k of [
    'window_animation_scale',
    'transition_animation_scale',
    'animator_duration_scale',
  ]) {
    try {
      adb(serial, ['shell', 'settings', 'put', 'global', k, scale]);
    } catch {
      /* best effort */
    }
  }
}
