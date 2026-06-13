import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';

import { deltaE, hex, parseHex, sampleRegion } from './measure';

function solid(w: number, h: number, r: number, g: number, b: number): PNG {
  const p = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) {
    const j = i * 4;
    p.data[j] = r;
    p.data[j + 1] = g;
    p.data[j + 2] = b;
    p.data[j + 3] = 255;
  }
  return p;
}

describe('measure', () => {
  it('hex/parseHex round-trip', () => {
    expect(hex({ r: 216, g: 183, b: 58 })).toBe('#d8b73a');
    expect(parseHex('#d8b73a')).toEqual({ r: 216, g: 183, b: 58 });
  });

  it('sampleRegion averages a solid block exactly', () => {
    const img = solid(20, 20, 48, 42, 24);
    expect(hex(sampleRegion(img, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }))).toBe('#302a18');
  });

  it('sampleRegion isolates the right quadrant', () => {
    const img = solid(10, 10, 0, 0, 0);
    // paint right half white
    for (let y = 0; y < 10; y++)
      for (let x = 5; x < 10; x++) {
        const j = (y * 10 + x) * 4;
        img.data[j] = img.data[j + 1] = img.data[j + 2] = 255;
      }
    expect(hex(sampleRegion(img, { x: 0.5, y: 0, w: 0.5, h: 1 }))).toBe('#ffffff');
    expect(hex(sampleRegion(img, { x: 0, y: 0, w: 0.5, h: 1 }))).toBe('#000000');
  });

  it('deltaE: identical = 0, and a just-noticeable difference is small', () => {
    expect(deltaE({ r: 100, g: 100, b: 100 }, { r: 100, g: 100, b: 100 })).toBe(0);
    const jnd = deltaE({ r: 100, g: 100, b: 100 }, { r: 103, g: 100, b: 100 });
    expect(jnd).toBeGreaterThan(0);
    expect(jnd).toBeLessThan(2.5);
  });

  it('deltaE: clearly different colors are large', () => {
    expect(deltaE(parseHex('#2d281f'), parseHex('#605b34'))).toBeGreaterThan(20);
  });
});
