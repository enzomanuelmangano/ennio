// Visibility predicates — `isVisible`, `waitUntilVisible`,
// `waitUntilNotVisible` — the building blocks for assertVisible /
// assertNotVisible / waitFor / extendedWaitUntil.

import { MaestroSelector } from '../maestro-parser';

import { POLL_MS, RunContext, sleep } from './context';

/// Returns `true` if the selector resolves to any visible view —
/// testID-indexed, text-walked, or surfaced via the UIAlertController
/// layer / cross-process AX proxies. Used by assertVisible/waitFor
/// predicates (and their `notVisible` inverses).
export async function isVisible(ctx: RunContext, sel: MaestroSelector): Promise<boolean> {
  if (sel.id) {
    const r = await ctx.client.call('visible', { testID: sel.id });
    if (r.ok && r.data && (r.data as { visible: boolean }).visible) return true;
  }
  if (sel.text) {
    const r = await ctx.client.call('find_by_text', { text: sel.text });
    if (r.ok) return true;
    // UIAlertController titles/messages/buttons sit outside the React
    // tree, so find_by_text misses them. Check the alert layer too.
    try {
      const a = await ctx.client.call('alert_present');
      if (a.ok && a.data && (a.data as { present: boolean }).present) {
        const t = await ctx.client.call('alert_text');
        const txt = t.ok && t.data ? String((t.data as { text: string }).text || '') : '';
        if (txt && txt.toLowerCase().includes(sel.text.toLowerCase())) return true;
        const b = await ctx.client.call('alert_buttons');
        const btns = b.ok && b.data ? ((b.data as { buttons: string[] }).buttons ?? []) : [];
        for (const btn of btns) {
          if (btn && btn.toLowerCase().includes(sel.text.toLowerCase())) return true;
        }
      }
      // Cross-process AX via in-process UIAccessibilityElement proxy
      // walk — UIRemoteView (PHPicker, share sheet, document picker)
      // exposes the remote content's a11y labels through proxy objects
      // sitting on the UIRemoteView itself.
      const r2 = await ctx.client
        .call('find_ax_by_text', { text: sel.text })
        .catch(() => undefined);
      if (r2 && r2.ok && r2.data) return true;
    } catch {
      /* not an alert */
    }
  }
  return false;
}

export async function waitUntilVisible(
  ctx: RunContext,
  sel: MaestroSelector,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isVisible(ctx, sel)) return;
    await sleep(POLL_MS);
  }
  throw new Error(`assertVisible/waitFor timeout: ${JSON.stringify(sel)}`);
}

export async function waitUntilNotVisible(
  ctx: RunContext,
  sel: MaestroSelector,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isVisible(ctx, sel))) return;
    await sleep(POLL_MS);
  }
  throw new Error(`assertNotVisible timeout: ${JSON.stringify(sel)}`);
}
