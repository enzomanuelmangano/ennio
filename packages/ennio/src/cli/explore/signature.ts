// Screen signatures — the node identity of the exploration graph.
//
// Requirements pull in opposite directions:
//   * STABLE across visits — timers, counters, prices, and list data must
//     not split one screen into many nodes (cycle detection dies).
//   * DISCRIMINATING between screens — two genuinely different screens
//     must not collapse into one node (edges get mislabeled).
//
// The compromise, documented so the trade-off is auditable:
//   * Elements WITH a testID contribute `role|id=<testID>` — testIDs are
//     authored identity, the strongest stable signal.
//   * Elements WITHOUT a testID contribute `role|tx=<normalized text>`,
//     where digit runs collapse to '#' (prices, counts, timestamps) —
//     text is identity only when the author gave us nothing better.
//   * Duplicates collapse via a count (a 2-row list and a 9-row list of
//     the same cell template hash identically — template, not data).
//   * Geometry is excluded entirely (animation jitter, scroll offsets).
//
// The signature is the SHA-1 of the sorted, deduplicated entry list, so
// element ORDER does not matter — RN list virtualization reorders the
// native view tree between visits.

import { createHash } from 'node:crypto';

import type { DescribedElement } from '../mcp/describe';

/** Collapse digit runs so volatile numbers don't split nodes. */
export function normalizeText(text: string): string {
  return text.replace(/\d+/g, '#').trim().toLowerCase();
}

/** The canonical entry one element contributes to the signature. */
export function elementEntry(el: DescribedElement): string | null {
  if (el.testID) return `${el.role}|id=${el.testID}`;
  if (el.text) return `${el.role}|tx=${normalizeText(el.text)}`;
  return null;
}

/** Structural signature of a screen: 12-hex-char SHA-1 prefix. */
export function screenSignature(elements: DescribedElement[]): string {
  const counts = new Map<string, number>();
  for (const el of elements) {
    const entry = elementEntry(el);
    if (!entry) continue;
    counts.set(entry, (counts.get(entry) ?? 0) + 1);
  }
  // Presence matters, multiplicity collapses: any repeat count hashes as
  // 'n' so list LENGTH (a data property) never splits a node.
  const entries = [...counts.entries()]
    .map(([entry, n]) => `${entry}${n > 1 ? '|n' : ''}`)
    .sort();
  return createHash('sha1').update(entries.join('\n')).digest('hex').slice(0, 12);
}

/** Best-effort screen title: the first non-empty element text. */
export function screenTitle(elements: DescribedElement[]): string | undefined {
  for (const el of elements) {
    if (el.text && el.text.trim()) return el.text.trim();
  }
  return undefined;
}
