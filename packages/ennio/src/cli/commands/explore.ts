/**
 * `ennio explore <bundleId>` — deterministic app crawler.
 *
 * Walks the app as a graph: screens are nodes (structural signatures),
 * taps on testID'd elements are edges. Depth-first, deterministic action
 * order, signature-verified backtracking (back first, clearState+replay
 * fallback). Produces an app map an agent or a human can navigate from:
 *
 *   <out>/app-map.json   — sorted, diffable graph (nodes/edges/warnings)
 *   <out>/map.mmd        — mermaid rendering of the nav edges
 *   <out>/screens/*.png  — one screenshot per discovered screen
 *
 * Guards: --max-depth, --max-nodes, --max-actions, --max-steps and a
 * --deny regex (defaults block logout/delete/purchase-looking testIDs).
 * All caps are recorded as warnings in the map — nothing is silently cut.
 */

import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { Flags } from '../cli/args';
import { crawl, DEFAULT_DENY, DEFAULT_LIMITS } from '../explore/crawler';
import { LiveExploreDriver } from '../explore/live-driver';
import { buildAppMap, writeArtifacts } from '../explore/output';
import { EnnioMcpSession } from '../mcp/session';
import { selectPlatform } from '../platform';

function intFlag(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export async function runExploreCommand(positional: string[], flags: Flags): Promise<number> {
  const bundleId = positional[0];
  if (!bundleId) {
    console.error('Usage: ennio explore <bundleId> [--max-depth N] [--out DIR]');
    return 1;
  }
  const limits = {
    maxDepth: intFlag(flags.maxDepth, DEFAULT_LIMITS.maxDepth),
    maxNodes: intFlag(flags.maxNodes, DEFAULT_LIMITS.maxNodes),
    maxMs: intFlag(flags.duration, DEFAULT_LIMITS.maxMs / 1000) * 1000,
    deny: flags.deny ? new RegExp(flags.deny, 'i') : DEFAULT_DENY,
    // Explore's product is a DIFFABLE map: document order unless the
    // user explicitly opts into a seeded shuffle.
    ...(flags.seed !== undefined && { seed: Number(flags.seed) >>> 0 }),
  };
  const outDir = resolve(flags.output ?? join('.ennio', 'explore', bundleId));

  // Exploration maps structure, not animation fidelity: snap transitions
  // to their final frame. The env var rides every (re)launch (the runtime
  // toggle below covers the already-running attach); --keep-animations
  // opts back into real timing.
  if (!flags.keepAnimations) process.env.ENNIO_NO_ANIMATIONS = '1';

  const session = new EnnioMcpSession({
    platform: selectPlatform(flags.android ? 'android' : 'ios'),
    inProcessTap: flags.inProcessTap,
    safeMode: flags.safeMode,
  });
  try {
    const attached = await session.attach(bundleId);
    if (!attached.ok) {
      console.error(`attach failed: ${attached.error.message}`);
      return 1;
    }
    // Exploration maps structure, not animation fidelity — transitions
    // snap to their final frame by default so every settle returns at
    // the commit. --keep-animations opts back into real timing.
    if (!flags.keepAnimations) await session.setAnimations(false);

    const startedAt = Date.now();
    mkdirSync(join(outDir, 'screens'), { recursive: true });
    const driver = new LiveExploreDriver(session, bundleId);
    const result = await crawl(driver, limits, {
      log: (msg) => console.error(`[explore] ${msg}`),
      onNode: async (node) => {
        const rel = join('screens', `${node.sig}.png`);
        try {
          await driver.screenshot(join(outDir, rel));
          node.screenshot = rel;
        } catch {
          /* screenshot is best-effort — the map stays valid without it */
        }
      },
    });

    const map = buildAppMap(bundleId, result);
    const jsonPath = writeArtifacts(outDir, map);
    const wallMs = Date.now() - startedAt;
    console.error(
      `[explore] ${map.stats.screens} screens, ${map.stats.edges} edges, ` +
        `${result.steps} steps, ${map.warnings.length} warnings → ${jsonPath}`,
    );
    console.error(
      `[explore] wall ${(wallMs / 1000).toFixed(1)}s — ` +
        `${result.steps > 0 ? Math.round(wallMs / result.steps) : 0}ms/action`,
    );
    if (flags.reporter === 'json') console.log(JSON.stringify(map, null, 2));
    return 0;
  } finally {
    // Leave the app as we found it: the crawl disabled animations for
    // speed, the user keeps interacting with the app afterwards.
    if (!flags.keepAnimations) await session.setAnimations(true).catch(() => undefined);
    session.close();
  }
}
