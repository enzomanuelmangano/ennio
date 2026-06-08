/**
 * Crash → one-click bug report.
 *
 * When ennio throws an UNEXPECTED error (not a normal test failure — those
 * return a non-zero exit code, they don't throw), we print the error plus a
 * pre-filled GitHub issue link so reporting takes one click. The repo has
 * `blank_issues_enabled: false`, so the link must target the issue-form
 * template and pre-fill its fields by `id` (summary / verbose-output /
 * ennio-version / xcode-node / simulator) via the query string.
 *
 * Privacy: this only builds a LINK. Nothing is sent anywhere — the user
 * reviews the pre-filled report in their browser before submitting. The
 * payload is just the stack trace + tool/OS versions, no flow content.
 */

import { currentVersion } from './update-check';

const REPO = 'https://github.com/enzomanuelmangano/ennio';
const TEMPLATE = 'bug_report.yml';
// Keep the encoded URL comfortably under browser/GitHub limits.
const MAX_STACK_CHARS = 1200;

/** OSC-8 hyperlink when stderr is a TTY; plain text otherwise. */
function link(url: string, text: string): string {
  if (!process.stderr.isTTY) return text;
  return `]8;;${url}${text}]8;;`;
}

function bold(s: string): string {
  return process.stderr.isTTY ? `[1m${s}[0m` : s;
}
function red(s: string): string {
  return process.stderr.isTTY ? `[31m${s}[0m` : s;
}
function dim(s: string): string {
  return process.stderr.isTTY ? `[2m${s}[0m` : s;
}

/** Build a pre-filled GitHub issue URL for a crash. */
export function buildCrashIssueUrl(err: unknown): string {
  const e = err instanceof Error ? err : new Error(String(err));
  const summary = (e.message || 'unknown error').split('\n')[0].slice(0, 140);
  const platform =
    process.env.ENNIO_PLATFORM === 'android' ? 'Android emulator' : 'iOS simulator';
  const stack = (e.stack || e.message || '').slice(0, MAX_STACK_CHARS);
  const params = new URLSearchParams({
    template: TEMPLATE,
    labels: 'crash',
    title: `[crash] ${summary}`,
    summary: `ennio crashed while running a command:\n\n${summary}`,
    'verbose-output': `Crash stack trace:\n\n\`\`\`\n${stack}\n\`\`\``,
    'ennio-version': currentVersion(),
    'xcode-node': `Node ${process.version} · ${process.platform} ${process.arch}`,
    simulator: platform,
  });
  return `${REPO}/issues/new?${params.toString()}`;
}

let reported = false;

/**
 * Print the crash + a one-click pre-filled issue link. Idempotent — safe to
 * call from both the top-level rejection handler and uncaughtException.
 */
export function printCrashReport(err: unknown): void {
  if (reported) return;
  reported = true;
  const e = err instanceof Error ? err : new Error(String(err));
  const url = buildCrashIssueUrl(err);
  const out = process.stderr;
  out.write('\n' + red(bold('💥 ennio crashed')) + '\n');
  out.write((e.stack || e.message || String(err)) + '\n\n');
  out.write('This is probably a bug — and a 1-click report genuinely helps fix it:\n');
  if (process.stderr.isTTY) {
    out.write('  ' + link(url, '→ Open a pre-filled GitHub issue') + '\n');
    out.write(dim('  (or copy this URL)\n'));
  }
  out.write('  ' + url + '\n\n');
  out.write(
    dim('Re-run with --verbose for more detail. Silence the update check with ENNIO_NO_UPDATE_CHECK=1.\n'),
  );
}
