// App + simulator lifecycle handlers: launchApp / clearState /
// stopApp / killApp / openLink / waitForAnimationToEnd.
//
// All of these wrap helpers in runner/lifecycle.ts (the helper module,
// not this file). The legacy module retains the heavy lifting so the
// migration is mechanical.

import { execFileSync } from 'node:child_process';

import { CommandRegistry } from '../../core/command-registry';
import type { MaestroCommand } from '../../maestro-parser';
import { chainHasCrossProcessPresenter } from '../../runner/capabilities';
import { interpolate, sleep } from '../../runner/context';
// Relaunch / terminate / soft-reset all route through ctx.platform (the
// iOS/Android backend abstraction); the launch-args reuse gate is the
// one direct lifecycle helper import.
import { launchArgsSatisfiedByProcess } from '../../runner/lifecycle';

interface LaunchAppCmd {
  launchApp:
    | true
    | {
        clearState?: boolean;
        clearKeychain?: boolean;
        arguments?: Record<string, string | boolean | number>;
      };
}
interface ClearStateCmd {
  clearState: true | Record<string, unknown>;
}
interface StopKillAppCmd {
  stopApp?: unknown;
  killApp?: unknown;
}
interface OpenLinkCmd {
  openLink: string | { link: string };
}
interface WaitForAnimationToEndCmd {
  waitForAnimationToEnd: true | { timeout?: number };
}

function has<T extends string>(
  cmd: MaestroCommand,
  key: T,
): cmd is MaestroCommand & Record<T, unknown> {
  return typeof cmd === 'object' && cmd !== null && key in cmd;
}

