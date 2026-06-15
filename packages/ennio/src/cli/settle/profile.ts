// Tuning profile — ennio's behavioral defaults.
//
// ennio ships ONE profile, `resilient`: the empirically-tuned values that drive
// real apps reliably (waits sized for the slow iOS-26 simulator, literal-first
// text matching with the metacharacter sniff as a regex fallback). There is no
// strict "Maestro drop-in" profile: faithful-Maestro whole-string regex
// anchoring (`^(?:…)$`) broke literal text that merely CONTAINS regex
// metacharacters — e.g. the on-screen label "Change position (left)", where the
// `(left)` parsed as a capture group and never matched. Resilient is the only
// behavior, and the default.
//
// The profile is still threaded onto RunContext (core/flow-executor) and read by
// the assert/wait handlers (defaultWaitMs) and the finder/visibility layers
// (textMatchDefault) — one indirection, one profile.
//
// Budgets reference the LIVE constants (runner/context.ts) so the preset can
// never silently drift from current behavior; the parity test pins it.

import { DEFAULT_WAIT_MS, POST_TAP_SETTLE_MS } from '../runner/context';

export type ProfileName = 'resilient';

/** How an UNannotated text selector (no explicit `regex:`/`literal:`) is matched. */
export type TextMatchDefault =
  | 'literal' // literal substring
  | 'sniff'; // isRegexText metacharacter heuristic: literal first, regex fallback

/** How an `id` selector is matched. */
export type IdMatchMode = 'exact'; // exact accessibilityIdentifier compare

export interface TuningProfile {
  name: ProfileName;
  /** Implicit-wait budget for visibility predicates (assertVisible / waitFor). */
  defaultWaitMs: number;
  /** Bridge wait after a tap before the commit is observed. */
  postTapSettleMs: number;
  /** Default match mode for an unannotated `text` selector. */
  textMatchDefault: TextMatchDefault;
  /** Match mode for an `id` selector. */
  idMatch: IdMatchMode;
}

// The one profile. Budgets reference the live constants (which themselves honor
// ENNIO_DEFAULT_WAIT_MS / ENNIO_TAP_SETTLE_MS), so this preset == current runtime.
export const resilientProfile: TuningProfile = {
  name: 'resilient',
  defaultWaitMs: DEFAULT_WAIT_MS,
  postTapSettleMs: POST_TAP_SETTLE_MS,
  // Unannotated text goes through the sniff: a literal substring match is tried
  // first (so "Change position (left)" resolves by its real text), and only a
  // selector that LOOKS like a pattern ("users[,]? or feeds") falls to regex.
  textMatchDefault: 'sniff',
  idMatch: 'exact',
};

export const PROFILES: Record<ProfileName, TuningProfile> = {
  resilient: resilientProfile,
};

/** Resolve the active profile NAME. Only `resilient` exists; it is the default. */
export function resolveProfileName(_raw?: string | undefined): ProfileName {
  return 'resilient';
}

/** Resolve the active TuningProfile. */
export function resolveProfile(_raw?: string): TuningProfile {
  return resilientProfile;
}
