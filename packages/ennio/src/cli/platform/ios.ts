// IosPlatform — wraps the existing simulator backend (sim.ts +
// runner/lifecycle.ts + HID/Fast drivers) behind the Platform interface.
// Pure adapter: all the heavy iOS logic stays where it was, so this is a
// zero-behavior-change wrapper for the iOS path.

import { execFileSync } from 'node:child_process';

import { EnnioConnection } from '../core/ennio-connection';
import { SimulatorSession } from '../core/simulator-session';
import { diagnoseSocketFailure, isAppRunning } from '../crash-detector';
import { createDriver } from '../driver';
import type { GestureDriver } from '../driver';
import {
  axFocusTextField,
  axResolve,
  axTapTarget,
  axTextFieldId,
  dismissSystemSheet,
} from '../ennio-ax';
import {
  clearStateAndRelaunch as iosClearStateAndRelaunch,
  dismissPermissionDialogs,
  relaunchAndReconnect as iosRelaunchAndReconnect,
  softResetAndReload,
  waitForFirstPaint,
} from '../runner/lifecycle';
import { findDylib, prepareSimulator, setSimLaunchEnv, tracePhase, tracePhaseAsync } from '../sim';
import { EnnioSocketClient, ennioSocketPath } from '../socket-client';
import { sleep } from '../runner/context';
import type { RunContext } from '../runner/context';

import type { AxBridge, ConnectOptions, OpenConnection, Platform, SystemBridge } from './types';

export class IosPlatform implements Platform {
  readonly name = 'ios' as const;

  // The macOS-AX bridge reading the Simulator's tree + tapping via HID.
  readonly ax: AxBridge = {
    resolve: (udid, sel) => axResolve(udid, sel),
    tapTarget: (udid, sel) => axTapTarget(udid, sel),
    dismissSystemSheet: (udid) => dismissSystemSheet(udid),
    textFieldId: (udid) => axTextFieldId(udid),
    focusTextField: (udid) => axFocusTextField(udid),
  };

