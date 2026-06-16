// AndroidPlatform — the emulator/device backend. Mirrors IosPlatform but
// drives the device through adb instead of simctl, reaches the in-app
// EnnioAgent over an adb-forwarded TCP port instead of a Unix socket, and
// uses the in-process MotionEvent driver for gestures.
//
// Lifecycle mapping (iOS → Android):
//   simctl launch              → adb shell am start / monkey
//   simctl terminate           → adb shell am force-stop
//   data-container wipe        → adb shell pm clear
//   SIMCTL_CHILD_DYLD_INSERT   → am attach-agent: push the agent .so, run-as
//                                copy it into the target app's code_cache,
//                                then attach it as a JVMTI agent (deterministic,
//                                app-agnostic — no repackaging of the target)
//   /tmp Unix socket           → adb forward tcp:0 localabstract:ennio

import { existsSync } from 'node:fs';

import { getActiveConnection } from '../core/active-connections';
import { EnnioConnection } from '../core/ennio-connection';
import { createAndroidDriver } from '../driver';
import type { GestureDriver } from '../driver';
import { sleep } from '../runner/context';
import type { RunContext } from '../runner/context';
import type { ConnectTarget } from '../socket-client';
import {
  abstractSocketBound,
  appPidNow,
  clearAppData,
  enableRoot,
  enableShowTouches,
  getAndroidSerial,
  getClipboard,
  getDeviceAbi,
  grantAllPermissions,
  isAppDebuggable,
  pressHardwareBack,
  launchAndroidApp,
  openAndroidUrl,
  ptraceInjectAgent,
  pushAgentToTmp,
  pushInjector,
  removeForward,
  screenshot,
  setClipboard,
  setSelinuxPermissive,
  setupForward,
  stageAndAttachAgent,
  terminateAndroidApp,
  waitForAppPid,
} from '../android/adb';

import type { AxBridge, ConnectOptions, OpenConnection, Platform, SystemBridge } from './types';

export class AndroidPlatform implements Platform {
  readonly name = 'android' as const;

  // The in-app agent already traverses the whole view tree (native menus
  // and dialogs included), so there is no cross-process tree to read and
  // no separate system sheet to dismiss — a null object.
  readonly ax: AxBridge = {
    resolve: async () => null,
    // The in-app tree walk can't tap a value hidden inside a closed native
    // widget (Spinner / NumberPicker). When the normal find→tap misses,
    // this routes a text selector to the agent's native_select, which sets
    // the widget selection programmatically. iOS-authored picker flows
    // (tapOn 'Banana') then work unchanged on Android.
    tapTarget: async (udid, sel) => {
      const socket = getActiveConnection(udid).socket;
      // An id that the normal find missed may be a horizontal-list item the
      // Android removeClippedSubviews optimization detached off-viewport.
      // reveal_tap sweeps the scroller to re-materialize it, then taps.
      if (sel.id) {
        try {
          const r = await socket.call('reveal_tap', { testID: sel.id });
          if (r.ok && r.data && (r.data as { tapped?: boolean }).tapped) return true;
        } catch {
          /* fall through */
        }
      }
      if (!sel.text) return false;
      try {
        const r = await socket.call('native_select', { text: sel.text });
        return !!(r.ok && r.data && (r.data as { selected?: boolean }).selected);
      } catch {
        return false;
      }
    },
    dismissSystemSheet: async () => false,
    textFieldId: async () => null,
    focusTextField: async () => false,
  };

  readonly system: SystemBridge = {
    screenshot: (udid, path) => screenshot(udid, path),
    // No separate OS keychain on Android — pm clear already wipes the
    // app's keystore-backed data, so this is a no-op.
    clearKeychain: () => {},
    setClipboard: (udid, text) => setClipboard(udid, text),
    getClipboard: (udid) => getClipboard(udid),
    hardwareBack: (udid) => pressHardwareBack(udid),
  };

  // adb-forwarded TCP port → the device's `@ennio_<pid>` abstract socket.
  // The agent's socket name is pid-scoped, so the forward must be re-pointed
  // at the new pid on every (re)launch — see refreshForward.
  private forwardPort = new Map<string, number>();

  // The agent .so, pushed to the device's /data/local/tmp once per serial
  // (re-staged into each app's code_cache on every attach).
  private pushedSo = new Map<string, string>();

