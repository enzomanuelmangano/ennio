/**
 * `ennio version` — print package version.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

export function runVersionCommand(): number {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf-8'));
    console.log(`ennio ${pkg.version}`);
  } catch {
    console.log('ennio (version unknown)');
  }
  return 0;
}
