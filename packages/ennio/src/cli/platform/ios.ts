// IosPlatform — wraps the existing simulator backend (sim.ts +
// runner/lifecycle.ts + HID/Fast drivers) behind the Platform interface.
// Pure adapter: all the heavy iOS logic stays where it was, so this is a
// zero-behavior-change wrapper for the iOS path.

import { execFileSync } from 'node:child_process';

import { EnnioConnection } from '../core/ennio-connection';
import { SimulatorSession } from '../core/simulator-session';
import { diagnoseSocketFailure } from '../crash-detector';
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
} from '../runner/lifecycle';
import { enableAccessibility } from '../sim';
import { POST_LAUNCH_SETTLE_MS, sleep } from '../runner/context';
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
      execFileSync('xcrun', ['simctl', 'io', udid, 'screenshot', path]);
    },
    clearKeychain: (udid) => {
      execFileSync('xcrun', ['simctl', 'keychain', udid, 'reset'], { stdio: 'pipe' });
    },
    setClipboard: (udid, text) => {
      execFileSync('xcrun', ['simctl', 'pbcopy', udid], { input: text, stdio: ['pipe', 'pipe', 'pipe'] });
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

    // SwiftUI / native screens only build their a11y tree when an a11y
    // client is active — flip it on so find_ax_by_text can read them.
    enableAccessibility(session.udid);

    const connection = new EnnioConnection({ udid: session.udid });
    if (!(await connection.open(2_000))) {
      // App isn't running with the dylib loaded — launch + retry.
      session.terminate();
      const launchedAt = Date.now();
      session.launch();
      if (!(await connection.open(15_000))) {
        const diagnosis = diagnoseSocketFailure(session.udid, session.bundleId, launchedAt);
        throw new Error(
          'Auto-launched the app with DYLD injection but libennio socket never came up.' +
            (diagnosis
              ? `\n${diagnosis}`
              : ' Check the app is a Debug build and the dylib path is correct.'),
        );
      }
      await this.waitBootstrapReady(connection);
    }
    return { session, connection };
  }

  clearStateAndRelaunch(ctx: RunContext, launchArgs: string[] = []): Promise<void> {
    return iosClearStateAndRelaunch(ctx, launchArgs);
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
    execFileSync('xcrun', ['simctl', 'openurl', ctx.udid, url]);
    if (url.includes('expo-development-client')) {
      await ctx.client.call('wait_react_commit', { sinceMs: 0, maxMs: 20000 }).catch(() => undefined);
      await ctx.client.call('wait_commit', { maxMs: 5000, stableMs: 500 }).catch(() => undefined);
      const permDeadline = Date.now() + 8000;
      while (Date.now() < permDeadline) {
        if (await dismissPermissionDialogs(ctx.udid).catch(() => false)) break;
        await sleep(1000);
      }
    }
    await sleep(POST_LAUNCH_SETTLE_MS);
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
