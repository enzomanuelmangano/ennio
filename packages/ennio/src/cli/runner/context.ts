// Run-time state shared by every command + the orchestrator.
//
// `RunContext` is threaded through the entire flow: the socket client,
// the device target, the current flow's file path (so subflow paths
// resolve relative), and a handful of "last step's effect" hints that
// the next step's pre/post-tap settle path uses to disambiguate
// transitions from no-ops. Everything here is pure data — no I/O.

import { createContext, runInContext } from 'node:vm';

import type { GestureDriver } from '../driver/types';
import type { Platform } from '../platform/types';
import type { TuningProfile } from '../settle/profile';
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
const _envWait = parseInt(process.env.ENNIO_DEFAULT_WAIT_MS ?? '', 10);
export const DEFAULT_WAIT_MS = Number.isFinite(_envWait) && _envWait > 0 ? _envWait : 15000;

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

/// Fallback screen dimensions when window_size() fails (iPhone 17 Pro logical points).
export const DEFAULT_WIN_W = 402;
export const DEFAULT_WIN_H = 874;

/// Bridge wait — gives JS thread time to fire onPress → setState →
/// React commit before wait_commit observes the screen. The frame-hash
/// hasn't changed yet immediately post-tap, so without this buffer
/// wait_commit would see "stable" prematurely and return. 800 ms is
/// the empirical sweet spot — shorter values let wait_commit return
/// on the unchanged pre-commit frame and pass stability through to the
/// next find; longer values bloat suite runtime without measurable gain.
export const POST_TAP_SETTLE_MS = Number(process.env.ENNIO_TAP_SETTLE_MS) || 800;
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
  /** When true, unknown/unsupported commands are skipped with a warning
   *  instead of failing the flow. Useful during incremental Maestro migration. */
  lenient: boolean;
  /** Gesture mechanism + settle policy for this run. HidDriver
   *  (baseline, real IOHIDEvents) or FastDriver (in-process-first with
   *  per-gesture HID fallback). Decided once by EnnioRunner. */
  driver: GestureDriver;
  /** Device backend (iOS simulator or Android emulator). Owns app
   *  lifecycle (clearState/relaunch/terminate/openUrl) so command
   *  handlers stay platform-agnostic. */
  platform: Platform;
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
  /** Set by a step that has already consumed the next command (e.g.
   *  two consecutive `tapOn` on the same target collapsed into a
   *  single doubleTap dispatched on the FIRST step). The runner loop
   *  reads + clears this on the next iteration and advances past the
   *  consumed command. */
  skipNextCmd?: boolean;
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
  /** Last text captured by copyTextFrom. Exposed to flows as the
   *  Maestro magic var `${maestro.copiedText}`. */
  copiedText?: string;
  /** Flow-level `env:` block, runFlow-passed overrides, and globals
   *  assigned by evalScript/runScript. Scoped across subflows. */
  flowEnv?: Record<string, unknown>;
  /** Active tuning profile (resilient — the only one). Owns the behavioral
   *  defaults: implicit-wait budget, post-tap settle, and the default
   *  text/id match mode. */
  profile: TuningProfile;
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

const EXPRESSION = /\$\{([^}]+)\}/g;
const BARE_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const JS_SCOPE_RESERVED_KEYS = new Set(['output', 'env', 'maestro', 'http', 'json', 'console']);

function maestroProcessEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[0].startsWith('MAESTRO_') && entry[1] != null,
    ),
  );
}

/** Build the shared Maestro JavaScript scope used by interpolation,
 * evalScript, assertTrue, conditions, and runScript. Per-command values
 * override flow globals, while reserved host globals cannot be shadowed. */
export function createJsScope(
  ctx: RunContext,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...(ctx.flowEnv ?? {}),
    ...extra,
    output: ctx.outputs,
    env: maestroProcessEnv(),
    maestro: {
      platform: ctx.platform?.name ?? '',
      copiedText: ctx.copiedText ?? '',
    },
  };
}

/** Persist user-defined globals created or changed by a script without
 * copying host-provided namespaces back into the flow environment. */
export function syncJsScope(ctx: RunContext, scope: Record<string, unknown>): void {
  const flowEnv = (ctx.flowEnv ??= {});
  for (const [key, value] of Object.entries(scope)) {
    if (!JS_SCOPE_RESERVED_KEYS.has(key)) flowEnv[key] = value;
  }
}

export function stripExpressionWrapper(value: string): string {
  const match = value.match(/^\s*\$\{([\s\S]*)\}\s*$/);
  return match ? match[1] : value;
}

/** Evaluate a raw Maestro JavaScript body. Unlike scalar interpolation,
 * this never preprocesses nested `${...}` text, so assignments execute
 * exactly once when their command is dispatched. */
export function evaluateJsExpression(expression: string, ctx: RunContext): unknown {
  const scope = createJsScope(ctx);
  try {
    return runInContext(stripExpressionWrapper(expression), createContext(scope), {
      timeout: 5000,
    });
  } finally {
    syncJsScope(ctx, scope);
  }
}

/// Lazily replace Maestro-style `${...}` placeholders when a leaf handler
/// consumes a scalar. JavaScript expressions share the same scope as
/// evalScript/assertTrue/runScript. Nullish results preserve Maestro's
/// historical empty-string behavior; evaluation failures surface at the
/// command that contains the typo instead of leaking a literal placeholder.
export function interpolate(str: string, ctx: RunContext): string {
  if (typeof str !== 'string') return str;
  EXPRESSION.lastIndex = 0;
  return str.replace(EXPRESSION, (_match, rawExpression: string) => {
    const expression = rawExpression.trim();

    // Preserve the existing CLI/shell fallback for a simple `${VAR}` without
    // adding the entire process environment to the JavaScript sandbox.
    if (
      BARE_IDENTIFIER.test(expression) &&
      !Object.prototype.hasOwnProperty.call(ctx.flowEnv ?? {}, expression)
    ) {
      // Dynamic lookup is intentional: the identifier comes from the flow.
      // eslint-disable-next-line expo/no-dynamic-env-var
      const shellValue = process.env[expression];
      if (shellValue !== undefined) return shellValue;
    }

    try {
      const result = evaluateJsExpression(expression, ctx);
      return result == null ? '' : String(result);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`failed to evaluate interpolation \`${'${'}${expression}}\`: ${reason}`);
    }
  });
}

/// Interpolate every string field of a selector-like object against
/// the run context. Used by tap/assert/scroll handlers so ${VAR} /
/// ${maestro.copiedText} resolve in id/text args, not just inputText.
export function interpolateSelector<T>(sel: T, ctx: RunContext): T {
  if (typeof sel === 'string') return interpolate(sel, ctx) as T;
  if (Array.isArray(sel)) return sel.map((s) => interpolateSelector(s, ctx)) as T;
  if (sel && typeof sel === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(sel)) out[k] = interpolateSelector(v, ctx);
    return out as T;
  }
  return sel;
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
    const dt = Date.now() - t;
    recordPhase(ctx, name, dt);
    if (process.env.ENNIO_PHASE_TRACE) {
      process.stderr.write(`[phase] ${name} ${dt}ms\n`);
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
