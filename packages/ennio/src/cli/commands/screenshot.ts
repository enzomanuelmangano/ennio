/**
 * `ennio screenshot [path]` — grab the booted simulator's screen.
 *
 * Wraps `xcrun simctl io <UDID> screenshot`. Default destination
 * `/tmp/ennio-shot.png` so a bare `ennio screenshot` always writes
 * somewhere predictable.
 */

import { execSync } from 'child_process';
import { dirname } from 'path';
import { mkdirSync } from 'fs';
import { getBootedSimulatorId } from '../maestro-runner';
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
    execSync(`xcrun simctl io ${udid} screenshot "${out}"`, { stdio: 'pipe' });
    console.log(out);
    return 0;
  } catch (e) {
    console.error(`Screenshot failed: ${(e as Error).message}`);
    return 1;
  }
}
