// Structural conformance reward. Compares the LIVE element tree (what ennio
// reads off the running app: ids, text, normalized rects, state) against a
// REFERENCE MANIFEST (the target: the same fields, authored from the design /
// video). Emits a ranked, text-first report an agent can act on without ever
// looking at a screenshot — each finding is a directive ("add chip Amused",
// "move Grateful up 56px").
//
// Why this exists: a global pixel ratio is inflated by background and blind to
// content (a missing chip barely moves it). Matching element SETS + positions
// is the un-inflatable, localizable signal — and it's ennio's edge: it has the
// live tree; a pixel tool never does.
//
// Pure, deterministic, no device, no socket — unit-testable on plain objects.

import { deltaE, parseHex } from './measure';
import type { NormRect } from './types';

export type Severity = 'blocker' | 'major' | 'minor';
export type FindingKind =
  | 'missing' // in reference, absent live
  | 'extra' // in live, not in reference
  | 'moved' // matched, position off beyond tolerance
  | 'resized' // matched, size off beyond tolerance
  | 'text' // matched by position, different text
  | 'recolored' // matched, measured color off beyond ΔE tolerance
  | 'state'; // matched, selection/enabled differs

/** One element of the target design. `id` is the stable key (testID); `text`
 *  and `role` aid fuzzy matching when no id is present. */
export interface RefElement {
  id?: string;
  role?: string;
  text?: string;
  rect: NormRect;
  state?: 'selected' | 'default';
  /** Target color (hex), measured from the reference frame. */
  color?: string;
}

export interface RefManifest {
  name: string;
  elements: RefElement[];
}

/** One element as ennio reports it from the running app. */
export interface LiveElement {
  id?: string;
  role?: string;
  text?: string;
  rect: NormRect;
  state?: 'selected' | 'default';
  /** Measured rendered color (hex), sampled from the live screenshot. */
  color?: string;
}

export interface Finding {
  sev: Severity;
  kind: FindingKind;
  target: string;
  expected?: unknown;
  actual?: unknown;
  delta?: Record<string, number>;
  hint: string;
}

export interface ConformanceResult {
  verdict: 'pass' | 'fail';
  /** Gated overall: a single blocker caps it low — never an average that
   *  buries a missing element under easy background agreement. */
  score: number;
  dimensions: {
    /** F1 over element presence (matched vs missing/extra). */
    elementF1: number;
    /** Mean IoU over matched pairs (how well positions/sizes line up). */
    meanIoU: number;
    /** Fraction of matched pairs within position+size tolerance. */
    placement: number;
  };
  counts: { matched: number; missing: number; extra: number };
  findings: Finding[];
  text: string;
}

export interface ConformanceOptions {
  /** Normalized position delta (per axis) below which a match isn't "moved". */
  posTol?: number;
  /** Normalized size delta (per axis) below which a match isn't "resized". */
  sizeTol?: number;
  /** Move/resize beyond this (normalized) is a major finding, else minor. */
  majorTol?: number;
  /** IoU at/above which an id-less element may fuzzy-match by role+overlap. */
  iouMatch?: number;
  /** Approx screen height in px, to render normalized deltas as px hints. */
  screenPx?: { w: number; h: number };
}

const DEFAULTS = {
  posTol: 0.02,
  sizeTol: 0.03,
  majorTol: 0.05,
  iouMatch: 0.3,
  screenPx: { w: 393, h: 852 },
};

function iou(a: NormRect, b: NormRect): number {
  const ax2 = a.x + a.w;
  const ay2 = a.y + a.h;
  const bx2 = b.x + b.w;
  const by2 = b.y + b.h;
  const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(ay2, by2) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const uni = a.w * a.h + b.w * b.h - inter;
  return uni > 0 ? inter / uni : 0;
}

function key(e: { id?: string; text?: string }): string | undefined {
  return e.id ?? e.text;
}

