import { describe, it, expect } from 'vitest';

import { DEFAULT_WAIT_MS, POST_TAP_SETTLE_MS } from '../runner/context';
import {
  resilientProfile,
  maestroProfile,
  resolveProfile,
  resolveProfileName,
  PROFILES,
} from './profile';

// Phase 2 step 1: profiles exist and are tested, but the active default is still
// `resilient` (byte-identical to today). These tests lock that invariant so the
// step-2 default flip is a deliberate, visible change — and pin the maestro
// preset's documented deltas.

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

  describe('resolveProfileName — step-1 default is resilient', () => {
    it('falls back to resilient for unset / unknown values', () => {
      expect(resolveProfileName(undefined)).toBe('resilient');
      expect(resolveProfileName('')).toBe('resilient');
      expect(resolveProfileName('nonsense')).toBe('resilient');
    });

    it('selects an explicitly named profile', () => {
      expect(resolveProfileName('maestro')).toBe('maestro');
      expect(resolveProfileName('resilient')).toBe('resilient');
    });

    it('resolveProfile returns the matching preset object', () => {
      expect(resolveProfile('maestro')).toBe(PROFILES.maestro);
      expect(resolveProfile(undefined)).toBe(PROFILES.resilient);
    });
  });
});
