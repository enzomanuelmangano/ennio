// adb helpers — the Android analogue of sim.ts. Picks the target serial,
// sets up the abstract-socket port forward the CLI uses to reach the
// in-app EnnioAgent, and drives app lifecycle (launch / clear-data /
// terminate) via `adb shell`.
//
// Transport model: the agent binds a LocalServerSocket in the abstract
// namespace named "ennio_<pid>" (per-process — a global fixed name lets a
// stale agent shadow the new one). `adb forward tcp:0 localabstract:ennio_<pid>`
// allocates a host TCP port that routes to it; the CLI's socket client
// connects to 127.0.0.1:<port>. Because the name is pid-scoped, the forward
// must be re-pointed at the new pid on every (re)launch — see refreshForward
// in android.ts.

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const ABSTRACT_SOCKET_NAME = 'ennio';

function adb(
  serial: string | undefined,
  args: string[],
  opts: { encoding?: 'utf-8'; timeoutMs?: number } = {},
): string {
  const full = serial ? ['-s', serial, ...args] : args;
  return execFileSync('adb', full, {
    encoding: opts.encoding ?? 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    // A bounded wait for blocking commands (e.g. `am start -W`) so a wedged
    // launch can't hang the whole CLI; on timeout execFileSync throws and the
    // caller decides what to do.
    ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}),
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
export function setupForward(serial: string, socketName: string = ABSTRACT_SOCKET_NAME): number {
  const out = adb(serial, ['forward', 'tcp:0', `localabstract:${socketName}`]).trim();
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

// Serials whose show_touches we flipped, with the value to put back.
const showTouchesRestore = new Map<string, string>();

/**
 * Turn on Android's OS-level "show touches" pointer indicator (the
 * --show-touches flag). ennio's gestures are injected MotionEvents, so
 * the OS renders them exactly like real fingers — no in-app overlay
 * needed. The user's prior setting is restored on process exit; only
 * the first call per serial snapshots it (later calls would snapshot
 * our own '1').
 */
export function enableShowTouches(serial: string): void {
  if (showTouchesRestore.has(serial)) return;
  let prev = '0';
  try {
    const v = adb(serial, ['shell', 'settings', 'get', 'system', 'show_touches']).trim();
    if (v && v !== 'null') prev = v;
  } catch {
    /* unreadable — assume default off */
  }
  try {
    adb(serial, ['shell', 'settings', 'put', 'system', 'show_touches', '1']);
  } catch {
    return; // device gone — nothing to restore either
  }
  showTouchesRestore.set(serial, prev);
  if (showTouchesRestore.size === 1) {
    process.on('exit', () => {
      for (const [s, value] of showTouchesRestore) {
        try {
          adb(s, ['shell', 'settings', 'put', 'system', 'show_touches', value]);
        } catch {
          /* device gone */
        }
      }
    });
  }
}

/** Launch the app's default launcher activity and WAIT for it to be displayed.
 *
 *  `am start -W` blocks until the launch settles (Application constructed, first
 *  Activity displayed, process quiescent). This is the deterministic core of the
 *  inject path: we inject into a SETTLED process, not the zygote-fork instant
 *  `pidof` first sees. Injecting at fork was the root of the Android flake — the
 *  agent then raced the app's cold start (Application not yet built → no bind)
 *  AND ptrace had to attach to a process still churning through dex2oat/GC,
 *  which silently no-op'd. Wait for the display event first and both disappear:
 *  currentApplication() is immediately non-null and the target is calm, so the
 *  bind is first-try deterministic (no retry loop relied upon).
 *
 *  Bounded so a genuinely broken launch can't hang the CLI; on timeout we
 *  proceed anyway (the inject path's own readiness checks still cover the rare
 *  slow-display case). monkey is the no-component fallback. */
export function launchAndroidApp(serial: string, pkg: string): void {
  // Prefer explicit component (faster, no monkey noise); fall back to monkey.
  try {
    adb(
      serial,
      [
        'shell',
        'am',
        'start',
        '-W',
        '-n',
        `${pkg}/.MainActivity`,
        '-a',
        'android.intent.action.MAIN',
      ],
      { timeoutMs: 45_000 },
    );
    return;
  } catch {
    /* component name may differ, or -W timed out — fall through */
  }
  try {
    adb(serial, ['shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1']);
  } catch {
    /* best effort — the inject path waits for the pid + readiness regardless */
  }
}

/** Block the calling (synchronous) path for `ms` without busy-spinning the
 *  CPU. Atomics.wait on a private buffer parks the thread; used to pace the
 *  few sync poll loops here where async/await isn't available. */
function syncSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Resolve the app's pid, polling up to maxMs for the process to appear after
 *  a launch. Returns null if it never starts. Paces each poll explicitly
 *  rather than leaning on the `pidof` round-trip as an implicit timer — a
 *  bounded poll, not a hot spin (see no-blind-sleeps). */
export function waitForAppPid(serial: string, pkg: string, maxMs = 8000): string | null {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const pid = adb(serial, ['shell', 'pidof', pkg]).trim().split(/\s+/)[0];
      if (pid && /^\d+$/.test(pid)) return pid;
    } catch {
      /* not up yet */
    }
    syncSleep(50);
  }
  return null;
}

