/**
 * `ennio version` — print package version.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';

export function runVersionCommand(): number {
  try {
    // After esbuild bundles to CJS, __filename is the absolute path to
    // dist/cli.js. The pkg's package.json is one directory up.
    const here = dirname(__filename);
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf-8'));
    console.log(`ennio ${pkg.version}`);
  } catch {
    console.log('ennio (version unknown)');
  }
  return 0;
}
