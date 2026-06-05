// Text input handlers: inputText / eraseText / clearText / pressKey.
//
// inputText is the only nontrivial one: it polls for a first responder,
// retries insert_text up to 3 times (re-tapping the previous testID
// between attempts to recover from a tap that missed focus), and falls
// back to a hardware-keyboard type. eraseText / clearText / pressKey
// are thin wrappers over hardware_key calls.

import { CommandRegistry } from '../../core/command-registry';
import type { MaestroCommand } from '../../maestro-parser';
import { typeText as hidType, getActuator } from '../../hid';
import { axFocusTextField, axTextFieldId } from '../../ennio-ax';
import { interpolate, sleep } from '../../runner/context';

// Fields whose value is driven by an onChangeText handler that
// UIKeyInput.insertText doesn't trigger (rich-text editors). For these
// we must type via REAL keyboard HID events so the controlled value
// updates — Bluesky's composer is the canonical case: its publish button
// stays disabled (canPost=false) under insert_text on a reopened sheet.
const REAL_KEYBOARD_FIELDS = new Set(['composerTextInput']);

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

      // Rich-text composer: insert_text won't fire its onChangeText, so
      // canPost never flips. Focus the field, then type via REAL keyboard
      // HID events (host Indigo keyboard builder) which traverse the full
      // text-input delegate chain.
      const liveField = await axTextFieldId(ctx.udid);
      if (liveField && REAL_KEYBOARD_FIELDS.has(liveField)) {
        await ctx.client.call('focus_testid', { testID: liveField }).catch(() => undefined);
        await ctx.client.call('first_responder_ready', { maxMs: 800 }).catch(() => undefined);
        await getActuator(ctx.udid).typeText(text);
        await ctx.client.call('wait_commit', { maxMs: 600, stableMs: 100 }).catch(() => undefined);
        ctx.lastWasTextInput = true;
        return;
      }

      // Try insert_text (UIKeyInput on the current firstResponder) up
      // to 3 times. Between attempts, if the prior tap target was a
      // testID, re-tap via the dylib activate path to recover when the
      // original tap didn't actually move focus into the field.
      let ok = false;
      for (let attempt = 0; attempt < 4 && !ok; attempt++) {
        const fr = await ctx.client
          .call('first_responder_ready', { maxMs: 500 })
          .catch(() => undefined);
        const focused = !!(fr && fr.ok && fr.data && (fr.data as { ok?: boolean }).ok);
        if (!focused) {
          // No first responder — a composer/sheet input that didn't
          // auto-focus. Recovery depends on whether the field is on
          // screen yet:
          //   • field present (composer open, just unfocused) → tap the
          //     FIELD to focus it. Crucially, do NOT re-tap the opener
          //     (replyBtn/composeFAB) here — that toggles an open sheet
          //     SHUT (the bug behind consecutive replies failing).
          //   • field absent (composer hasn't mounted / was dismissed) →
          //     re-tap the opener to (re)open it.
          const fieldId = await axTextFieldId(ctx.udid);
          let focusTap = false;
          if (fieldId) {
            const r = await ctx.client
              .call('find_by_testid', { testID: fieldId })
              .catch(() => undefined);
            if (r && r.ok && r.data) {
              const rr = r.data as { x: number; y: number; w: number; h: number };
              await ctx.driver.tap(ctx.udid, rr.x + rr.w / 2, rr.y + rr.h / 2, { intent: 'focus' });
              focusTap = true;
            }
          }
          if (!focusTap) {
            focusTap = await axFocusTextField(ctx.udid).catch(() => false);
          }
          if (!focusTap && ctx.lastTapTestID) {
            const rect = await ctx.client
              .call('find_by_testid', { testID: ctx.lastTapTestID })
              .catch(() => undefined);
            if (rect && rect.ok && rect.data) {
              const r = rect.data as { x: number; y: number; w: number; h: number };
              await ctx.driver.tap(ctx.udid, r.x + r.w / 2, r.y + r.h / 2, { intent: 'focus' });
            }
          }
          await ctx.client.call('first_responder_ready', { maxMs: 800 }).catch(() => undefined);
        }
        try {
          const r = await ctx.client.call('insert_text', { text });
          ok = !!(r.ok && r.data && (r.data as { ok: boolean }).ok);
        } catch {
          /* retry */
        }
        if (!ok) await sleep(300); // let the composer settle before retrying
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
