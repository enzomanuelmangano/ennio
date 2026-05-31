// System-level command handlers — anything that talks to simctl/idb
// directly without going through the dylib.
//
// First migrated set to validate the CommandRegistry pattern. Each
// handler is a small focused function; the registry binds them to
// matcher predicates on the MaestroCommand shape.

import { execFileSync } from 'node:child_process';

import { CommandRegistry } from '../../core/command-registry';
import type { MaestroCommand } from '../../maestro-parser';

interface TakeScreenshotCmd {
  takeScreenshot: string | { path: string };
}

interface ClearKeychainCmd {
  clearKeychain: true | Record<string, unknown>;
}

function isTakeScreenshot(cmd: MaestroCommand): cmd is MaestroCommand & TakeScreenshotCmd {
  return typeof cmd === 'object' && cmd !== null && 'takeScreenshot' in cmd;
}

function isClearKeychain(cmd: MaestroCommand): cmd is MaestroCommand & ClearKeychainCmd {
  return typeof cmd === 'object' && cmd !== null && 'clearKeychain' in cmd;
}

/**
 * Register system commands on the given CommandRegistry. Call from
 * FlowExecutor wiring (or from a registerAllHandlers helper).
 */
export function registerSystemHandlers(registry: CommandRegistry): void {
  registry.register(isTakeScreenshot, async (cmd, { ctx }) => {
    const path =
      typeof cmd.takeScreenshot === 'string' ? cmd.takeScreenshot : cmd.takeScreenshot.path;
    execFileSync('xcrun', ['simctl', 'io', ctx.udid, 'screenshot', path]);
  });

  registry.register(isClearKeychain, async (_cmd, { ctx }) => {
    execFileSync('xcrun', ['simctl', 'keychain', ctx.udid, 'reset'], { stdio: 'pipe' });
  });
}
