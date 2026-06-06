// Assertion handlers — visibility predicates with implicit-wait
// budgets. Mirrors Maestro semantics: assertVisible / assertNotVisible
// / waitFor are 1:1; assertAnyVisible polls a selector list with OR
// semantics; extendedWaitUntil is a longer-budget wait for async
// data fetches.

import { CommandRegistry } from '../../core/command-registry';
import type { MaestroCommand, MaestroSelector } from '../../maestro-parser';
import { normalizeSelector } from '../../maestro-parser';
import { DEFAULT_WAIT_MS, POLL_MS, interpolateSelector, sleep } from '../../runner/context';
import { isVisible, waitUntilNotVisible, waitUntilVisible } from '../../runner/visibility';

interface AssertVisibleCmd {
  assertVisible: MaestroSelector & { timeout?: number };
}
interface AssertNotVisibleCmd {
  assertNotVisible: MaestroSelector & { timeout?: number };
}
interface WaitForCmd {
  waitFor: MaestroSelector & { timeout?: number };
}
interface AssertAnyVisibleCmd {
  assertAnyVisible: { anyOf: MaestroSelector[]; timeout?: number };
}
interface ExtendedWaitUntilCmd {
  extendedWaitUntil: {
    visible?: MaestroSelector;
    notVisible?: MaestroSelector;
    timeout?: number;
  };
}

function has<T extends string>(
  cmd: MaestroCommand,
  key: T,
): cmd is MaestroCommand & Record<T, unknown> {
  return typeof cmd === 'object' && cmd !== null && key in cmd;
}

export function registerAssertHandlers(registry: CommandRegistry): void {
  registry.register(
    (c): c is MaestroCommand & AssertVisibleCmd => has(c, 'assertVisible'),
    async (cmd, { ctx }) => {
      const sel = normalizeSelector(interpolateSelector(cmd.assertVisible, ctx));
      const timeout = cmd.assertVisible.timeout ?? DEFAULT_WAIT_MS;
      await waitUntilVisible(ctx, sel, timeout);
    },
  );

  registry.register(
    (c): c is MaestroCommand & AssertNotVisibleCmd => has(c, 'assertNotVisible'),
    async (cmd, { ctx }) => {
      const sel = normalizeSelector(interpolateSelector(cmd.assertNotVisible, ctx));
      const timeout = cmd.assertNotVisible.timeout ?? DEFAULT_WAIT_MS;
      await waitUntilNotVisible(ctx, sel, timeout);
    },
  );

  registry.register(
    (c): c is MaestroCommand & WaitForCmd => has(c, 'waitFor'),
    async (cmd, { ctx }) => {
      const sel = normalizeSelector(interpolateSelector(cmd.waitFor, ctx));
      const timeout = cmd.waitFor.timeout ?? DEFAULT_WAIT_MS;
      await waitUntilVisible(ctx, sel, timeout);
    },
  );

  registry.register(
    (c): c is MaestroCommand & AssertAnyVisibleCmd => has(c, 'assertAnyVisible'),
    async (cmd, { ctx }) => {
      const timeout = cmd.assertAnyVisible.timeout ?? DEFAULT_WAIT_MS;
      const selectors = interpolateSelector(cmd.assertAnyVisible.anyOf, ctx).map(normalizeSelector);
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        for (const s of selectors) {
          if (await isVisible(ctx, s)) return;
        }
        await sleep(POLL_MS);
      }
      throw new Error(`assertAnyVisible: none of the ${selectors.length} selectors became visible`);
    },
  );

  registry.register(
    (c): c is MaestroCommand & ExtendedWaitUntilCmd => has(c, 'extendedWaitUntil'),
    async (cmd, { ctx }) => {
      // Default 60s — bigger than the 15s implicit wait. Meant for
      // slow async data fetches (cold sign-in mock PDS → first post
      // can take 30-40s).
      const timeout = cmd.extendedWaitUntil.timeout ?? 60000;
      if (cmd.extendedWaitUntil.visible) {
        await waitUntilVisible(ctx, normalizeSelector(interpolateSelector(cmd.extendedWaitUntil.visible, ctx)), timeout);
      } else if (cmd.extendedWaitUntil.notVisible) {
        await waitUntilNotVisible(
          ctx,
          normalizeSelector(interpolateSelector(cmd.extendedWaitUntil.notVisible, ctx)),
          timeout,
        );
      }
    },
  );
}
