// Crash → one-click bug report. On an unexpected throw (NOT a normal test
// failure — those exit non-zero, they don't throw) print the error plus a
// pre-filled GitHub issue link. Blank issues are disabled on the repo, so the
// link targets the bug_report issue-form template and pre-fills fields by id
// (summary / verbose-output / ennio-version / xcode-node / simulator). Only a
// link is built — nothing is sent; the user reviews it in-browser first.

import { bold, dim, hyperlink, red } from './ui/ansi';
import { currentVersion } from './update-check';

const REPO = 'https://github.com/enzomanuelmangano/ennio';
const MAX_STACK_CHARS = 1200; // keep the encoded URL under browser/GitHub limits

export function buildCrashIssueUrl(err: unknown): string {
  const e = err instanceof Error ? err : new Error(String(err));
  const summary = (e.message || 'unknown error').split('\n')[0].slice(0, 140);
  const platform = process.env.ENNIO_PLATFORM === 'android' ? 'Android emulator' : 'iOS simulator';
  const stack = (e.stack || e.message || '').slice(0, MAX_STACK_CHARS);
  const params = new URLSearchParams({
    template: 'bug_report.yml',
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

/** Print the crash + a one-click pre-filled issue link. Idempotent. */
export function printCrashReport(err: unknown): void {
  if (reported) return;
  reported = true;
  const e = err instanceof Error ? err : new Error(String(err));
  const url = buildCrashIssueUrl(err);
  const out = process.stderr;
  out.write('\n' + red(bold('💥 ennio crashed')) + '\n');
  out.write((e.stack || e.message || String(err)) + '\n\n');
  out.write('This is probably a bug — a 1-click report genuinely helps fix it:\n');
  if (out.isTTY) out.write('  ' + hyperlink(url, '→ Open a pre-filled GitHub issue') + '\n');
  out.write('  ' + url + '\n\n');
  out.write(
    dim('Re-run with --verbose for detail. Silence updates with ENNIO_NO_UPDATE_CHECK=1.\n'),
  );
}
