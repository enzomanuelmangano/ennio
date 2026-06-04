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
import { axTapTarget, dismissSystemSheet } from '../ennio-ax';
import { MaestroSelector } from '../maestro-parser';

import { DEFAULT_WIN_H, DEFAULT_WIN_W, Rect, RunContext, sleep, timedAsync } from './context';
import { captureHash, parsePoint, resolveRect } from './find';

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
    await ctx.client.call('wait_commit', { maxMs: 1500, stableMs: 250 }).catch(() => undefined);
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
      const a = await ctx.client.call('alert_present');
      if (a.ok && a.data && (a.data as { present: boolean }).present) {
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
    if (await ctx.driver.tryTabTap(ctx.client, sel.text)) return;
  }
  let rect = await timedAsync(ctx, 'tap.find', () => resolveRect(ctx, sel));
  if (!rect) {
    // A cross-process system sheet (Photo Library, tracking, a
    // SpringBoard confirmation) may be floating over the app and hiding
    // the in-app target. Clear it via the macOS AX tree + a real HID
    // tap, then resolve once more before giving up.
    if (await dismissSystemSheet(ctx.udid).catch(() => false)) {
      await ctx.client.call('wait_commit', { maxMs: 1500, stableMs: 200 }).catch(() => undefined);
      rect = await timedAsync(ctx, 'tap.find', () => resolveRect(ctx, sel));
    }
  }
  if (!rect && (sel.id || sel.text)) {
    // The target may live in a native bottom-sheet / popover the in-app
    // dylib doesn't traverse (Bluesky's Dialog/Prompt + composer render
    // in a separate SheetViewController window). It's still on screen,
    // so the cross-process AX tree sees it — match by testID (bridged
    // AXIdentifier) or label and tap it directly. Soft-fails off-box.
    if (await axTapTarget(ctx.udid, { id: sel.id, text: sel.text }).catch(() => false)) {
      return;
    }
  }
  if (!rect) {
    throw new Error(`element not found: ${JSON.stringify(sel)}`);
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
  // velocity entirely.
  if (sel.id) {
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
      // After scrollRectToVisible the carousel snaps, but React
      // Fabric in Release mode mounts virtualized items lazily —
      // the target view exists in the UIView tree (its testID
      // resolves to a rect) yet its Pressability onPress handler
      // hasn't been wired by the JS thread yet. Tapping in this
      // window fires the coord but no handler responds.
      // Wait for one React commit before re-resolving + tapping.
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
          await ctx.client.call('scroll_to', { elementTestID: sel.id }).catch(() => undefined);
          await ctx.client
            .call('wait_commit', { maxMs: 600, stableMs: 100 })
            .catch(() => undefined);
          confirmedExposed = await checkExposed();
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
    const isLateRecogniserHost = chain.some(
      (cls) =>
        cls.includes('CropViewController') ||
        cls.includes('Mantis') ||
        cls.includes('PHPicker') ||
        cls.includes('PhotoPicker'),
    );
    const maxRetaps = isLateRecogniserHost ? 5 : 1;
    for (let i = 0; i < maxRetaps; i++) {
      const hc = await ctx.client
        .call('wait_hash_change', {
          sinceHash: baseHash,
          maxMs: isLateRecogniserHost ? 800 : 1500,
        })
        .catch(() => undefined);
      const hashChanged = !!(hc && hc.ok && (hc.data as { ok?: boolean })?.ok);
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
      if (hashChanged && !isLateRecogniserHost) break;
      const c = { x: re.x + re.w / 2, y: re.y + re.h / 2 };
      await timedAsync(ctx, 'tap.selfHealRetap', () =>
        isTextOnlyTap
          ? ctx.driver.press(ctx.udid, c.x, c.y)
          : ctx.driver.tap(ctx.udid, c.x, c.y, { intent, exposed: stillExposed }),
      );
    }
    // Last-resort: if the entire retap loop above never moved the
    // hash AND the target is still in the same place, the gesture
    // recogniser likely never armed (RN onPress wired late after a
    // remount, RNGH Pressable still in its initial layout pass).
    // Invoke the accessibility activation handler directly — bypasses
    // the gesture chain entirely. UIView's
    // _accessibilityHandleUserTouchActivate is what VoiceOver fires
    // when it double-taps an element, and React-Native Pressable
    // hooks into accessibilityActivate so the React-side onPress runs
    // through the same path. Costs one extra round-trip when the
    // normal tap worked (exits the loop early via hashChanged), and
    // recovers the cases where it didn't.
    const finalHc = await ctx.client
      .call('wait_hash_change', { sinceHash: baseHash, maxMs: 80 })
      .catch(() => undefined);
    let finalChanged = !!(finalHc && finalHc.ok && (finalHc.data as { ok?: boolean })?.ok);
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
    }
    // Tab-bar resilience: iOS 26's liquid-glass tab bar drops HID
    // taps when the host is mid-transition (slow CI runners reproduce
    // this on roughly every nav-after-state-transition pattern). The
    // press-feedback layer still bumps the frame hash so the
    // !finalChanged gate above doesn't fire; meanwhile the tab never
    // actually swaps and the next assertVisible times out. Always
    // probe tap_tab when the selector is a bare text name — the
    // dylib op no-ops if the name doesn't resolve to a UITabBarItem,
    // and if it DOES resolve UIKit's setSelectedIndex is idempotent
    // (no-op when the target tab is already selected).
    if (sel.text && !sel.id) {
      await ctx.client.call('tap_tab', { name: sel.text }).catch(() => undefined);
    }
  }
}
