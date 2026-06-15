// Tuning profiles — the single selector for ennio's behavioral defaults.
//
// ennio ships two profiles:
//   • `maestro`   — faithful Maestro drop-in (7 s waits, regex-by-default text,
//                   id-as-regex). The intended shipped default.
//   • `resilient` — today's empirically-tuned values (15 s waits for the slow
//                   iOS-26 simulator, the legacy text-match sniff). What ennio's
//                   own react-nav / bsky e2e suites run under.
//
// The active profile is threaded onto RunContext (core/flow-executor) and read
// by the assert/wait handlers (defaultWaitMs) and the finder/visibility layers
// (textMatchDefault). The shipped default is `maestro`; ennio's own e2e suites
// opt into `resilient` via ENNIO_PROFILE. id-as-regex (maestroProfile.idMatch)
// is carried here but consumed in Phase 6 when the native finder gains regex id
// matching; today id stays an exact compare.
//
// `resilientProfile` references the LIVE constants (runner/context.ts) so it can
// never silently drift from current behavior — if a constant changes, the
// preset changes with it, and the parity test below pins the relationship.

import { DEFAULT_WAIT_MS, POST_TAP_SETTLE_MS } from '../runner/context';

export type ProfileName = 'maestro' | 'resilient';

/** How an UNannotated text selector (no explicit `regex:`/`literal:`) is matched. */
export type TextMatchDefault =
  | 'regex' // whole-string regex, Maestro semantics
  | 'literal' // literal substring
  | 'sniff'; // legacy isRegexText metacharacter heuristic (transitional)

/** How an `id` selector is matched. */
export type IdMatchMode =
  | 'regex' // Maestro treats id as a regex
  | 'exact'; // ennio legacy: exact accessibilityIdentifier compare

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

// Today's behavior. Budgets reference the live constants (which themselves honor
// ENNIO_DEFAULT_WAIT_MS / ENNIO_TAP_SETTLE_MS), so this preset == current runtime.
export const resilientProfile: TuningProfile = {
  name: 'resilient',
  defaultWaitMs: DEFAULT_WAIT_MS,
  postTapSettleMs: POST_TAP_SETTLE_MS,
  // Unannotated text still goes through the legacy sniff during migration, so a
  // flow that relied on `text: "users[,]? or feeds"` auto-promoting to regex
  // keeps working until the author opts into the maestro profile.
  textMatchDefault: 'sniff',
  idMatch: 'exact',
};

// Faithful Maestro defaults. defaultWaitMs is the headline delta (Maestro's
// fluent assertions default to ~7 s); text/id become regex-by-default. postTap
// is left at the shared constant for now — Phase 2 step 2 refines it against the
// device suites rather than guessing a number here.
export const maestroProfile: TuningProfile = {
  name: 'maestro',
  defaultWaitMs: 7000,
  postTapSettleMs: POST_TAP_SETTLE_MS,
  textMatchDefault: 'regex',
  idMatch: 'regex',
};

export const PROFILES: Record<ProfileName, TuningProfile> = {
  maestro: maestroProfile,
  resilient: resilientProfile,
};

/**
 * Resolve the active profile NAME from `ENNIO_PROFILE` (or an explicit arg).
 *
 * The shipped default is `maestro` (faithful Maestro semantics). `resilient` is
 * opt-in via `ENNIO_PROFILE=resilient` — ennio's own react-nav / bsky e2e suites
 * set it for the slow iOS-26 simulator. Any unset / unrecognized value resolves
 * to `maestro`.
 */
export function resolveProfileName(
  raw: string | undefined = process.env.ENNIO_PROFILE,
): ProfileName {
  return raw === 'resilient' ? 'resilient' : 'maestro';
}

/** Resolve the active TuningProfile. */
export function resolveProfile(raw?: string): TuningProfile {
  return PROFILES[resolveProfileName(raw)];
}