  /**
   * Resolve the host path to the agent .so matching the device ABI. Override
   * with ENNIO_ANDROID_AGENT (a direct .so path). Otherwise look for an
   * ABI-suffixed prebuilt next to the package, then the local build output of
   * android-inject/scripts/build-android.sh. The iOS analogue is
   * ENNIO_DYLIB_PATH.
   */
  private resolveAgentSo(serial: string): string {
    const override = process.env.ENNIO_ANDROID_AGENT;
    if (override) {
      if (!existsSync(override)) {
        throw new Error(`ENNIO_ANDROID_AGENT points to a missing file: ${override}`);
      }
      return override;
    }
    const abi = getDeviceAbi(serial);
    const candidates = [
      // Packaged prebuilts (shipped in the npm tarball, one per ABI).
      `${__dirname}/../../prebuilt/libennio-${abi}.so`,
      `${__dirname}/../../../prebuilt/libennio-${abi}.so`,
      // Local dev: build-android.sh output (single ABI per build).
      '/tmp/ennio-android/libennio.so',
    ];
    const found = candidates.find((p) => existsSync(p));
    if (!found) {
      throw new Error(
        `No Android agent .so found for ABI ${abi}. Build it with ` +
          'packages/ennio/android-inject/scripts/build-android.sh ' +
          `(ENNIO_ABI=${abi}), or set ENNIO_ANDROID_AGENT to its path.`,
      );
    }
    return found;
  }

  /** Push the agent .so to /data/local/tmp once per device serial. */
  private ensureAgentPushed(serial: string): string {
    let remote = this.pushedSo.get(serial);
    if (!remote) {
      remote = pushAgentToTmp(serial, this.resolveAgentSo(serial));
      this.pushedSo.set(serial, remote);
    }
    return remote;
  }

  // Injection method per serial: 'attach' (am attach-agent — needs a debuggable
  // app, no root) or 'ptrace' (root + ptrace remote-dlopen — works on ANY app,
  // incl. a non-debuggable release build). Plus the pushed injector path.
  private injectMode = new Map<string, 'attach' | 'ptrace'>();
  private pushedInjector = new Map<string, string>();

  /** Host path to the ptrace injector matching the device ABI. */
  private resolveInjector(serial: string): string {
    const override = process.env.ENNIO_ANDROID_INJECTOR;
    if (override) {
      if (!existsSync(override)) {
        throw new Error(`ENNIO_ANDROID_INJECTOR points to a missing file: ${override}`);
      }
      return override;
    }
    const abi = getDeviceAbi(serial);
    const candidates = [
      `${__dirname}/../../prebuilt/ennio_ptrace-${abi}`,
      `${__dirname}/../../../prebuilt/ennio_ptrace-${abi}`,
      '/tmp/ennio-android/ennio_ptrace',
    ];
    const found = candidates.find((p) => existsSync(p));
    if (!found) {
      throw new Error(
        `No ptrace injector found for ABI ${abi}. Build it with ` +
          `android-inject/scripts/build-android.sh (ENNIO_ABI=${abi}), or set ENNIO_ANDROID_INJECTOR.`,
      );
    }
    return found;
  }

  /**
   * Decide and prepare the injection method for a device, ONCE per serial.
   *
   * Auto: a debuggable app uses am attach-agent (clean, no root); a
   * non-debuggable one needs ptrace. Override with ENNIO_ANDROID_INJECT=attach|ptrace.
   *
   * Must run BEFORE any adb forward — enabling root restarts adbd and would drop
   * forwards. ptrace also flips SELinux permissive and pushes the injector.
   */
  private prepareInjection(serial: string, bundleId: string): 'attach' | 'ptrace' {
    const cached = this.injectMode.get(serial);
    if (cached) return cached;
    const forced = process.env.ENNIO_ANDROID_INJECT as 'attach' | 'ptrace' | undefined;
    const mode = forced ?? (isAppDebuggable(serial, bundleId) ? 'attach' : 'ptrace');
    if (mode === 'ptrace') {
      if (!enableRoot(serial)) {
        throw new Error(
          `Cannot inject into non-debuggable ${bundleId}: ptrace needs root (adb root), ` +
            'available on emulators/userdebug. Use a debuggable build, or run on an emulator.',
        );
      }
      setSelinuxPermissive(serial);
      this.pushedInjector.set(serial, pushInjector(serial, this.resolveInjector(serial)));
    }
    this.injectMode.set(serial, mode);
    return mode;
  }

  createDriver(_fast: boolean): GestureDriver {
    // Android gestures are always in-process MotionEvent dispatch; there
    // is no HID-vs-fast distinction. The flag is accepted for API parity.
    return createAndroidDriver();
  }

