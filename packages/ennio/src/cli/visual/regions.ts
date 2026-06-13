// Diff-region extraction — the bridge from "the pixels differ" to "a model can
// verify WHAT differs without confabulating." After the deterministic diff, we
// cluster the changed pixels into a few bounding boxes and crop live+reference
// side-by-side per region. Handing a VLM math-proven regions (not the whole
// screen) is the anti-hallucination move: it can't invent a difference where
// the pixels already proved one, and can't miss one the clustering surfaced.
//
// Pure + deterministic — no model, no network. Clustering is coarse-grid
// union-find: cheap, stable, good enough to point attention.

import { PNG } from 'pngjs';

import type { DiffRegion, NormRect } from './types';

export interface RegionOptions {
  maxRegions?: number;
  /** Clusters with fewer diff pixels than this are dropped as noise. */
  minRegionPixels?: number;
  /** Emit a side-by-side crop per region. */
  emitCrops?: boolean;
}

const DEFAULT_MAX_REGIONS = 6;
const DEFAULT_MIN_REGION_PIXELS = 80;

/**
 * Cluster a boolean diff mask (1 = changed) into bounding-box regions via
 * coarse-grid union-find. `live` / `ref` are the aligned RGBA buffers at
 * (width×height); when `emitCrops` is set each region carries a side-by-side
 * PNG crop.
 */
export function clusterRegions(
  mask: Uint8Array,
  width: number,
  height: number,
  live: Uint8Array,
  ref: Uint8Array,
  opts: RegionOptions = {},
): DiffRegion[] {
  const maxRegions = opts.maxRegions ?? DEFAULT_MAX_REGIONS;
  const minPixels = opts.minRegionPixels ?? DEFAULT_MIN_REGION_PIXELS;

  // Grid resolution: ~96 cells across the long edge — fine enough to separate
  // distinct UI areas, coarse enough to merge a single noisy element.
  const cell = Math.max(8, Math.round(Math.max(width, height) / 96));
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const cellCount = new Int32Array(cols * rows);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x]) cellCount[Math.floor(y / cell) * cols + Math.floor(x / cell)]++;
    }
  }
  // A cell is "hot" if it carries a non-trivial share of changed pixels.
  const hotThreshold = Math.max(2, Math.floor(cell * cell * 0.04));
  const hot = (c: number) => cellCount[c] >= hotThreshold;

  // Union-find over 4-connected hot cells.
  const parent = new Int32Array(cols * rows).map((_, i) => i);
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      if (!hot(idx)) continue;
      if (c + 1 < cols && hot(idx + 1)) union(idx, idx + 1);
      if (r + 1 < rows && hot(idx + cols)) union(idx, idx + cols);
    }
  }

  // Accumulate each component's pixel bounds + diff count.
  interface Acc {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    diff: number;
  }
  const comps = new Map<number, Acc>();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      if (!hot(idx)) continue;
      const root = find(idx);
      const px0 = c * cell;
      const py0 = r * cell;
      const px1 = Math.min(width, px0 + cell);
      const py1 = Math.min(height, py0 + cell);
      const a = comps.get(root);
      if (!a) {
        comps.set(root, { x0: px0, y0: py0, x1: px1, y1: py1, diff: cellCount[idx] });
      } else {
        a.x0 = Math.min(a.x0, px0);
        a.y0 = Math.min(a.y0, py0);
        a.x1 = Math.max(a.x1, px1);
        a.y1 = Math.max(a.y1, py1);
        a.diff += cellCount[idx];
      }
    }
  }

  const regions = [...comps.values()]
    .filter((a) => a.diff >= minPixels)
    .sort((a, b) => b.diff - a.diff)
    .slice(0, maxRegions)
    .map((a): DiffRegion => {
      const rect: NormRect = {
        x: a.x0 / width,
        y: a.y0 / height,
        w: (a.x1 - a.x0) / width,
        h: (a.y1 - a.y0) / height,
      };
      const region: DiffRegion = { rect, diffPixels: a.diff };
      if (opts.emitCrops) {
        region.crop = cropSideBySide(
          live,
          ref,
          width,
          height,
          a.x0,
          a.y0,
          a.x1 - a.x0,
          a.y1 - a.y0,
        );
      }
      return region;
    });
  return regions;
}

/** Side-by-side PNG: the live crop, a thin separator, then the reference crop. */
function cropSideBySide(
  live: Uint8Array,
  ref: Uint8Array,
  width: number,
  height: number,
  rx: number,
  ry: number,
  rw: number,
  rh: number,
): Buffer {
  const gap = 6;
  const out = new PNG({ width: rw * 2 + gap, height: rh });
  const ow = out.width;
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const src = ((ry + y) * width + (rx + x)) * 4;
      const dl = (y * ow + x) * 4; // live (left)
      const dr = (y * ow + (rw + gap + x)) * 4; // reference (right)
      for (let k = 0; k < 4; k++) {
        out.data[dl + k] = live[src + k];
        out.data[dr + k] = ref[src + k];
      }
    }
    // separator strip (opaque grey)
    for (let g = 0; g < gap; g++) {
      const di = (y * ow + (rw + g)) * 4;
      out.data[di] = out.data[di + 1] = out.data[di + 2] = 80;
      out.data[di + 3] = 255;
    }
  }
  return PNG.sync.write(out);
}
