// The exploration engine — deterministic DFS over the app's screen graph.
//
// Invariants that make two runs produce the same map:
//   * Actions are enumerated in document order and attempted in that
//     order — unless limits.seed is set, in which case each screen's
//     order is shuffled by a PRNG seeded with that value. Same seed +
//     same build = same crawl: randomized, still reproducible.
//   * Every decision is a pure function of the graph state + limits — no
//     wall-clock, no unseeded randomness, no retries-with-jitter.
//   * Returning to a screen is verified by signature; when `back` lands
//     somewhere unexpected the crawler REPLAYS the action path from a
//     clearState relaunch — and verifies again. A second mismatch is
//     recorded as a nondeterminism warning, never silently absorbed.
//
// The engine is device-agnostic: everything it knows about the app comes
// through the ExploreDriver interface, so the whole traversal is unit-
// testable against a scripted fake.

import type { DescribedElement } from '../mcp/describe';

import { screenSignature, screenTitle } from './signature';
import type {
  ExploreAction,
  ExploreDriver,
  ExploreEdge,
  ExploreLimits,
  ExploreNode,
  ExploreResult,
  ExploreWarning,
} from './types';

export const DEFAULT_DENY = /log.?out|sign.?out|delete|remove|destroy|pay|purchase|buy now/i;

export const DEFAULT_LIMITS: ExploreLimits = {
  maxDepth: 5,
  maxNodes: 50,
  maxMs: 30_000,
  deny: DEFAULT_DENY,
};

/** Primary actions may run this many levels past maxDepth — enough to
 *  finish a wizard/checkout instead of abandoning it one step short. */
export const FLOW_DEPTH_BONUS = 5;

/** Scroll-mining passes per node. The first pass that reveals nothing
 *  new ends mining early, so non-scrollable screens pay for one swipe. */
export const MAX_SCROLLS_PER_NODE = 3;

/**
 * Does this action look like a flow-advancing CTA? Matched against the
 * testID and the visible label. Deliberately conservative: a false
 * positive only reorders the walk; a false negative just means the flow
 * gets completed later (or cut at maxDepth like before).
 */
const PRIMARY_RE =
  /(^|[-_ ])(next|continue|submit|done|confirm|save|apply|checkout|proceed|sign[-_ ]?in|log[-_ ]?in|sign[-_ ]?up|register|get[-_ ]?started|start|finish|send|search|add[-_ ]?to[-_ ]?cart|place[-_ ]?order)([-_ ]|$)/i;

export function isPrimaryAction(action: { id?: string; text?: string }): boolean {
  return PRIMARY_RE.test(action.id ?? '') || PRIMARY_RE.test(action.text ?? '');
}

/**
 * Sliders are dragged, not tapped. Detected by the adjustable
 * accessibility trait (UISlider, accessibilityRole="adjustable") with a
 * naming heuristic as backstop for custom gesture-handler sliders that
 * never set the trait.
 */
export function isSliderElement(el: DescribedElement): boolean {
  return el.adjustable === true || /slider/i.test(el.testID ?? '') || /Slider/.test(el.role);
}

/** Editable text inputs (RN TextInput / UIKit text fields), by class.
 *  The Label guard matters: a UITextField's placeholder renders as a
 *  `UITextFieldLabel` — same screen position, not editable — and typing
 *  "into" it double-fills the real field. */
const INPUT_ROLE_RE = /TextField|TextInput|TextView|SecureField/i;
const INPUT_ROLE_EXCLUDE_RE = /Label/i;

export function enumerateInputs(elements: DescribedElement[]): ExploreAction[] {
  const out: ExploreAction[] = [];
  const seen = new Set<string>();
  for (const el of elements) {
    if (!INPUT_ROLE_RE.test(el.role) || INPUT_ROLE_EXCLUDE_RE.test(el.role)) continue;
    const key = el.testID ? el.testID : el.text ? `tx:${el.text}` : null;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, ...(el.testID ? { id: el.testID } : { text: el.text }) });
  }
  return out;
}

/**
 * A plausible value for a text input, keyed off its name so forms with
 * format validation (email, phone, zip) actually advance. `n` is drawn
 * from the crawl's seeded PRNG — varied run-to-run, replayable by seed.
 */