  readonly system: SystemBridge = {
    screenshot: (udid, path) => {
      // stdio piped: simctl chats ("Detected file type 'PNG'... Wrote
      // screenshot to:") on stderr and it leaks into every quiet run.
      execFileSync('xcrun', ['simctl', 'io', udid, 'screenshot', path], { stdio: 'pipe' });
    },
    clearKeychain: (udid) => {
      execFileSync('xcrun', ['simctl', 'keychain', udid, 'reset'], { stdio: 'pipe' });
    },
    setClipboard: (udid, text) => {
      execFileSync('xcrun', ['simctl', 'pbcopy', udid], {
        input: text,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    },
    getClipboard: (udid) =>
      execFileSync('xcrun', ['simctl', 'pbpaste', udid], { encoding: 'utf-8' }).toString(),
  };

  createDriver(fast: boolean): GestureDriver {
    return createDriver(fast);
  }

  async connect(opts: ConnectOptions): Promise<OpenConnection> {
    const session = new SimulatorSession({
      udid: opts.udid,
      bundleId: opts.bundleId,
      dylibPath: opts.dylibPath ?? null,
      safeMode: opts.safeMode,
    });

    // SwiftUI a11y tree + deterministic keyboard — device-level prefs,
    // applied once per sim boot (sentinel-skipped on later invocations).
    prepareSimulator(session.udid);

    const connection = new EnnioConnection({ udid: session.udid, bundleId: session.bundleId });
    if (!(await tracePhaseAsync('socketOpenFast', () => connection.open(2_000)))) {
      // App isn't running with the dylib loaded — launch + retry.
      tracePhase('terminate', () => session.terminate());
      const launchedAt = Date.now();
      tracePhase('launch', () => session.launch());
      if (!(await tracePhaseAsync('socketOpenLaunched', () => connection.open(15_000)))) {
        const diagnosis = diagnoseSocketFailure(session.udid, session.bundleId, launchedAt);
        throw new Error(
          'Auto-launched the app with DYLD injection but libennio socket never came up.' +
            (diagnosis
              ? `\n${diagnosis}`
              : ' Check the app is a Debug build and the dylib path is correct.'),
        );
      }
      await tracePhaseAsync('bootstrapReady', () => this.waitBootstrapReady(connection));
    }
    return { session, connection };
  }

  clearStateAndRelaunch(ctx: RunContext, launchArgs: string[] = []): Promise<void> {
    return iosClearStateAndRelaunch(ctx, launchArgs);
  }

  // Soft-reset in place: sandbox wipe + JS reload, no relaunch. Falls back to
  // a full relaunch inside softResetAndReload when the reload symbol is absent.
  softReset(ctx: RunContext): Promise<void> {
    return softResetAndReload(ctx);
  }

  relaunchAndReconnect(ctx: RunContext, launchArgs: string[] = []): Promise<void> {
    return iosRelaunchAndReconnect(ctx, launchArgs);
  }

  terminate(udid: string, bundleId: string): void {
    try {
      execFileSync('xcrun', ['simctl', 'terminate', udid, bundleId], { stdio: 'pipe' });
    } catch {
      /* not running */
    }
  }

  async openUrl(ctx: RunContext, url: string): Promise<void> {
    // expo-development-client URLs load a JS bundle into the dev client — a
    // launcher concern, not an in-app deep link — so keep the system openurl
    // path (the app may not be the running foreground process).
    if (url.includes('expo-development-client')) {
      execFileSync('xcrun', ['simctl', 'openurl', ctx.udid, url]);
      await ctx.client
        .call('wait_react_commit', { sinceMs: 0, maxMs: 20000 })
        .catch(() => undefined);
      await ctx.client.call('wait_commit', { maxMs: 5000, stableMs: 500 }).catch(() => undefined);
      const permDeadline = Date.now() + 8000;
      while (Date.now() < permDeadline) {
        if (await dismissPermissionDialogs(ctx.udid).catch(() => false)) break;
        await sleep(1000);
      }
      return;
    }
    // Two cases, each with the mechanism that matches how iOS itself delivers a
    // URL. Process truth (launchctl), not the socket flag — right after a
    // stopApp the socket object reads stale-connected.
    const alive = isAppRunning(ctx.udid, ctx.bundleId) && ctx.client.isConnected();
    if (alive) {
      // App already running (an in-app openLink): deliver the URL IN-PROCESS via
      // the agent (open_url posts RN's RCTOpenURLNotification), so RN's Linking
      // routes it without a `simctl openurl` — which would raise a foreground
      // "Open in <app>?" prompt — and without tearing down the app's state.
      await ctx.client.call('open_url', { url });
    } else {
      // Cold path (post-stopApp): cold-launch THROUGH the URL so it arrives as
      // the app's launch option. react-navigation's linking gives the launch
      // URL precedence over persisted navigation state — a fresh route, exactly
      // as the OS delivers a deep link — and a cold launch shows no "Open in
      // app?" prompt. See coldLaunchUrl for the sim-wide injection it needs.
      await this.coldLaunchUrl(ctx, url);
    }
    await ctx.client.call('wait_react_commit', { sinceMs: 0, maxMs: 8000 }).catch(() => undefined);
    await ctx.client.call('wait_commit', { maxMs: 1500, stableMs: 150 }).catch(() => undefined);
  }

  /**
   * Cold-launch the app via `simctl openurl` with the dylib injected so the URL
   * arrives as the launch option (getInitialURL) — the only way to give a deep
   * link precedence over persisted navigation state. `simctl openurl` can't
   * carry SIMCTL_CHILD_DYLD_INSERT_LIBRARIES the way `simctl launch` does, so
   * the dylib is set sim-wide on launchctl for the launch window and cleared
   * immediately after. That's safe: EnnioBootstrap no-ops in any process whose
   * main bundle isn't an iOS app (CFBundlePackageType != "APPL"), so a stray
   * daemon that spawns in the window loads it inertly.
   */
  private async coldLaunchUrl(ctx: RunContext, url: string): Promise<void> {
    const udid = ctx.udid;
    const dylib = ctx.dylibPath ?? findDylib();
    if (!dylib) throw new Error('libennio.dylib not found for cold deep-link launch');
    ctx.client.close();
    this.terminate(udid, ctx.bundleId);
    // ENNIO_SOCKET_PATH is sticky from the first launch, but set it explicitly
    // so a cold openurl that is the FIRST launch still finds the socket path.
    execFileSync(
      'xcrun',
      ['simctl', 'spawn', udid, 'launchctl', 'setenv', 'ENNIO_SOCKET_PATH', ennioSocketPath(udid)],
      { stdio: 'pipe' },
    );
    execFileSync(
      'xcrun',
      ['simctl', 'spawn', udid, 'launchctl', 'setenv', 'DYLD_INSERT_LIBRARIES', dylib],
      { stdio: 'pipe' },
    );
    const launchedAt = Date.now();
    try {
      execFileSync('xcrun', ['simctl', 'openurl', udid, url], { stdio: 'pipe' });
      const reopen = new EnnioSocketClient(udid);
      if (!(await reopen.connectWithRetry(15_000))) {
        const diagnosis = diagnoseSocketFailure(udid, ctx.bundleId, launchedAt);
        throw new Error(
          'socket reconnect failed after cold deep-link launch' +
            (diagnosis ? `\n${diagnosis}` : ''),
        );
      }
      ctx.client = reopen;
    } finally {
      // Clear the sim-wide insert so subsequent plain launches aren't polluted.
      setSimLaunchEnv(udid, 'DYLD_INSERT_LIBRARIES', false);
    }
    const readyBy = Date.now() + 5_000;
    while (Date.now() < readyBy) {
      const ready = await ctx.client
        .call('ping')
        .then(
          (r) => !!(r.ok && (r.data as { bootstrap?: string } | undefined)?.bootstrap === 'ready'),
        )
        .catch(() => false);
      if (ready) break;
      await sleep(100);
    }
    await waitForFirstPaint(ctx.client);
  }

  private async waitBootstrapReady(connection: EnnioConnection): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try {
        const r = await connection.socket.call('ping');
        const ready = r.ok && r.data && (r.data as { bootstrap?: string }).bootstrap === 'ready';
        if (ready) return;
      } catch {
        /* retry */
      }
      await sleep(100);
    }
  }
}
