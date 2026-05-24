// Run-time state shared by every command + the orchestrator.
//
// `RunContext` is threaded through the entire flow: the socket client,
// the device target, the current flow's file path (so subflow paths
// resolve relative), and a handful of "last step's effect" hints that
// the next step's pre/post-tap settle path uses to disambiguate
// transitions from no-ops. Everything here is pure data — no I/O.

import type { EnnioSocketClient } from '../socket-client';

// =====================================================================
// Wait budgets
// =====================================================================

/// Default implicit-wait on visibility predicates. Maestro's default is
/// 5 s. We use 15 s because on iOS 26 sim, a tile-tap-driven screen
/// transition can take 4-7 s (RN bundle execute on the destination
/// screen + UIKit layout pass + RNGH gesture acceptance). Tests pass
/// the same flow definitions Maestro accepts; we just give the runtime
/// more headroom.
export const DEFAULT_WAIT_MS = 15000;

/// Coarse poll interval for legacy retry loops. Most modern paths
/// poll inside the dylib on a CADisplayLink tick (~16 ms) instead.
export const POLL_MS = 100;

/// Default find-by-id deadline. Single value: any tap that kicks off
/// a slow async chain (image picker → compress → re-encode → state
/// update) extends the next find naturally because the polling loop
/// runs until the target appears or this deadline expires. 4 s gives
/// room for media-processing chains on default high-resolution
/// simulator photos without making bona-fide negative findings drag.
export const FIND_DEADLINE_DEFAULT_MS = 4000;

/// Bridge wait — gives JS thread time to fire onPress → setState →
/// React commit before wait_commit observes the screen. The frame-hash
/// hasn't changed yet immediately post-tap, so without this buffer
/// wait_commit would see "stable" prematurely and return. 800 ms is
/// the empirical sweet spot — shorter values let wait_commit return
/// on the unchanged pre-commit frame and pass stability through to the
/// next find; longer values bloat suite runtime without measurable gain.
export const POST_TAP_SETTLE_MS = 800;
export const POST_LAUNCH_SETTLE_MS = 1500;

// =====================================================================
// Run context
// =====================================================================

export interface RunContext {
  client: EnnioSocketClient;
  udid: string;
  bundleId: string;
  /** dylib path; only used for clearState relaunch */
  dylibPath: string | null;
  verbose: boolean;
  /** Path to the currently-executing flow file. Used for runFlow
   *  subflow path resolution. */
  flowPath: string;
  /** Last tapOn target signature. When the next tapOn matches the
   *  same target, the runner shortens its post-tap settle so the two
   *  taps land inside RN's double-tap window (<350 ms). */
  lastTapKey?: string;
  /** TestID of the previously-tapped target. Used to apply an extra
   *  pre-tap settle when the previous tap was on a button that
   *  triggers an async network round-trip (publish, submit, send),
   *  to outlast that flow before letting the next tap proceed. */
  lastTapTestID?: string;
  /** Set when the previous step typed/erased text. The next non-input
   *  tap calls hide_keyboard first so iOS's editing-menu popover
   *  doesn't intercept the touch (observed on Bluesky's edit-profile
   *  modal: Save tap fires onto the popover instead of the button,
   *  modal never dismisses). */
  lastWasTextInput?: boolean;
  /** Timestamp of the last UIRefreshControl trigger. Throttles the
   *  trigger_refresh shortcut so a YAML pattern of "warmup swipe +
   *  real swipe" doesn't fire the refresh handler twice. */
  lastRefreshAtMs?: number;
  /** Aggregate per-phase timings. Used by the bottleneck reporter at
   *  the end of each flow. Phase names map to the discrete chunks of
   *  work inside a single command (preWaitCommit, find, hidTap, …). */
  phaseTotals?: Map<string, number>;
  phaseCounts?: Map<string, number>;
  /** Mutable bag populated by runScript and consumed by ${output.X}
   *  substitution in subsequent inputText / tapOn text args. Mirrors
   *  Maestro's `output` global available inside its JS sandbox. */
  outputs: Record<string, unknown>;
}

export interface RunResult {
  passed: boolean;
  stepsRun: number;
  stepsPassed: number;
  failure?: { step: number; command: string; reason: string };
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// =====================================================================
// Helpers
// =====================================================================

/// Replace Maestro-style `${output.X}` placeholders with values from
/// `ctx.outputs`. Also handles `${env.X}` → `process.env.X`.
export function interpolate(str: string, ctx: RunContext): string {
  if (typeof str !== 'string') return str;
  return str.replace(/\$\{(output|env)\.([A-Za-z0-9_]+)\}/g, (_, scope, key) => {
    if (scope === 'output') {
      const v = ctx.outputs[key];
      return v == null ? '' : String(v);
    }
    return process.env[key] ?? '';
  });
}

export function recordPhase(ctx: RunContext, name: string, ms: number): void {
  if (!ctx.phaseTotals) ctx.phaseTotals = new Map();
  if (!ctx.phaseCounts) ctx.phaseCounts = new Map();
  ctx.phaseTotals.set(name, (ctx.phaseTotals.get(name) ?? 0) + ms);
  ctx.phaseCounts.set(name, (ctx.phaseCounts.get(name) ?? 0) + 1);
}

export async function timedAsync<T>(
  ctx: RunContext,
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  const t = Date.now();
  try {
    return await fn();
  } finally {
    recordPhase(ctx, name, Date.now() - t);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
