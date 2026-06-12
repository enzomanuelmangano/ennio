// The crawl engine behind `ennio smoke` — deterministic app crawler.
// Shared types.
//
// The crawler walks the app as a graph: a NODE is a screen (identified by
// a structural signature of its element inventory), an EDGE is one action
// (a tap on a testID'd element) observed to move the app from one screen
// to another. Traversal is depth-first with a deterministic action order,
// so two runs over the same app build produce the same map.

import type { DescribedElement } from '../mcp/describe';

/**
 * One tappable action: a stable key for bookkeeping plus the selector
 * parts. `id` is preferred; `text` is the fallback for UIKit-native
 * elements (tab-bar labels) whose accessibilityIdentifier exists in the
 * view dump but is invisible to the RN testID index.
 */
export interface ExploreAction {
  key: string;
  id?: string;
  text?: string;
  /** Looks like a flow-advancing CTA (next/submit/checkout/...): hoisted
   *  to the front of the screen's action order and allowed to run past
   *  maxDepth so wizards/checkouts get completed, not abandoned. */
  primary?: boolean;
  /** Adjustable element (slider): the driver drags across it instead of
   *  tapping its center (which does nothing on a UISlider track). */
  slide?: boolean;
}

/** One screen, keyed by its structural signature. */
export interface ExploreNode {
  /** Structural signature — see signature.ts for what goes into it. */
  sig: string;
  /** Best-effort human name: first nav-bar-ish text on the screen. */
  title?: string;
  /** Full element inventory at first visit (the map's "what's here"). */
  elements: DescribedElement[];
  /** Actions the crawler will tap, in deterministic document order. */
  actions: ExploreAction[];
  /** Action keys actually attempted (≤ actions, caps may cut it). */
  tried: string[];
  /** Relative screenshot path inside the output dir, when captured. */
  screenshot?: string;
  /** Depth (path length from the root) at first discovery. */
  depth: number;
  /** Action path root → this node at first discovery (replay recipe). */
  path: ExploreAction[];
  /** Text inputs on the screen (filled once before the first primary tap). */
  inputs: ExploreAction[];
  /** Whether the screen's inputs have been filled this visit cycle. */
  filled?: boolean;
  /** Scroll-mining passes performed on this node (capped). */
  scrolls?: number;
}

export type EdgeKind =
  /** The action navigated to a different screen. */
  | 'nav'
  /** The action changed state on the same screen (self-loop). */
  | 'state'
  /** The tap itself failed (element vanished, not tappable). */
  | 'error';

/** One observed transition: tapping `action` on `from` produced `to`. */
export interface ExploreEdge {
  from: string;
  action: string;
  to: string;
  kind: EdgeKind;
  /** For kind 'error': why the tap failed. */
  detail?: string;
}

/** Non-fatal events worth surfacing (nondeterminism, caps hit). */
export interface ExploreWarning {
  kind: 'replay-mismatch' | 'cap-hit' | 'back-failed' | 'low-coverage';
  detail: string;
}

export interface ExploreLimits {
  /** Max path length from the root (default 5). */
  maxDepth: number;
  /** Max distinct screens to register (default 50). */
  maxNodes: number;
  /** Wall-clock budget for the whole crawl in ms (default 30s). The cut
   *  is recorded as a cap-hit warning — the partial map stays valid.
   *  This is the global stop: there is deliberately no step-count cap. */
  maxMs: number;
  /** Case-insensitive regex; matching testIDs are never tapped. */
  deny: RegExp;
  /** When set, per-screen action order is shuffled by a PRNG seeded with
   *  this value — randomized walks that are still reproducible: same
   *  seed + same build = same crawl. Unset = document order. */
  seed?: number;
}

export interface ExploreResult {
  root: string;
  nodes: ExploreNode[];
  edges: ExploreEdge[];
  warnings: ExploreWarning[];
  steps: number;
}

/**
 * What the crawler needs from a device. The live implementation wraps
 * EnnioMcpSession; tests drive the crawler with a scripted fake.
 */
export interface ExploreDriver {
  /** Relaunch the app with cleared state — the canonical root. */
  relaunch(): Promise<void>;
  /** Tap one action (id preferred, text fallback). `ok: false` = failed. */
  tap(action: ExploreAction): Promise<{ ok: boolean; detail?: string }>;
  /** Navigate back (iOS pop / Android back). Best-effort. */
  back(): Promise<void>;
  /** Current on-screen element inventory (settled). */
  describe(): Promise<DescribedElement[]>;
  /** One forward scroll (content moves up) — used to mine actions below
   *  the fold once a screen's visible frontier drains. Best-effort. */
  scrollForward(): Promise<void>;
  /** Focus a text input and type into it. Best-effort: false = couldn't. */
  typeInto(target: { id?: string; text?: string }, value: string): Promise<boolean>;
  /** Capture a screenshot to an absolute path. No-op allowed. */
  screenshot(absPath: string): Promise<void>;
}
