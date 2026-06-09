// The one selector model the MCP surface exposes.
//
// An agent targets an element exactly one way: by `testID`, by visible
// `text`, or by a normalized `point` ([0,1] fractions of the screen —
// the same coordinate space ennio_describe reports rects in). This maps
// onto Maestro's richer selector internally, so the public contract stays
// small while losing none of the runner's targeting intelligence.

import type { MaestroSelector } from '../maestro-parser';

import { err, ok } from './result';
import type { EnnioResult } from './result';

export interface McpSelector {
  testID?: string;
  text?: string;
  /** Normalized [0,1] screen fractions. */
  point?: { x: number; y: number };
}

/** JSON Schema fragment shared by every tool that takes a selector. */
export const SELECTOR_SCHEMA = {
  type: 'object',
  description:
    'Target an element exactly one way: by testID, by visible text, or by a ' +
    'normalized point. Coordinates are [0,1] fractions of the screen.',
  properties: {
    testID: { type: 'string', description: "The element's testID / accessibilityIdentifier." },
    text: { type: 'string', description: 'Visible text or accessibility label (substring match).' },
    point: {
      type: 'object',
      description: 'Normalized screen coordinate, [0,1] fractions.',
      properties: {
        x: { type: 'number', minimum: 0, maximum: 1 },
        y: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['x', 'y'],
    },
  },
} as const;

function isFraction(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
}

/**
 * Validate the public selector and lower it to a MaestroSelector. Enforces
 * the "exactly one of" rule so an ambiguous `{ testID, text }` is rejected
 * up front rather than silently resolving one and ignoring the other.
 */
export function toMaestroSelector(sel: McpSelector | undefined): EnnioResult<MaestroSelector> {
  if (!sel || typeof sel !== 'object') {
    return err('invalid', 'selector is required (one of testID, text, point)');
  }
  const provided = (['testID', 'text', 'point'] as const).filter((k) => sel[k] !== undefined);
  if (provided.length === 0) {
    return err('invalid', 'selector must specify one of: testID, text, point');
  }
  if (provided.length > 1) {
    return err(
      'invalid',
      `selector must specify exactly one of testID, text, point (got ${provided.join(', ')})`,
    );
  }

  if (sel.testID !== undefined) {
    if (typeof sel.testID !== 'string' || !sel.testID)
      return err('invalid', 'testID must be a non-empty string');
    return ok({ id: sel.testID });
  }
  if (sel.text !== undefined) {
    if (typeof sel.text !== 'string' || !sel.text)
      return err('invalid', 'text must be a non-empty string');
    return ok({ text: sel.text });
  }
  const p = sel.point!;
  if (!isFraction(p.x) || !isFraction(p.y)) {
    return err('invalid', 'point.x and point.y must be numbers in [0,1]');
  }
  // Maestro point selectors take percentages (0..100); the runner resolves
  // them to normalized device coords. Convert from our [0,1] contract.
  return ok({ point: `${p.x * 100}%,${p.y * 100}%` });
}

/** Format a normalized [0,1] point as a Maestro "X%,Y%" coordinate string. */
export function pointToMaestro(p: { x: number; y: number }): string {
  return `${p.x * 100}%,${p.y * 100}%`;
}
