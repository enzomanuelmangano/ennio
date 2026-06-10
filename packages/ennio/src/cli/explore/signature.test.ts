import { describe, expect, it } from 'vitest';

import type { DescribedElement } from '../mcp/describe';

import { elementEntry, normalizeText, screenSignature } from './signature';

const el = (p: Partial<DescribedElement>): DescribedElement => ({
  role: 'RCTView',
  enabled: true,
  ...p,
});

describe('normalizeText', () => {
  it('collapses digit runs so counters/prices/timestamps do not split nodes', () => {
    expect(normalizeText('3 items · $42.99')).toBe('# items · $#.#');
    expect(normalizeText('Updated 10:23 AM')).toBe('updated #:# am');
  });
});

describe('elementEntry', () => {
  it('prefers testID over text', () => {
    expect(elementEntry(el({ testID: 'cart-btn', text: 'Cart (3)' }))).toBe('RCTView|id=cart-btn');
  });
  it('falls back to normalized text', () => {
    expect(elementEntry(el({ text: 'Cart (3)' }))).toBe('RCTView|tx=cart (#)');
  });
  it('returns null for structural elements', () => {
    expect(elementEntry(el({}))).toBeNull();
  });
});

describe('screenSignature', () => {
  const home = [el({ testID: 'home-screen' }), el({ testID: 'signin-btn', text: 'Sign in' })];

  it('is stable across element order (RN list virtualization reorders views)', () => {
    expect(screenSignature(home)).toBe(screenSignature([...home].reverse()));
  });

  it('ignores volatile numbers in text-identified elements', () => {
    const a = [el({ text: '3 items' })];
    const b = [el({ text: '7 items' })];
    expect(screenSignature(a)).toBe(screenSignature(b));
  });

  it('collapses list multiplicity: 2 rows and 9 rows of one template match', () => {
    const row = el({ testID: 'product-row' });
    expect(screenSignature([row, row])).toBe(screenSignature(Array(9).fill(row)));
  });

  it('distinguishes presence from absence', () => {
    expect(screenSignature(home)).not.toBe(screenSignature(home.slice(0, 1)));
  });

  it('distinguishes single from repeated entries', () => {
    const row = el({ testID: 'product-row' });
    expect(screenSignature([row])).not.toBe(screenSignature([row, row]));
  });
});
