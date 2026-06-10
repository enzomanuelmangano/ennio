// Crash post-mortem for the injected app.
//
// When the control socket dies mid-flow the proximate error is
// "ennio socket not connected" — useless to the user when the real
// event is the app SIGSEGV'ing with libennio.dylib loaded (see
// issue #44). This module turns the symptom into a diagnosis:
//
//   1. Is the app process still alive on the simulator?
//   2. If not, did macOS write a fresh .ips crash report for it?
//   3. If yes, extract exception type + faulting frames and whether
//      libennio was loaded, and hand the caller a human-readable
//      summary plus the report path to attach to a bug report.
//
// Simulator apps are plain macOS processes, so their crash reports
// land in ~/Library/Logs/DiagnosticReports like any host process.
// .ips format (bug_type 309): line 1 is a JSON header
// ({app_name, timestamp, ...}); the remainder is one JSON object
// with procName, bundleInfo, exception, faultingThread, threads,
// usedImages.

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface CrashReport {
  path: string;
  procName: string;
  bundleId?: string;
  /** e.g. "EXC_BAD_ACCESS (SIGSEGV)" */
  exception: string;
  /** Top frames of the faulting thread, symbolized where possible. */
  faultingFrames: string[];
  /** Whether libennio.dylib was loaded in the crashed process. */
  ennioLoaded: boolean;
  /** The crash is React Native's fatal-JS-exception abort
   *  (RCTExceptionsManager reportFatal) — an app bug, not injection. */
  jsFatal: boolean;
  crashedAtMs: number;
}

interface IpsFrame {
  imageIndex?: number;
  symbol?: string;
  imageOffset?: number;
}

interface IpsBody {
  procName?: string;
  bundleInfo?: { CFBundleIdentifier?: string };
  exception?: { type?: string; signal?: string; subtype?: string };
  faultingThread?: number;
  threads?: { frames?: IpsFrame[] }[];
  usedImages?: { name?: string; path?: string }[];
  lastExceptionBacktrace?: IpsFrame[];
}

const REPORTS_DIR = join(homedir(), 'Library/Logs/DiagnosticReports');
const ISSUES_URL = 'https://github.com/enzomanuelmangano/ennio/issues';
// Crash reporting is async — the .ips can land a couple of seconds
// before our caller's "since" anchor (launch timestamps are taken
// after simctl launch returns).
const MTIME_SLACK_MS = 10_000;

function parseIps(path: string): { headerAppName?: string; body: IpsBody } | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
  const nl = raw.indexOf('\n');
  if (nl < 0) return null;
  try {
    const header = JSON.parse(raw.slice(0, nl)) as { app_name?: string };
    const body = JSON.parse(raw.slice(nl + 1)) as IpsBody;
    return { headerAppName: header.app_name, body };
  } catch {
    return null;
  }
}

