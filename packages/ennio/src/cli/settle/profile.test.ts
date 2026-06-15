import { describe, it, expect } from 'vitest';

import { DEFAULT_WAIT_MS, POST_TAP_SETTLE_MS } from '../runner/context';
import { resilientProfile, resolveProfile, resolveProfileName, PROFILES } from './profile';

// ennio ships ONE profile, `resilient` — the empirically-tuned defaults that
// drive real apps reliably. There is no strict "Maestro" profile: whole-string
// regex anchoring broke literal labels containing metacharacters (e.g.
// "Change position (left)"). These tests pin the single profile's values and
// that resolution always lands on it.

describe('tuning profile (resilient, the only profile)', () => {
  it('mirrors the live wait budgets so it cannot drift', () => {
    expect(resilientProfile.defaultWaitMs).toBe(DEFAULT_WAIT_MS);
    expect(resilientProfile.postTapSettleMs).toBe(POST_TAP_SETTLE_MS);
  });

  it('matches text literal-first (sniff) and id exactly', () => {
    expect(resilientProfile.textMatchDefault).toBe('sniff');
    expect(resilientProfile.idMatch).toBe('exact');
  });

  it('resolveProfileName always resolves to resilient', () => {
    expect(resolveProfileName(undefined)).toBe('resilient');
    expect(resolveProfileName('')).toBe('resilient');
    expect(resolveProfileName('maestro')).toBe('resilient');
    expect(resolveProfileName('resilient')).toBe('resilient');
    expect(resolveProfileName('nonsense')).toBe('resilient');
  });

  it('resolveProfile returns the resilient preset for any input', () => {
    expect(resolveProfile('resilient')).toBe(PROFILES.resilient);
    expect(resolveProfile(undefined)).toBe(PROFILES.resilient);
    expect(resolveProfile('maestro')).toBe(PROFILES.resilient);
  });
});
