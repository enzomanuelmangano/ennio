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
      const liveField = await ctx.platform.ax.textFieldId(ctx.udid);
      if (liveField && REAL_KEYBOARD_FIELDS.has(liveField)) {
        await ctx.client.call('focus_testid', { testID: liveField }).catch(() => undefined);
        await ctx.client.call('first_responder_ready', { maxMs: 800 }).catch(() => undefined);
        await getActuator(ctx.udid).typeText(text);
        await ctx.client.call('wait_commit', { maxMs: 600, stableMs: 100 }).catch(() => undefined);
        ctx.lastWasTextInput = true;
        return;
      }

      // Try insert_text (UIKeyInput on the current firstResponder) up
      // to 3 times. Focus is verified by IDENTITY, not existence: when
      // the previous tap targeted a testID, readiness requires that
      // exact field to hold first responder. RN switches focus
      // asynchronously after the tap — during the switch the PREVIOUS
      // field still answers "a field is focused", and typing lands in
      // the old field (the checkout-form cascade; in-house HID's speed
      // exposed what idb's gRPC latency used to mask).
      const expectedField = ctx.lastTapTestID;
      const responderReady = async (maxMs: number): Promise<boolean> => {
        const fr = await ctx.client
          .call('first_responder_ready', {
            maxMs,
            ...(expectedField ? { testID: expectedField } : {}),
          })
          .catch(() => undefined);
        return !!(fr && fr.ok && fr.data && (fr.data as { ready?: boolean }).ready);
      };
      let ok = false;
      for (let attempt = 0; attempt < 4 && !ok; attempt++) {
        let focused = await responderReady(800);
        if (!focused) {
          // Wrong field focused, or none. Recovery order:
          //   1. The INTENDED field (last tap's testID) via the dylib
          //      focus path, rect-tap fallback.
          //   2. The live text field per the cross-process AX tree —
          //      composer/sheet inputs without a prior testID tap.
          //      Deliberately second: during a focus switch AX still
          //      reports the OLD field; preferring it typed into the
          //      wrong input.
          //   3. axFocusTextField as the last resort.
          // Never re-tap the opener here — that toggles an open sheet
          // SHUT (the bug behind consecutive replies failing).
          let focusTap = false;
          if (expectedField) {
            const r = await ctx.client
              .call('focus_testid', { testID: expectedField })
              .catch(() => undefined);
            focusTap = !!(r && r.ok && r.data && (r.data as { ok?: boolean }).ok);
            if (!focusTap) {
              const rect = await ctx.client
                .call('find_by_testid', { testID: expectedField })
                .catch(() => undefined);
              if (rect && rect.ok && rect.data) {
                const rr = rect.data as { x: number; y: number; w: number; h: number };
                await ctx.driver.tap(ctx.udid, rr.x + rr.w / 2, rr.y + rr.h / 2, {
                  intent: 'focus',
                });
                focusTap = true;
              }
            }
          }
          if (!focusTap) {
            const fieldId = await ctx.platform.ax.textFieldId(ctx.udid);
            if (fieldId) {
              const r = await ctx.client
                .call('find_by_testid', { testID: fieldId })
                .catch(() => undefined);
              if (r && r.ok && r.data) {
                const rr = r.data as { x: number; y: number; w: number; h: number };
                await ctx.driver.tap(ctx.udid, rr.x + rr.w / 2, rr.y + rr.h / 2, {
                  intent: 'focus',
                });
                focusTap = true;
              }
            }
          }
          if (!focusTap) {
            await ctx.platform.ax.focusTextField(ctx.udid).catch(() => false);
          }
          await responderReady(800);
        }
        try {
          const r = await ctx.client.call('insert_text', {
            text,
            ...(expectedField ? { testID: expectedField } : {}),
          });
          ok = !!(r.ok && r.data && (r.data as { ok: boolean }).ok);
        } catch {
          /* retry */
        }
        if (!ok) await sleep(300); // let the composer settle before retrying
      }
      if (!ok) await hidType(ctx.udid, text);
      // With --no-animations, React re-renders from onChangeText settle in
      // ~1 frame. 30ms stability window sufficient vs 80ms with animations.
      const textStableMs = process.env.ENNIO_NO_ANIMATIONS === '1' ? 30 : 80;
      await ctx.client.call('wait_commit', { maxMs: 500, stableMs: textStableMs });
      // Drain any in-flight request a field change / earlier navigation kicked
      // off, then let React propagate its result, BEFORE the next step submits.
      // Closes async-after-navigation races with no blind sleep: bsky login
      // needs the describeServer lookup to land so "alice" resolves to
      // "alice.test"; nothing visible marks that arrival, but the RN OkHttp
      // in-flight count dropping to zero does. No-op (returns fast, idle=known
      // false) on iOS / non-RN apps where the op is unimplemented.
      if (ctx.platform.name === 'android') {
        const netr = await ctx.client
          .call('wait_network_idle', { maxMs: 4000, idleMs: 120 })
          .catch(() => undefined);
        // Only re-settle React when we actually waited for a request to drain
        // (idle && known); the never-busy fast path returns instantly and
        // needs no extra commit wait.
        const nd = netr?.data as { waited?: boolean } | undefined;
        if (nd?.waited) {
          await ctx.client.call('wait_commit', { maxMs: 500, stableMs: textStableMs });
        }
      }
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
      // A submit key (Enter/Return) fires the form's handler, which reads
      // state populated by an earlier async lookup. On Android, drain any
      // in-flight (or imminent — grace window) request and let React
      // propagate its result BEFORE submitting, so the handler sees loaded
      // data. Closes the bsky login race deterministically: the custom
      // server's describeServer (kicked off late, in the dialog's
      // close-animation callback) must land so "alice" → "alice.test"
      // before createSession fires. No-op on iOS / non-RN (idle:known=false).
      if (ctx.platform.name === 'android' && (name === 'enter' || name === 'return')) {
        const netr = await ctx.client
          .call('wait_network_idle', { maxMs: 6000, idleMs: 120, graceMs: 1200 })
          .catch(() => undefined);
        if ((netr?.data as { waited?: boolean } | undefined)?.waited) {
          await ctx.client.call('wait_commit', { maxMs: 800, stableMs: 120 }).catch(() => undefined);
        }
      }
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
