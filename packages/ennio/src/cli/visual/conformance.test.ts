import { describe, expect, it } from 'vitest';

import { scoreConformance } from './conformance';
import type { LiveElement, RefManifest } from './conformance';

const chip = (
  id: string,
  x: number,
  y: number,
): { id: string; text: string; rect: { x: number; y: number; w: number; h: number } } => ({
  id,
  text: id.replace('tag-', ''),
  rect: { x, y, w: 0.2, h: 0.04 },
});

const ref: RefManifest = {
  name: 'mood-emotion',
  elements: [chip('tag-Amazed', 0.1, 0.3), chip('tag-Brave', 0.4, 0.3), chip('tag-Calm', 0.7, 0.3)],
};

describe('scoreConformance — calibration controls', () => {
  it('identical tree → pass, score 1.0', () => {
    const live: LiveElement[] = ref.elements.map((e) => ({ ...e }));
    const r = scoreConformance(live, ref);
    expect(r.verdict).toBe('pass');
    expect(r.score).toBe(1);
    expect(r.findings).toHaveLength(0);
  });

  it('a missing element → blocker, score capped low', () => {
    const live: LiveElement[] = [ref.elements[0], ref.elements[2]].map((e) => ({ ...e }));
    const r = scoreConformance(live, ref);
    expect(r.verdict).toBe('fail');
    expect(r.counts.missing).toBe(1);
    expect(r.findings[0]).toMatchObject({ sev: 'blocker', kind: 'missing', target: 'Brave' });
    expect(r.score).toBeLessThanOrEqual(0.5);
  });

  it('a moved element → finding with px hint, but not missing', () => {
    const live: LiveElement[] = ref.elements.map((e) => ({ ...e }));
    live[1] = { ...live[1], rect: { ...live[1].rect, y: 0.4 } }; // 0.1 down
    const r = scoreConformance(live, ref);
    expect(r.counts.missing).toBe(0);
    const moved = r.findings.find((f) => f.kind === 'moved');
    expect(moved).toBeTruthy();
    expect(moved?.sev).toBe('major');
    expect(moved?.target).toBe('Brave');
  });

  it('an extra element → major finding', () => {
    const live: LiveElement[] = [
      ...ref.elements.map((e) => ({ ...e })),
      chip('tag-Ghost', 0.5, 0.6),
    ];
    const r = scoreConformance(live, ref);
    expect(r.findings.some((f) => f.kind === 'extra' && f.target === 'Ghost')).toBe(true);
  });

  it('color delta → recolored finding with exact target hex', () => {
    const refC = { ...ref, elements: ref.elements.map((e) => ({ ...e, color: '#605b34' })) };
    const live: LiveElement[] = refC.elements.map((e) => ({ ...e, color: '#2d281f' }));
    const r = scoreConformance(live, refC);
    const rc = r.findings.find((f) => f.kind === 'recolored');
    expect(rc).toBeTruthy();
    expect(rc?.expected).toBe('#605b34');
    expect(rc?.hint).toContain('#605b34');
    expect(rc?.delta?.deltaE).toBeGreaterThan(10);
  });

  it('matching colors → no recolored finding', () => {
    const refC = { ...ref, elements: ref.elements.map((e) => ({ ...e, color: '#605b34' })) };
    const live: LiveElement[] = refC.elements.map((e) => ({ ...e, color: '#605b34' }));
    const r = scoreConformance(live, refC);
    expect(r.findings.some((f) => f.kind === 'recolored')).toBe(false);
  });

  it('NEGATIVE CONTROL: a completely different tree → low score', () => {
    const live: LiveElement[] = [chip('tag-Foo', 0.1, 0.1), chip('tag-Bar', 0.5, 0.5)];
    const r = scoreConformance(live, ref);
    expect(r.verdict).toBe('fail');
    expect(r.score).toBeLessThan(0.4);
  });
});