  private resolveSerial(udid?: string): string {
    const serial = udid ?? getAndroidSerial();
    if (!serial) {
      throw new Error(
        'No Android device available. Boot an emulator or connect a device (adb devices), ' +
          'or set ENNIO_UDID to a serial.',
      );
    }
    return serial;
  }

  /**
   * (Re)point the adb forward at the given pid's `@ennio_<pid>` socket and
   * cache the new host port. The agent's socket name is pid-scoped to avoid a
   * stale agent shadowing the new one, so this runs after every (re)launch
   * once the new pid is known. Tears down the prior forward to avoid leaking
   * host ports across relaunches.
   */
  private refreshForward(serial: string, pid: string): ConnectTarget {
    const prev = this.forwardPort.get(serial);
    if (prev != null) removeForward(serial, prev);
    const port = setupForward(serial, `ennio_${pid}`);
    this.forwardPort.set(serial, port);
    return { kind: 'tcp', port };
  }

  async connect(opts: ConnectOptions): Promise<OpenConnection> {
    const serial = this.resolveSerial(opts.udid);
    const session = { udid: serial, bundleId: opts.bundleId, dylibPath: null };

    // --show-touches: the OS pointer indicator renders our injected
    // MotionEvents like real fingers. Prior setting restored on exit.
    if (process.env.ENNIO_SHOW_TOUCHES === '1') enableShowTouches(serial);

    // Decide attach-agent vs ptrace and (for ptrace) enable root BEFORE any adb
    // forward is set up — `adb root` restarts adbd and would drop forwards.
    this.prepareInjection(serial, opts.bundleId);

    // Already running with a live agent? Use it. Otherwise establish one.
    // The agent's socket is pid-scoped, so we need the running pid before we
    // can forward to it — a quick pidof; if the app isn't up there's nothing
    // to reuse and we fall straight through to establishReady.
    const runningPid = waitForAppPid(serial, opts.bundleId, 500);
    if (runningPid) {
      const existing = new EnnioConnection({
        udid: serial,
        target: this.refreshForward(serial, runningPid),
      });
      if ((await existing.open(2_000)) && (await this.isAgentReady(existing, 3_000))) {
        return { session, connection: existing };
      }
      existing.close();
    }
    grantAllPermissions(serial, opts.bundleId);
    const connection = await this.establishReady(serial, opts.bundleId);
    return { session, connection };
  }

  async clearStateAndRelaunch(ctx: RunContext, _launchArgs: string[] = []): Promise<void> {
    const serial = ctx.udid;
    ctx.client.close();
    // pm clear wipes app data AND force-stops the process — the Android
    // analogue of the iOS data-container wipe. (No re-grant here: it's the
    // per-flow hot path and the example declares no runtime permissions;
    // apps that need them are granted once in connect().)
    clearAppData(serial, ctx.bundleId);
    await this.relaunchInto(ctx, serial);
  }

  // No in-process JS reload on a release bundle, so the reuse-app fast path
  // can't soft-reset — a full clear+relaunch IS the reset. (iOS soft-resets
  // via simctl; routing through the platform keeps that off the emulator.)
  softReset(ctx: RunContext): Promise<void> {
    return this.clearStateAndRelaunch(ctx);
  }

  async relaunchAndReconnect(ctx: RunContext, _launchArgs: string[] = []): Promise<void> {
    const serial = ctx.udid;
    ctx.client.close();
    terminateAndroidApp(serial, ctx.bundleId);
    await sleep(200);
    await this.relaunchInto(ctx, serial);
  }

  terminate(udid: string, bundleId: string): void {
    terminateAndroidApp(udid, bundleId);
  }

