// ExploreDriver backed by a live EnnioMcpSession — the crawler drives the
// device through the exact runtime a flow run / MCP session uses (same
// find → settle → actuate pipeline), so every edge in the map reflects a
// real, replayable interaction.

import type { EnnioMcpSession } from '../mcp/session';

import type { ExploreAction, ExploreDriver } from './types';

export class LiveExploreDriver implements ExploreDriver {
  constructor(
    private readonly session: EnnioMcpSession,
    private readonly bundleId: string,
  ) {}

  async relaunch(): Promise<void> {
    const r = await this.session.dispatch({ launchApp: { clearState: true } });
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
      const found = await this.session.find({ id: action.id });
      if (found.ok) {
        const r = await this.session.rawTap(found.data.center);
        return r.ok ? { ok: true } : { ok: false, detail: r.error.message };
      }
    }
    if (action.text) {
      // UIKit-native case first (tab-bar labels — identifier in the dump,
      // invisible to the RN testID index): the dylib's tap_tab op is
      // deterministic UIKit selection, ~20ms, no-op for non-tabs.
      const tab = await this.session.tapTab(action.text);
      if (tab.ok && tab.data.tapped) return { ok: true };
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

  async back(): Promise<void> {
    await this.session.dispatch({ back: true });
  }

  async describe(): Promise<
    { role: string; testID?: string; text?: string; value?: string; enabled: boolean }[]
  > {
    const r = await this.session.describe();
    if (!r.ok) throw new Error(`describe failed: ${r.error.message}`);
    return r.data.elements;
  }

  async screenshot(absPath: string): Promise<void> {
    this.session.screenshot(absPath);
  }
}
