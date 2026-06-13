// Deterministic measurement primitives — the algorithm that replaces eyeballing.
// Sample the region-averaged color of a rect from a decoded PNG, and compute a
// perceptual color distance (CIE76 ΔE over Lab). The conformance engine uses
// these to emit EXACT target colors per element ("set fill to #312f25, now
// #2a2620, ΔE 9") so corrections are computed, not guessed.

import { PNG } from 'pngjs';

import type { NormRect } from './types';

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export function hex({ r, g, b }: RGB): string {
  return '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
}

export function parseHex(h: string): RGB {
  const s = h.replace('#', '');
  return {
    r: parseInt(s.slice(0, 2), 16),
    g: parseInt(s.slice(2, 4), 16),
    b: parseInt(s.slice(4, 6), 16),
  };
}

/** Region-averaged RGB over a normalized rect of a decoded PNG. */
export function sampleRegion(img: PNG, rect: NormRect): RGB {
  const W = img.width;
  const H = img.height;
  const x0 = Math.max(0, Math.round(rect.x * W));
  const y0 = Math.max(0, Math.round(rect.y * H));
  const x1 = Math.min(W, Math.round((rect.x + rect.w) * W));
  const y1 = Math.min(H, Math.round((rect.y + rect.h) * H));
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 4;
      r += img.data[i];
      g += img.data[i + 1];
      b += img.data[i + 2];
      n++;
    }
  }
  if (n === 0) return { r: 0, g: 0, b: 0 };
  return { r: r / n, g: g / n, b: b / n };
}

function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** sRGB → CIE Lab (D65). */
function toLab({ r, g, b }: RGB): [number, number, number] {
  const rl = srgbToLinear(r);
  const gl = srgbToLinear(g);
  const bl = srgbToLinear(b);
  let x = (rl * 0.4124 + gl * 0.3576 + bl * 0.1805) / 0.95047;
  let y = rl * 0.2126 + gl * 0.7152 + bl * 0.0722;
  let z = (rl * 0.0193 + gl * 0.1192 + bl * 0.9505) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  x = f(x);
  y = f(y);
  z = f(z);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/** CIE76 ΔE — perceptual color distance. ~2.3 = just-noticeable difference. */
export function deltaE(a: RGB, b: RGB): number {
  const [l1, a1, b1] = toLab(a);
  const [l2, a2, b2] = toLab(b);
  return Math.sqrt((l1 - l2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2);
}