export function inputValueFor(key: string, n: number): string {
  const k = key.toLowerCase();
  if (/e.?mail/.test(k)) return `ennio${n}@example.com`;
  if (/phone|tel|mobile/.test(k)) return `555${String(1000000 + (n % 9000000))}`;
  if (/zip|postal/.test(k)) return '10001';
  if (/pass/.test(k)) return `Passw0rd!${n}`;
  // Name checks must precede card: "cardholder" is a NAME field.
  if (/holder|(first|last|full)?.?name/.test(k)) return 'Ennio Tester';
  if (/expir|mm.?yy/.test(k)) return '12/30';
  if (/cvc|cvv|security.?code/.test(k)) return '123';
  if (/card|cc.?num/.test(k)) return '4242424242424242';
  if (/state|province/.test(k)) return 'NY';
  if (/country/.test(k)) return 'Italy';
  if (/city/.test(k)) return 'Milano';
  if (/address|street/.test(k)) return `Via Roma ${1 + (n % 99)}`;
  if (/search|query|filter/.test(k)) return 'a';
  return `ennio ${n}`;
}

/** mulberry32 — tiny seeded PRNG; good enough to vary a walk, fully
 *  reproducible from its 32-bit seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** In-place Fisher-Yates with the crawl's seeded PRNG. */
