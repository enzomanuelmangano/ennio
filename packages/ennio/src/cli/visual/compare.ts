// The deterministic visual comparator. Pixel-perfect, reproducible, no model
// in the loop — the un-lieable reward. Given a live screenshot and a reference
// image, it aligns them, masks author-flagged dynamic regions, runs pixelmatch
// (the engine behind Percy/Playwright visual regression, anti-aliasing-aware),
// and returns a thresholdable match ratio plus a diff heatmap showing *where*
// they differ.

import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

import { clusterRegions } from './regions';
import { resizeRGBA } from './resize';
import type { MatchOptions, MatchResult, NormRect } from './types';

const DEFAULT_PASS_THRESHOLD = 0.97;
const DEFAULT_PIXEL_THRESHOLD = 0.1;
// Aspect ratios closer than this are treated as equal (rounding / 1px slack).
const ASPECT_EPSILON = 0.02;

interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Compare a live screenshot against a reference image. Both are PNG byte
 * buffers. Throws only on undecodable input or an aspect-ratio mismatch
 * (comparing across aspect ratios is meaningless); a poor match is a normal
 * result with a low `matchRatio`, not an error.
 */
export function compareScreens(
  livePng: Buffer,
  refPng: Buffer,
  opts: MatchOptions = {},
): MatchResult {
  const live = PNG.sync.read(livePng);
  const ref = PNG.sync.read(refPng);

  const arLive = live.width / live.height;
  const arRef = ref.width / ref.height;
  if (Math.abs(arLive - arRef) > ASPECT_EPSILON) {
    throw new Error(
      `aspect ratio mismatch: live ${live.width}x${live.height} vs reference ` +
        `${ref.width}x${ref.height} — cannot compare across aspect ratios`,
    );
  }

  // The reference defines the canonical comparison space.
  const width = ref.width;
  const height = ref.height;
  let resized = false;
  let liveData: Uint8Array = live.data;
  if (live.width !== width || live.height !== height) {
    liveData = resizeRGBA(live.data, live.width, live.height, width, height);
    resized = true;
  }
  // Copy so masking never mutates the caller's decoded reference buffer.
  const refData = Buffer.from(ref.data);
  // resizeRGBA already returns a fresh buffer; copy only the no-resize case.
  if (!resized) liveData = Buffer.from(liveData);

  // Mask: paint flagged regions to a constant in BOTH images (so pixelmatch
  // sees them equal) and drop their area from the denominator. Masks are
  // normalized, so they're correct regardless of the resize above.
  let maskedPixels = 0;
  const rects = (opts.masks ?? [])
    .map((m) => toPixelRect(m, width, height))
    .filter((r) => r.w > 0 && r.h > 0);
  if (rects.length > 0) {
    const masked = new Uint8Array(width * height);
    for (const r of rects) {
      for (let y = r.y; y < r.y + r.h; y++) {
        for (let x = r.x; x < r.x + r.w; x++) masked[y * width + x] = 1;
      }
    }
    for (let p = 0; p < width * height; p++) {
      if (!masked[p]) continue;
      maskedPixels++;
      const i = p * 4;
      liveData[i] = refData[i] = 0;
      liveData[i + 1] = refData[i + 1] = 0;
      liveData[i + 2] = refData[i + 2] = 0;
      liveData[i + 3] = refData[i + 3] = 255;
    }
  }

  const emitHeatmap = opts.emitHeatmap ?? true;
  const diff = new PNG({ width, height });
  // Explicit diff color so the region mask below is unambiguous: counted diff
  // pixels are red; anti-aliased pixels (not counted) are yellow.
  const diffPixels = pixelmatch(liveData, refData, diff.data, width, height, {
    threshold: opts.threshold ?? DEFAULT_PIXEL_THRESHOLD,
    includeAA: false,
    diffColor: [255, 0, 0],
  });

  // Cluster the changed pixels into bounding-box regions — the artifact an
  // agent/VLM verifies (math-proven "where", so the model only NAMES "what").
  // A pixel is a counted diff iff pixelmatch painted it red.
  const changed = new Uint8Array(width * height);
  for (let p = 0; p < width * height; p++) {
    const i = p * 4;
    if (diff.data[i] > 200 && diff.data[i + 1] < 80 && diff.data[i + 2] < 80) changed[p] = 1;
  }
  const diffRegions = clusterRegions(changed, width, height, liveData, refData, {
    ...(opts.maxRegions !== undefined && { maxRegions: opts.maxRegions }),
    emitCrops: opts.emitCrops ?? false,
  });

  const totalPixels = width * height;
  const comparedPixels = totalPixels - maskedPixels;
  const matchRatio = comparedPixels > 0 ? 1 - diffPixels / comparedPixels : 1;
  const passThreshold = opts.passThreshold ?? DEFAULT_PASS_THRESHOLD;

  return {
    matchRatio: +matchRatio.toFixed(6),
    diffPixels,
    comparedPixels,
    maskedPixels,
    totalPixels,
    width,
    height,
    resized,
    passed: matchRatio >= passThreshold,
    diffRegions,
    ...(emitHeatmap && { heatmap: PNG.sync.write(diff) }),
  };
}

/** Normalized [0,1] rect → integer pixel rect, clamped to the image. */
function toPixelRect(m: NormRect, width: number, height: number): PixelRect {
  const x = clamp(Math.round(m.x * width), 0, width);
  const y = clamp(Math.round(m.y * height), 0, height);
  const x2 = clamp(Math.round((m.x + m.w) * width), 0, width);
  const y2 = clamp(Math.round((m.y + m.h) * height), 0, height);
  return { x, y, w: Math.max(0, x2 - x), h: Math.max(0, y2 - y) };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
