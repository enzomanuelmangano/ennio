// Deterministic comparator behavior, exercised against in-memory PNGs (no
// committed binary fixtures, no device) so the math is pinned exactly.

import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';

import { compareScreens } from './compare';

/** Solid-color RGBA PNG. */
function solid(w: number, h: number, r: number, g: number, b: number): Buffer {
  const png = new PNG({ width: w, height: h });
  for (let p = 0; p < w * h; p++) {
    const i = p * 4;
    png.data[i] = r;
    png.data[i + 1] = g;
    png.data[i + 2] = b;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

/** Solid base with one filled rectangle in pixel coords. */
function withRect(
  w: number,
  h: number,
  base: [number, number, number],
  rect: { x: number; y: number; w: number; h: number },
  color: [number, number, number],
): Buffer {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inRect = x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
      const [r, g, b] = inRect ? color : base;
      const i = (y * w + x) * 4;
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

describe('compareScreens', () => {
  it('identical images → ratio 1.0, passed, zero diff', () => {
    const a = solid(100, 100, 10, 20, 30);
    const res = compareScreens(a, solid(100, 100, 10, 20, 30));
    expect(res.diffPixels).toBe(0);
    expect(res.matchRatio).toBe(1);
    expect(res.passed).toBe(true);
    expect(res.resized).toBe(false);
    expect(res.heatmap).toBeInstanceOf(Buffer);
  });

  it('a known NxN different block yields the exact ratio', () => {
    // 100x100 = 10000 px; a 10x10 red block differs from white = 100 px.
    const live = solid(100, 100, 255, 255, 255);
    const ref = withRect(100, 100, [255, 255, 255], { x: 0, y: 0, w: 10, h: 10 }, [255, 0, 0]);
    const res = compareScreens(live, ref);
    expect(res.diffPixels).toBe(100);
    expect(res.comparedPixels).toBe(10000);
    expect(res.matchRatio).toBeCloseTo(0.99, 5);
  });

  it('masking the differing region restores a perfect match', () => {
    const live = solid(100, 100, 255, 255, 255);
    const ref = withRect(100, 100, [255, 255, 255], { x: 0, y: 0, w: 10, h: 10 }, [255, 0, 0]);
    // Mask the top-left 10% x 10% (covers the 10x10 block).
    const res = compareScreens(live, ref, { masks: [{ x: 0, y: 0, w: 0.1, h: 0.1 }] });
    expect(res.maskedPixels).toBe(100);
    expect(res.comparedPixels).toBe(9900);
    expect(res.diffPixels).toBe(0);
    expect(res.matchRatio).toBe(1);
  });

  it('resizes the live frame to the reference dimensions', () => {
    // Same solid color, different size → resampled, still a match.
    const live = solid(200, 200, 40, 40, 40);
    const ref = solid(100, 100, 40, 40, 40);
    const res = compareScreens(live, ref);
    expect(res.resized).toBe(true);
    expect(res.width).toBe(100);
    expect(res.height).toBe(100);
    expect(res.matchRatio).toBe(1);
  });

  it('passThreshold drives the passed flag', () => {
    const live = solid(100, 100, 255, 255, 255);
    const ref = withRect(100, 100, [255, 255, 255], { x: 0, y: 0, w: 20, h: 20 }, [0, 0, 0]);
    // 400/10000 differ → ratio 0.96.
    const strict = compareScreens(live, ref, { passThreshold: 0.97 });
    expect(strict.matchRatio).toBeCloseTo(0.96, 5);
    expect(strict.passed).toBe(false);
    const lenient = compareScreens(live, ref, { passThreshold: 0.9 });
    expect(lenient.passed).toBe(true);
  });

  it('throws on an aspect-ratio mismatch', () => {
    expect(() => compareScreens(solid(100, 200, 0, 0, 0), solid(100, 100, 0, 0, 0))).toThrow(
      /aspect ratio mismatch/,
    );
  });

  it('emitHeatmap:false omits the heatmap buffer', () => {
    const a = solid(50, 50, 1, 2, 3);
    const res = compareScreens(a, solid(50, 50, 1, 2, 3), { emitHeatmap: false });
    expect(res.heatmap).toBeUndefined();
  });

  it('clusters the diff into a region that localizes the change', () => {
    const live = solid(100, 100, 255, 255, 255);
    const ref = withRect(100, 100, [255, 255, 255], { x: 60, y: 70, w: 20, h: 20 }, [255, 0, 0]);
    const res = compareScreens(live, ref);
    expect(res.diffRegions.length).toBe(1);
    const r = res.diffRegions[0].rect;
    // The region's bounding box should contain the 20x20 block at (60,70).
    expect(r.x).toBeLessThanOrEqual(0.6);
    expect(r.y).toBeLessThanOrEqual(0.7);
    expect(r.x + r.w).toBeGreaterThanOrEqual(0.8);
    expect(r.y + r.h).toBeGreaterThanOrEqual(0.9);
    expect(res.diffRegions[0].crop).toBeUndefined(); // not requested
  });

  it('emitCrops attaches a side-by-side PNG per region', () => {
    const live = solid(100, 100, 255, 255, 255);
    const ref = withRect(100, 100, [255, 255, 255], { x: 10, y: 10, w: 30, h: 30 }, [0, 0, 0]);
    const res = compareScreens(live, ref, { emitCrops: true });
    expect(res.diffRegions.length).toBeGreaterThanOrEqual(1);
    expect(res.diffRegions[0].crop).toBeInstanceOf(Buffer);
    // It's a valid PNG, wider than tall (live | gap | reference).
    const png = PNG.sync.read(res.diffRegions[0].crop as Buffer);
    expect(png.width).toBeGreaterThan(png.height);
  });

  it('a clean match yields no diff regions', () => {
    const a = solid(80, 80, 12, 34, 56);
    const res = compareScreens(a, solid(80, 80, 12, 34, 56));
    expect(res.diffRegions).toEqual([]);
  });
});
