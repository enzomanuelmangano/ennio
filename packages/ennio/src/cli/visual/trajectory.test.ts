// Motion-match core, exercised against synthetic curves (no device): DTW
// behavior, trajectory comparison, spring simulation + parameter recovery.

import { describe, expect, it } from 'vitest';

import {
  compareTrajectories,
  dtwDistance,
  fitSpring,
  resampleCurve,
  simulateSpring,
  type Curve,
  type Trajectory,
} from './trajectory';

/** Uniform time samples in [0, dur]. */
function times(n: number, dur: number): number[] {
  return Array.from({ length: n }, (_, i) => (dur * i) / (n - 1));
}

describe('resampleCurve', () => {
  it('preserves endpoints and interpolates linearly', () => {
    const c: Curve = { t: [0, 1, 2], v: [0, 10, 20] };
    const r = resampleCurve(c, 5);
    expect(r[0]).toBeCloseTo(0, 6);
    expect(r[4]).toBeCloseTo(20, 6);
    expect(r[2]).toBeCloseTo(10, 6); // midpoint
  });
});

describe('dtwDistance', () => {
  it('is ~0 for identical sequences', () => {
    const a = [0, 1, 2, 3, 4];
    expect(dtwDistance(a, a)).toBeLessThan(1e-9);
  });

  it('is small for the same shape warped in time', () => {
    const a = [0, 0, 1, 2, 3, 3]; // slow start
    const b = [0, 1, 2, 3, 3, 3]; // same rise, different timing
    const warped = dtwDistance(a, b);
    const different = dtwDistance(a, [3, 2, 1, 0, 0, 0]); // reversed
    expect(warped).toBeLessThan(different);
  });
});

describe('compareTrajectories', () => {
  it('scores an identical trajectory ~1', () => {
    const traj: Trajectory = {
      scale: { t: times(20, 0.5), v: times(20, 1) },
      opacity: { t: times(20, 0.5), v: times(20, 1) },
    };
    const res = compareTrajectories(traj, traj);
    expect(res.motionRatio).toBeGreaterThan(0.99);
  });

  it('scores a different motion lower', () => {
    const ref: Trajectory = { scale: { t: times(20, 0.5), v: times(20, 1) } };
    // A constant (no motion) reproduction vs a ramp reference.
    const flat: Trajectory = { scale: { t: times(20, 0.5), v: new Array(20).fill(0) } };
    const good = compareTrajectories(ref, ref).motionRatio;
    const bad = compareTrajectories(flat, ref).motionRatio;
    expect(bad).toBeLessThan(good);
  });

  it('returns 0 when no channels are shared', () => {
    const a: Trajectory = { x: { t: [0, 1], v: [0, 1] } };
    const b: Trajectory = { y: { t: [0, 1], v: [0, 1] } };
    expect(compareTrajectories(a, b).motionRatio).toBe(0);
  });
});

describe('simulateSpring', () => {
  it('starts at 0 and settles near 1', () => {
    const ts = times(60, 1.5);
    const v = simulateSpring({ stiffness: 120, damping: 14, mass: 1 }, ts);
    expect(v[0]).toBeCloseTo(0, 6);
    expect(v[v.length - 1]).toBeCloseTo(1, 1);
  });

  it('underdamped springs overshoot past 1; overdamped do not', () => {
    const ts = times(120, 1.5);
    const under = simulateSpring({ stiffness: 200, damping: 4, mass: 1 }, ts);
    const over = simulateSpring({ stiffness: 200, damping: 60, mass: 1 }, ts);
    expect(Math.max(...under)).toBeGreaterThan(1.05);
    expect(Math.max(...over)).toBeLessThanOrEqual(1.01);
  });
});

describe('fitSpring', () => {
  it('recovers the parameters of a curve it generated', () => {
    const ts = times(50, 0.8);
    const truth = { stiffness: 160, damping: 12, mass: 1 };
    const target: Curve = { t: ts, v: simulateSpring(truth, ts) };
    const fit = fitSpring(target);
    expect(fit.rmse).toBeLessThan(0.02);
    expect(fit.params.stiffness).toBeGreaterThan(120);
    expect(fit.params.stiffness).toBeLessThan(200);
    expect(fit.params.damping).toBeGreaterThan(8);
    expect(fit.params.damping).toBeLessThan(16);
  });
});
