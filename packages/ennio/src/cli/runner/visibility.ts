// Visibility predicates — `isVisible`, `waitUntilVisible`,
// `waitUntilNotVisible` — the building blocks for assertVisible /
// assertNotVisible / waitFor / extendedWaitUntil.

import { axHasText } from '../ennio-ax';
import { MaestroSelector } from '../maestro-parser';

import { POLL_MS, RunContext, sleep } from './context';
import { dismissPermissionDialogs } from './lifecycle';

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
    const r = await ctx.client.call('find_by_text', { text: sel.text, relaxed: true });
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
    // Last resort: fully cross-process UI the in-app proxies can't reach
    // (the system Photos picker, SpringBoard sheets). Read Simulator.app's
    // macOS AX tree via the ennioax helper. Soft-fails to false off-box.
    if (axHasText(ctx.udid, sel.text)) return true;
  }
  return false;
}

export async function waitUntilVisible(
  ctx: RunContext,
  sel: MaestroSelector,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // Don't probe for a blocking permission sheet on the first few seconds
  // — most targets appear quickly. Only
  // pay it once the wait is genuinely stalling.
  let lastPermCheck = Date.now();
  while (Date.now() < deadline) {
    if (await isVisible(ctx, sel)) return;
    const now = Date.now();
    if (now - lastPermCheck > 3000) {
      lastPermCheck = now;
      // A native system permission sheet (Photo Library, notifications,
      // tracking) renders in another process and floats over the app,
      // swallowing every touch — the in-app dylib can't see it, so a
      // wait would otherwise spin to timeout. Clear it, then
      // re-check immediately.
      if (await dismissPermissionDialogs(ctx.udid).catch(() => false)) continue;
    }
    await sleep(POLL_MS);
  }
  // Dump diagnostic state to stderr so a CI-side failure log
  // includes what was actually on screen at the timeout. Without
  // this we'd only see "assertVisible timeout" and have to guess.
  await dumpFailureState(ctx, sel, 'assertVisible');
  throw new Error(`assertVisible/waitFor timeout: ${JSON.stringify(sel)}`);
}

async function dumpFailureState(ctx: RunContext, sel: MaestroSelector, op: string): Promise<void> {
  try {
    const probe = sel.id
      ? await ctx.client.call('finder_probe', { testID: sel.id }).catch(() => undefined)
      : null;
    if (probe) {
      process.stderr.write(
        `[ennio:diag] ${op} ${JSON.stringify(sel)} probe=${JSON.stringify(probe.data)}\n`,
      );
    }
    const chain = await ctx.client.call('top_vc_chain').catch(() => undefined);
    if (chain && chain.ok) {
      process.stderr.write(`[ennio:diag] top_vc_chain=${JSON.stringify(chain.data)}\n`);
    }
    const dump = await ctx.client.call('dump_views').catch(() => undefined);
    if (dump && dump.ok) {
      const views = dump.data as string[] | undefined;
      if (Array.isArray(views)) {
        process.stderr.write(`[ennio:diag] dump_views count=${views.length}\n`);
        for (const v of views.slice(0, 50)) {
          process.stderr.write(`[ennio:diag]   ${v}\n`);
        }
      }
    }
    // Snapshot the simulator screen — uploaded with the rest of the
    // ennio logs as a CI artifact so a reviewer can visually verify
    // the state at failure without re-running anything. Filename
    // encodes the selector so multi-fail runs don't collide.
    try {
      const shotsDir = '/tmp/ennio-shots';
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require('node:fs');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const child = require('node:child_process');
      fs.mkdirSync(shotsDir, { recursive: true });
      const tag = (sel.id ?? sel.text ?? 'sel')
        .toString()
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .slice(0, 60);
      const path = `${shotsDir}/fail-${Date.now()}-${tag}.png`;
      child.execFileSync('xcrun', ['simctl', 'io', ctx.udid, 'screenshot', path], {
        stdio: 'pipe',
      });
      process.stderr.write(`[ennio:diag] screenshot=${path}\n`);
    } catch {
      /* screenshot best-effort */
    }
  } catch {
    /* diagnostic failure shouldn't mask the original error */
  }
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
