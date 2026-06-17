// Core tap pipeline — `execTapOn` is the single entry point every
// tapOn-style command flows through. Handles:
//
//   * point taps (Maestro `tapOn: { point: "x%,y%" }`)
//   * alert-button taps (route through UIAlertAction)
//   * selector taps (testID / text / childOf) with:
//       - position-stability gate (catches RN list reorder + composer
//         mount animations that would land the tap on the wrong view)
//       - hit-test exposure wait (skips taps while a sheet is still
//         mid-animation — layout rect at final position but layer at
//         visual midway)
//       - tiny-control 3× fire (1×1 px e2e-only Pressables miss on int
//         rounding, fire pure Down+Up three times)
//       - find-and-retap self-heal (exits on hash change / target lost /
//         exposure flip; covers RNGH late-recogniser races + Mantis /
//         PHPicker cropper hosts with continuous repaints)
//       - activate_testid final fallback (invokes
//         _accessibilityHandleUserTouchActivate directly when the
//         gesture chain never armed)

import type { TapIntent } from '../driver/types';
import { bumpActuationGen, getScreenSize } from '../hid';
import { MaestroSelector } from '../maestro-parser';
import { chainHasAsyncPayloadHost, SUBMIT_DISMISS_TESTID_PATTERN } from './capabilities';

import { DEFAULT_WIN_H, DEFAULT_WIN_W, Rect, RunContext, sleep, timedAsync } from './context';
import { captureHash, captureReactTs, parsePoint, resolveRect } from './find';

// A find slower than this means the app's main thread is starved (the
// in-process finder polls there). Normal finds are ~16ms, so this only
// trips under genuine load — where the per-tap coord cross-check +
// off-viewport probe each cost seconds and are skipped. Env-tunable.
const MAIN_THREAD_SLOW_MS = Number(process.env.ENNIO_MAIN_THREAD_SLOW_MS) || 1500;

