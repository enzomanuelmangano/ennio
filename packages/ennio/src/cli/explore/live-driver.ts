// ExploreDriver backed by a live EnnioMcpSession — the crawler drives the
// device through the exact runtime a flow run / MCP session uses (same
// find → settle → actuate pipeline), so every edge in the map reflects a
// real, replayable interaction.

import type { EnnioMcpSession } from '../mcp/session';

import type { ExploreAction, ExploreDriver } from './types';

export interface LiveDriverOptions {
  /** Whether relaunches wipe app data. Explore wants the known-zero
   *  state (deterministic, diffable maps); smoke keeps the user's
   *  state — the test starts from the app exactly as it stands. */
  clearState?: boolean;
  /** Real input only: every tap is a HID touch through the simulator's
   *  event pipeline — no in-process shortcuts (tap_tab drives UIKit
   *  selection directly). Smoke sets this: it exists to exercise the
   *  app the way a finger would. */
  realInput?: boolean;
}

export class LiveExploreDriver implements ExploreDriver {
  private readonly clearState: boolean;
  private readonly realInput: boolean;

  constructor(
    private readonly session: EnnioMcpSession,
    private readonly bundleId: string,
    opts: LiveDriverOptions = {},
  ) {
    this.clearState = opts.clearState ?? true;
    this.realInput = opts.realInput ?? false;
  }

  async relaunch(): Promise<void> {
    const r = await this.session.dispatch({ launchApp: { clearState: this.clearState } });
    if (!r.ok) throw new Error(`relaunch failed: ${r.error.message}`);
    // clearState soft-resets (data wipe + JS reload): the launch settle
    // covers the React commit, but the first dump_views can still race
    // the initial mount and read an empty tree. Bounded poll on the
    // SIGNAL (a non-empty inventory) — an app whose root screen is
    // genuinely empty falls through after the deadline.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const d = await this.session.describe();
      if (d.ok && d.data.elements.length > 0) return;
      await new Promise((r2) => setTimeout(r2, 200));
    }
  }

  async tap(action: ExploreAction): Promise<{ ok: boolean; detail?: string }> {
    // Alert-button path: describe() surfaced these as the screen's only
    // actions, and neither the finder nor a HID tap can reach a
    // UIAlertAction — route through alert_tap, same as the flow runner.
    // tapped=false when no alert (or wrong label) — falls through to the
    // normal paths below.
    if (action.text) {
      const al = await this.session.alertTap(action.text);
      if (al.ok && al.data.tapped) return { ok: true };
    }
    // Sliders: a center tap does nothing on a UISlider track — drag
    // across the element instead. Start near the left edge (a fresh
    // slider's thumb usually sits at its minimum) and pull to ~80%;
    // pan-based RN sliders accept the gesture anywhere on the track.
    if (action.slide === true) {
      const found = await this.session.find(
        action.id ? { id: action.id } : { text: action.text ?? '' },
      );
      if (!found.ok) return { ok: false, detail: `not visible: ${action.key}` };
      const r = found.data.rect;
      const y = r.y + r.h / 2;
      const drag = await this.session.rawSwipe(
        { x: r.x + r.w * 0.1, y },
        { x: r.x + r.w * 0.8, y },
        300,
      );
      return drag.ok ? { ok: true } : { ok: false, detail: drag.error.message };
    }
    // Fast path ONLY: the crawler just dumped this screen, so the element
    // is known-present and settled — resolve its rect in one RPC and fire
    // a raw HID tap (commit-aware ~250ms wait). The full execTapOn
    // pipeline (alert/tab probes, AX dumps, stability gates, 500ms+
    // post-settle, scroll-into-view) exists for test-grade robustness on
    // UNKNOWN screens; its not-found recovery budgets cost 8-16s per miss
    // (measured), which inside a wall-clock-budgeted crawl buys one slow
    // edge for the price of ~10 normal ones. A find miss here means the
    // element left the viewport or unmounted since the dump — record it
    // as a cheap error edge and spend the budget elsewhere.
    if (action.id) {
      let found = await this.session.find({ id: action.id });
      if (!found.ok) {
        // The element was enumerated on this screen but left the viewport
        // (earlier taps mutated/scrolled the content). One in-process
        // scroll_to + re-find turns what used to be a dead "error edge"
        // into a real tap for ~one RPC.
        if (await this.session.scrollTo(action.id)) {
          found = await this.session.find({ id: action.id });
        }
      }
      if (found.ok) {
        const r = await this.session.rawTap(found.data.center);
        return r.ok ? { ok: true } : { ok: false, detail: r.error.message };
      }
    }
    if (action.text) {
      // UIKit-native case first (tab-bar labels — identifier in the dump,
      // invisible to the RN testID index): the dylib's tap_tab op is
      // deterministic UIKit selection, ~20ms, no-op for non-tabs. Skipped
      // under realInput — driving UIKit directly is not a real touch.
      if (!this.realInput) {
        const tab = await this.session.tapTab(action.text);
        if (tab.ok && tab.data.tapped) return { ok: true };
      }
      const found = await this.session.find({ text: action.text });
      if (found.ok) {
        const r = await this.session.rawTap(found.data.center);
        return r.ok ? { ok: true } : { ok: false, detail: r.error.message };
      }
      return { ok: false, detail: `not visible: ${action.text}` };
    }
    if (action.id) return { ok: false, detail: `not visible: ${action.id}` };
    return { ok: false, detail: 'empty selector' };
  }

  async scrollForward(): Promise<void> {
    // One real swipe (content moves up) — the crawler mines whatever the
    // scroll revealed from the next dump.
    await this.session.rawSwipe({ x: 0.5, y: 0.72 }, { x: 0.5, y: 0.28 }).catch(() => undefined);
  }

  async typeInto(target: { id?: string; text?: string }, value: string): Promise<boolean> {
    return this.session.typeText(target, value);
  }

  async back(): Promise<void> {
    // An alert eats the back gesture; dismissing it IS the back action.
    const al = await this.session.alertInfo();
    if (al.ok && al.data.present) {
      await this.session.alertDismiss();
      return;
    }
    await this.session.dispatch({ back: true });
  }

  async describe(): Promise<
    { role: string; testID?: string; text?: string; value?: string; enabled: boolean }[]
  > {
    // A native alert is modal AND invisible to dump_views (it lives in
    // its own window outside the RN tree): without this probe the crawler
    // enumerates the dimmed background and taps at it forever while the
    // alert swallows every touch. When an alert is up, IT is the screen —
    // its buttons are the only reachable actions.
    const alert = await this.session.alertInfo();
    if (alert.ok && alert.data.present) {
      return [
        { role: 'Alert', text: alert.data.text || 'alert', enabled: true },
        ...alert.data.buttons.map((b) => ({
          role: 'Button',
          text: b,
          button: true,
          enabled: true,
        })),
      ];
    }
    const r = await this.session.describe();
    if (!r.ok) throw new Error(`describe failed: ${r.error.message}`);
    return r.data.elements;
  }

  async screenshot(absPath: string): Promise<void> {
    this.session.screenshot(absPath);
  }
}
