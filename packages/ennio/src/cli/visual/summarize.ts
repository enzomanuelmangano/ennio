// Turn a MatchResult (which carries in-memory PNG buffers) into a JSON-safe
// summary, writing the heatmap and per-region crops to disk when paths are
// given. Shared by all three surfaces (assertScreenMatches, ennio_match_screen,
// ennio match) so the artifact contract is identical everywhere — the same
// shape the agent reads to verify and iterate.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { MatchResult, NormRect } from './types';

export interface RegionSummary {
  rect: NormRect;
  diffPixels: number;
  /** Side-by-side live|reference crop on disk, when a regions dir was given. */
  cropPath?: string;
}

export interface MatchSummary {
  matchRatio: number;
  passed: boolean;
  diffPixels: number;
  comparedPixels: number;
  maskedPixels: number;
  totalPixels: number;
  width: number;
  height: number;
  resized: boolean;
  /** Diff heatmap on disk, when a heatmap path was given. */
  heatmapPath?: string;
  /** Reference-over-live overlay on disk, when an overlay path was given. */
  overlayPath?: string;
  /** Where the screen differs (largest first) — for agent/VLM verification. */
  diffRegions: RegionSummary[];
}

/**
 * Write the heatmap + region crops to disk (when their paths are set) and
 * return the JSON-safe summary with the in-memory buffers stripped.
 */
export function writeMatchArtifacts(
  result: MatchResult,
  paths: { heatmapPath?: string; regionsDir?: string; overlayPath?: string },
): MatchSummary {
  if (paths.heatmapPath && result.heatmap) writeFileSync(paths.heatmapPath, result.heatmap);
  if (paths.overlayPath && result.overlay) writeFileSync(paths.overlayPath, result.overlay);
  if (paths.regionsDir) mkdirSync(paths.regionsDir, { recursive: true });

  const diffRegions: RegionSummary[] = result.diffRegions.map((r, i) => {
    let cropPath: string | undefined;
    if (paths.regionsDir && r.crop) {
      cropPath = join(paths.regionsDir, `region-${i + 1}.png`);
      writeFileSync(cropPath, r.crop);
    }
    return { rect: r.rect, diffPixels: r.diffPixels, ...(cropPath && { cropPath }) };
  });

  return {
    matchRatio: result.matchRatio,
    passed: result.passed,
    diffPixels: result.diffPixels,
    comparedPixels: result.comparedPixels,
    maskedPixels: result.maskedPixels,
    totalPixels: result.totalPixels,
    width: result.width,
    height: result.height,
    resized: result.resized,
    ...(paths.heatmapPath && result.heatmap && { heatmapPath: paths.heatmapPath }),
    ...(paths.overlayPath && result.overlay && { overlayPath: paths.overlayPath }),
    diffRegions,
  };
}
