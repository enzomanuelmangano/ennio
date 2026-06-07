// Tap handlers: tapOn / doubleTapOn / longPress / longPressOn.
//
// tapOn is the heavyweight: optional / repeat / collapsed double-tap
// (look-ahead at next command), pre-tap settle, focus-via-testID for
// next-step inputText, post-tap commit + presentation-idle waits.
// doubleTapOn / longPress are thin HID wrappers.

import { CommandRegistry } from '../../core/command-registry';
import type { MaestroCommand } from '../../maestro-parser';
import { normalizeSelector } from '../../maestro-parser';
import { POST_TAP_SETTLE_MS, interpolateSelector, sleep, timedAsync } from '../../runner/context';
import { captureHash, captureReactTs, findOnce, resolveCenter } from '../../runner/find';
import { execTapOn } from '../../runner/tap';

interface TapOnCmd {
  tapOn: unknown;
}
interface DoubleTapOnCmd {
  doubleTapOn: unknown;
}
interface LongPressCmd {
  longPress?: unknown;
  longPressOn?: unknown;
}

function has<T extends string>(
  cmd: MaestroCommand,
  key: T,
): cmd is MaestroCommand & Record<T, unknown> {
  return typeof cmd === 'object' && cmd !== null && key in cmd;
}

export function registerTapHandlers(registry: CommandRegistry): void {
  registry.register(
    (c): c is MaestroCommand & TapOnCmd => has(c, 'tapOn'),
    async (cmd, { ctx, nextCmd }) => {
      const sel = normalizeSelector(
        interpolateSelector(cmd.tapOn, ctx) as Parameters<typeof normalizeSelector>[0],
      );
      // Maestro `optional: true`: silently skip if selector misses.
      const tapObj =
        cmd.tapOn && typeof cmd.tapOn === 'object'
          ? (cmd.tapOn as { optional?: boolean; repeat?: number; delay?: number })
          : null;
      const isOptional = !!tapObj?.optional;
      if (isOptional) {
        const r = await findOnce(ctx, sel);
        if (!r) return;
      }
      // Maestro `repeat: N` + `delay: ms`: N taps with `delay` ms gap.
      if (tapObj?.repeat && tapObj.repeat > 1) {
        const times = tapObj.repeat;
        const delayMs = tapObj.delay ?? 200;
        for (let i = 0; i < times; i++) {
          if (i > 0) await sleep(delayMs);
          await execTapOn(ctx, sel);
        }
        return;
      }
      const tapKey = JSON.stringify(sel);
      const isRepeatTap = ctx.lastTapKey === tapKey;
      // Look-ahead: collapse two same-target taps into one HID
      // double-tap so the gap lands inside RN's double-tap window.
      let nextIsSameTap = false;
      if (nextCmd && typeof nextCmd === 'object' && 'tapOn' in nextCmd) {
        const nextSel = normalizeSelector(
          (nextCmd as { tapOn: unknown }).tapOn as Parameters<typeof normalizeSelector>[0],
        );
        if (JSON.stringify(nextSel) === tapKey) nextIsSameTap = true;
      }
      // Collapse policy lives on the driver — HID needs it (two real
      // taps land inside RN's double-tap window), in-process
      // activation fires onPress deterministically per call and must
      // NOT collapse (g-switch-stepper dropped an increment).
      if (ctx.driver.collapsesRepeatTaps && nextIsSameTap && sel.id && !ctx.lastWasTextInput) {
        const rect = await findOnce(ctx, sel);
        if (rect && (rect.w > 5 || rect.h > 5)) {
          await timedAsync(ctx, 'tap.execTapOn', () =>
            ctx.driver.doubleTap(ctx.udid, rect.x + rect.w / 2, rect.y + rect.h / 2),
          );
          ctx.lastTapKey = tapKey;
          ctx.lastTapTestID = sel.id;
          ctx.skipNextCmd = true;
          return;
        }
      }
      // After typing, the editing-menu popover floats over the screen
      // and eats the next tap. Resign first responder unless the next
      // tap is another text input.
      const tapIsIntoInput = sel.id && /Input$/i.test(sel.id);
      if (ctx.lastWasTextInput && !tapIsIntoInput) {
        await ctx.client.call('hide_keyboard').catch(() => undefined);
        // Wait for the keyboard window to actually retract — wait_commit
        // tracks the app view-hash, not the separate keyboard window's
        // dismiss animation, so a tap could fire while it still covers
        // the target (the custom-server "Done" case).
        const kbDeadline = Date.now() + 1200;
        while (Date.now() < kbDeadline) {
          const kr = await ctx.client.call('keyboard_frame').catch(() => undefined);
          if (!(kr?.data as { visible?: boolean } | undefined)?.visible) break;
          await sleep(50);
        }
      }
      ctx.lastWasTextInput = false;
      if (!isRepeatTap) {
        // Pre-tap settle: wait for any UIKit transition to fully end.
        await timedAsync(ctx, 'tap.preWaitCommit', async () => {
          const deadline = Date.now() + 1500;
          while (Date.now() < deadline) {
            const r = await ctx.client.call('animations_active').catch(() => undefined);
            const active = !!(r && r.ok && r.data && (r.data as { active?: boolean }).active);
            if (!active) break;
            await sleep(20);
          }
        });
      }
      const preTapHash = await captureHash(ctx);
      const preReact = await captureReactTs(ctx);
      // If next op edits the field AND we have a testID, route the
      // "tap to focus" through focus_testid (calls becomeFirstResponder
      // in-process — deterministic, no race with onPress-driven focus).
      const nextEditsField =
        !!nextCmd &&
        typeof nextCmd === 'object' &&
        ('inputText' in nextCmd || 'eraseText' in nextCmd || 'clearText' in nextCmd);
      let focusedViaTestId = false;
      if (sel.id && nextEditsField) {
        const r = await ctx.client.call('focus_testid', { testID: sel.id }).catch(() => undefined);
        // r.ok is the TRANSPORT result; the handler reports whether the
        // focus actually landed in r.data.ok. Conflating them made every
        // focus_testid "succeed" and skip the real tap (thread-muting:
        // tapOn replyBtn + next inputText never pressed the button).
        focusedViaTestId = !!(r && r.ok && (r.data as { ok?: boolean } | undefined)?.ok);
        if (process.env.ENNIO_PHASE_TRACE) {
          process.stderr.write(
            `[dbg] focus_testid id=${sel.id} ok=${focusedViaTestId} raw=${JSON.stringify(r?.data ?? null)}\n`,
          );
        }
      }
      if (focusedViaTestId) {
        // Field is firstResponder — skip the HID tap so the
        // mid-animation keyboard doesn't intercept the touch.
        // With --no-animations the in-app render after focus settles in
        // ~1 frame — 50ms stability window is sufficient vs 200ms.
        const focusStableMs = process.env.ENNIO_NO_ANIMATIONS === '1' ? 50 : 200;
        await ctx.client
          .call('wait_commit', { maxMs: 1000, stableMs: focusStableMs })
          .catch(() => undefined);
        ctx.lastTapKey = tapKey;
        ctx.lastTapTestID = sel.id;
        return;
      }
      // A tap whose next command types text must deliver REAL focus —
      // in-process activation fires onPress but does not focus native
      // inputs (UISearchBar — g-searchbar), and the focus_testid
      // shortcut above only covers id selectors. Express the intent;
      // the driver picks the mechanism.
      await timedAsync(ctx, 'tap.execTapOn', () =>
        execTapOn(ctx, sel, preTapHash, nextEditsField ? 'focus' : 'press'),
      );
      if (isRepeatTap || nextIsSameTap) {
        await timedAsync(ctx, 'tap.postSleepRepeat', () => sleep(120));
      } else {
        await timedAsync(ctx, 'tap.postSettle', () =>
          ctx.driver.settleAfterTap(ctx.client, {
            preTapHash,
            reactAttach: preReact.attach,
            reactSinceMs: preReact.ts,
            nextEditsField,
          }),
        );
      }
      ctx.lastTapKey = tapKey;
      ctx.lastTapTestID = sel.id;
    },
  );

  registry.register(
    (c): c is MaestroCommand & DoubleTapOnCmd => has(c, 'doubleTapOn'),
    async (cmd, { ctx }) => {
      const sel = normalizeSelector(
        interpolateSelector(cmd.doubleTapOn, ctx) as Parameters<typeof normalizeSelector>[0],
      );
      const { x, y } = await resolveCenter(ctx, sel);
      await ctx.driver.doubleTap(ctx.udid, x, y);
      await sleep(POST_TAP_SETTLE_MS);
    },
  );

  registry.register(
    (c): c is MaestroCommand & LongPressCmd =>
      typeof c === 'object' && c !== null && ('longPress' in c || 'longPressOn' in c),
    async (cmd, { ctx }) => {
      const sel = normalizeSelector(
        interpolateSelector(
          'longPress' in cmd ? cmd.longPress : cmd.longPressOn,
          ctx,
        ) as Parameters<typeof normalizeSelector>[0],
      );
      const { x, y } = await resolveCenter(ctx, sel);
      // Long press = tap with hold duration. Maestro default 1500ms;
      // many RN handlers register at ~500ms — 0.8s is the middle.
      await ctx.driver.tap(ctx.udid, x, y, { intent: 'longPress', holdSec: 0.8 });
      await sleep(POST_TAP_SETTLE_MS);
    },
  );
}
