/**
 * `ennio match <reference.png> [bundleId]` — deterministic visual conformance
 * as a CI gate. Capture the current screen of the running app, compare it
 * against a reference PNG (Figma export / mock / prior baseline), print a
 * one-line summary, and exit 0 (match) / 1 (mismatch or error).
 *
 * Reuses the exact comparator the assertScreenMatches step and the
 * ennio_match_screen MCP tool use, via EnnioMcpSession.matchScreen.
 */

import { resolve } from 'node:path';

import type { Flags } from '../cli/args';
import { EnnioMcpSession } from '../mcp/session';
import type { MaskInput } from '../visual/capture';
import { selectPlatform } from '../platform';
import { getTargetUdid } from '../sim';

import { runningApps } from './improvise';

export async function runMatchCommand(positional: string[], flags: Flags): Promise<number> {
  const reference = positional[0];
  if (!reference) {
    console.error('usage: ennio match <reference.png> [bundleId] [--threshold] [--mask] [--output]');
    return 1;
  }

  // Default to the app already open on the booted simulator (same rule as
  // `ennio improvise`); ambiguity is an error listing the candidates.
  let bundleId = positional[1];
  if (!bundleId) {
    const udid = getTargetUdid();
    if (!udid) {
      console.error('no booted simulator found — boot one or pass a bundleId');
      return 1;
    }
    const apps = runningApps(udid);
    if (apps.length === 1) {
      bundleId = apps[0];
    } else if (apps.length === 0) {
      console.error('no app running on the simulator — open one or pass a bundleId');
      return 1;
    } else {
      console.error(
        `several apps running — pass one explicitly:\n  ${apps
          .map((a) => `ennio match ${reference} ${a}`)
          .join('\n  ')}`,
      );
      return 1;
    }
  }

  const masks: MaskInput[] = flags.mask
    ? flags.mask
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  const session = new EnnioMcpSession({
    platform: selectPlatform(flags.android ? 'android' : 'ios'),
    safeMode: flags.safeMode,
  });
  try {
    const attached = await session.attach(bundleId);
    if (!attached.ok) {
      console.error(`attach failed: ${attached.error.message}`);
      return 1;
    }
    const res = await session.matchScreen({
      reference: resolve(reference),
      ...(flags.threshold !== undefined && { threshold: Number(flags.threshold) }),
      ...(masks.length > 0 && { mask: masks }),
      ...(flags.output && { output: resolve(flags.output) }),
    });
    if (!res.ok) {
      console.error(`match failed: ${res.error.message}`);
      return 1;
    }
    const d = res.data;
    const pct = (d.matchRatio * 100).toFixed(2);
    const masked = d.maskedPixels > 0 ? `, ${d.maskedPixels} masked` : '';
    const heat = d.heatmapPath ? ` — heatmap: ${d.heatmapPath}` : '';
    console.log(
      `${d.passed ? 'MATCH' : 'MISMATCH'} ${bundleId} — ${pct}% ` +
        `(${d.diffPixels}/${d.comparedPixels} px differ${masked})${heat}`,
    );
    return d.passed ? 0 : 1;
  } finally {
    session.close();
  }
}
