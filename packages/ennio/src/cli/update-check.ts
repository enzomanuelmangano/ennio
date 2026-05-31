/**
 * Update notifier — tells the user when a newer `@reactiive/ennio` is on
 * npm. Zero runtime deps, non-blocking, and silent by default on the first
 * run.
 *
 * How it stays out of the way:
 *   - Reads a cached `{ checkedAt, latest }` from ~/.ennio/update-check.json
 *     synchronously and returns a notice instantly — the network is never on
 *     the command's critical path.
 *   - When the cache is missing or older than TTL, it spawns a *detached*
 *     child that fetches the `latest` dist-tag and rewrites the cache, then
 *     exits without being waited on. The freshly-fetched value shows up on the
 *     NEXT invocation. This is the npm update-notifier pattern.
 *   - Compares against the `latest` dist-tag specifically, so someone running
 *     a prerelease that is ahead of `latest` (e.g. 0.0.7-beta.1 vs latest
 *     0.0.6) is not nagged to "downgrade".
 *
 * Opt-out: CI, a non-TTY stdout, ENNIO_NO_UPDATE_CHECK, or NO_UPDATE_NOTIFIER
 * (the de-facto community env var) all disable it entirely.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PKG_NAME = '@reactiive/ennio';
// %2f is an encoded slash — the npm registry's per-version endpoint for a
// scoped package. Returns just the dist-tag's manifest, not the full doc.
const LATEST_URL = 'https://registry.npmjs.org/@reactiive%2fennio/latest';
const TTL_MS = 24 * 60 * 60 * 1000; // 24h
const FETCH_TIMEOUT_MS = 4000;

function cachePath(): string {
  return join(homedir(), '.ennio', 'update-check.json');
}

/** Honor CI / non-interactive / explicit opt-out. */
function shouldCheck(): boolean {
  if (process.env.ENNIO_NO_UPDATE_CHECK || process.env.NO_UPDATE_NOTIFIER) return false;
  if (process.env.CI) return false;
  // No human watching → no point. Also keeps the notice out of piped/JSON
  // output that something downstream might parse.
  if (!process.stdout.isTTY) return false;
  return true;
}

type Cache = { checkedAt: number; latest: string };

function readCache(): Cache | null {
  try {
    const raw = readFileSync(cachePath(), 'utf-8');
    const c = JSON.parse(raw) as Partial<Cache>;
    if (typeof c.checkedAt === 'number' && typeof c.latest === 'string') {
      return { checkedAt: c.checkedAt, latest: c.latest };
    }
  } catch {
    /* missing or corrupt cache → treat as no cache */
  }
  return null;
}

/**
 * Spawn a detached, unref'd child that refreshes the cache and exits. The
 * parent never waits on it, so this adds nothing to the command's runtime.
 * The fetch + write is a self-contained `node -e` script (no bundled helper
 * to ship, no path resolution at runtime).
 */
function spawnRefresh(now: number): void {
  const script = `
    const https = require('node:https');
    const fs = require('node:fs');
    const path = require('node:path');
    const cache = ${JSON.stringify(cachePath())};
    const req = https.get(${JSON.stringify(LATEST_URL)}, {
      timeout: ${FETCH_TIMEOUT_MS},
      headers: { accept: 'application/vnd.npm.install-v1+json' },
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return; }
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          const latest = JSON.parse(body).version;
          if (typeof latest === 'string') {
            fs.mkdirSync(path.dirname(cache), { recursive: true });
            fs.writeFileSync(cache, JSON.stringify({ checkedAt: ${now}, latest }));
          }
        } catch (_) { /* ignore */ }
      });
    });
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
  `;
  try {
    const child = spawn(process.execPath, ['-e', script], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch {
    /* best effort — a failed refresh just means no notice next time */
  }
}

type Parsed = { major: number; minor: number; patch: number; pre: string };

/** Parse a semver-ish "x.y.z" or "x.y.z-pre.n". Tolerant; missing → 0. */
function parse(v: string): Parsed {
  const [core, ...preParts] = v.trim().split('-');
  const [major, minor, patch] = core.split('.').map((n) => parseInt(n, 10) || 0);
  return {
    major: major || 0,
    minor: minor || 0,
    patch: patch || 0,
    pre: preParts.join('-'),
  };
}

/**
 * Is `a` strictly newer than `b`? Release > prerelease at the same core
 * version (semver §11), so 0.0.7 > 0.0.7-beta.1 but 0.0.7-beta.1 is NOT >
 * 0.0.7. Prerelease-vs-prerelease falls back to a lexical compare, which is
 * good enough for the "should I nag?" decision.
 */
export function isNewer(a: string, b: string): boolean {
  const x = parse(a);
  const y = parse(b);
  if (x.major !== y.major) return x.major > y.major;
  if (x.minor !== y.minor) return x.minor > y.minor;
  if (x.patch !== y.patch) return x.patch > y.patch;
  if (!x.pre && y.pre) return true; // release beats prerelease
  if (x.pre && !y.pre) return false;
  if (x.pre && y.pre) return x.pre > y.pre;
  return false;
}

function formatNotice(current: string, latest: string): string {
  return [
    '',
    `Update available: ${current} → ${latest}`,
    `Run \`npm i -g ${PKG_NAME}\` to update.`,
    `(silence with ENNIO_NO_UPDATE_CHECK=1)`,
    '',
  ].join('\n');
}

/**
 * Returns an update notice string if a newer version is known from cache,
 * else null. Side effect: kicks off a detached background refresh when the
 * cache is stale, so the next run is current. Never throws, never blocks.
 */
export function getUpdateNotice(currentVersion: string): string | null {
  if (!shouldCheck()) return null;

  const cache = readCache();
  // Stamp "now" once; reused for the staleness check and the refresh marker.
  // Date.now() is fine here — this module is not part of any replayable
  // workflow, just a CLI side effect.
  const now = Date.now();

  if (!cache || now - cache.checkedAt > TTL_MS) {
    spawnRefresh(now);
  }

  if (cache && cache.latest && isNewer(cache.latest, currentVersion)) {
    return formatNotice(currentVersion, cache.latest);
  }
  return null;
}

/** Print the notice to stderr (keeps stdout clean for JSON/pipes). */
export function printUpdateNotice(currentVersion: string): void {
  const notice = getUpdateNotice(currentVersion);
  if (notice) console.error(notice);
}

/** Resolve the running CLI's version from the bundled package.json. */
export function currentVersion(): string {
  try {
    // After esbuild, __filename is dist/cli.js; package.json is one up.
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
