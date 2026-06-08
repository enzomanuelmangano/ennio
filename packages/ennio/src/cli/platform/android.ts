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
import { POST_LAUNCH_SETTLE_MS, sleep } from '../runner/context';
import type { RunContext } from '../runner/context';
import type { ConnectTarget } from '../socket-client';
import {
  clearAppData,
  getAndroidSerial,
  getClipboard,
  getDeviceAbi,
  grantAllPermissions,
  pressHardwareBack,
  launchAndroidApp,
  openAndroidUrl,
  pushAgentToTmp,
  screenshot,
  setClipboard,
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

  // adb-forwarded TCP port → the device's `@ennio` abstract socket. Set
  // up once per device and reused across relaunches (the forward targets
  // the abstract name, which each new app process re-binds).
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

  private target(serial: string): ConnectTarget {
    let port = this.forwardPort.get(serial);
    if (port == null) {
      port = setupForward(serial);
      this.forwardPort.set(serial, port);
    }
    return { kind: 'tcp', port };
  }

  async connect(opts: ConnectOptions): Promise<OpenConnection> {
    const serial = this.resolveSerial(opts.udid);
    const session = { udid: serial, bundleId: opts.bundleId, dylibPath: null };

    // Already running with a live agent? Use it. Otherwise establish one
    // (launch + self-heal through bad wrap.sh launches).
    const existing = new EnnioConnection({ udid: serial, target: this.target(serial) });
    if ((await existing.open(2_000)) && (await this.isAgentReady(existing, 3_000))) {
      return { session, connection: existing };
    }
    existing.close();
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
    openAndroidUrl(ctx.udid, ctx.bundleId, url);
    await sleep(POST_LAUNCH_SETTLE_MS);
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
  private async establishReady(serial: string, bundleId: string): Promise<EnnioConnection> {
    let lastErr = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        terminateAndroidApp(serial, bundleId);
        await sleep(400);
      }
      launchAndroidApp(serial, bundleId);
      const pid = waitForAppPid(serial, bundleId, 8_000);
      if (!pid) {
        lastErr = 'app process never started';
        continue;
      }
      try {
        // Stage the agent into the freshly-started process' code_cache and
        // attach it. The agent's own bounded wait covers the brief window
        // before Application.onCreate. code_cache is wiped by pm clear, so we
        // re-stage on every (re)launch.
        const tmpSo = this.ensureAgentPushed(serial);
        stageAndAttachAgent(serial, bundleId, pid, tmpSo);
      } catch (e) {
        lastErr = `attach-agent failed: ${e instanceof Error ? e.message : String(e)}`;
        continue;
      }
      const conn = new EnnioConnection({ udid: serial, target: this.target(serial) });
      if ((await conn.open(8_000)) && (await this.isAgentReady(conn, 6_000))) {
        return conn;
      }
      conn.close();
      lastErr = 'agent attached but @ennio never became ready';
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
