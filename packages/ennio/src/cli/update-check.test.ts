import { describe, it, expect } from 'vitest';

import { isNewer } from './update-check';

describe('isNewer', () => {
  it('compares core versions numerically (not lexically)', () => {
    expect(isNewer('0.0.10', '0.0.9')).toBe(true); // 10 > 9, would fail string compare
    expect(isNewer('0.1.0', '0.0.99')).toBe(true);
    expect(isNewer('1.0.0', '0.99.99')).toBe(true);
  });

  it('returns false when equal or older', () => {
    expect(isNewer('0.0.6', '0.0.6')).toBe(false);
    expect(isNewer('0.0.5', '0.0.6')).toBe(false);
    expect(isNewer('0.1.0', '1.0.0')).toBe(false);
  });

  it('treats a release as newer than its own prerelease', () => {
    // The published `latest` becoming a real release should nudge a beta user.
    expect(isNewer('0.0.7', '0.0.7-beta.1')).toBe(true);
    // …but a prerelease ahead of latest must NOT nag (no "downgrade" prompt).
    expect(isNewer('0.0.7-beta.1', '0.0.7')).toBe(false);
  });

  it('does not nag when latest is behind a prerelease the user runs', () => {
    // User on 0.0.7-beta.1, latest dist-tag still 0.0.6 → no notice.
    expect(isNewer('0.0.6', '0.0.7-beta.1')).toBe(false);
  });

  it('orders prereleases lexically as a tiebreak', () => {
    expect(isNewer('0.0.7-beta.2', '0.0.7-beta.1')).toBe(true);
    expect(isNewer('0.0.7-beta.1', '0.0.7-beta.2')).toBe(false);
  });

  it('tolerates malformed input without throwing', () => {
    expect(isNewer('', '0.0.6')).toBe(false);
    expect(isNewer('garbage', 'garbage')).toBe(false); // both parse to 0.0.0
  });
});
