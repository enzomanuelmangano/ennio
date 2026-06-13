// Types for the deterministic visual comparator. The comparator is pure
// host-side logic — no device, no socket — so the whole thing is unit-testable
// against in-memory PNG buffers.

/** A rectangle in normalized [0,1] screen fractions (the same space ennio_find
 *  reports element rects in). Masks are expressed here so they're independent
 *  of device resolution and of any resize the comparator applies. */
export interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A clustered diff region: where the screen differs, for a model to inspect.
 *  Pixels already proved the difference here — a VLM only has to NAME it. */
export interface DiffRegion {
  /** Bounding box of the cluster, normalized [0,1]. */
  rect: NormRect;
  /** Diff pixels inside the cluster. */
  diffPixels: number;
  /** Side-by-side live|reference crop (PNG bytes), when crops are requested. */
  crop?: Buffer;
}

export interface MatchOptions {
  /** pixelmatch per-pixel color-distance threshold in [0,1]; higher tolerates
   *  more color drift before a pixel counts as different. Default 0.1. */
  threshold?: number;
  /** Regions to ignore before diffing (dynamic content: clocks, avatars,
   *  data-driven text). Normalized [0,1]. Painted to a constant in both images
   *  and excluded from the denominator. */
  masks?: NormRect[];
  /** matchRatio at or above which the screen is considered a match.
   *  Default 0.97 — a Figma export never renders pixel-identical to the OS. */
  passThreshold?: number;
  /** Emit the diff heatmap PNG (where it differs). Default true. */
  emitHeatmap?: boolean;
  /** Cap on clustered diff regions returned (default 6). */
  maxRegions?: number;
  /** Attach a side-by-side live|reference crop to each diff region — the
   *  artifact an agent/VLM verifies. Default false. */
  emitCrops?: boolean;
  /** Emit an overlay PNG: the reference blended over the live capture so a
   *  human can eyeball alignment (ghosting = misalignment). Default false. */
  emitOverlay?: boolean;
  /** Overlay blend weight of the reference in [0,1]. Default 0.5. */
  overlayAlpha?: number;
}

export interface MatchResult {
  /** 1 - diffPixels / comparedPixels. The thresholdable reward. */
  matchRatio: number;
  /** Pixels pixelmatch flagged as different (anti-aliasing excluded). */
  diffPixels: number;
  /** Pixels actually compared (total minus masked). */
  comparedPixels: number;
  maskedPixels: number;
  totalPixels: number;
  /** Comparison dimensions (the reference image's). */
  width: number;
  height: number;
  /** Whether the live image was resized to the reference's dimensions. */
  resized: boolean;
  /** matchRatio >= passThreshold. */
  passed: boolean;
  /** PNG bytes of the diff heatmap, when emitHeatmap. */
  heatmap?: Buffer;
  /** PNG bytes of the reference-over-live overlay, when emitOverlay. */
  overlay?: Buffer;
  /** Where the screen differs, clustered into bounding boxes (largest first).
   *  Empty on a clean match. Crops attached when emitCrops. */
  diffRegions: DiffRegion[];
}
