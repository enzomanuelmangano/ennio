/**
 * `ennio improvise [bundleId]` — autonomous crash hunt for CI.
 *
 * A YAML flow is the score; this command is ennio playing WITHOUT one.
 * The product is the EXIT CODE. It walks the app (the crawl engine in
 * src/cli/explore/) for the wall-clock budget and answers one question —
 * does the app survive autonomous exploration? — printing a one-screen
 * summary and writing NOTHING unless --output is given.
 * (`smoke` is accepted as a hidden back-compat alias through the 0.1.0
 * betas.)
 *
 * It exercises the app the way a user would:
 *   * WARM START — no relaunch, no clearState, ever: the crawl roots at
 *     whatever screen the app shows right now, with the user's session
 *     and data intact.
 *   * RANDOM SEED — per-screen action order is shuffled so repeated CI
 *     runs probe different paths; the seed is printed in the summary so
 *     any run replays exactly with --seed.
 *   * REAL INPUT — every tap is a HID touch through the simulator's
 *     event pipeline (no in-process shortcuts), and animations run
 *     untouched.
 *
 *   exit 0  crawl completed (caps/budget cuts are fine)
 *   exit 1  the app crashed mid-crawl (diagnosis printed, with the last
 *           action attributed), attach failed, or no screen was readable
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
import type { ScreenRecording } from '../recorder';
import { startScreenRecording } from '../recorder';
import { getTargetUdid } from '../sim';
import { dim, cyan, SPINNER } from '../ui/ansi';
import { LiveRegion } from '../ui/live-region';

/**
 * Live `⠋ improvising · <bundleId>` line on a TTY — a heartbeat that
 * shows the walk is alive and how far it's gotten. No-op when output
 * isn't a TTY (CI logs stay clean) or when --verbose streams per-action
 * lines (the spinner would fight them). Counters are fed from the crawl
 * log callback; the braille frame advances on its own ~12fps timer.
 */
function makeImproviseSpinner(bundleId: string, enabled: boolean) {
  let screens = 0;
  let actions = 0;
  let frame = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  const region = new LiveRegion(process.stderr, 80);
  const paint = () => {
    region.render([
      `${cyan(SPINNER[frame % SPINNER.length])} ${dim('improvising')} · ${bundleId}` +
        dim(`   ${screens} screens · ${actions} actions`),
    ]);
  };
  return {
    start() {
      if (!enabled) return;
      timer = setInterval(() => {
        frame++;
        paint();
      }, 80);
    },
    note(msg: string) {
      if (msg.startsWith('screen ')) screens++;
      else if (/^\s*[→·]/.test(msg)) actions++;
    },
    stop() {
      if (timer) clearInterval(timer);
      region.stop();
    },
  };
}

