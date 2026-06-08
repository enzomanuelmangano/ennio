// App + simulator lifecycle handlers: launchApp / clearState /
// stopApp / killApp / openLink / waitForAnimationToEnd.
//
// All of these wrap helpers in runner/lifecycle.ts (the helper module,
// not this file). The legacy module retains the heavy lifting so the
// migration is mechanical.

import { execFileSync } from 'node:child_process';

import { CommandRegistry } from '../../core/command-registry';
import type { MaestroCommand } from '../../maestro-parser';
import { POST_LAUNCH_SETTLE_MS, sleep } from '../../runner/context';
// Relaunch / terminate now route through ctx.platform (the iOS/Android
// backend abstraction); only the iOS soft-reset optimization is still a
// direct helper call.
import { softResetAndReload } from '../../runner/lifecycle';

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
          launchArgs.push(k);
          if (v === true) launchArgs.push('YES');
          else if (v === false) launchArgs.push('NO');
          else launchArgs.push(String(v));
        }
      }
      if (opts.clearState) {
        // --reuse-app: when the app is ALREADY running (the runner
        // reconnected to the prior flow's process) and there are no
        // launch arguments (those need a real relaunch to take effect),
        // soft-reset in place — wipe data + reload the JS bundle —
        // instead of paying the ~6s relaunch. Falls back to relaunch
        // inside softResetAndReload if the reload symbol is missing.
        const canReuse =
          process.env.ENNIO_REUSE_APP === '1' &&
          ctx.client.isConnected() &&
          launchArgs.length === 0 &&
          !opts.clearKeychain;
        if (canReuse) {
          await softResetAndReload(ctx);
        } else {
          await ctx.platform.clearStateAndRelaunch(ctx, launchArgs);
        }
      } else if (!ctx.client.isConnected()) {
        // Socket dropped — app was killed (stopApp/killApp) or crashed.
        // Re-launch so the agent reattaches.
        await ctx.platform.relaunchAndReconnect(ctx, launchArgs);
      }
      await sleep(POST_LAUNCH_SETTLE_MS);
    },
  );

  registry.register(
    (c): c is MaestroCommand & ClearStateCmd => has(c, 'clearState'),
    async (_cmd, { ctx }) => {
      await ctx.platform.clearStateAndRelaunch(ctx);
      await sleep(POST_LAUNCH_SETTLE_MS);
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
      const link = typeof cmd.openLink === 'string' ? cmd.openLink : cmd.openLink.link;
      await ctx.platform.openUrl(ctx, link);
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
      // Cross-process safety: PHPicker / share sheet / document picker
      // dismiss in another XPC process — animations_active is blind.
      const dismissDeadline = Date.now() + 2500;
      while (Date.now() < dismissDeadline) {
        const r = await ctx.client.call('top_vc_chain').catch(() => undefined);
        if (!r || !r.ok) break;
        const chain = (r.data as { chain?: string[] })?.chain ?? [];
        const hasCrossProcess = chain.some(
          (cls) =>
            cls.includes('PHPicker') ||
            cls.includes('PhotoPicker') ||
            cls.includes('PHImagePicker') ||
            cls.includes('UIActivityViewController') ||
            cls.includes('UIDocumentPickerViewController'),
        );
        if (!hasCrossProcess) break;
        await sleep(80);
      }
    },
  );
}
