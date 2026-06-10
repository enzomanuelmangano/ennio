// The exploration engine — deterministic DFS over the app's screen graph.
//
// Invariants that make two runs produce the same map:
//   * Actions are enumerated in document order and attempted in that order.
//   * Every decision is a pure function of the graph state + limits — no
//     wall-clock, no randomness, no retries-with-jitter.
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
  maxActionsPerScreen: 25,
  maxMs: 60_000,
  deny: DEFAULT_DENY,
};

/**
 * Tappable candidates, document order, deduped:
 *   * every testID'd element (authored interactivity), and
 *   * Button-role elements identified only by text (RNGestureHandler
 *     buttons, UIKit buttons — interactive by class, no testID given).
 * Generic text views are NOT actions: `dump_views` carries no
 * interactivity signal, so a bare RCTView card without a testID is
 * invisible to the crawler — give it a testID to make it explorable.
 */
export function enumerateActions(
  elements: DescribedElement[],
  limits: ExploreLimits,
): { actions: ExploreAction[]; capped: boolean } {
  const seen = new Set<string>();
  const all: ExploreAction[] = [];
  for (const el of elements) {
    if (el.testID) {
      if (seen.has(el.testID)) continue;
      seen.add(el.testID);
      if (limits.deny.test(el.testID)) continue;
      // Carry the element's text as the tap fallback: UIKit-native views
      // (tab-bar labels) surface an accessibilityIdentifier in the dump
      // that the RN testID index can't resolve — the text path routes
      // through the deterministic tab/alert handling instead.
      all.push({ key: el.testID, id: el.testID, ...(el.text && { text: el.text }) });
      continue;
    }
    if (el.text && /Button/.test(el.role)) {
      const key = `tx:${el.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (limits.deny.test(el.text)) continue;
      all.push({ key, text: el.text });
    }
  }
  return {
    actions: all.slice(0, limits.maxActionsPerScreen),
    capped: all.length > limits.maxActionsPerScreen,
  };
}

export interface CrawlerHooks {
  /** Called once per newly discovered node (for screenshots / progress). */
  onNode?: (node: ExploreNode) => Promise<void>;
  /** Progress line for the human watching. */
  log?: (msg: string) => void;
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
      const { actions, capped } = enumerateActions(elements, limits);
      const node: ExploreNode = {
        sig,
        title: screenTitle(elements),
        elements,
        actions: nodes.size >= limits.maxNodes ? [] : actions,
        tried: [],
        depth: pathNow.length,
        path: [...pathNow],
      };
      if (nodes.size >= limits.maxNodes) {
        warnings.push({ kind: 'cap-hit', detail: `maxNodes=${limits.maxNodes}: ${sig} frozen` });
      } else if (capped) {
        warnings.push({
          kind: 'cap-hit',
          detail: `maxActionsPerScreen=${limits.maxActionsPerScreen} on ${sig}`,
        });
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

  await driver.relaunch();
  // The budget clock starts AFTER the initial relaunch settle: launch cost
  // varies by machine, exploration work is what the budget meters.
  const deadline = Date.now() + limits.maxMs;
  const root = await snapshot([]);
  // The action path from root to the screen the device currently shows.
  let path: ExploreAction[] = [];
  let current = root;

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
    const next = node.actions.find((a) => !node.tried.includes(a.key));

    if (!next || path.length >= limits.maxDepth + 1) {
      if (next && path.length >= limits.maxDepth + 1) {
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
            n.path.length <= limits.maxDepth,
        );
        if (!pending) break;
        log(`sweep → ${pending.sig} (${pending.path.map((a) => a.key).join(' → ')})`);
        current = await replayTo(pending.path, pending.sig);
        path = pending.path;
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
      path = parentPath;
      continue;
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
