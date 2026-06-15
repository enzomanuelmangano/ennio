import { describe, it, expect } from 'vitest';

import { DEFAULT_WAIT_MS, POST_TAP_SETTLE_MS } from '../runner/context';
import {
  resilientProfile,
  maestroProfile,
  resolveProfile,
  resolveProfileName,
  PROFILES,
} from './profile';

// Phase 2: the shipped default profile is `maestro`; `resilient` is opt-in via
// ENNIO_PROFILE. These tests lock the default and pin each preset's values so a
// future change to either is deliberate and visible.

describe('tuning profiles', () => {
  describe('resilientProfile == current runtime (byte-identical anchor)', () => {
    it('mirrors the live wait budgets so it cannot drift', () => {
      expect(resilientProfile.defaultWaitMs).toBe(DEFAULT_WAIT_MS);
      expect(resilientProfile.postTapSettleMs).toBe(POST_TAP_SETTLE_MS);
    });

    it('keeps the legacy text sniff and exact id match during migration', () => {
      expect(resilientProfile.textMatchDefault).toBe('sniff');
      expect(resilientProfile.idMatch).toBe('exact');
    });
  });

  describe('maestroProfile carries the documented Maestro deltas', () => {
    it('defaults to a 7 s implicit wait', () => {
      expect(maestroProfile.defaultWaitMs).toBe(7000);
    });

    it('matches text and id as regex by default', () => {
      expect(maestroProfile.textMatchDefault).toBe('regex');
      expect(maestroProfile.idMatch).toBe('regex');
    });
  });

  describe('resolveProfileName — default is maestro, resilient is opt-in', () => {
    it('falls back to maestro for unset / unknown values', () => {
      expect(resolveProfileName(undefined)).toBe('maestro');
      expect(resolveProfileName('')).toBe('maestro');
      expect(resolveProfileName('nonsense')).toBe('maestro');
    });

    it('selects resilient only when explicitly named', () => {
      expect(resolveProfileName('maestro')).toBe('maestro');
      expect(resolveProfileName('resilient')).toBe('resilient');
    });

    it('resolveProfile returns the matching preset object', () => {
      expect(resolveProfile('resilient')).toBe(PROFILES.resilient);
      expect(resolveProfile(undefined)).toBe(PROFILES.maestro);
    });
  });
});
