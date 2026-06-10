/**
 * `ennio smoke [bundleId]` — crawl-based app smoke test for CI.
 *
 * Same engine as `ennio explore`, different product: explore's output is
 * the artifact folder (the map); smoke's output is the EXIT CODE. It
 * walks the app for the wall-clock budget and answers one question —
 * does the app survive autonomous exploration? — printing a one-screen
 * summary and writing NOTHING unless --output is given.
 *
 *   exit 0  crawl completed (caps/budget cuts are fine)
 *   exit 1  the app crashed mid-crawl (diagnosis printed, with the last
 *           action attributed), attach failed, or no screen was readable
 *
 * Not to be confused with `ennio doctor --smoke`, which self-tests
 * ennio's own plumbing (inject → socket → actuate). `ennio smoke` tests
 * YOUR app.
 *
 * The default bundleId is the app already open on the booted simulator:
 * launchctl lists running app processes as "UIKitApplication:<id>", and
 * a simulator rarely has more than one non-system app alive. Ambiguity
 * (several running apps) is an error listing the candidates, never a
 * guess.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { Flags } from '../cli/args';
import { diagnoseSocketFailure } from '../crash-detector';
import { crawl, DEFAULT_DENY, DEFAULT_LIMITS } from '../explore/crawler';
import { LiveExploreDriver } from '../explore/live-driver';
import { buildAppMap, writeArtifacts } from '../explore/output';
import { EnnioMcpSession } from '../mcp/session';
import { selectPlatform } from '../platform';
import { getTargetUdid } from '../sim';

function intFlag(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Non-system apps currently running on the simulator, via launchctl's
 * "UIKitApplication:<bundleId>[...]" labels.
 */
export function runningApps(udid: string): string[] {
  try {
    const out = execFileSync('xcrun', ['simctl', 'spawn', udid, 'launchctl', 'list'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const ids = new Set<string>();
    for (const m of out.matchAll(/UIKitApplication:([A-Za-z0-9.\-]+)/g)) {
      if (!m[1].startsWith('com.apple.')) ids.add(m[1]);
    }
    return [...ids].sort();
  } catch {
    return [];
  }
}

export async function runSmokeCommand(positional: string[], flags: Flags): Promise<number> {
  let bundleId = positional[0];
  if (!bundleId) {
    const udid = getTargetUdid();
    if (!udid) {
      console.error('no booted simulator found — boot one or pass a bundleId');
      return 1;
    }
    const apps = runningApps(udid);
    if (apps.length === 1) {
      bundleId = apps[0];
      console.error(`[smoke] target: ${bundleId} (app open on the simulator)`);
    } else if (apps.length === 0) {
      console.error('no app running on the simulator — open one or pass a bundleId');
      return 1;
    } else {
      console.error(
        `several apps running — pass one explicitly:\n  ${apps
          .map((a) => `ennio smoke ${a}`)
          .join('\n  ')}`,
      );
      return 1;
    }
  }

  const limits = {
    maxDepth: intFlag(flags.maxDepth, DEFAULT_LIMITS.maxDepth),
    maxNodes: intFlag(flags.maxNodes, DEFAULT_LIMITS.maxNodes),
    maxActionsPerScreen: intFlag(flags.maxActions, DEFAULT_LIMITS.maxActionsPerScreen),
    maxMs: intFlag(flags.duration, DEFAULT_LIMITS.maxMs / 1000) * 1000,
    deny: flags.deny ? new RegExp(flags.deny, 'i') : DEFAULT_DENY,
  };
  if (!flags.keepAnimations) process.env.ENNIO_NO_ANIMATIONS = '1';

  const session = new EnnioMcpSession({
    platform: selectPlatform(flags.android ? 'android' : 'ios'),
    inProcessTap: flags.inProcessTap,
    safeMode: flags.safeMode,
  });
  const startedAt = Date.now();
  // The crawler logs every action; remember the last one so a crash can
  // be attributed ("died after tapping X") instead of just diagnosed.
  let lastAction = '(launch)';
  try {
    const attached = await session.attach(bundleId);
    if (!attached.ok) {
      console.error(`attach failed: ${attached.error.message}`);
      return 1;
    }
    if (!flags.keepAnimations) await session.setAnimations(false);

    const outDir = flags.output ? resolve(flags.output) : null;
    if (outDir) mkdirSync(join(outDir, 'screens'), { recursive: true });
    const driver = new LiveExploreDriver(session, bundleId);
    let result;
    try {
      result = await crawl(driver, limits, {
        log: (msg) => {
          if (flags.verbose) console.error(`[smoke] ${msg}`);
          const m = msg.match(/[→·✗] (.+?) (?:tap=\d|\d+ms)/);
          if (m) lastAction = m[1];
        },
        onNode: outDir
          ? async (node) => {
              const rel = join('screens', `${node.sig}.png`);
              try {
                await driver.screenshot(join(outDir, rel));
                node.screenshot = rel;
              } catch {
                /* screenshot is best-effort */
              }
            }
          : undefined,
      });
    } catch (e) {
      // The crawl aborting mid-walk (describe/socket death) is exactly
      // what a smoke test exists to catch. Diagnose: app crash report,
      // process death, or genuine socket failure.
      const msg = e instanceof Error ? e.message : String(e);
      const diagnosis = diagnoseSocketFailure(
        session.udid ?? getTargetUdid() ?? '',
        bundleId,
        startedAt,
      );
      console.error(`\nSMOKE FAIL ${bundleId} — crawl aborted after ${lastAction}`);
      console.error(`  ${msg}`);
      if (diagnosis) console.error(diagnosis.replace(/^/gm, '  '));
      return 1;
    }

    const map = buildAppMap(bundleId, result);
    const kinds = { nav: 0, state: 0, error: 0 };
    for (const edge of map.edges) kinds[edge.kind as keyof typeof kinds] += 1;
    const wallS = ((Date.now() - startedAt) / 1000).toFixed(1);

    if (outDir) {
      const jsonPath = writeArtifacts(outDir, map);
      console.error(`[smoke] artifacts → ${jsonPath}`);
    }
    if (map.stats.screens === 0) {
      console.error(`SMOKE FAIL ${bundleId} — no screen readable (empty element tree)`);
      return 1;
    }

    console.log(
      `SMOKE PASS ${bundleId} — ${map.stats.screens} screens, ${result.steps} actions ` +
        `(${kinds.nav} nav, ${kinds.state} state, ${kinds.error} failed) in ${wallS}s`,
    );
    for (const w of map.warnings) console.log(`  warning: ${w.kind} — ${w.detail}`);
    return 0;
  } finally {
    session.close();
  }
}
