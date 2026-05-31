/**
 * `ennio screenshot [path]` — grab the booted simulator's screen.
 *
 * Wraps `xcrun simctl io <UDID> screenshot`. Default destination
 * `/tmp/ennio-shot.png` so a bare `ennio screenshot` always writes
 * somewhere predictable.
 */

import { execFileSync } from 'child_process';
import { dirname } from 'path';
import { mkdirSync } from 'fs';
import { getTargetUdid as getBootedSimulatorId } from '../sim';
import type { Flags } from '../cli/args';

export function runScreenshotCommand(positional: string[], _flags: Flags): number {
  const udid = getBootedSimulatorId();
  if (!udid) {
    console.error('No booted iOS simulator found. Boot one or set ENNIO_UDID.');
    return 1;
  }
  const out = positional[0] || '/tmp/ennio-shot.png';
  try {
    mkdirSync(dirname(out), { recursive: true });
    // execFileSync (argv, no shell) so a UDID or path containing shell
    // metacharacters can't inject a command.
    execFileSync('xcrun', ['simctl', 'io', udid, 'screenshot', out], { stdio: 'pipe' });
    console.log(out);
    return 0;
  } catch (e) {
    console.error(`Screenshot failed: ${(e as Error).message}`);
    return 1;
  }
}