function shuffle<T>(items: T[], rng: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/**
 * Tappable candidates, document order, deduped:
 *   * every testID'd element (authored interactivity),
 *   * elements carrying the button/link accessibility trait (how apps
 *     without testIDs mark their tappables — accessibilityRole="button"
 *     sets it), and
 *   * Button-role elements identified only by text (RNGestureHandler
 *     buttons, UIKit buttons — interactive by class, no trait dumped on
 *     older dylibs).
 * Untraited bare text views are NOT actions: give an element a testID or
 * an accessibility role to make it explorable.
 */
export function enumerateActions(
  elements: DescribedElement[],
  limits: ExploreLimits,
): ExploreAction[] {
  const seen = new Set<string>();
  const all: ExploreAction[] = [];
  for (const el of elements) {
    if (el.testID) {
      if (seen.has(el.testID)) continue;
      seen.add(el.testID);
      if (limits.deny.test(el.testID)) continue;
      // Text inputs are fill targets (enumerateInputs), not tap actions —
      // tapping one just opens the keyboard and reads as a state edge.
      if (INPUT_ROLE_RE.test(el.role)) continue;
      // Carry the element's text as the tap fallback: UIKit-native views
      // (tab-bar labels) surface an accessibilityIdentifier in the dump
      // that the RN testID index can't resolve — the text path routes
      // through the deterministic tab/alert handling instead.
      const a: ExploreAction = { key: el.testID, id: el.testID, ...(el.text && { text: el.text }) };
      if (isPrimaryAction(a)) a.primary = true;
      if (isSliderElement(el)) a.slide = true;
      all.push(a);
      continue;
    }
    if (el.text && (el.button || el.adjustable || /Button/.test(el.role))) {
      const key = `tx:${el.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (limits.deny.test(el.text)) continue;
      const a: ExploreAction = { key, text: el.text };
      if (isPrimaryAction(a)) a.primary = true;
      if (isSliderElement(el)) a.slide = true;
      all.push(a);
    }
  }
  // Every candidate is kept — there is deliberately no per-screen action
  // cap: the wall-clock budget is the only thing that cuts work short,
  // and an arbitrary slice would hide whole regions behind busy screens.
  return all;
}

export interface CrawlerHooks {
  /** Called once per newly discovered node (for screenshots / progress). */
  onNode?: (node: ExploreNode) => Promise<void>;
  /** Progress line for the human watching. */
  log?: (msg: string) => void;
  /** Skip the initial relaunch: the crawl's root is whatever screen the
   *  app is showing right now (smoke's warm start). Recovery replays
   *  still call driver.relaunch() — what THAT does to app state is the
   *  driver's policy. */
  warmStart?: boolean;
}

export async function crawl(
  driver: ExploreDriver,
  limits: ExploreLimits = DEFAULT_LIMITS,
  hooks: CrawlerHooks = {},
): Promise<ExploreResult> {
  const nodes = new Map<string, ExploreNode>();
  const edges: ExploreEdge[] = [];
  const warnings: ExploreWarning[] = [];
  const log = hooks.log ?? (() => undefined);
  // One PRNG stream for the whole crawl: each new screen draws its
  // shuffle from it in discovery order, so the seed pins the entire walk.
  const rng = limits.seed !== undefined ? mulberry32(limits.seed) : null;
  let steps = 0;

  /** Describe the current screen; register the node if it's new. */
  const snapshot = async (pathNow: ExploreAction[]): Promise<string> => {
    let elements = await driver.describe();
    let sig = screenSignature(elements);
    if (!nodes.has(sig)) {
      // Unknown signature: the screen may still be mounting async content
      // (a list racing its data fetch would register rows-less). Poll
      // until two consecutive dumps agree — a SIGNAL that mounting
      // settled, not a fixed sleep. Known signatures skip this: the
      // screen is already recognized. 70ms ≈ 4 frames between dumps; a
      // dump itself is ~15ms in-process, so the loop converges in
      // ~150-250ms on a settled screen while still giving slow async
      // mounts ~700ms to land.
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 70));
        const again = await driver.describe();
        const sigAgain = screenSignature(again);
        if (sigAgain === sig) break;
        elements = again;
        sig = sigAgain;
      }
    }
    if (!nodes.has(sig)) {
      const actions = enumerateActions(elements, limits);
      if (rng) shuffle(actions, rng);
      // Primary CTAs first (stable sort): the crawler works a screen the
      // way a user would — fill the form, hit the main button, map the
      // secondary chrome later. Within each group the (shuffled) order
      // is preserved, so the seed still pins the walk.
      actions.sort((a, b) => Number(b.primary ?? false) - Number(a.primary ?? false));
      const node: ExploreNode = {
        sig,
        title: screenTitle(elements),
        elements,
        actions: nodes.size >= limits.maxNodes ? [] : actions,
        tried: [],
        depth: pathNow.length,
        path: [...pathNow],
        inputs: enumerateInputs(elements),
      };
      if (nodes.size >= limits.maxNodes) {
        warnings.push({ kind: 'cap-hit', detail: `maxNodes=${limits.maxNodes}: ${sig} frozen` });
      }
      nodes.set(sig, node);
      log(`screen ${sig}${node.title ? ` "${node.title}"` : ''} — ${node.actions.length} actions`);
      await hooks.onNode?.(node);
    }
    return sig;
  };

  /** clearState relaunch + replay `path`, verifying the landing sig. */
  const replayTo = async (path: ExploreAction[], expected: string): Promise<string> => {
    await driver.relaunch();
    for (const action of path) await driver.tap(action);
    const sig = await snapshot(path);
    if (sig !== expected) {
      warnings.push({
        kind: 'replay-mismatch',
        detail: `path [${path.map((a) => a.key).join(' → ')}] expected ${expected}, landed ${sig}`,
      });
    }
    return sig;
  };

  if (!hooks.warmStart) await driver.relaunch();
  // The budget clock starts AFTER the initial relaunch settle: launch cost
  // varies by machine, exploration work is what the budget meters.
  const deadline = Date.now() + limits.maxMs;
  const root = await snapshot([]);
  // The action path from root to the screen the device currently shows.
  let path: ExploreAction[] = [];
  let current = root;
  // Nodes whose discovery path no longer reproduces them (state-dependent
  // screens: a clearState replay wiped the session/data they depended
  // on). Sweeping to one again would replay-mismatch forever — frozen
  // after the first failure; their untried actions stay in the map.
  const unreachable = new Set<string>();

  // No step-count cap by design: the wall-clock budget is the global
  // stop, and the frontier draining (no node with untried actions) is
  // the natural end.
  for (;;) {
    if (Date.now() >= deadline) {
      warnings.push({ kind: 'cap-hit', detail: `maxMs=${limits.maxMs} budget exhausted` });
      break;
    }
    const node = nodes.get(current);
    if (!node) break; // unreachable; defensive
    const depthLimit = limits.maxDepth + 1;
    const untried = node.actions.filter((a) => !node.tried.includes(a.key));
    // Action pick. Below maxDepth anything goes (primaries already sit
    // first). In the FLOW ZONE — past maxDepth but within the bonus —
    // only primary CTAs may run: deep enough to finish a checkout or
    // wizard, without letting ordinary branching explode the walk.
    let next: ExploreAction | undefined;
    if (path.length < depthLimit) {
      next = untried[0];
    } else if (path.length < depthLimit + FLOW_DEPTH_BONUS) {
      next = untried.find((a) => a.primary === true);
    }

    // Scroll mining: the visible frontier drained, but RN virtualization
    // means below-the-fold actions don't even exist in the dump. Swipe
    // forward and re-enumerate; the first barren swipe ends mining so a
    // non-scrollable screen pays for exactly one.
    if (
      !next &&
      untried.length === 0 &&
      path.length < depthLimit &&
      (node.scrolls ?? 0) < MAX_SCROLLS_PER_NODE
    ) {
      await driver.scrollForward();
      const after = await driver.describe();
      const mined = enumerateActions(after, limits).filter(
        (a) => !node.actions.some((e) => e.key === a.key),
      );
      const minedInputs = enumerateInputs(after).filter(
        (i) => !node.inputs.some((e) => e.key === i.key),
      );
      node.inputs.push(...minedInputs);
      if (mined.length > 0) {
        if (rng) shuffle(mined, rng);
        mined.sort((a, b) => Number(b.primary ?? false) - Number(a.primary ?? false));
        node.actions.push(...mined);
        node.scrolls = (node.scrolls ?? 0) + 1;
        log(`  ⤓ scroll: +${mined.length} actions on ${current}`);
      } else {
        node.scrolls = MAX_SCROLLS_PER_NODE; // barren — stop mining here
        log(`  ⤓ scroll: nothing new on ${current}`);
      }
      continue;
    }

    if (!next) {
      if (untried.length > 0 && path.length >= depthLimit) {
        warnings.push({ kind: 'cap-hit', detail: `maxDepth=${limits.maxDepth} at ${current}` });
        // Freeze the node's remaining actions at this depth — they stay
        // visible in the map as untried.
      }
      if (path.length === 0) {
        // Root exhausted — but lateral re-anchoring means other screens
        // may still hold untried actions. Sweep the frontier: replay to
        // the first such node (insertion order, deterministic) and keep
        // going. Done only when no node has work left.
        const pending = [...nodes.values()].find(
          (n) =>
            n.actions.some((a) => !n.tried.includes(a.key)) &&
            n.path.length > 0 &&
            // Depth-frozen nodes can never try their actions — sweeping
            // to them would loop forever; their untried list stays
            // visible in the map instead.
            n.path.length <= limits.maxDepth &&
            !unreachable.has(n.sig),
        );
        if (!pending) break;
        log(`sweep → ${pending.sig} (${pending.path.map((a) => a.key).join(' → ')})`);
        current = await replayTo(pending.path, pending.sig);
        if (current === pending.sig) {
          path = pending.path;
        } else {
          // Landed elsewhere: the target depends on state the relaunch
          // wiped. Freeze it and anchor on where we actually are — the
          // replay's taps ARE the recipe for the landing screen, and
          // snapshot() registered it under exactly that path if new.
          unreachable.add(pending.sig);
          path = nodes.get(current)?.path ?? pending.path;
        }
        continue;
      }
      // Backtrack — cheap to expensive, every hop signature-verified:
      //   1. `back`: on the parent → done. On another KNOWN screen with
      //      work left → re-anchor there (its discovery path is the
      //      recipe) instead of forcing a return.
      //   2. Parent-entry shortcut: the action that originally entered
      //      the parent (or, for the root, the root's own self-loop tab)
      //      visible on the CURRENT screen — persistent tab bars make
      //      this a one-tap return.
      //   3. clearState replay of the parent path — the ground truth.
      const parentPath = path.slice(0, -1);
      const expected =
        parentPath.length === 0
          ? root
          : edgeTarget(
              edges,
              root,
              parentPath.map((a) => a.key),
            );
      const tb = Date.now();
      await driver.back();
      let sig = await snapshot(parentPath);
      log(`  ↩ back ${Date.now() - tb}ms (${sig === expected ? 'parent' : sig})`);
      if (sig === expected) {
        path = parentPath;
        current = sig;
        continue;
      }
      if (sig !== current) {
        const known = nodes.get(sig);
        if (known && known.actions.some((a) => !known.tried.includes(a.key))) {
          path = known.path;
          current = sig;
          continue;
        }
      }
      const entry =
        parentPath.length > 0
          ? parentPath[parentPath.length - 1]
          : rootReEntry(nodes.get(root), edges);
      const here = nodes.get(sig)?.elements ?? [];
      if (entry && actionVisible(entry, here)) {
        await driver.tap(entry);
        sig = await snapshot(parentPath);
        if (sig === expected) {
          path = parentPath;
          current = sig;
          continue;
        }
      }
      warnings.push({ kind: 'back-failed', detail: `back from ${current} landed ${sig}` });
      current = await replayTo(parentPath, expected);
      if (current === expected) {
        path = parentPath;
        continue;
      }
      // The parent can't be reached by replay anymore — the app's state
      // moved on under the path (login flipped mid-crawl, data gone).
      // Freeze it (its untried work stays visible in the map) and re-root
      // on a fresh relaunch: adopting the landing screen's stale path
      // here loops back into the same failing backtrack forever.
      unreachable.add(expected);
      await driver.relaunch();
      current = await snapshot([]);
      path = [];
      continue;
    }

    // Complete the flow like a user: before pressing a screen's primary
    // CTA for the first time, fill its text inputs with plausible values
    // (email-shaped for email fields, etc.) so format validation doesn't
    // bounce the whole subtree.
    if (next.primary === true && node.inputs.length > 0 && node.filled !== true) {
      node.filled = true;
      for (const input of node.inputs) {
        const value = inputValueFor(input.key, rng ? 1 + Math.floor(rng() * 9999) : 1);
        const filled = await driver.typeInto(input, value);
        log(`  ✎ ${input.key}${filled ? ` = "${value}"` : ' — fill failed'}`);
      }
    }

    node.tried.push(next.key);
    steps++;
    const t0 = Date.now();
    const tapped = await driver.tap(next);
    const tapMs = Date.now() - t0;
    if (!tapped.ok) {
      log(`  ✗ ${next.key} ${tapMs}ms — ${tapped.detail ?? 'tap failed'}`);
      edges.push({
        from: current,
        action: next.key,
        to: current,
        kind: 'error',
        detail: tapped.detail,
      });
      continue;
    }
    const t1 = Date.now();
    const after = await snapshot([...path, next]);
    const snapMs = Date.now() - t1;
    if (after === current) {
      log(`  · ${next.key} tap=${tapMs}ms snap=${snapMs}ms (state)`);
      edges.push({ from: current, action: next.key, to: current, kind: 'state' });
      continue;
    }
    log(`  → ${next.key} tap=${tapMs}ms snap=${snapMs}ms (nav ${after})`);
    edges.push({ from: current, action: next.key, to: after, kind: 'nav' });
    const known = nodes.get(after);
    if (known && known.path.length <= path.length) {
      // Lateral hop into an already-mapped screen (tab switches): adopt
      // its canonical discovery path instead of growing ours — otherwise
      // tab ping-pong inflates depth and exhausts maxDepth before any
      // real content is reached.
      path = known.path;
    } else {
      path = [...path, next];
    }
    current = after;
  }

  return { root, nodes: [...nodes.values()], edges, warnings, steps };
}

/** Is this action's selector present in an element inventory? */
function actionVisible(action: ExploreAction, elements: DescribedElement[]): boolean {
  return elements.some(
    (el) =>
      (action.id !== undefined && el.testID === action.id) ||
      (action.text !== undefined && el.text === action.text),
  );
}

/**
 * The root's own tab: an action recorded as a 'state' self-loop on the
 * root (tapping the already-selected tab changes nothing). Tapping it
 * from another tab is a one-tap return to the root.
 */
function rootReEntry(
  rootNode: ExploreNode | undefined,
  edges: ExploreEdge[],
): ExploreAction | undefined {
  if (!rootNode) return undefined;
  return rootNode.actions.find((a) =>
    edges.some((e) => e.from === rootNode.sig && e.action === a.key && e.kind === 'state'),
  );
}

/** Resolve where a path SHOULD land by walking recorded nav edges. */
function edgeTarget(edges: ExploreEdge[], root: string, path: string[]): string {
  let at = root;
  for (const action of path) {
    const edge = edges.find((e) => e.from === at && e.action === action && e.kind === 'nav');
    if (!edge) return at;
    at = edge.to;
  }
  return at;
}
