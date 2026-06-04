// Text input handlers: inputText / eraseText / clearText / pressKey.
//
// inputText is the only nontrivial one: it polls for a first responder,
// retries insert_text up to 3 times (re-tapping the previous testID
// between attempts to recover from a tap that missed focus), and falls
// back to a hardware-keyboard type. eraseText / clearText / pressKey
// are thin wrappers over hardware_key calls.

import { CommandRegistry } from '../../core/command-registry';
import type { MaestroCommand } from '../../maestro-parser';
import { typeText as hidType } from '../../hid';
import { interpolate, sleep } from '../../runner/context';

interface InputTextCmd {
  inputText: string | number;
}
interface EraseTextCmd {
  eraseText: true | number | { characters: number };
}
interface ClearTextCmd {
  clearText: true | Record<string, unknown>;
}
interface PressKeyCmd {
  pressKey: string;
}

function has<T extends string>(
  cmd: MaestroCommand,
  key: T,
): cmd is MaestroCommand & Record<T, unknown> {
  return typeof cmd === 'object' && cmd !== null && key in cmd;
}

export function registerInputHandlers(registry: CommandRegistry): void {
  registry.register(
    (c): c is MaestroCommand & InputTextCmd => has(c, 'inputText'),
    async (cmd, { ctx }) => {
      const text = interpolate(String(cmd.inputText), ctx);
      // Try insert_text (UIKeyInput on the current firstResponder) up
      // to 3 times. Between attempts, if the prior tap target was a
      // testID, re-tap via the dylib activate path to recover when the
      // original tap didn't actually move focus into the field.
      let ok = false;
      for (let attempt = 0; attempt < 3 && !ok; attempt++) {
        if (attempt > 0 && ctx.lastTapTestID) {
          const rect = await ctx.client
            .call('find_by_testid', { testID: ctx.lastTapTestID })
            .catch(() => undefined);
          if (rect && rect.ok && rect.data) {
            const r = rect.data as { x: number; y: number; w: number; h: number };
            // Recovery tap must move FOCUS into the field — real touch.
            await ctx.driver.tap(ctx.udid, r.x + r.w / 2, r.y + r.h / 2, { intent: 'focus' });
          }
        }
        const fr = await ctx.client
          .call('first_responder_ready', { maxMs: 500 })
          .catch(() => undefined);
        void fr;
        try {
          const r = await ctx.client.call('insert_text', { text });
          ok = !!(r.ok && r.data && (r.data as { ok: boolean }).ok);
        } catch {
          /* retry */
        }
      }
      if (!ok) await hidType(ctx.udid, text);
      await ctx.client.call('wait_commit', { maxMs: 500, stableMs: 80 });
      ctx.lastWasTextInput = true;
    },
  );

  registry.register(
    (c): c is MaestroCommand & EraseTextCmd => has(c, 'eraseText'),
    async (cmd, { ctx }) => {
      // Maestro semantics:
      //   - eraseText                 → erase ALL text (bare form)
      //   - eraseText: 5              → erase exactly 5 chars
      //   - eraseText: { characters } → that many chars
      let count: number;
      if (typeof cmd.eraseText === 'number') {
        count = cmd.eraseText;
      } else if (
        cmd.eraseText &&
        typeof cmd.eraseText === 'object' &&
        'characters' in cmd.eraseText
      ) {
        count = (cmd.eraseText as { characters: number }).characters;
      } else {
        count = 100; // bare form
      }
      for (let i = 0; i < count; i++) await ctx.client.call('hardware_key', { keyCode: 42 });
      ctx.lastWasTextInput = true;
    },
  );

  registry.register(
    (c): c is MaestroCommand & ClearTextCmd => has(c, 'clearText'),
    async (_cmd, { ctx }) => {
      // Best-effort: erase a generous chunk via backspace.
      for (let i = 0; i < 200; i++) await ctx.client.call('hardware_key', { keyCode: 42 });
    },
  );

  registry.register(
    (c): c is MaestroCommand & PressKeyCmd => has(c, 'pressKey'),
    async (cmd, { ctx }) => {
      const name = String(cmd.pressKey).toLowerCase();
      const map: Record<string, number> = {
        backspace: 42,
        delete: 42,
        enter: 40,
        return: 40,
        tab: 43,
        space: 44,
        escape: 41,
        esc: 41,
      };
      const code = map[name];
      if (code != null) await ctx.client.call('hardware_key', { keyCode: code });
      // pressKey Enter on a form input typically triggers submit + a
      // chain of React state updates. Wait for commit + UIView stable
      // before the next step.
      await sleep(80);
      await ctx.client.call('wait_react_commit', { sinceMs: 0, maxMs: 800 }).catch(() => undefined);
      await ctx.client.call('wait_commit', { maxMs: 1500, stableMs: 150 }).catch(() => undefined);
    },
  );
}