  async openUrl(ctx: RunContext, url: string): Promise<void> {
    const serial = ctx.udid;
    // Two distinct cases, because a deep link delivered as the COLD initial
    // intent and one delivered as onNewIntent to a running app route
    // differently in react-navigation: the initial URL replays the full path
    // (including the target tab/sub-route), whereas onNewIntent only routes to
    // the screen and leaves sub-routes at their defaults. The suite's deep
    // links always follow a stopApp, so they must go through the cold path to
    // land on the exact route (e.g. the Contacts tab, not the default tab).
    const agentAlive = await ctx.client
      .call('ping')
      .then(
        (r) => !!(r.ok && (r.data as { bootstrap?: string } | undefined)?.bootstrap === 'ready'),
      )
      .catch(() => false);
    if (waitForAppPid(serial, ctx.bundleId, 300) && agentAlive) {
      // App already up with a live agent (an in-app openLink, e.g. auth-flow's
      // openLink-to-profile). Navigate in place — the agent survives and the
      // app keeps its state. Tearing it down here would drop to the launcher.
      openAndroidUrl(serial, ctx.bundleId, url);
      await ctx.client
        .call('wait_react_commit', { sinceMs: 0, maxMs: 8000 })
        .catch(() => undefined);
      await ctx.client.call('wait_commit', { maxMs: 1500, stableMs: 150 }).catch(() => undefined);
      return;
    }
    // Cold path: the link follows a stopApp, so the process is dead. Launch it
    // VIA the VIEW intent so the deep link is the initial URL and the full
    // route is replayed, then attach + reconnect. (The "lands on home" flake
    // once blamed on this path was actually an empty ${LINK} from the
    // runFlow.env bug — now that the link interpolates correctly, the cold
    // launch routes deterministically.)
    ctx.client.close();
    const reopen = await this.establishReady(serial, ctx.bundleId, () =>
      openAndroidUrl(serial, ctx.bundleId, url),
    );
    ctx.client = reopen.socket;
    await this.waitForFirstPaint(reopen);
  }

  // ── helpers ────────────────────────────────────────────────────────
  private async relaunchInto(ctx: RunContext, serial: string): Promise<void> {
    const reopen = await this.establishReady(serial, ctx.bundleId);
    ctx.client = reopen.socket;
    await this.waitForFirstPaint(reopen);
  }

  /**
   * Launch the app and return a connection to a LIVE agent.
   *
   * Deterministic injection: start the app, wait for its pid, then attach the
   * bundled JVMTI agent with `am attach-agent`. The runtime hands the agent
   * the live VM and it binds `@ennio` — the attach either succeeds or errors
   * loudly. No wrap.sh, no seccomp setgid (SIGSYS) race, no zombie abstract
   * socket. The retry loop only covers ordinary launch hiccups (the process
   * failing to appear, or a rare attach error), not a probabilistic inject.
   */
  private async establishReady(
    serial: string,
    bundleId: string,
    launch: () => void = () => launchAndroidApp(serial, bundleId),
  ): Promise<EnnioConnection> {
    let lastErr = '';
    // Retry against a WALL-CLOCK BUDGET, not a fixed attempt count. Each failed
    // inject is cheap (the socket-bind check below fails in ~ms-to-4s), so we
    // keep retrying to ride out the x86 emulator's transient "bad patches" —
    // windows (~40s seen) where ptrace silently no-ops because the target VM is
    // momentarily unresponsive under GC / system_server load. The budget is the
    // principled bound: it outlasts the observed patches and self-scales to a
    // slower runner (where each attempt costs more, so fewer fit) instead of a
    // hardcoded 12 fitted to one machine. The inter-attempt backoff ESCALATES —
    // rapid-fire relaunches add load and prolong the patch, so later attempts
    // space out (up to ~6s) to span more wall-clock and let the emulator recover.
    const budgetMs = Number(process.env.ENNIO_INJECT_BUDGET_MS) || 90_000;
    const injectDeadline = Date.now() + budgetMs;
    for (let attempt = 0; Date.now() < injectDeadline; attempt++) {
      if (attempt > 0) {
        terminateAndroidApp(serial, bundleId);
        await sleep(Math.min(400 + attempt * 600, 6_000));
      }
      launch();
      const pid = waitForAppPid(serial, bundleId, 8_000);
      if (!pid) {
        lastErr = 'app process never started';
        continue;
      }
      try {
        // Inject the agent into the freshly-started process. Both paths stage
        // the .so into the app's code_cache (wiped by pm clear, so re-staged
        // every launch); the agent's bounded wait covers the brief window
        // before Application.onCreate.
        const tmpSo = this.ensureAgentPushed(serial);
        if (this.injectMode.get(serial) === 'ptrace') {
          ptraceInjectAgent(serial, bundleId, pid, tmpSo, this.pushedInjector.get(serial)!);
        } else {
          stageAndAttachAgent(serial, bundleId, pid, tmpSo);
        }
      } catch (e) {
        lastErr = `inject failed: ${e instanceof Error ? e.message : String(e)}`;
        continue;
      }
      // dlopen success ≠ a live agent: the agent's constructor (find VM → wait
      // for Application → bind LocalServerSocket) runs AFTER dlopen. That bind
      // happens on an EVENT — the app's Application being constructed — not on
      // a fixed schedule, and on a loaded cold start (pm clear → full restart
      // under swiftshader) the Application can take several seconds to appear.
      //
      // So wait for the bind EVENT, not a guessed duration. The previous fixed
      // ~4s cap relaunched a still-bootstrapping agent; the relaunch added
      // system_server/GC load that prolonged the NEXT cold start, so the cap
      // expired again — a feedback loop that burned the whole inject budget on
      // doomed retries (observed: launchApp hanging ~1.7 min, then failing).
      //
      // The only reasons @ennio won't bind are real failures, each with its own
      // signal: the process we injected into crashed, or the pid we saw at
      // zygote-fork was replaced. Poll for either the bind or the process going
      // away, and relaunch only on that death signal. The outer inject budget
      // (injectDeadline) remains the sole time cap — no per-attempt bind
      // timeout. (Paired with the agent waiting indefinitely for the
      // Application instead of self-aborting; see ennio_inject.cpp.)
      let bound = false;
      while (Date.now() < injectDeadline) {
        if (abstractSocketBound(serial, `ennio_${pid}`)) {
          bound = true;
          break;
        }
        if (appPidNow(serial, bundleId) !== pid) {
          lastErr = `injected process ${pid} died before @ennio bound (crash / pid replaced)`;
          break;
        }
        await sleep(200);
      }
      if (!bound) {
        if (!lastErr) lastErr = 'inject budget exhausted before @ennio socket bound';
        continue;
      }
      const target = this.refreshForward(serial, pid);
      const port = target.kind === 'tcp' ? target.port : -1;
      const conn = new EnnioConnection({ udid: serial, target });
      // Generous on the readiness wait: a KVM emulator on a loaded CI runner
      // can take >6 s from process-start to the first resumed Activity (when
      // the agent flips `ready`). The socket binds quickly (open succeeds),
      // but a tight ready-poll declared "@ennio never became ready" and forced
      // a relaunch — sometimes burning all attempts. Wider windows + an extra
      // attempt make a hot-path relaunch reliable under CI load.
      const openOk = await conn.open(12_000);
      if (openOk && (await this.isAgentReady(conn, 12_000))) {
        return conn;
      }
      // Diagnostics. The CLI forwards to localabstract:ennio_<pid>; the agent
      // logs the pid it actually bound (@ennio_<myPid>). pid + port + open let
      // us tell a forward/pid mismatch (open=false → nothing listening on that
      // name) from a bound-but-not-ready agent (open=true). The ping fields
      // distinguish a stuck ready flag from an un-resumed app.
      let diag = '';
      try {
        const p = await conn.socket.call('ping');
        const d = p?.data as { bootstrap?: string } | undefined;
        diag = ` bootstrap=${d?.bootstrap ?? '?'}`;
      } catch {
        diag = ' pingThrew';
      }
      conn.close();
      lastErr = `agent attached but @ennio never became ready (pid=${pid} port=${port} open=${openOk}${diag})`;
    }
    throw new Error(
      `EnnioAgent never came up for ${bundleId}: ${lastErr}. ` +
        'The app must be debuggable (a debuggable build, or any app on a ' +
        'userdebug emulator/device) for am attach-agent to load the agent.',
    );
  }