interface KeyboardFrame {
  visible: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Query the software-keyboard window rect (separate high-level
 *  UIWindow that is_exposed can't see). Returns null when no op /
 *  not visible. */
async function keyboardFrame(ctx: RunContext): Promise<KeyboardFrame | null> {
  const r = await ctx.client.call('keyboard_frame').catch(() => undefined);
  const d = r?.data as KeyboardFrame | undefined;
  return d && d.visible ? d : null;
}

/** Wait for the keyboard window to actually retract after a
 *  hide_keyboard. wait_commit tracks the app view-hash, not the
 *  keyboard window's dismiss animation, so a tap could fire while the
 *  keyboard still covers the target. Poll the keyboard frame until it's
 *  gone (cap 1200ms). */
async function waitKeyboardHidden(ctx: RunContext): Promise<void> {
  const deadline = Date.now() + 1200;
  while (Date.now() < deadline) {
    if (!(await keyboardFrame(ctx))) return;
    await sleep(50);
  }
}

/** Dismiss the software keyboard before a tap when it would otherwise
 *  swallow that tap, and wait for it to retract. Two ways a tap dies to
 *  the keyboard:
 *
 *   1. COVERAGE — the target sits under the keyboard window. is_exposed
 *      hit-tests the app window only (the keyboard is a separate
 *      high-level window), so the target reads as exposed while a real
 *      HID touch lands on the keyboard.
 *   2. PERSIST-TAPS — even when the target is ABOVE the keyboard, RN's
 *      default keyboardShouldPersistTaps consumes the first tap on a
 *      NON-input view to dismiss the keyboard; the target's onPress never
 *      fires (the custom-server "Done" button: visible above the keyboard,
 *      yet the first tap only closes the keyboard). Real-user parity.
 *
 *  So: if the keyboard is up, dismiss it first UNLESS the target itself is
 *  a text input (tapping another field just moves focus — keyboard stays,
 *  no swallow) or the target sits inside the keyboard area (covered → also
 *  dismiss). Leaving the keyboard up for text-input targets preserves
 *  input-accessory / autocomplete behaviour. Normalized center in [0,1]. */
async function clearKeyboardOverTarget(
  ctx: RunContext,
  centerNx: number,
  centerNy: number,
): Promise<void> {
  const kb = await keyboardFrame(ctx);
  if (!kb) return;
  const covered =
    centerNx >= kb.x && centerNx <= kb.x + kb.w && centerNy >= kb.y && centerNy <= kb.y + kb.h;
  if (!covered) {
    // Target is above the keyboard. Only the persist-taps swallow applies,
    // and only to non-input targets — leave the keyboard up when tapping
    // another text input (focus move, no swallow).
    const r = await ctx.client
      .call('is_text_input_at', { nx: centerNx, ny: centerNy })
      .catch(() => undefined);
    const isTextInput = !!(r?.ok && (r.data as { isTextInput?: boolean })?.isTextInput);
    if (isTextInput) return;
  }
  await ctx.client.call('hide_keyboard').catch(() => undefined);
  await waitKeyboardHidden(ctx);
}

export async function execTapOn(
  ctx: RunContext,
  sel: MaestroSelector,
  preHash?: string,
  intent: TapIntent = 'press',
): Promise<void> {
  // Point-tap fast path — no discovery needed. Wait for commits to
  // quiesce before firing: the YAML emits literal-coord taps right
  // after assertVisible-style gates, and a picker / sheet may still
  // be animating into place at the coord the YAML predicted. Without
  // a settle, the tap can land on a still-moving frame or behind a
  // transitioning overlay.
  if (sel.point !== undefined) {
    // Settle budget is env-tunable: on slow hosts (CI VMs) a picker
    // sheet's image grid keeps committing while thumbnails decode, the
    // 1500ms cap expires mid-load, and the blind point-tap lands on a
    // not-yet-hittable cell (observed: bsky onboarding's 50%,22% photo
    // pick dismissing the sheet pick-less).
    const pointSettleMaxMs =
      parseInt(process.env.ENNIO_POINT_TAP_SETTLE_MAX_MS ?? '1500', 10) || 1500;
    await ctx.client
      .call('wait_commit', { maxMs: pointSettleMaxMs, stableMs: 250 })
      .catch(() => undefined);
    // wait_commit tracks REACT commits — a sheet rising via a pure CA /
    // presentation animation is invisible to it, and a point tap fired
    // mid-rise lands where the YAML's coordinate WILL be, not where it
    // is (observed: bsky onboarding's 50%,22% photo pick hitting the
    // backdrop above the still-rising sheet, dismissing it pick-less on
    // a slow CI VM). Wait out in-flight animations + presentation
    // transitions too — one cheap RPC when nothing is animating.
    {
      // Animation budget rides the same env knob as the commit settle —
      // a host slow enough to need a longer commit budget is slow at
      // animations too.
      const animDeadline = Date.now() + Math.max(3000, pointSettleMaxMs);
      while (Date.now() < animDeadline) {
        const a = await ctx.client.call('animations_active').catch(() => undefined);
        if (!(a?.ok && (a.data as { active?: boolean } | undefined)?.active)) break;
        await sleep(60);
      }
      await ctx.client.call('wait_presentation_idle', { maxMs: 1500 }).catch(() => undefined);
    }
    let winW = DEFAULT_WIN_W;
    let winH = DEFAULT_WIN_H;
    const ws = await ctx.client.call('window_size').catch(() => undefined);
    if (ws && ws.ok && ws.data) {
      const d = ws.data as { w: number; h: number };
      if (d.w > 0 && d.h > 0) {
        winW = d.w;
        winH = d.h;
      }
    }
    const { x, y } = parsePoint(sel.point, winW, winH);
    await ctx.driver.tap(ctx.udid, x, y, { intent });
    return;
  }
  // UIAlertController auto-handler: button labels never make it into
  // the RN view tree, so a text-selector tap on an alert button would
  // miss. Detect a present alert and route through the dylib's
  // alert_tap op, which targets the UIAlertAction directly.
  if (sel.text) {
    try {
      const a = await timedAsync(ctx, 'tap.alertProbe', () => ctx.client.call('alert_present'));
      if (a.ok && a.data && (a.data as { present: boolean }).present) {
        bumpActuationGen();
        const t = await ctx.client.call('alert_tap', { buttonText: sel.text });
        if (t.ok && t.data && (t.data as { tapped: boolean }).tapped) return;
      }
    } catch {
      /* fall through to normal find */
    }
    // Tab-bar routing is a driver decision: fast routes text matching
    // a tab item through tap_tab up front (in-process, deterministic,
    // idempotent — re-tapping the CURRENT tab produces zero visual
    // change, which would otherwise trip the phantom detector into a
    // pointless HID redo); baseline keeps the probe in the retap loop
    // only.
    if (await timedAsync(ctx, 'tap.tabProbe', () => ctx.driver.tryTabTap(ctx.client, sel.text!)))
      return;
    // (Skipped when childOf is set — the cross-process AX can't scope by
    // parent, and a bare testID/label match would pick the wrong sibling.)
    // Text tap onto a testID'd interactive container the in-app finder
    // mis-locates: it returns the inner Text label's rect (a pager tab,
    // a segmented control), so the HID tap lands on the label and the
    // Pressable's onPress never fires. The cross-process AX tree carries
    // the FULL interactive element (with its testID) at device-correct
    // coords — when the label resolves there to a testID'd element, tap
    // it and verify the frame moved. High-confidence (testID-backed) and
    // text-only, so the hot path is unaffected; falls through on no
    // match / no effect / off-box.
    const axEl = sel.childOf
      ? null
      : await timedAsync(ctx, 'tap.axFastResolve', () =>
          ctx.platform.ax.resolve(ctx.udid, { text: sel.text }),
        );
    if (axEl) {
      // Doomed-tap gate for the AX fast path: a VC transition in flight
      // at dispatch time swallows the touch AND means the AX snapshot
      // (taken ~300-800 ms ago) likely located the OUTGOING screen's
      // instance of the label (feed-reorder: "Go back" on the dismissing
      // edit-feeds screen). The ambient dismiss animation then satisfies
      // the hash check below, masking the lost tap. If we had to wait,
      // the coords are stale — skip the fast path and fall through to
      // the standard find, which re-resolves on the settled hierarchy.
      const pi = await timedAsync(ctx, 'tap.axPresIdle', () =>
        ctx.client.call('wait_presentation_idle', { maxMs: 2500 }).catch(() => undefined),
      );
      const axWaitedMs = Number((pi?.data as { elapsedMs?: number } | undefined)?.elapsedMs ?? 0);
      if (axWaitedMs <= 50) {
        const { w, h } = await getScreenSize(ctx.udid);
        const baseHash = preHash ?? (await captureHash(ctx));
        await ctx.driver.tap(ctx.udid, axEl.cx * w, axEl.cy * h, { intent });
        const hc = await ctx.client
          .call('wait_hash_change', { sinceHash: baseHash, maxMs: 500 })
          .catch(() => undefined);
        if (hc && hc.ok && (hc.data as { ok?: boolean })?.ok) {
          // A native bottom-sheet menu row was tapped; wait for its
          // dismiss transition to actually END (signal, not a fixed
          // sleep) so the NEXT tap (often a button that re-opens a
          // sibling sheet) doesn't race the animation and miss.
          await ctx.client.call('wait_presentation_idle', { maxMs: 1200 }).catch(() => undefined);
          await ctx.client
            .call('wait_commit', { maxMs: 800, stableMs: 150 })
            .catch(() => undefined);
          return;
        }
      }
    }
  }
  const findStart = Date.now();
  let rect = await timedAsync(ctx, 'tap.find', () => resolveRect(ctx, sel));
  // The find's own latency is a free main-thread-load probe. The dylib's
  // finder polls on the app's MAIN thread; when that thread is CPU-starved
  // (busy launch/render frame, a loaded CI runner) the find burns seconds
  // to locate an element that's already on screen. Every OTHER per-tap
  // in-process round-trip (the ambiguity probe, AX coord cross-check, the
  // off-viewport window_size probe) is just as starved — each adds ~seconds.
  // When the find was slow, we're degraded: take the lean path and skip the
  // belt-and-suspenders refinements (they each cost ~3s under load and the
  // element is already located on-screen). When the find was fast the main
  // thread is healthy and those checks are ~free, so run them unchanged —
  // no behaviour change off the degraded path.
  const mainThreadSlow = Date.now() - findStart > MAIN_THREAD_SLOW_MS;
  if (!rect) {
    // A cross-process system sheet (Photo Library, tracking, a
    // SpringBoard confirmation) may be floating over the app and hiding
    // the in-app target. Clear it via the macOS AX tree + a real HID
    // tap, then resolve once more before giving up.
    if (await ctx.platform.ax.dismissSystemSheet(ctx.udid).catch(() => false)) {
      await ctx.client.call('wait_commit', { maxMs: 1500, stableMs: 200 }).catch(() => undefined);
      rect = await timedAsync(ctx, 'tap.find', () => resolveRect(ctx, sel));
    }
  }
  if (!rect && (sel.id || sel.text) && !sel.childOf) {
    // The target may live in a native bottom-sheet / popover the in-app
    // dylib doesn't traverse (Bluesky's Dialog/Prompt + composer render
    // in a separate SheetViewController window). It's still on screen,
    // so the cross-process AX tree sees it — match by testID (bridged
    // AXIdentifier) or label and tap it directly. Soft-fails off-box.
    if (
      await ctx.platform.ax.tapTarget(ctx.udid, { id: sel.id, text: sel.text }).catch(() => false)
    ) {
      return;
    }
  }
  if (!rect) {
    throw new Error(`element not found: ${JSON.stringify(sel)}`);
  }
  // Coordinate cross-check: the in-app rect can be a mislocated sub-rect
  // — the inner Text label of a tab-bar button or pager tab, where a tap
  // hits the label and the Pressable's onPress never fires — or a rect in
  // a native sheet window's coordinate space. If the cross-process AX
  // places the SAME element (by testID, or exact label) far from the
  // in-app center, the AX coords are device-authoritative; tap there and
  // return on a confirmed frame change. Only diverges when the two
  // disagree, so correctly-located taps fall straight through untouched.
  // Ambiguity guard: when a testID has MORE THAN ONE on-screen match
  // (a reply notification + a "followed you" row both tagged
  // feedItem-by-bob.test), find_by_testid already picked the right
  // topmost instance — but the cross-process AX surfaces only one of
  // them, so a coord cross-check would mis-correct to the wrong row.
  // Skip the AX override entirely for ambiguous testIDs.
  // Also skip the whole cross-check (two more main-thread round-trips) when
  // the main thread is slow — under starvation it costs ~3s while the
  // already-located rect is good enough to tap.
  let ambiguousId = false;
  if (sel.id && !sel.childOf && !mainThreadSlow) {
    const nth = await timedAsync(ctx, 'tap.ambiguityProbe', () =>
      ctx.client.call('find_by_testid_nth', { testID: sel.id, index: 1 }).catch(() => undefined),
    );
    ambiguousId = !!(nth && nth.ok && nth.data);
  }
  if ((sel.id || sel.text) && !sel.childOf && !ambiguousId && !mainThreadSlow) {
    const axEl = await timedAsync(ctx, 'tap.axCrossResolve', () =>
      ctx.platform.ax.resolve(ctx.udid, { id: sel.id, text: sel.text }),
    );
    // Only correct SMALL interactive elements (buttons, tabs, menu rows
    // — height < ~12% of the screen). For a large container (a feed item,
    // a card) the AX "center" can sit on an inner sub-link (the avatar →
    // profile) while the in-app rect already targets the right body
    // region; overriding there would mis-route the tap.
    if (axEl && axEl.nh > 0 && axEl.nh < 0.12) {
      const { w, h } = await getScreenSize(ctx.udid);
      const axCx = axEl.cx * w;
      const axCy = axEl.cy * h;
      const inCx = rect.x + rect.w / 2;
      const inCy = rect.y + rect.h / 2;
      if (Math.hypot(axCx - inCx, axCy - inCy) > 44) {
        const baseHash = preHash ?? (await captureHash(ctx));
        await ctx.driver.tap(ctx.udid, axCx, axCy, { intent });
        if (sel.id) ctx.lastTapTestID = sel.id;
        const hc = await ctx.client
          .call('wait_hash_change', { sinceHash: baseHash, maxMs: 500 })
          .catch(() => undefined);
        if (hc && hc.ok && (hc.data as { ok?: boolean })?.ok) return;
      }
    }
  }
  // Off-viewport auto-scroll: the testID resolved, but the rect
  // sits outside the window's visible bounds — common when a YAML
  // `swipe` doesn't fully snap a horizontal carousel to the target
  // page (gesture velocity is hardware-dependent: a swipe that
  // page-snaps on M-series local hardware can land short on slower
  // CI runners, leaving the target one page to the right of the
  // viewport). Tapping that off-screen coord lands on whatever's
  // visible at that pixel and the user's onPress never fires.
  // Drive the enclosing UIScrollView directly via scroll_to — its
  // scrollRectToVisible: is deterministic and ignores gesture
  // velocity entirely. Skipped when the main thread is slow: window_size is
  // another starved round-trip, and an off-viewport carousel target is far
  // rarer than a plain on-screen button being tapped under load.
  if (sel.id && !mainThreadSlow) {
    const sz = await ctx.client.call('window_size').catch(() => undefined);
    const wd = (sz?.data as { w?: number; h?: number }) ?? {};
    const winW = wd.w ?? 402;
    const winH = wd.h ?? 874;
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    const offViewport = cx < 0 || cx > winW || cy < 0 || cy > winH;
    if (offViewport) {
      if (process.env.ENNIO_PHASE_TRACE) {
        process.stderr.write(
          `[ennio] off-viewport id="${sel.id}" rect=(${rect.x.toFixed(0)},${rect.y.toFixed(0)},${rect.w.toFixed(0)},${rect.h.toFixed(0)}) center=(${cx.toFixed(0)},${cy.toFixed(0)}) win=(${winW.toFixed(0)},${winH.toFixed(0)}) → scroll_to\n`,
        );
      }
      bumpActuationGen();
      const scrollResp = await ctx.client
        .call('scroll_to', { elementTestID: sel.id })
        .catch(() => undefined);
      const scrolled = !!(
        scrollResp &&
        scrollResp.ok &&
        scrollResp.data &&
        (scrollResp.data as { scrolled?: boolean }).scrolled
      );
      if (process.env.ENNIO_PHASE_TRACE) {
        process.stderr.write(`[ennio] scroll_to id="${sel.id}" scrolled=${scrolled}\n`);
      }
      // After scrollRectToVisible the carousel snaps, but a virtualized
      // list (RN Fabric in Release) mounts items lazily — the target
      // view exists in the UIView tree (its testID resolves to a rect)
      // yet its press handler hasn't been wired by the JS thread yet.
      // Tapping in this window fires the coord but no handler responds.
      // Wait for a commit before re-resolving + tapping (universal
      // CoreAnimation commit signal, renderer-agnostic).
      await ctx.client.call('wait_react_commit', { sinceMs: 0, maxMs: 600 }).catch(() => undefined);
      const refresh = await timedAsync(ctx, 'tap.find', () => resolveRect(ctx, sel));
      if (refresh) {
        rect = refresh;
        if (process.env.ENNIO_PHASE_TRACE) {
          process.stderr.write(
            `[ennio] post-scroll rect id="${sel.id}" rect=(${refresh.x.toFixed(0)},${refresh.y.toFixed(0)},${refresh.w.toFixed(0)},${refresh.h.toFixed(0)})\n`,
          );
        }
      }
      // Activate path bypasses hit-test entirely. Works on RN
      // Pressable in most archs; returns false on Fabric Release
      // where Pressability's handler isn't reachable via the public
      // accessibility chain — fall through to HID tap in that case.
      bumpActuationGen();
      const r = await ctx.client.call('activate_testid', { testID: sel.id }).catch(() => undefined);
      const ok = !!(r && r.ok && r.data && (r.data as { ok?: boolean }).ok);
      if (process.env.ENNIO_PHASE_TRACE) {
        process.stderr.write(`[ennio] activate_testid id="${sel.id}" ok=${ok}\n`);
      }
      if (ok) return;
    }
  }
  // Hidden test-only controls: some apps expose 1×1 px elements
  // (TextInput and Pressable variants) as side-channels for e2e
  // harnesses. HID taps round to int — a 1×1 rect at
  // (401, 101) has its FP-center at (401.5, 101.5) which rounds
  // to (402, 102) — landing on the sibling button 1 px below.
  // Fall back to focus_testid for tiny TextInputs so the next
  // inputText routes via insert_text → firstResponder.
  if (sel.id && rect.w < 6 && rect.h < 6) {
    try {
      const r = await ctx.client.call('focus_testid', { testID: sel.id });
      if (r.ok && r.data && (r.data as { ok: boolean }).ok) return;
    } catch {
      /* fall through */
    }
  }
  // Position-stability gate: poll the selector-aware finder until 3
  // consecutive samples (10 ms apart) return the same rect. Catches
  // RN list reorder + composer mount animations — both shift the
  // target's window-space coords mid-layout. The check costs ~30 ms
  // in the common steady-state case, climbs to ~2 s on a shifting
  // layout. Replaces a stack of pre-tap settles that burned 700+ ms
  // unconditionally.
  const sampleRect = async (): Promise<Rect | null> => {
    if (sel.childOf && sel.childOf.id && sel.id) {
      const r = await ctx.client
        .call('find_child_by_testid', {
          childTestID: sel.id,
          parentTestID: sel.childOf.id,
        })
        .catch(() => undefined);
      if (r && r.ok && r.data) return r.data as Rect;
      return null;
    }
    if (sel.id) {
      const r = await ctx.client.call('find_by_testid', { testID: sel.id }).catch(() => undefined);
      if (r && r.ok && r.data) return r.data as Rect;
    }
    if (sel.text) {
      const r = await ctx.client.call('find_by_text', { text: sel.text }).catch(() => undefined);
      if (r && r.ok && r.data) return r.data as Rect;
    }
    return null;
  };
  const sameRect = (a: Rect | null, b: Rect | null): boolean =>
    !!a &&
    !!b &&
    Math.abs(a.x - b.x) < 1 &&
    Math.abs(a.y - b.y) < 1 &&
    Math.abs(a.w - b.w) < 1 &&
    Math.abs(a.h - b.h) < 1;
  let stableRect: Rect = rect;
  // Scroll-idle gate FIRST. A HID touch delivered while any scroll
  // view is mid-scroll (keyboard-driven setContentOffset, momentum)
  // is swallowed by the scroll view as "stop scrolling" and never
  // reaches the target — the tap "lands" but focuses nothing. The
  // in-house HID path is fast enough to beat those animations (idb's
  // gRPC latency used to accidentally outlive them), so wait for the
  // signal, not luck. Soft cap: a continuously-scrolling screen falls
  // through to the retap self-heal.
  await timedAsync(ctx, 'tap.waitScrollIdle', () =>
    ctx.client.call('wait_scroll_idle', { maxMs: 1200 }).catch(() => undefined),
  );
  // Position-stability gate. Preferred: the driver's signal-based
  // steadiness (wait_view_steady — frame-locked native sampling +
  // CALayer animation introspection; immune to spring inflection
  // points that fool socket-roundtrip sampling). Fallback: the legacy
  // CLI-side rect-sampling loop (HID driver, or the op missed).
  const steady = await timedAsync(ctx, 'tap.waitSteady', () =>
    ctx.driver.waitTargetSteady(ctx.client, { id: sel.id, text: sel.text }),
  );
  if (steady) {
    const cur = await sampleRect();
    if (cur) stableRect = cur;
  } else {
    const deadline = Date.now() + 800;
    const gapMs = ctx.driver.stabilityGateGapMs;
    let s1: Rect | null = rect;
    let s2: Rect | null = null;
    let s3: Rect | null = null;
    while (Date.now() < deadline) {
      await sleep(gapMs);
      const cur = await sampleRect();
      if (cur) {
        s3 = s2;
        s2 = s1;
        s1 = cur;
        if (sameRect(s1, s2) && sameRect(s2, s3)) {
          stableRect = s1!;
          break;
        }
      }
    }
  }
  const center = {
    x: stableRect.x + stableRect.w / 2,
    y: stableRect.y + stableRect.h / 2,
  };
  // Target-driven exposure wait. is_exposed hit-tests at the target's
  // layout-rect center and walks the responder chain — if the hit
  // doesn't land on the target (or a descendant) the target is
  // either covered by an overlay OR still mid-animation (the layer's
  // VISUAL position differs from its layout frame). Either way the
  // tap would land on the wrong layer; wait for hit-test to confirm
  // exposure.
  const exposureSel: { testID?: string; text?: string } | null = sel.id
    ? { testID: sel.id }
    : sel.text
      ? { text: sel.text }
      : null;
  // When the exposure wait expires without the target ever becoming
  // exposed, the point is covered by another layer (tab bar, overlay).
  // In fast mode the activation hitTest would land on — and activate —
  // that occluder (observed: g-pan row half under the tab bar fired
  // the tab button). Force a real HID tap for this gesture; UIKit
  // touch routing handles edge-covered rows far more gracefully.
  let confirmedExposed = true;
  if (exposureSel) {
    const checkExposed = async (): Promise<boolean> => {
      const r = await ctx.client.call('is_exposed', exposureSel).catch(() => undefined);
      return !!(r && r.ok && r.data && (r.data as { exposed?: boolean }).exposed);
    };
    if (!(await checkExposed())) {
      confirmedExposed = false;
      // Triage the occlusion BEFORE waiting: when the cover is a
      // presented modal (composer sheet pending an async publish →
      // server round-trip), exposure cannot flip until the modal
      // clears — the 800 ms animation wait and scroll_to below are
      // guaranteed dead time (measured: every waitExposed in the bsky
      // composer flow ran to its full cap, then the modal gate
      // resolved it anyway). The modal gate's own poll breaks early
      // the moment exposure flips, so the mid-dismissal case loses
      // nothing by skipping straight there.
      const earlyBm = await ctx.client.call('behind_modal', exposureSel).catch(() => undefined);
      const behindModalNow = !!(
        earlyBm &&
        earlyBm.ok &&
        (earlyBm.data as { behind?: boolean } | undefined)?.behind
      );
      if (!behindModalNow) {
        await timedAsync(ctx, 'tap.waitExposed', async () => {
          // 800 ms cap: RN animations (sheet present/dismiss, modal
          // slide) are typically 300-500 ms. The retap-self-heal loop
          // covers any case where the initial tap still misses.
          const deadline = Date.now() + 800;
          while (Date.now() < deadline) {
            await sleep(80);
            if (await checkExposed()) {
              confirmedExposed = true;
              break;
            }
          }
        });
        // Occlusion self-heal: still covered after the wait AND we have
        // a testID → the cover is positional (target parked under the
        // tab bar / nav header), not transitional. scroll_to drives
        // scrollRectToVisible:, which respects adjusted contentInset on
        // any layout — UIKit moves the row clear of its own chrome.
        // This is checked at TAP time (not in scrollUntilVisible) so the
        // answer can't decay between scroll and tap.
        if (!confirmedExposed && sel.id) {
          await timedAsync(ctx, 'tap.scrollToExpose', async () => {
            bumpActuationGen();
            await ctx.client.call('scroll_to', { elementTestID: sel.id }).catch(() => undefined);
            await ctx.client
              .call('wait_commit', { maxMs: 600, stableMs: 100 })
              .catch(() => undefined);
            confirmedExposed = await checkExposed();
          });
        }
      }
      // Modal-occlusion gate: the target's hosting VC sits BEHIND the
      // topmost presented VC — a modal floats over it, and (pageSheet)
      // the presentation also TRANSFORMS the root, so the cached rect
      // is doubly wrong. The 800 ms exposure wait above assumes a
      // transition-in-flight; a modal that dismisses only after an
      // async action (composer publish → server round-trip) outlives
      // it and the blind tap lands on the modal (thread-muting:
      // e2eSignOut fired into the still-open composer). Wait on the
      // exposure SIGNAL until the modal clears — bounded poll, no
      // blind sleep; bail early the moment the occluding modal is gone.
      if (!confirmedExposed) {
        const bm = await ctx.client.call('behind_modal', exposureSel).catch(() => undefined);
        if (bm && bm.ok && (bm.data as { behind?: boolean } | undefined)?.behind) {
          await timedAsync(ctx, 'tap.waitModalClear', async () => {
            const deadline = Date.now() + 8000;
            while (Date.now() < deadline) {
              if (await checkExposed()) {
                confirmedExposed = true;
                break;
              }
              const still = await ctx.client
                .call('behind_modal', exposureSel)
                .catch(() => undefined);
              if (
                !(still && still.ok && (still.data as { behind?: boolean } | undefined)?.behind)
              ) {
                // Modal gone but target still unexposed (tab-bar edge
                // cover, transform settling) — re-check exposure once
                // after the next commit, then proceed either way.
                await ctx.client
                  .call('wait_commit', { maxMs: 800, stableMs: 150 })
                  .catch(() => undefined);
                confirmedExposed = await checkExposed();
                break;
              }
              await sleep(100);
            }
          });
        }
      }
    }
    // Disabled-control gate: the target is exposed but advertises
    // NotEnabled (RN accessibilityState.disabled / Button disabled) — a
    // tap would land and be swallowed without firing onPress. The
    // enable flips on a SIGNAL the app controls (bsky's Save goes
    // enabled when the async avatar-crop state lands and the form turns
    // dirty), so wait on it: bounded poll, proceed at the cap either
    // way (a flow that really wants to tap a disabled control gets the
    // same no-op it would get from a finger).
    {
      const en = await ctx.client.call('is_exposed', exposureSel).catch(() => undefined);
      const enabledNow = (en?.data as { enabled?: boolean } | undefined)?.enabled;
      if (enabledNow === false) {
        await timedAsync(ctx, 'tap.waitEnabled', async () => {
          const deadline = Date.now() + 4000;
          while (Date.now() < deadline) {
            const r = await ctx.client.call('is_exposed', exposureSel).catch(() => undefined);
            if ((r?.data as { enabled?: boolean } | undefined)?.enabled !== false) return;
            await sleep(80);
          }
        });
      }
    }
    // Re-sample rect post-exposure. The position-stability gate can
    // lock onto a transient steady frame during a spring animation
    // (overshoot, low-velocity inflection points). The view's final
    // resting frame may differ by tens of pixels — tapping the cached
    // center then lands on whatever view is currently at that coord.
    // bsky's MoreOptions sheet reproduces this: "Delete list" finalises
    // ~27 px below the captured stable rect.
    const final = await sampleRect();
    if (final) {
      stableRect = final;
      center.x = final.x + final.w / 2;
      center.y = final.y + final.h / 2;
    }
  }
  // Child-hijack detour: when the testID-tagged target is a plain
  // wrapper View (no onPress) whose center hit-tests to an inner
  // interactive child, the child's onPress fires instead of the
  // intended outer Link. bsky's NotificationFeedItem is the canonical
  // case: <View testID="feedItem-by-X"> wraps <Post>, and tapping
  // the View's center lands on an inline author Link → profile nav
  // instead of post-detail. Ask the dylib to resolve the LARGEST
  // interactive descendant inside the testID view and tap THAT
  // descendant's center instead. Only triggers when find returns
  // a non-interactive wrapper (kind=descendant).
  if (sel.id && !sel.childOf) {
    const tt = await ctx.client
      .call('find_tap_target_by_testid', { testID: sel.id })
      .catch(() => undefined);
    if (tt && tt.ok && tt.data) {
      const data = tt.data as { x: number; y: number; w: number; h: number; kind?: string };
      if (data.kind === 'descendant') {
        center.x = data.x + data.w / 2;
        center.y = data.y + data.h / 2;
      }
    }
  }
  // HID tap: down + up immediately. No pre-tap sleep — the position-
  // stability gate above already proved the rect isn't moving, so
  // UIKit's hit-test layer-tree is settled.
  //
  // Down + Up immediately is the safest baseline for both selector
  // kinds; the previous 50 ms hidPress hold was misinterpreted by
  // RN-Screens bottom-sheet (ReportDialog) as a drag-to-dismiss
  // gesture, closing the sheet instead of selecting the row. The
  // retap-self-heal loop covers any single-miss case.
  const isTextOnlyTap = !!sel.text && !sel.id;
  // Keyboard-cover gate: is_exposed hit-tests the app window only, so a
  // target beneath the software keyboard (a separate high-level
  // UIWindow) reads as exposed while a real HID touch would land on the
  // keyboard. If the keyboard covers this point, dismiss + wait for it
  // to retract first (the custom-server "Done" under the keyboard).
  {
    const sz = await getScreenSize(ctx.udid);
    await clearKeyboardOverTarget(ctx, center.x / sz.w, center.y / sz.h);
  }
  // Doomed-tap gate: a VC transition is in flight at dispatch time —
  // UIKit disables window touch delivery for the duration of a
  // present/dismiss/push/pop, so the tap would be swallowed outright.
  // Worse, the find above may have matched the OUTGOING screen's
  // instance of the label (feed-reorder: "Go back" resolved on the
  // dismissing edit-feeds screen; the tap died with it and the flow
  // never left Feeds). The transition starts ASYNC (a prior tap's JS →
  // dismiss), so the handler-level pre-tap settle can run too early to
  // see it — re-check at the last moment: wait for presentation idle,
  // then re-resolve the selector so the SURVIVING screen's instance is
  // the one tapped. Zero-cost when no transition is active.
  if (sel.id || sel.text) {
    const pi = await timedAsync(ctx, 'tap.waitPresentationIdle', () =>
      ctx.client.call('wait_presentation_idle', { maxMs: 2500 }).catch(() => undefined),
    );
    const waitedMs = Number((pi?.data as { elapsedMs?: number } | undefined)?.elapsedMs ?? 0);
    if (waitedMs > 50) {
      // A transition really was in flight — the cached rect may belong
      // to the outgoing screen. Re-resolve on the settled hierarchy.
      const re = await sampleRect();
      if (re) {
        stableRect = re;
        center.x = re.x + re.w / 2;
        center.y = re.y + re.h / 2;
      }
    }
  }
  // The driver picks the mechanism from intent + exposure: a focus
  // tap needs a real touch (activation can't focus native inputs);
  // an unexposed target means an in-process activation would hit the
  // occluding layer.
  await timedAsync(ctx, 'tap.hidTap', () =>
    ctx.driver.tap(ctx.udid, center.x, center.y, { intent, exposed: confirmedExposed }),
  );
  // Tiny ≤5 px test-harness Pressables (Bluesky's TestCtrls.e2e.tsx
  // stack of 1×1 px Pressables at top:100 right:0 zIndex:100): integer
  // rounding misses the hit-box ~30 % of taps. Fire pure DOWN+UP and
  // re-fire only if the view-tree hash didn't change. Previously
  // unconditional 3× — wasted ~160 ms per tiny-control tap and risked
  // dismissing sibling controls when the first tap succeeded.
  if (rect.w <= 5 && rect.h <= 5) {
    const baseHash = preHash ?? (await captureHash(ctx));
    await ctx.driver.tap(ctx.udid, center.x, center.y, { intent, exposed: confirmedExposed });
    for (let i = 1; i < 3; i++) {
      await sleep(80);
      const h = await captureHash(ctx);
      if (h !== baseHash) return;
      await ctx.driver.tap(ctx.udid, center.x, center.y, { intent, exposed: confirmedExposed });
    }
    return;
  }

  // Find-and-tap retry loop. Every iteration re-finds the target at
  // its CURRENT coords and re-fires. Stops the instant ANY of:
  //   - the target is gone from the find walk (button dismissed its
  //     host, navigated away)
  //   - VC presentation chain changed (sheet / picker / nav push)
  //   - is_exposed flipped false (modal slid over the hit point)
  //   - render hash changed since pre-tap baseline (RN re-render
  //     after setState — covers state-only buttons whose VC chain
  //     doesn't move)
  //
  // Critically: NO sleep before the initial tap above. The retry
  // loop only fires if the first tap left the screen unchanged.
  //
  // Retap policy:
  //   - Default: single retap when hash didn't diverge AND target
  //     is still topmost-hittable. Covers the late-recogniser race
  //     for most buttons.
  //   - Cropper / PHPicker hosts: multi-retap (5×) with exposure as
  //     the signal. These VCs have continuous in-place repaints
  //     (rotation slider, photo grid flicker) that flap the hash —
  //     hash-change exits the loop before the real tap effect lands.
  //     iOS system classes, not app-specific naming.
  if (sel.id || sel.text) {
    const baseHash = preHash ?? (await captureHash(ctx));
    const chainResp = await ctx.client.call('top_vc_chain').catch(() => undefined);
    const chain = ((chainResp?.data as { chain?: string[] })?.chain ?? []) as string[];
    // A continuously-repainting host whose payload lands after dismissal
    // (image cropper, system photo picker). The class set lives in the
    // overridable capability registry, not inline here.
    const isLateRecogniserHost = chainHasAsyncPayloadHost(chain);
    // Captured BEFORE the retap loop. Two uses: (1) the cropper/picker
    // dismissal is pure UIKit (no react commits), so the first commit
    // after this timestamp IS the dismissal's payload (bsky avatar crop:
    // image reaches JS ~1-2s post-dismissal); (2) a "commit landed strictly
    // after this timestamp" check is a useful secondary confirm for the
    // async-onPress case where the visible-tree hash hasn't moved yet but a
    // commit is in flight. This is the UNIVERSAL commit signal (frame-hash
    // change through CoreAnimation) — renderer-agnostic, no React hook.
    const preLoopReact = await captureReactTs(ctx);
    const hasObserver = preLoopReact.attach !== 'none';
    const maxRetaps = isLateRecogniserHost ? 5 : 1;
    // Hoisted so the post-loop fallback can skip itself when the tap
    // already confirmed it landed.
    let registered = false;
    for (let i = 0; i < maxRetaps; i++) {
      // Registration signal: the visible-tree hash change is the
      // reliable, fast primary confirm here — wait_hash_change returns
      // the INSTANT the tap's effect renders (~tens of ms), and it's
      // renderer-agnostic (any commit through CoreAnimation moves the
      // frame-hash). The universal commit-since check below is only a
      // secondary backstop for the async-onPress case. (An earlier
      // commit-first attempt regressed badly: a "wait for the next
      // commit" call burned the full 600ms cap on state-only taps that
      // produced no visible change, before falling back to this hash
      // check, which then returned in ~1ms. Hash-first, commit-since as
      // a backup only.)
      const hc = await timedAsync(ctx, 'tap.confirm', () =>
        ctx.client
          .call('wait_hash_change', {
            sinceHash: baseHash,
            maxMs: isLateRecogniserHost ? 800 : 600,
          })
          .catch(() => undefined),
      );
      registered = !!(hc && hc.ok && (hc.data as { ok?: boolean })?.ok);
      // Confirmed on the first signal → the tap landed; nothing more to
      // do. Break BEFORE the re-find + exposure round-trips below (they
      // only exist to position the next RETAP, which won't happen).
      if (registered && !isLateRecogniserHost) break;
      if (!registered && hasObserver && !isLateRecogniserHost) {
        // No visible change yet — a commit may still be in flight
        // (async onPress whose state lands a frame after the hash
        // window). Give the universal commit signal a SHORT extra
        // window: wait for a commit strictly after the pre-loop
        // timestamp (frame-hash change through CoreAnimation).
        const rc = await ctx.client
          .call('wait_react_commit', { sinceMs: preLoopReact.ts, maxMs: 250 })
          .catch(() => undefined);
        registered = !!(rc && rc.ok && (rc.data as { ok?: boolean })?.ok);
        if (registered) break;
      }
      const re = await sampleRect();
      if (!re) break;
      let stillExposed = true;
      if (sel.id) {
        const ex = await ctx.client.call('is_exposed', { testID: sel.id }).catch(() => undefined);
        if (ex && ex.ok && ex.data) {
          stillExposed = !!(ex.data as { exposed?: boolean }).exposed;
        }
      }
      if (!stillExposed) break;
      if (registered && !isLateRecogniserHost) break;
      // A deterministic in-process tap already delivered onPress; the
      // absence of a hash change means the handler had no immediate visible
      // effect (e.g. a button that only starts a timer), not a missed tap.
      // Re-firing here would double-invoke onPress. (HID/Fast can truly
      // miss, so they still retap.)
      if (ctx.driver.deterministicTaps) break;
      const c = { x: re.x + re.w / 2, y: re.y + re.h / 2 };
      await timedAsync(ctx, 'tap.selfHealRetap', () =>
        isTextOnlyTap
          ? ctx.driver.press(ctx.udid, c.x, c.y)
          : ctx.driver.tap(ctx.udid, c.x, c.y, { intent, exposed: stillExposed }),
      );
    }
    // Fast exit: the tap already confirmed it landed (hash moved in the
    // loop). The whole last-resort fallback below — a second hash wait
    // plus activate_testid / activate_by_text / cross-process AX retap —
    // exists ONLY to recover taps that did NOT register. Skipping it
    // when registered saves ~140ms+ of dead round-trips per tap, which
    // is the bulk of every successful tap's remaining cost. tap_tab and
    // the cropper-payload settle below still run (they're conditional
    // and cheap / load-bearing for their specific cases).
    if (!registered && !ctx.driver.deterministicTaps) {
      // Last-resort: if the entire retap loop above never moved the
      // hash AND the target is still in the same place, the gesture
      // recogniser likely never armed (RN onPress wired late after a
      // remount, RNGH Pressable still in its initial layout pass).
      // Skipped for a deterministic in-process driver: the MotionEvent
      // already fired onPress, so activate_* would be a second invocation.
      // Invoke the accessibility activation handler directly — bypasses
      // the gesture chain entirely. UIView's
      // _accessibilityHandleUserTouchActivate is what VoiceOver fires
      // when it double-taps an element, and React-Native Pressable
      // hooks into accessibilityActivate so the React-side onPress runs
      // through the same path.
      const finalHc = await ctx.client
        .call('wait_hash_change', { sinceHash: baseHash, maxMs: 80 })
        .catch(() => undefined);
      const finalChanged = !!(finalHc && finalHc.ok && (finalHc.data as { ok?: boolean })?.ok);
      // For testID taps only: confirm the hash change DIDN'T revert
      // to baseline within ~80 ms. iOS press-feedback bumps the hash
      // transiently even when onPress never fires; a single
      // wait_hash_change returns true on that transient bump and the
      // activate_testid recovery is then skipped. CI runners hit this
      // on slow-handler buttons (next-btn → submit, add-to-cart → API
      // round-trip). Text-only taps stay on the original gate — they
      // already get the unconditional tap_tab fallback below.
      if (!finalChanged) {
        if (sel.id) {
          bumpActuationGen();
          await ctx.client.call('activate_testid', { testID: sel.id }).catch(() => undefined);
        } else if (sel.text) {
          // Text-only tap whose retap loop never moved the hash —
          // find_by_text often returns the LABEL rect inside a button
          // (e.g. a 21×12 px "Cart" label inside a tab-bar button).
          // The HID tap lands on the label, iOS hit-test stays on the
          // label view, and the parent button's onPress is never
          // dispatched. activate_by_text walks accessibilityElements
          // and invokes the button's accessibilityActivate, which RN
          // wires to the React-side onPress.
          await ctx.client.call('activate_by_text', { text: sel.text }).catch(() => undefined);
        }
        // Native sheet / context-menu / picker: the in-app finder returned
        // a rect in a separate SheetViewController window's coordinate
        // space, so the device-space HID tap (and the in-app activation
        // above) both no-op'd. The element is still frontmost, so the
        // cross-process AX tree has it at the correct device-screen coords
        // — re-tap there. Self-guarding: if the original tap actually
        // worked, the element is gone from the AX tree and this is a no-op.
        const stillNoChange = await ctx.client
          .call('wait_hash_change', { sinceHash: baseHash, maxMs: 60 })
          .catch(() => undefined);
        if (!(stillNoChange && stillNoChange.ok && (stillNoChange.data as { ok?: boolean })?.ok)) {
          await ctx.platform.ax
            .tapTarget(ctx.udid, { id: sel.id, text: sel.text })
            .catch(() => false);
        }
      }
    }
    // Tab-bar resilience: iOS 26's liquid-glass tab bar drops HID taps when the
    // host is mid-transition (slow CI runners reproduce this on roughly every
    // nav-after-state-transition pattern). The press-feedback layer still bumps
    // the frame hash so the !finalChanged gate above doesn't fire; meanwhile the
    // tab never actually swaps and the next assertVisible times out. Probe
    // tap_tab when the selector is a bare text name — the dylib op no-ops if the
    // name doesn't resolve to a UITabBarItem, and if it DOES resolve UIKit's
    // setSelectedIndex is idempotent. This is an iOS platform behavior; Android
    // MotionEvent taps are deterministic and don't drop, so gate it to iOS.
    if (sel.text && !sel.id && ctx.platform.name === 'ios') {
      bumpActuationGen();
      await ctx.client.call('tap_tab', { name: sel.text }).catch(() => undefined);
    }
    // Async-payload dismissal settle: this tap fired INTO a cropper /
    // picker host (chain captured pre-tap). Its "Done" hands the result
    // to JS only AFTER the VC fully dismisses, and the NEXT step often
    // reads that state (bsky: Save persists newUserAvatar — pressed
    // before the payload commit it silently drops the image). Wait for
    // the host to leave the VC chain, then for the payload commit.
    // Only crop/picker dismissals pay this; ordinary taps skip.
    if (isLateRecogniserHost && preLoopReact) {
      await timedAsync(ctx, 'tap.waitAsyncPayload', async () => {
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          const cr = await ctx.client.call('top_vc_chain').catch(() => undefined);
          const cls = ((cr?.data as { chain?: string[] })?.chain ?? []) as string[];
          if (!chainHasAsyncPayloadHost(cls)) break;
          await sleep(80);
        }
        await ctx.client
          .call('wait_react_commit', { sinceMs: preLoopReact.ts, maxMs: 4000 })
          .catch(() => undefined);
      });
    }
    // Submit-dismissal settle (opt-in, ENNIO_SUBMIT_DISMISS_MAX_MS): a
    // publish/submit/send button inside a presented sheet dismisses it
    // only AFTER an async server round-trip (bsky composer "Post"
    // uploads blobs first). The flow's next step can reach FLOATING
    // overlay controls straight through the still-open sheet and reset
    // app state mid-flight — observed on a slow CI VM: e2eRefreshHome
    // fired during the upload, the app cancelled the in-flight
    // uploadBlob task, and the composer wedged in "Uploading images...".
    // Wait on the SIGNAL — the pre-tap VC chain changing (dismissal
    // start) — then let presentation-idle absorb the transition. Bails
    // the moment the chain changes; fast hosts pay ~1 poll.
    const submitDismissMaxMs = parseInt(process.env.ENNIO_SUBMIT_DISMISS_MAX_MS ?? '0', 10) || 0;
    if (submitDismissMaxMs > 0 && sel.id && SUBMIT_DISMISS_TESTID_PATTERN.test(sel.id)) {
      await timedAsync(ctx, 'tap.waitSubmitDismiss', async () => {
        const before = chain.join('>');
        const deadline = Date.now() + submitDismissMaxMs;
        while (Date.now() < deadline) {
          const r = await ctx.client.call('top_vc_chain').catch(() => undefined);
          const cur = (((r?.data as { chain?: string[] })?.chain ?? []) as string[]).join('>');
          if (cur && cur !== before) {
            await ctx.client.call('wait_presentation_idle', { maxMs: 2000 }).catch(() => undefined);
            return;
          }
          await sleep(150);
        }
      });
    }
  }
}
