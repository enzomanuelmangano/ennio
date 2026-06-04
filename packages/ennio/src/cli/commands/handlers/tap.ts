// Tap handlers: tapOn / doubleTapOn / longPress / longPressOn.
//
// tapOn is the heavyweight: optional / repeat / collapsed double-tap
// (look-ahead at next command), pre-tap settle, focus-via-testID for
// next-step inputText, post-tap commit + presentation-idle waits.
// doubleTapOn / longPress are thin HID wrappers.

import { CommandRegistry } from '../../core/command-registry';
import type { MaestroCommand } from '../../maestro-parser';
import { normalizeSelector } from '../../maestro-parser';
import { doubleTap as hidDoubleTap, tap as hidTap } from '../../hid';
import { POST_TAP_SETTLE_MS, sleep, timedAsync } from '../../runner/context';
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
      const sel = normalizeSelector(cmd.tapOn as Parameters<typeof normalizeSelector>[0]);
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
      // Fast mode: no collapse. The collapse works around HID's tap-gap
      // landing inside RN's double-tap window; in-process activations
      // fire onPress deterministically per call, and mixing one HID
      // doubleTap with a follow-up activation has been seen to drop an
      // increment (g-switch-stepper).
      if (!ctx.fast && nextIsSameTap && sel.id && !ctx.lastWasTextInput) {
        const rect = await findOnce(ctx, sel);
        if (rect && (rect.w > 5 || rect.h > 5)) {
          await timedAsync(ctx, 'tap.execTapOn', () =>
            hidDoubleTap(ctx.udid, rect.x + rect.w / 2, rect.y + rect.h / 2),
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
        await ctx.client.call('wait_commit', { maxMs: 1500, stableMs: 200 }).catch(() => undefined);
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
        focusedViaTestId = !!(r && r.ok);
      }
      if (focusedViaTestId) {
        // Field is firstResponder — skip the HID tap so the
        // mid-animation keyboard doesn't intercept the touch.
        await ctx.client.call('wait_commit', { maxMs: 1000, stableMs: 200 }).catch(() => undefined);
        ctx.lastTapKey = tapKey;
        ctx.lastTapTestID = sel.id;
        return;
      }
      // Fast-mode exception: a tap whose next command types text must
      // deliver REAL focus. In-process activation fires onPress but
      // does not focus native inputs (UISearchBar — g-searchbar), and
      // the focus_testid shortcut above only covers id selectors.
      if (ctx.fast && nextEditsField) ctx.suppressFastTap = true;
      try {
        await timedAsync(ctx, 'tap.execTapOn', () => execTapOn(ctx, sel, preTapHash));
      } finally {
        ctx.suppressFastTap = false;
      }
      if (isRepeatTap || nextIsSameTap) {
        await timedAsync(ctx, 'tap.postSleepRepeat', () => sleep(120));
      } else if (ctx.fast) {
        // Fast mode: event-driven only. wait_hash_change returns the
        // instant the visible tree differs (the tap's effect landed);
        // a short stable window smooths mid-layout reads. Animation
        // tails are absorbed by the NEXT command's own guards — the
        // pre-tap animations_active poll, the position-stability gate
        // in execTapOn, and assert/find polling.
        await timedAsync(ctx, 'tap.postWaitHashChange', async () => {
          await ctx.client
            .call('wait_hash_change', { sinceHash: preTapHash, maxMs: 500 })
            .catch(() => undefined);
        });
        if (nextEditsField) {
          await ctx.client
            .call('wait_react_commit', { sinceMs: preReact.ts, maxMs: 250 })
            .catch(() => undefined);
        }
        // Tight cap: on screens with perpetual animation (auto-playing
        // carousel) the hash never stabilises and a stableMs wait just
        // burns its full maxMs budget. Hash-change above already proved
        // the tap landed.
        await timedAsync(ctx, 'tap.postWaitCommit', () =>
          ctx.client.call('wait_commit', { maxMs: 250, stableMs: 60 }).catch(() => undefined),
        );
      } else if (preReact.attach !== 'none') {
        // Hermes/Paper/Fabric commit observer attached — block on the
        // next RN commit AFTER the tap.
        const waitOneCommit = async (since: number, maxMs: number): Promise<number> => {
          const r = await ctx.client
            .call('wait_react_commit', { sinceMs: since, maxMs })
            .catch(() => undefined);
          if (!r || !r.ok || !r.data) return 0;
          const data = r.data as { ok: boolean; elapsedMs: number };
          if (!data.ok) return 0;
          const ts = await captureReactTs(ctx);
          return ts.ts || since + (data.elapsedMs ?? 0);
        };
        const committed = await timedAsync(ctx, 'tap.postWaitReactCommit', async () => {
          const deadline = Date.now() + 1500;
          while (Date.now() < deadline) {
            const cur = await captureHash(ctx);
            if (cur !== preTapHash) {
              const animR = await ctx.client.call('animations_active').catch(() => undefined);
              const animActive = !!(
                animR &&
                animR.ok &&
                animR.data &&
                (animR.data as { active?: boolean }).active
              );
              if (!animActive) {
                if (nextEditsField) {
                  await waitOneCommit(preReact.ts, 250);
                }
                return true;
              }
            }
          }
          return false;
        });
        if (!committed) {
          await timedAsync(ctx, 'tap.postWaitHashChange', async () => {
            await ctx.client
              .call('wait_hash_change', { sinceHash: preTapHash, maxMs: 400 })
              .catch(() => undefined);
          });
        }
        await timedAsync(ctx, 'tap.postWaitCommit', () =>
          ctx.client.call('wait_commit', { maxMs: 1500, stableMs: 200 }).catch(() => undefined),
        );
      } else {
        // Event-driven post-tap settle. wait_hash_change inside the
        // dylib returns the instant the visible-UIView hash differs.
        const changed = await timedAsync(ctx, 'tap.postWaitHashChange', async () => {
          const r = await ctx.client
            .call('wait_hash_change', { sinceHash: preTapHash, maxMs: 600 })
            .catch(() => undefined);
          return !!(r && r.ok && r.data && (r.data as { ok: boolean }).ok);
        });
        if (!changed) {
          const animR = await ctx.client.call('animations_active').catch(() => undefined);
          const animActive = !!(
            animR &&
            animR.ok &&
            animR.data &&
            (animR.data as { active?: boolean }).active
          );
          const settleMs = animActive ? POST_TAP_SETTLE_MS : Math.min(POST_TAP_SETTLE_MS, 400);
          await timedAsync(ctx, 'tap.postSleep', () => sleep(settleMs));
        }
        await timedAsync(ctx, 'tap.postWaitCommit', () =>
          ctx.client.call('wait_commit', { maxMs: 800, stableMs: 350 }).catch(() => undefined),
        );
        // UIKit-level tail: modal-dismiss / RN-Nav interactive pop
        // transitions that don't fire React commits.
        await ctx.client.call('wait_presentation_idle', { maxMs: 500 }).catch(() => undefined);
      }
      ctx.lastTapKey = tapKey;
      ctx.lastTapTestID = sel.id;
    },
  );

  registry.register(
    (c): c is MaestroCommand & DoubleTapOnCmd => has(c, 'doubleTapOn'),
    async (cmd, { ctx }) => {
      const sel = normalizeSelector(cmd.doubleTapOn as Parameters<typeof normalizeSelector>[0]);
      const { x, y } = await resolveCenter(ctx, sel);
      await hidDoubleTap(ctx.udid, x, y);
      await sleep(POST_TAP_SETTLE_MS);
    },
  );

  registry.register(
    (c): c is MaestroCommand & LongPressCmd =>
      typeof c === 'object' && c !== null && ('longPress' in c || 'longPressOn' in c),
    async (cmd, { ctx }) => {
      const sel = normalizeSelector(
        ('longPress' in cmd ? cmd.longPress : cmd.longPressOn) as Parameters<
          typeof normalizeSelector
        >[0],
      );
      const { x, y } = await resolveCenter(ctx, sel);
      // Long press = tap with hold duration. Maestro default 1500ms;
      // many RN handlers register at ~500ms — 0.8s is the middle.
      await hidTap(ctx.udid, x, y, 0.8);
      await sleep(POST_TAP_SETTLE_MS);
    },
  );
}
