import { describe, expect, it } from 'vitest';

import { resizeRGBA } from './resize';

/** Build a row-major RGBA buffer from a per-pixel callback. */
function make(
  w: number,
  h: number,
  fn: (x: number, y: number) => [number, number, number],
): Buffer {
  const buf = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fn(x, y);
      const i = (y * w + x) * 4;
      buf[i] = r;
      buf[i + 1] = g;
      buf[i + 2] = b;
      buf[i + 3] = 255;
    }
  }
  return buf;
}

describe('resizeRGBA', () => {
  it('returns a buffer of the destination size', () => {
    const src = make(4, 4, () => [128, 128, 128]);
    const out = resizeRGBA(src, 4, 4, 8, 8);
    expect(out.length).toBe(8 * 8 * 4);
  });

  it('preserves a solid color under up- and down-scaling', () => {
    const src = make(10, 10, () => [50, 100, 150]);
    for (const [dw, dh] of [
      [5, 5],
      [20, 20],
      [7, 13],
    ]) {
      const out = resizeRGBA(src, 10, 10, dw, dh);
      // Every pixel of a solid source stays the solid color.
      for (let p = 0; p < dw * dh; p++) {
        expect(out[p * 4]).toBe(50);
        expect(out[p * 4 + 1]).toBe(100);
        expect(out[p * 4 + 2]).toBe(150);
        expect(out[p * 4 + 3]).toBe(255);
      }
    }
  });

  it('keeps corner pixels anchored (no half-pixel drift)', () => {
    // Left half black, right half white; after a same-size resample the
    // extreme corners keep their original colors.
    const src = make(8, 8, (x) => (x < 4 ? [0, 0, 0] : [255, 255, 255]));
    const out = resizeRGBA(src, 8, 8, 8, 8);
    expect(out[0]).toBe(0); // top-left stays black
    expect(out[(7 * 8 + 7) * 4]).toBe(255); // bottom-right stays white
  });
});