function intFlag(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Fresh random seed per run, small enough to read off a CI log. */
function randomSeed(): number {
  return Math.floor(Math.random() * 1_000_000);
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

/** All booted simulator UDIDs, list order (= simctl's runtime order). */
function bootedSims(): string[] {
  try {
    const json = execFileSync('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'], {
      encoding: 'utf-8',
    });
    const data = JSON.parse(json) as {
      devices?: Record<string, { udid: string; state: string }[]>;
    };
    const out: string[] = [];
    for (const bucket of Object.values(data.devices ?? {})) {
      for (const d of bucket) if (d.state === 'Booted') out.push(d.udid);
    }
    return out;
  } catch {
    return [];
  }
}

export async function runImproviseCommand(positional: string[], flags: Flags): Promise<number> {
  let bundleId = positional[0];
  // Device pick, warm-start flavored: with several sims booted and no
  // ENNIO_UDID pin, "first booted" can land the run on a sim that merely
  // has the app INSTALLED — launching a cold copy there while the user
  // watches their live one. Prefer the sim where the target app is
  // actually RUNNING.
  if (bundleId && !process.env.ENNIO_UDID) {
    const where = bootedSims().filter((u) => runningApps(u).includes(bundleId));
    if (where.length > 0) {
      process.env.ENNIO_UDID = where[0];
      console.error(`[improvise] device: ${where[0]} (${bundleId} is running there)`);
      if (where.length > 1) {
        console.error(
          `[improvise] note: ${bundleId} runs on ${where.length} booted sims — pin one with ENNIO_UDID`,
        );
      }
    }
  }
  if (!bundleId) {
    const udid = getTargetUdid();
    if (!udid) {
      console.error('no booted simulator found — boot one or pass a bundleId');
      return 1;
    }
    const apps = runningApps(udid);
    if (apps.length === 1) {
      bundleId = apps[0];
      console.error(`[improvise] target: ${bundleId} (app open on the simulator)`);
    } else if (apps.length === 0) {
      console.error('no app running on the simulator — open one or pass a bundleId');
      return 1;
    } else {
      console.error(
        `several apps running — pass one explicitly:\n  ${apps
          .map((a) => `ennio improvise ${a}`)
          .join('\n  ')}`,
      );
      return 1;
    }
  }

  // Smoke is a monkey at heart: vary the walk run-to-run so CI keeps
  // probing different paths — but ALWAYS from a printed seed, so any
  // failure replays exactly with --seed.
  const seed = flags.seed !== undefined ? Number(flags.seed) >>> 0 : randomSeed();
  const limits = {
    maxDepth: intFlag(flags.maxDepth, DEFAULT_LIMITS.maxDepth),
    maxNodes: intFlag(flags.maxNodes, DEFAULT_LIMITS.maxNodes),
    maxMs: intFlag(flags.duration, DEFAULT_LIMITS.maxMs / 1000) * 1000,
    deny: flags.deny ? new RegExp(flags.deny, 'i') : DEFAULT_DENY,
    seed,
  };

  // Touch visualization is ON by default (session.attach arms it even on
  // a warm start, and turns it off at close). --disable-touches opts out
  // for pixel-exact artifacts.
  process.env.ENNIO_SHOW_TOUCHES = flags.disableTouches ? '0' : '1';

  // As real as it gets: animations run untouched and every tap is a HID
  // touch through the simulator's event pipeline — improvise exists to
  // exercise the app the way a user would, not to map it fast.
  const session = new EnnioMcpSession({
    platform: selectPlatform(flags.android ? 'android' : 'ios'),
    inProcessTap: false,
    safeMode: flags.safeMode,
  });
  const startedAt = Date.now();
  // The crawler logs every action; remember the last one so a crash can
  // be attributed ("died after tapping X") instead of just diagnosed.
  let lastAction = '(launch)';
  let recording: ScreenRecording | null = null;
  try {
    const attached = await session.attach(bundleId);
    if (!attached.ok) {
      console.error(`attach failed: ${attached.error.message}`);
      return 1;
    }
    const outDir = flags.output ? resolve(flags.output) : null;
    if (outDir) mkdirSync(join(outDir, 'screens'), { recursive: true });
    if (flags.record && session.udid) {
      recording = startScreenRecording(
        session.platformName,
        session.udid,
        outDir ? join(outDir, 'recording.mp4') : resolve(`ennio-improvise-${seed}.mp4`),
      );
    }
    // Warm start, never clearState: improvise tests the app from EXACTLY the
    // state it's in — logged-in session, filled carts and all. --relaunch
    // restarts the process first (data still kept); recovery relaunches
    // behave the same way.
    //
    // Root readiness: if attach itself (re)launched the app, the JS tree
    // may still be mounting — a static splash passes the crawler's quick
    // settle and roots the crawl on a dead screen. Wait until two dumps
    // 250ms apart agree on a non-empty inventory (up to 10s) before
    // crawling; a genuinely empty app falls through after the deadline.
    {
      const ready = Date.now() + 10_000;
      let prev = '';
      while (Date.now() < ready) {
        const d = await session.describe();
        const now = d.ok ? JSON.stringify(d.data.elements) : '';
        if (now && now !== '[]' && now === prev) break;
        prev = now;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    const driver = new LiveExploreDriver(session, bundleId, { clearState: false, realInput: true });
    // Heartbeat: spinner on a TTY unless --verbose is streaming lines.
    const spinner = makeImproviseSpinner(bundleId, !flags.verbose && !!process.stderr.isTTY);
    spinner.start();
    let result;
    try {
      result = await crawl(driver, limits, {
        warmStart: !flags.relaunch,
        log: (msg) => {
          if (flags.verbose) console.error(`[improvise] ${msg}`);
          else spinner.note(msg);
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
      spinner.stop();
    } catch (e) {
      spinner.stop();
      // The crawl aborting mid-walk (describe/socket death) is exactly
      // what this command exists to catch. Diagnose: app crash report,
      // process death, or genuine socket failure.
      const msg = e instanceof Error ? e.message : String(e);
      const diagnosis = diagnoseSocketFailure(
        session.udid ?? getTargetUdid() ?? '',
        bundleId,
        startedAt,
        'improvise',
      );
      console.error(
        `\nIMPROVISE FAIL ${bundleId} (seed ${seed}) — crawl aborted after ${lastAction}`,
      );
      console.error(`  replay exactly: ennio improvise ${bundleId} --seed ${seed}`);
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
      console.error(`[improvise] artifacts → ${jsonPath}`);
    }
    if (map.stats.screens === 0) {
      console.error(`IMPROVISE FAIL ${bundleId} — no screen readable (empty element tree)`);
      return 1;
    }

    console.log(
      `IMPROVISE PASS ${bundleId} (seed ${seed}) — ${map.stats.screens} screens, ` +
        `${result.steps} actions (${kinds.nav} nav, ${kinds.state} state, ` +
        `${kinds.error} failed) in ${wallS}s`,
    );
    // Quiet by default: warnings are routine crawl bookkeeping (caps hit,
    // nondeterministic backtracks), and a healthy run can produce a dozen.
    // One summary line; --verbose lists them all.
    if (flags.verbose) {
      for (const w of map.warnings) console.log(`  warning: ${w.kind} — ${w.detail}`);
    } else if (map.warnings.length > 0) {
      const byKind = new Map<string, number>();
      for (const w of map.warnings) byKind.set(w.kind, (byKind.get(w.kind) ?? 0) + 1);
      const parts = [...byKind.entries()].map(([k, n]) => `${n} ${k}`).join(', ');
      console.log(`  ${map.warnings.length} warnings (${parts}) — --verbose to list`);
    }
    // Coverage floor: a warm start can root on a stale/dead screen, drain
    // instantly, and "pass" having tested nothing. Still exit 0 (the app
    // didn't crash — the contract holds) but say it loudly so a CI log
    // reader doesn't mistake an empty walk for a healthy one.
    if (map.stats.screens < 2 || kinds.nav === 0) {
      console.log(
        `  warning: low-coverage — ${map.stats.screens} screen(s), ${kinds.nav} nav edges: ` +
          'the crawl barely moved. The root screen may be stale or stuck; try --relaunch.',
      );
    }
    return 0;
  } finally {
    if (recording) {
      const saved = await recording.stop();
      if (saved) console.error(`[improvise] recording → ${saved}`);
    }
    await session.disableShowTouches();
    session.close();
  }
}
