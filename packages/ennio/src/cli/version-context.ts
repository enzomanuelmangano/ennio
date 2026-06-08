// When a GLOBAL ennio runs inside a project that has its own pinned ennio,
// the project usually expects the local one. Surface the mismatch once — a
// notice only; we don't auto-exec the local binary (predictable behavior wins).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { dim, yellow } from './ui/ansi';
import { currentVersion } from './update-check';

/** True when the running CLI lives outside the current project's tree. */
function isGlobalInstall(): boolean {
  return __dirname.includes('node_modules') && !__dirname.startsWith(process.cwd());
}

/** Version of the ennio installed in the current project, if any. */
function localPinnedVersion(): string | null {
  const pkg = join(process.cwd(), 'node_modules', '@reactiive', 'ennio', 'package.json');
  try {
    if (!existsSync(pkg)) return null;
    return (JSON.parse(readFileSync(pkg, 'utf-8')) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

let warned = false;

export function warnVersionDrift(): void {
  if (warned || process.env.ENNIO_NO_UPDATE_CHECK || !process.stdout.isTTY) return;
  if (!isGlobalInstall()) return;
  const local = localPinnedVersion();
  const global = currentVersion();
  if (local && local !== global) {
    warned = true;
    process.stderr.write(
      yellow(`  ⚠ global ennio ${global}, but this project pins ${local}`) +
        dim(' — `npx ennio` runs the local one\n'),
    );
  }
}