function framesOf(body: IpsBody, max = 6): string[] {
  const thread = body.threads?.[body.faultingThread ?? 0];
  const images = body.usedImages ?? [];
  const out: string[] = [];
  for (const f of thread?.frames ?? []) {
    const image = f.imageIndex != null ? (images[f.imageIndex]?.name ?? '?') : '?';
    const sym = f.symbol ?? `+0x${(f.imageOffset ?? 0).toString(16)}`;
    out.push(`${image}: ${sym}`);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Find the newest crash report for `bundleId` written after `sinceMs`.
 * Matches on bundleInfo.CFBundleIdentifier; falls back to procName
 * containing the last bundle-id segment (Expo debug builds sometimes
 * omit bundleInfo). Returns null when no matching report exists.
 */
export function findCrashReport(
  bundleId: string,
  sinceMs: number,
  reportsDir: string = REPORTS_DIR,
): CrashReport | null {
  let entries: string[];
  try {
    entries = readdirSync(reportsDir);
  } catch {
    return null;
  }
  const candidates = entries
    .filter((f) => f.endsWith('.ips'))
    .map((f) => {
      const p = join(reportsDir, f);
      try {
        return { p, mtime: statSync(p).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((e): e is { p: string; mtime: number } => !!e && e.mtime >= sinceMs - MTIME_SLACK_MS)
    .sort((a, b) => b.mtime - a.mtime)
    // Parse at most the 10 newest — a busy dev box accumulates reports
    // from unrelated processes.
    .slice(0, 10);

  const nameHint = bundleId.split('.').pop()?.toLowerCase() ?? '';
  for (const c of candidates) {
    const parsed = parseIps(c.p);
    if (!parsed) continue;
    const { body } = parsed;
    const reportBundle = body.bundleInfo?.CFBundleIdentifier;
    const proc = body.procName ?? parsed.headerAppName ?? '';
    const matches =
      reportBundle === bundleId || (!reportBundle && proc.toLowerCase().includes(nameHint));
    if (!matches) continue;
    const exc = body.exception;
    const exception = exc
      ? `${exc.type ?? 'unknown'}${exc.signal ? ` (${exc.signal})` : ''}${exc.subtype ? ` — ${exc.subtype}` : ''}`
      : 'unknown exception';
    const ennioLoaded = (body.usedImages ?? []).some(
      (img) => img.name === 'libennio.dylib' || (img.path ?? '').includes('libennio'),
    );
    // RN routes fatal JS exceptions through RCTExceptionsManager before
    // aborting — its presence in the exception backtrace marks the crash
    // as the app's own JavaScript, not an injection problem.
    const jsFatal = (body.lastExceptionBacktrace ?? []).some((f) =>
      /RCTExceptionsManager|RCTFatal/.test(f.symbol ?? ''),
    );
    return {
      path: c.p,
      procName: proc,
      bundleId: reportBundle,
      exception,
      faultingFrames: framesOf(body),
      ennioLoaded,
      jsFatal,
      crashedAtMs: c.mtime,
    };
  }
  return null;
}

/**
 * Whether the app is currently running on the simulator. launchctl
 * lists running app processes under "UIKitApplication:<bundleId>".
 */
export function isAppRunning(udid: string, bundleId: string): boolean {
  try {
    const out = execFileSync('xcrun', ['simctl', 'spawn', udid, 'launchctl', 'list'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return out.includes(`UIKitApplication:${bundleId}`);
  } catch {
    // launchctl unavailable — can't tell; assume alive so we don't
    // fabricate a crash diagnosis.
    return true;
  }
}

/**
 * Build the multi-line diagnosis appended to socket errors. Empty
 * string when the app is alive and no crash report is found — the
 * socket failure is then genuinely a socket/dylib problem.
 */
export function diagnoseSocketFailure(udid: string, bundleId: string, sinceMs: number): string {
  const alive = isAppRunning(udid, bundleId);
  const report = findCrashReport(bundleId, sinceMs);
  if (alive && !report) return '';

  const lines: string[] = [];
  if (report) {
    const secs = Math.max(0, Math.round((report.crashedAtMs - sinceMs) / 1000));
    lines.push(`the app crashed (${report.exception}) ~${secs}s after launch.`);
    if (report.faultingFrames.length) {
      lines.push('faulting thread:');
      for (const f of report.faultingFrames) lines.push(`    ${f}`);
    }
    if (report.jsFatal) {
      lines.push(
        "the app's JavaScript threw a fatal exception (RCTFatalException) — " +
          'an app bug, not an ennio issue. Check the JS bundle the app is loading.',
      );
      lines.push(`crash report: ${report.path}`);
    } else {
      if (report.ennioLoaded) {
        lines.push(
          'libennio.dylib was loaded — likely an injection conflict. ' +
            'Retry with --safe-mode to disable in-app hooks.',
        );
      }
      lines.push(`crash report: ${report.path}`);
      lines.push(
        'this is likely an ennio bug — please open an issue attaching the ' +
          `report: ${ISSUES_URL}`,
      );
    }
  } else {
    lines.push(
      'the app process is no longer running (no crash report found yet — ' +
        'check ~/Library/Logs/DiagnosticReports in a few seconds, then ' +
        `open an issue: ${ISSUES_URL}).`,
    );
  }
  return lines.join('\n');
}

/**
 * Throttled liveness probe for EnnioSocketClient.aliveProbe. Shells out
 * to launchctl at most every 1.5s (the probe runs inside 150ms retry
 * loops); between checks it returns the cached verdict. A dead process
 * short-circuits every socket retry ladder — one crash then costs
 * seconds, not the 3-11 minutes of reconnect grinding measured on a
 * crash-on-boot app.
 */
export function throttledAliveProbe(udid: string, bundleId: string): () => boolean {
  let checkedAt = 0;
  let alive = true;
  return () => {
    const now = Date.now();
    if (now - checkedAt > 1_500) {
      checkedAt = now;
      alive = isAppRunning(udid, bundleId);
    }
    return alive;
  };
}
