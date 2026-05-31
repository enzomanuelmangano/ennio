/**
 * `ennio version` — print package version.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';

import { printUpdateNotice } from '../update-check';

export function runVersionCommand(): number {
  let version: string | null = null;
  try {
    // After esbuild bundles to CJS, __filename is the absolute path to
    // dist/cli.js. The pkg's package.json is one directory up.
    const here = dirname(__filename);
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf-8'));
    version = pkg.version;
    console.log(`ennio ${version}`);
  } catch {
    console.log('ennio (version unknown)');
  }
  // Surface "update available" right where a user looks for their version.
  if (version) printUpdateNotice(version);
  return 0;
}
