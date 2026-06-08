// System-level command handlers — anything that talks to simctl
// directly without going through the dylib (plus a few simple
// single-op dylib calls like hide_keyboard / alert_dismiss / back).
//
// First migrated set, proves the CommandRegistry pattern. Each handler
// is a small focused function; the registry binds them to matcher
// predicates on the MaestroCommand shape.

import { CommandRegistry } from '../../core/command-registry';
import type { MaestroCommand } from '../../maestro-parser';

interface TakeScreenshotCmd {
  takeScreenshot: string | { path: string };
}

interface ClearKeychainCmd {
  clearKeychain: true | Record<string, unknown>;
}

interface BackCmd {
  back: true | Record<string, unknown>;
}

interface HideKeyboardCmd {
  hideKeyboard: true | Record<string, unknown>;
}

interface DismissAlertCmd {
  dismissAlert: true | Record<string, unknown>;
}

interface SetClipboardCmd {
  setClipboard: string;
}

interface PasteTextCmd {
  pasteText: true | Record<string, unknown>;
}

function isTakeScreenshot(cmd: MaestroCommand): cmd is MaestroCommand & TakeScreenshotCmd {
  return typeof cmd === 'object' && cmd !== null && 'takeScreenshot' in cmd;
}

function isClearKeychain(cmd: MaestroCommand): cmd is MaestroCommand & ClearKeychainCmd {
  return typeof cmd === 'object' && cmd !== null && 'clearKeychain' in cmd;
}

function isBack(cmd: MaestroCommand): cmd is MaestroCommand & BackCmd {
  return typeof cmd === 'object' && cmd !== null && 'back' in cmd;
}

function isHideKeyboard(cmd: MaestroCommand): cmd is MaestroCommand & HideKeyboardCmd {
  return typeof cmd === 'object' && cmd !== null && 'hideKeyboard' in cmd;
}

function isDismissAlert(cmd: MaestroCommand): cmd is MaestroCommand & DismissAlertCmd {
  return typeof cmd === 'object' && cmd !== null && 'dismissAlert' in cmd;
}

function isSetClipboard(cmd: MaestroCommand): cmd is MaestroCommand & SetClipboardCmd {
  return typeof cmd === 'object' && cmd !== null && 'setClipboard' in cmd;
}

function isPasteText(cmd: MaestroCommand): cmd is MaestroCommand & PasteTextCmd {
  return typeof cmd === 'object' && cmd !== null && 'pasteText' in cmd;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Register system commands on the given CommandRegistry. Call from
 * FlowExecutor wiring (or from a registerAllHandlers helper).
 */
export function registerSystemHandlers(registry: CommandRegistry): void {
  registry.register(isTakeScreenshot, async (cmd, { ctx }) => {
    let path =
      typeof cmd.takeScreenshot === 'string' ? cmd.takeScreenshot : cmd.takeScreenshot.path;
    // Maestro lets you omit the extension; the platform writers expect one.
    if (!/\.(png|jpe?g)$/i.test(path)) path += '.png';
    ctx.platform.system.screenshot(ctx.udid, path);
  });

  registry.register(isClearKeychain, async (_cmd, { ctx }) => {
    ctx.platform.system.clearKeychain(ctx.udid);
  });

  registry.register(isBack, async (_cmd, { ctx }) => {
    const r = await ctx.client.call('back');
    // The agent couldn't pop in-process but the screen IS poppable (a custom
    // headerLeft replaced the chevron and predictive back owns the gesture).
    // Inject a real OS BACK from the host — the only thing that reaches the
    // window's OnBackInvokedDispatcher. Gated on `poppable`, so a navigation
    // root never gets a hardware back that would exit the app.
    const data = r?.data as { popped?: boolean; poppable?: boolean } | undefined;
    if (data && data.popped === false && data.poppable && ctx.platform.system.hardwareBack) {
      ctx.platform.system.hardwareBack(ctx.udid);
    }
    // Poll animations_active until the pop transition ends.
    // popViewControllerAnimated's CAAnimation registers on UIKit's
    // transitionCoordinator immediately; the poll exits as soon as
    // no VC in the chain is transitioning. Capped at 800 ms for
    // custom transitions that exceed the default ~250 ms.
    const deadline = Date.now() + 800;
    while (Date.now() < deadline) {
      const r = await ctx.client.call('animations_active').catch(() => undefined);
      const active = !!(r && r.ok && r.data && (r.data as { active?: boolean }).active);
      if (!active) break;
      await sleep(20);
    }
  });

  registry.register(isHideKeyboard, async (_cmd, { ctx }) => {
    await ctx.client.call('hide_keyboard');
    // With --no-animations, in-app layout after keyboard resign settles
    // in ~1 frame. 50ms sufficient vs 150ms with live animations.
    await sleep(process.env.ENNIO_NO_ANIMATIONS === '1' ? 50 : 150);
  });

  registry.register(isDismissAlert, async (_cmd, { ctx }) => {
    await ctx.client.call('alert_dismiss');
  });

  registry.register(isSetClipboard, async (cmd, { ctx }) => {
    ctx.platform.system.setClipboard(ctx.udid, String(cmd.setClipboard));
  });

  // pasteText reads sim clipboard and types via inputText. We can't
  // dispatch inputText here without re-entering the registry, so we
  // intentionally do NOT migrate it yet — it stays in the legacy
  // runCommand. Registry has no entry; legacy fallback handles it.
  void isPasteText;
}