/** One-shot pid lookup, no polling. Returns the app's current pid or null.
 *  Used to tell a DEAD injected process (relaunch) from a slow-but-LIVE one
 *  (keep waiting) — the deciding signal for the inject/readiness waits, so
 *  they never tear down a healthy agent nor spin forever on a corpse. */
export function appPidNow(serial: string, pkg: string): string | null {
  try {
    const pid = adb(serial, ['shell', 'pidof', pkg]).trim().split(/\s+/)[0];
    return pid && /^\d+$/.test(pid) ? pid : null;
  } catch {
    return null;
  }
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

/** Is the installed app debuggable? (dumpsys lists flags by name.) Selects the
 *  injection path: debuggable → am attach-agent (no root); else → ptrace. */
export function isAppDebuggable(serial: string, pkg: string): boolean {
  try {
    return /\bDEBUGGABLE\b/.test(adb(serial, ['shell', 'dumpsys', 'package', pkg]));
  } catch {
    return false;
  }
}

/** Restart adbd as root and return whether we got it. Works on userdebug
 *  emulators/devices (the test-harness target); a no-op "already root" is fine.
 *  Production user builds refuse — caller then needs a debuggable app. */
export function enableRoot(serial: string): boolean {
  try {
    adb(serial, ['root']);
  } catch {
    /* may print "restarting adbd as root" to stderr; ignore */
  }
  try {
    adb(serial, ['wait-for-device']);
    return /uid=0/.test(adb(serial, ['shell', 'id']));
  } catch {
    return false;
  }
}

/** Put SELinux in permissive mode. The ptrace path maps the agent .so
 *  executable from the app sandbox, which enforcing SELinux blocks for a
 *  non-debuggable app; the emulator is a permissive test context (the parallel
 *  of the iOS Simulator). Best-effort; needs root. */
export function setSelinuxPermissive(serial: string): void {
  try {
    adb(serial, ['shell', 'setenforce', '0']);
  } catch {
    /* not root / already permissive */
  }
}

/** Push the on-device ptrace injector and make it executable. */
export function pushInjector(serial: string, hostPath: string): string {
  const remote = '/data/local/tmp/ennio_ptrace';
  adb(serial, ['push', hostPath, remote]);
  adb(serial, ['shell', 'chmod', '755', remote]);
  return remote;
}

/**
 * Inject the agent via ptrace — the "any app" path. Works on ANY process,
 * including a non-debuggable release build, because root + ptrace bypass the
 * runtime debuggable gate that am attach-agent enforces. Needs root (emulator).
 *
 * Delivery: as root, copy the .so into the target's code_cache and relabel it
 * to the app's SELinux context (so the app can map it), then run the injector,
 * which remote-dlopens it. The agent's constructor finds the VM and starts.
 */
export function ptraceInjectAgent(
  serial: string,
  pkg: string,
  pid: string,
  tmpSoPath: string,
  injectorPath: string,
): void {
  const uid = adb(serial, ['shell', 'stat', '-c', '%u', `/data/data/${pkg}`]).trim();
  const cc = `/data/data/${pkg}/code_cache/libennio.so`;
  adb(serial, [
    'shell',
    `mkdir -p /data/data/${pkg}/code_cache && cp ${tmpSoPath} ${cc} && ` +
      `chown ${uid}:${uid} ${cc} && chmod 700 ${cc} && restorecon ${cc}`,
  ]);
  const out = adb(serial, ['shell', `${injectorPath} ${pid} ${cc}`]);
  if (!/OK dlopen/.test(out)) {
    throw new Error(`ptrace inject failed: ${out.trim().split('\n').slice(-2).join(' ')}`);
  }
}

/** Is the agent's abstract socket actually bound? `ptraceInjectAgent` only
 *  confirms the dlopen — the agent's constructor (JVM attach + LocalServerSocket
 *  bind) runs after that and can fail silently on an unstable cold-start
 *  process, leaving no socket and a ~14s readiness timeout to discover it.
 *  Abstract sockets appear in /proc/net/unix prefixed with '@', so a quick grep
 *  confirms the bind in ~ms. */
export function abstractSocketBound(serial: string, name: string): boolean {
  try {
    const out = adb(serial, ['shell', `cat /proc/net/unix | grep @${name}`]);
    return out.includes(`@${name}`);
  } catch {
    // grep exits non-zero (→ throw) when the socket isn't present yet.
    return false;
  }
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

/** Open a deep link via the VIEW intent.
 *
 *  NOTE: deliberately NOT using `am start -W` here. -W is the right tool for the
 *  plain launcher path (launchAndroidApp) where we just need a settled process
 *  before injecting. The deep-link COLD path is more delicate — react-navigation
 *  routes the initial-URL vs onNewIntent differently, and -W's "wait for the
 *  first display" can return on the launcher/home frame BEFORE the JS deep-link
 *  routing runs, masking a mis-route. Keep the deep-link delivery as the bare
 *  VIEW intent the routing logic was tuned against; the inject path's own
 *  readiness checks cover the settle. */
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
