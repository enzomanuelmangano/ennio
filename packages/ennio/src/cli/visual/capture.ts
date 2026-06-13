// Capture-for-match: the shared "read the live screen, ready for comparison"
// step, used identically by the assertScreenMatches handler, the
// ennio_match_screen MCP tool, and the `ennio match` CLI command — so capture
// behaviour (settle, screenshot, mask resolution) never drifts between them.
//
// Settle-gated so a comparison isn't taken mid-animation. Masks given as
// testIDs are resolved to normalized rects via the in-app finder; explicit
// normalized rects pass through. Resolution is best-effort — an unresolvable
// testID is simply not masked.

import { readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { NormRect } from './types';

/** A mask is either an element testID (resolved on-device) or a normalized
 *  [0,1] rectangle (passed through). */
export type MaskInput = string | NormRect;

interface SocketResponse {
  ok: boolean;
  data?: unknown;
  err?: string;
}

/** The minimal device surface capture needs — satisfied by a flow handler's
 *  RunContext, an MCP session attachment, or the CLI command. */
export interface CaptureDeps {
  call(op: string, args?: Record<string, unknown>): Promise<SocketResponse>;
  udid: string;
  screenshot(udid: string, path: string): void;
}

export interface Capture {
  livePng: Buffer;
  masks: NormRect[];
}

/**
 * Settle, capture the live screen to a PNG buffer, and resolve mask inputs to
 * normalized rects.
 */
export async function captureForMatch(deps: CaptureDeps, maskInputs: MaskInput[] = []): Promise<Capture> {
  // Gate on frame-hash stability so the shot isn't mid-transition.
  await deps.call('wait_commit', { maxMs: 1200, stableMs: 150 }).catch(() => undefined);

  // Logical screen size, for normalizing any testID-resolved rects (the
  // finder reports rects in the same point space window_size returns).
  let sw = 0;
  let sh = 0;
  const ws = await deps.call('window_size').catch(() => undefined);
  if (ws?.ok && ws.data) {
    const d = ws.data as { w?: number; h?: number };
    if (d.w && d.h) {
      sw = d.w;
      sh = d.h;
    }
  }

  const tmp = join(tmpdir(), `ennio-match-${process.pid}-${Date.now()}.png`);
  deps.screenshot(deps.udid, tmp);
  const livePng = readFileSync(tmp);
  try {
    unlinkSync(tmp);
  } catch {
    /* best-effort temp cleanup */
  }

  const masks: NormRect[] = [];
  for (const m of maskInputs) {
    if (typeof m !== 'string') {
      masks.push(m);
      continue;
    }
    if (sw <= 0 || sh <= 0) continue;
    const r = await deps.call('find_by_testid', { testID: m }).catch(() => undefined);
    if (r?.ok && r.data) {
      const rect = r.data as { x: number; y: number; w: number; h: number };
      masks.push({ x: rect.x / sw, y: rect.y / sh, w: rect.w / sw, h: rect.h / sh });
    }
    // testID not found → not masked (best-effort).
  }

  return { livePng, masks };
}