/** Compare a live element tree against a reference manifest. */
export function scoreConformance(
  live: LiveElement[],
  ref: RefManifest,
  opts: ConformanceOptions = {},
): ConformanceResult {
  const o = { ...DEFAULTS, ...opts, screenPx: { ...DEFAULTS.screenPx, ...opts.screenPx } };
  const findings: Finding[] = [];

  // Index live by key (id|text) for O(1) primary matching.
  const liveByKey = new Map<string, LiveElement>();
  for (const e of live) {
    const k = key(e);
    if (k) liveByKey.set(k, e);
  }
  const usedLive = new Set<LiveElement>();

  let matched = 0;
  let iouSum = 0;
  let withinTol = 0;

  for (const r of ref.elements) {
    const rk = key(r);
    let m: LiveElement | undefined;
    // 1) exact key match.
    if (rk && liveByKey.has(rk)) {
      m = liveByKey.get(rk);
    } else {
      // 2) fuzzy: best IoU among same-role, unused live elements.
      let best = 0;
      for (const e of live) {
        if (usedLive.has(e)) continue;
        if (r.role && e.role && r.role !== e.role) continue;
        const v = iou(r.rect, e.rect);
        if (v > best) {
          best = v;
          m = e;
        }
      }
      if (!m || best < o.iouMatch) m = undefined;
    }

    const label = r.text ?? r.id ?? r.role ?? 'element';
    if (!m) {
      findings.push({
        sev: 'blocker',
        kind: 'missing',
        target: label,
        expected: { rect: r.rect },
        hint: `add ${r.role ?? 'element'} "${label}" @ (${r.rect.x.toFixed(2)},${r.rect.y.toFixed(2)})`,
      });
      continue;
    }
    usedLive.add(m);
    matched++;
    iouSum += iou(r.rect, m.rect);

    const dx = m.rect.x - r.rect.x;
    const dy = m.rect.y - r.rect.y;
    const dw = m.rect.w - r.rect.w;
    const dh = m.rect.h - r.rect.h;
    const movedBy = Math.max(Math.abs(dx), Math.abs(dy));
    const resizedBy = Math.max(Math.abs(dw), Math.abs(dh));
    let ok = true;

    if (r.text && m.text && r.text !== m.text) {
      ok = false;
      findings.push({
        sev: 'blocker',
        kind: 'text',
        target: label,
        expected: r.text,
        actual: m.text,
        hint: `text "${m.text}" → "${r.text}"`,
      });
    }
    if (movedBy > o.posTol) {
      ok = false;
      const px = Math.round(
        (Math.abs(dy) >= Math.abs(dx) ? dy : dx) *
          (Math.abs(dy) >= Math.abs(dx) ? o.screenPx.h : o.screenPx.w),
      );
      findings.push({
        sev: movedBy > o.majorTol ? 'major' : 'minor',
        kind: 'moved',
        target: label,
        delta: { dx: +dx.toFixed(4), dy: +dy.toFixed(4), px },
        hint: `move ${dy < 0 ? 'down' : 'up'} ${Math.abs(px)}px${Math.abs(dx) > o.posTol ? ` / ${dx < 0 ? 'right' : 'left'} ${Math.abs(Math.round(dx * o.screenPx.w))}px` : ''}`,
      });
    }
    if (resizedBy > o.sizeTol) {
      ok = false;
      const pctW = r.rect.w > 0 ? (dw / r.rect.w) * 100 : 0;
      const pctH = r.rect.h > 0 ? (dh / r.rect.h) * 100 : 0;
      findings.push({
        sev: resizedBy > o.majorTol ? 'major' : 'minor',
        kind: 'resized',
        target: label,
        delta: { dw: +dw.toFixed(4), dh: +dh.toFixed(4) },
        hint: `${dw > 0 || dh > 0 ? 'shrink' : 'grow'} ~${Math.round(Math.max(Math.abs(pctW), Math.abs(pctH)))}%`,
      });
    }
    if (r.state && m.state && r.state !== m.state) {
      ok = false;
      findings.push({
        sev: 'major',
        kind: 'state',
        target: label,
        expected: r.state,
        actual: m.state,
        hint: `state ${m.state} → ${r.state}`,
      });
    }
    if (r.color && m.color) {
      const dE = deltaE(parseHex(m.color), parseHex(r.color));
      if (dE > 4) {
        ok = false;
        findings.push({
          sev: dE > 10 ? 'major' : 'minor',
          kind: 'recolored',
          target: label,
          expected: r.color,
          actual: m.color,
          delta: { deltaE: +dE.toFixed(1) },
          hint: `set color ${r.color} (now ${m.color}, ΔE ${dE.toFixed(1)})`,
        });
      }
    }
    if (ok) withinTol++;
  }

  // Live elements never matched → extra.
  const extra: LiveElement[] = live.filter((e) => !usedLive.has(e) && (e.id || e.text));
  for (const e of extra) {
    const label = e.text ?? e.id ?? e.role ?? 'element';
    findings.push({
      sev: 'major',
      kind: 'extra',
      target: label,
      actual: { rect: e.rect },
      hint: `remove unexpected ${e.role ?? 'element'} "${label}"`,
    });
  }

  const missing = ref.elements.length - matched;
  const elementF1 = matched === 0 ? 0 : (2 * matched) / (2 * matched + missing + extra.length);
  const meanIoU = matched === 0 ? 0 : iouSum / matched;
  const placement = matched === 0 ? 0 : withinTol / matched;

  // Gated score: the worst of the three, floored harder if any blocker exists.
  const hasBlocker = findings.some((f) => f.sev === 'blocker');
  let score = Math.min(elementF1, meanIoU, placement);
  if (hasBlocker) score = Math.min(score, 0.5);

  const order: Record<Severity, number> = { blocker: 0, major: 1, minor: 2 };
  findings.sort((a, b) => order[a.sev] - order[b.sev]);

  const result: ConformanceResult = {
    verdict: hasBlocker || placement < 1 ? 'fail' : 'pass',
    score: +score.toFixed(4),
    dimensions: {
      elementF1: +elementF1.toFixed(4),
      meanIoU: +meanIoU.toFixed(4),
      placement: +placement.toFixed(4),
    },
    counts: { matched, missing, extra: extra.length },
    findings,
    text: '',
  };
  result.text = renderText(result, ref.name);
  return result;
}

/** Deterministic text rendering — the block the agent reads in the tool result. */
export function renderText(r: ConformanceResult, name: string): string {
  const lines: string[] = [];
  lines.push(
    `VERDICT ${r.verdict} · score ${r.score} · ${name} · matched ${r.counts.matched} missing ${r.counts.missing} extra ${r.counts.extra}`,
  );
  lines.push(
    `DIMS elementF1 ${r.dimensions.elementF1} · IoU ${r.dimensions.meanIoU} · placement ${r.dimensions.placement}`,
  );
  const bySev = (s: Severity) => r.findings.filter((f) => f.sev === s);
  for (const [sev, head] of [
    ['blocker', 'BLOCKERS'],
    ['major', 'MAJOR'],
    ['minor', 'MINOR'],
  ] as [Severity, string][]) {
    const fs = bySev(sev);
    if (!fs.length) continue;
    lines.push(head);
    for (const f of fs)
      lines.push(`  ${sev === 'blocker' ? '✗' : '•'} ${f.kind} ${f.target} → ${f.hint}`);
  }
  if (r.findings.length === 0) lines.push('clean — all elements present and within tolerance');
  return lines.join('\n');
}