  /** A live agent answers a ready ping. A zombie socket only ever FINs, so
   *  each ping attempt (bounded at 1.5s — the call layer's reconnect-retries
   *  can't complete within that) returns false, and the whole check fails
   *  after the budget. One ready response is enough: the call layer already
   *  rides out the live agent's occasional transient close, so we must NOT
   *  require consecutive successes (that wrongly kills a live agent). */
  private async isAgentReady(connection: EnnioConnection, maxMs: number): Promise<boolean> {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      // Clear the bound on win so a fast ping doesn't leave a 1.5s dangling
      // timer (this polls in a tight loop, so leaked timers accumulate).
      let timer: NodeJS.Timeout | undefined;
      const bound = new Promise<boolean>((res) => {
        timer = setTimeout(() => res(false), 1500);
      });
      const ready = await Promise.race([
        connection.socket
          .call('ping')
          .then((r) => !!(r.ok && (r.data as { bootstrap?: string })?.bootstrap === 'ready'))
          .catch(() => false),
        bound,
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });
      if (ready) return true;
      await sleep(150);
    }
    return false;
  }

  private async waitForFirstPaint(connection: EnnioConnection): Promise<void> {
    await connection.socket
      .call('wait_react_commit', { sinceMs: 0, maxMs: 8000 })
      .catch(() => undefined);
    await connection.socket
      .call('wait_commit', { maxMs: 1500, stableMs: 150 })
      .catch(() => undefined);
  }
}