export function registerLifecycleHandlers(registry: CommandRegistry): void {
  registry.register(
    (c): c is MaestroCommand & LaunchAppCmd => has(c, 'launchApp'),
    async (cmd, { ctx }) => {
      const arg = cmd.launchApp;
      const opts =
        arg === true
          ? { clearState: false }
          : (arg as {
              clearState?: boolean;
              clearKeychain?: boolean;
              arguments?: Record<string, string | boolean | number>;
            });
      // Maestro clearKeychain: wipe the SIM-WIDE keychain before launch.
      // iOS-only system feature (simctl has a first-class verb); no
      // Android equivalent, so it no-ops there.
      if (opts.clearKeychain && ctx.platform.name === 'ios') {
        try {
          execFileSync('xcrun', ['simctl', 'keychain', ctx.udid, 'reset'], { stdio: 'pipe' });
        } catch {
          /* older Xcode without the verb — proceed; clearState wipes app data anyway */
        }
      }
      // iOS NSUserDefaults launch arguments need flat `-Key Value`
      // pairs. Bare key gets silently ignored. Booleans as YES/NO
      // (iOS convention). Android ignores these.
      const launchArgs: string[] = [];
      if (opts.arguments) {
        for (const [k, v] of Object.entries(opts.arguments)) {
          launchArgs.push(interpolate(k, ctx));
          if (v === true) launchArgs.push('YES');
          else if (v === false) launchArgs.push('NO');
          else launchArgs.push(interpolate(String(v), ctx));
        }
      }
      if (opts.clearState) {
        // App reuse (default ON; --disable-reuse-app sets ENNIO_REUSE_APP=0):
        // when the app is ALREADY running (the runner reconnected to the prior
        // flow's process), soft-reset in place instead of paying the ~6s
        // relaunch. Routed through ctx.platform.softReset so each backend
        // resets the right way — iOS wipes + JS-reloads in place; Android
        // relaunches (no in-process reload on a release bundle). Launch
        // arguments only force a relaunch when they DIFFER from the ones the
        // running process was started with: identical args are already live
        // in its NSUserDefaults arguments domain (process-scoped, survives
        // the data wipe + JS reload).
        const canReuse =
          process.env.ENNIO_REUSE_APP !== '0' &&
          ctx.client.isConnected() &&
          launchArgsSatisfiedByProcess(ctx.udid, ctx.bundleId, launchArgs) &&
          !opts.clearKeychain;
        // No trailing blind settle: every branch below ends on a
        // first-paint SIGNAL of its own (softResetAndReload and
        // clearStateAndRelaunch wait for the post-launch React commit,
        // relaunchAndReconnect calls waitForFirstPaint).
        if (canReuse) {
          await ctx.platform.softReset(ctx);
        } else {
          await ctx.platform.clearStateAndRelaunch(ctx, launchArgs);
        }
      } else if (!ctx.client.isConnected()) {
        // Socket dropped — app was killed (stopApp/killApp) or crashed.
        // Re-launch so the agent reattaches.
        await ctx.platform.relaunchAndReconnect(ctx, launchArgs);
      }
    },
  );

  registry.register(
    (c): c is MaestroCommand & ClearStateCmd => has(c, 'clearState'),
    async (_cmd, { ctx }) => {
      await ctx.platform.clearStateAndRelaunch(ctx);
    },
  );

  registry.register(
    (c): c is MaestroCommand & StopKillAppCmd =>
      typeof c === 'object' && c !== null && ('stopApp' in c || 'killApp' in c),
    async (_cmd, { ctx }) => {
      // Close socket BEFORE killing the app so the FIN from the dying
      // process doesn't race the next launchApp's isConnected() check.
      ctx.client.close();
      ctx.platform.terminate(ctx.udid, ctx.bundleId);
    },
  );

  registry.register(
    (c): c is MaestroCommand & OpenLinkCmd => has(c, 'openLink'),
    async (cmd, { ctx }) => {
      const raw = typeof cmd.openLink === 'string' ? cmd.openLink : cmd.openLink.link;
      await ctx.platform.openUrl(ctx, interpolate(raw, ctx));
    },
  );

  registry.register(
    (c): c is MaestroCommand & WaitForAnimationToEndCmd => has(c, 'waitForAnimationToEnd'),
    async (cmd, { ctx }) => {
      const timeout =
        cmd.waitForAnimationToEnd === true ? 600 : (cmd.waitForAnimationToEnd.timeout ?? 600);
      // Race UIViewController.transitionCoordinator (animations_active)
      // against frame_hash quiet for 80 ms. iOS 26 nav holds the
      // coordinator open past the visible animation end on
      // liquid-glass tab bar; hash-quiet catches that case.
      const deadline = Date.now() + timeout;
      let prevR = await ctx.client.call('frame_hash').catch(() => undefined);
      let prevHash = (prevR?.data as { hash?: string })?.hash ?? '';
      let lastChange = Date.now();
      while (Date.now() < deadline) {
        const animR = await ctx.client.call('animations_active').catch(() => undefined);
        const animActive = !!(
          animR &&
          animR.ok &&
          animR.data &&
          (animR.data as { active?: boolean }).active
        );
        const hashR = await ctx.client.call('frame_hash').catch(() => undefined);
        const curHash = (hashR?.data as { hash?: string })?.hash ?? '';
        if (curHash !== prevHash) {
          prevHash = curHash;
          lastChange = Date.now();
        }
        const hashQuiet = Date.now() - lastChange >= 80;
        if (!animActive || hashQuiet) break;
        await sleep(20);
      }
      // Cross-process safety: PHPicker / share sheet / document picker dismiss
      // in another XPC process — animations_active is blind. The class set lives
      // in the overridable capability registry.
      const dismissDeadline = Date.now() + 2500;
      while (Date.now() < dismissDeadline) {
        const r = await ctx.client.call('top_vc_chain').catch(() => undefined);
        if (!r || !r.ok) break;
        const chain = (r.data as { chain?: string[] })?.chain ?? [];
        if (!chainHasCrossProcessPresenter(chain)) break;
        await sleep(80);
      }
    },
  );
}
