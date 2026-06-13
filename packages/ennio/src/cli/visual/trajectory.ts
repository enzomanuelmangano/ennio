// Motion match — the deterministic reward for ANIMATION (design: docs/motion-match.md).
//
// Per-frame pixel diff cannot reward motion: two animations reaching the same
// end state via slightly different easing mismatch on every intermediate frame
// (temporal drift). Instead we compare the element CURVES — position(t),
// scale(t), opacity(t) — time-aligned with Dynamic Time Warping, and we FIT a
// damped spring to the reference curve so the agent gets concrete target params
// (stiffness/damping) instead of a blind search.
//
// Pure + host-side: no device, no CV. The reproduction curves come from ennio's
// in-process element reads (exact); the reference curves come from an offline
// trajectory spec. Everything here is unit-testable against synthetic curves.

/** A sampled scalar channel over time: `t[i]` seconds → `v[i]` value. */
export interface Curve {
  t: number[];
  v: number[];
}

/** Per-element channels (x, y, scale, opacity, …), each a Curve. */
export type Trajectory = Record<string, Curve>;

export interface SpringParams {
  stiffness: number;
  damping: number;
  mass: number;
}

export interface SpringFit {
  params: SpringParams;
  /** RMSE of the fitted step response against the target curve. */
  rmse: number;
}

export interface ChannelMotion {
  /** Normalized DTW distance in [0,1]; 0 = identical shape. */
  distance: number;
}

export interface MotionResult {
  /** 1 - mean channel distance, clamped to [0,1]. The thresholdable reward. */
  motionRatio: number;
  channels: Record<string, ChannelMotion>;
}

// ---- resampling ---------------------------------------------------------

/** Linear-interpolate a curve to `n` uniform samples across its own time span. */
export function resampleCurve(c: Curve, n: number): number[] {
  if (c.t.length === 0) return new Array(n).fill(0);
  if (c.t.length === 1) return new Array(n).fill(c.v[0]);
  const t0 = c.t[0];
  const t1 = c.t[c.t.length - 1];
  const span = t1 - t0 || 1;
  const out: number[] = new Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = t0 + (span * i) / (n - 1);
    while (j < c.t.length - 2 && c.t[j + 1] < t) j++;
    const ta = c.t[j];
    const tb = c.t[j + 1];
    const f = tb > ta ? (t - ta) / (tb - ta) : 0;
    out[i] = c.v[j] + (c.v[j + 1] - c.v[j]) * Math.max(0, Math.min(1, f));
  }
  return out;
}

/** Min-max normalize a sequence to [0,1] using a shared range. */
function normalizeShared(a: number[], b: number[]): [number[], number[]] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const x of [...a, ...b]) {
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }
  const span = hi - lo || 1;
  const f = (x: number) => (x - lo) / span;
  return [a.map(f), b.map(f)];
}

// ---- DTW ----------------------------------------------------------------

/**
 * Dynamic Time Warping distance between two value sequences, normalized to
 * [0,1] (sequences are min-max normalized against a shared range first, so the
 * result reflects SHAPE/timing agreement independent of absolute units).
 */
export function dtwDistance(rawA: number[], rawB: number[]): number {
  if (rawA.length === 0 || rawB.length === 0) return 1;
  const [a, b] = normalizeShared(rawA, rawB);
  const n = a.length;
  const m = b.length;
  const INF = Infinity;
  // Rolling two-row DP to keep it O(m) memory.
  let prev = new Float64Array(m + 1).fill(INF);
  let curr = new Float64Array(m + 1).fill(INF);
  prev[0] = 0;
  for (let i = 1; i <= n; i++) {
    curr[0] = INF;
    for (let j = 1; j <= m; j++) {
      const cost = Math.abs(a[i - 1] - b[j - 1]);
      curr[j] = cost + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    [prev, curr] = [curr, prev];
  }
  // Normalize by the warping-path length bound (n+m) so it lands in [0,1].
  return Math.min(1, prev[m] / (n + m));
}

// ---- trajectory comparison ---------------------------------------------

/**
 * Compare a reproduction trajectory against a reference, channel by channel.
 * Each shared channel is resampled to a common length and DTW-compared.
 * `motionRatio = 1 - mean(distance)`.
 */
export function compareTrajectories(
  repro: Trajectory,
  ref: Trajectory,
  opts: { samples?: number } = {},
): MotionResult {
  const samples = opts.samples ?? 64;
  const channels: Record<string, ChannelMotion> = {};
  const shared = Object.keys(ref).filter((k) => k in repro);
  if (shared.length === 0) return { motionRatio: 0, channels };
  let sum = 0;
  for (const ch of shared) {
    const a = resampleCurve(repro[ch], samples);
    const b = resampleCurve(ref[ch], samples);
    const distance = dtwDistance(a, b);
    channels[ch] = { distance };
    sum += distance;
  }
  const motionRatio = Math.max(0, Math.min(1, 1 - sum / shared.length));
  return { motionRatio: +motionRatio.toFixed(6), channels };
}

// ---- spring model + fit -------------------------------------------------

/**
 * Step response (0 → 1) of a damped spring, integrated the way Reanimated
 * does (semi-implicit Euler), sampled at `times` (seconds). So a fitted
 * { stiffness, damping, mass } can be dropped straight into withSpring.
 */
export function simulateSpring(p: SpringParams, times: number[]): number[] {
  const dt = 1 / 240;
  const end = times.length ? times[times.length - 1] : 0;
  let x = 0;
  let v = 0;
  let t = 0;
  const out: number[] = [];
  let next = 0;
  // Pre-step so t=0 yields x=0.
  while (next < times.length && times[next] <= 0) {
    out.push(0);
    next++;
  }
  while (t < end + dt && next < times.length) {
    const a = (-p.stiffness * (x - 1) - p.damping * v) / p.mass;
    v += a * dt;
    x += v * dt;
    t += dt;
    while (next < times.length && times[next] <= t) {
      out.push(x);
      next++;
    }
  }
  while (out.length < times.length) out.push(x);
  return out;
}

/**
 * Fit a damped spring (mass = 1) to a target step-response curve by coarse grid
 * search over stiffness/damping, then a local refine. Returns the params + RMSE
 * — the concrete target the agent sets, instead of guessing a curve.
 */
export function fitSpring(target: Curve, opts: { mass?: number } = {}): SpringFit {
  const mass = opts.mass ?? 1;
  const rmseFor = (stiffness: number, damping: number): number => {
    const sim = simulateSpring({ stiffness, damping, mass }, target.t);
    let s = 0;
    for (let i = 0; i < target.v.length; i++) s += (sim[i] - target.v[i]) ** 2;
    return Math.sqrt(s / Math.max(1, target.v.length));
  };

  let best = { stiffness: 100, damping: 10, rmse: Infinity };
  for (let k = 20; k <= 400; k += 20) {
    for (let c = 2; c <= 40; c += 2) {
      const e = rmseFor(k, c);
      if (e < best.rmse) best = { stiffness: k, damping: c, rmse: e };
    }
  }
  // Local refine around the grid winner.
  for (let k = best.stiffness - 18; k <= best.stiffness + 18; k += 3) {
    for (let c = best.damping - 1.8; c <= best.damping + 1.8; c += 0.3) {
      if (k <= 0 || c <= 0) continue;
      const e = rmseFor(k, c);
      if (e < best.rmse) best = { stiffness: k, damping: c, rmse: e };
    }
  }
  return {
    params: { stiffness: +best.stiffness.toFixed(2), damping: +best.damping.toFixed(2), mass },
    rmse: +best.rmse.toFixed(6),
  };
}
