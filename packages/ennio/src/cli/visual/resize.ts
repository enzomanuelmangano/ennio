// Pure-JS bilinear resize of an RGBA pixel buffer. pngjs decodes but doesn't
// resize, and a live device screenshot rarely matches the reference image's
// dimensions — so we normalize the live frame to the reference size before
// diffing. Bilinear (not nearest) keeps the resampled frame from inventing
// hard edges that would read as spurious differences.

/**
 * Resample an RGBA buffer from (sw×sh) to (dw×dh). `src` is row-major RGBA,
 * 4 bytes per pixel. Returns a new Buffer of length dw*dh*4.
 */
export function resizeRGBA(
  src: Uint8Array,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
): Buffer {
  const dst = Buffer.alloc(dw * dh * 4);
  const xRatio = sw / dw;
  const yRatio = sh / dh;
  for (let y = 0; y < dh; y++) {
    // Center-sample so the resample is symmetric (no half-pixel drift).
    const sy = (y + 0.5) * yRatio - 0.5;
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(sh - 1, y0 + 1);
    const fy = Math.max(0, sy - y0);
    for (let x = 0; x < dw; x++) {
      const sx = (x + 0.5) * xRatio - 0.5;
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(sw - 1, x0 + 1);
      const fx = Math.max(0, sx - x0);
      const i00 = (y0 * sw + x0) * 4;
      const i01 = (y0 * sw + x1) * 4;
      const i10 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;
      const di = (y * dw + x) * 4;
      for (let c = 0; c < 4; c++) {
        const top = src[i00 + c] * (1 - fx) + src[i01 + c] * fx;
        const bot = src[i10 + c] * (1 - fx) + src[i11 + c] * fx;
        dst[di + c] = Math.round(top * (1 - fy) + bot * fy);
      }
    }
  }
  return dst;
}
