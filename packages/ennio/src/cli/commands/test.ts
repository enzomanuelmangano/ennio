/**
 * `ennio test <flow.yaml | dir | glob>` — run one or more Maestro YAML
 * flows.
 *
 * Thin wrapper around EnnioRunner. All orchestration, lifecycle, and
 * reporting lives in core/. This file only handles arg expansion and
 * the process exit code.
 */

import { existsSync, statSync } from 'fs';
import { basename, join, resolve } from 'path';

import { glob } from 'glob';

import type { Flags } from '../cli/args';
import { EnnioRunner } from '../core';
import { currentVersion, printUpdateNotice } from '../update-check';

function isMaestroFile(filePath: string): boolean {
  return filePath.endsWith('.yaml') || filePath.endsWith('.yml');
}

function isSubflowFile(filePath: string): boolean {
  return basename(filePath).startsWith('_');
}

async function expandFiles(patterns: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const pattern of patterns) {
    const resolved = resolve(pattern);
    if (existsSync(resolved) && statSync(resolved).isDirectory()) {
      const yamlMatches = await glob(join(pattern, '**/*.{yaml,yml}'));
      files.push(
        ...yamlMatches
          .filter((f) => isMaestroFile(f) && !f.includes('/subflows/') && !isSubflowFile(f))
          .map((f) => resolve(f)),
      );
    } else {
      const matches = await glob(pattern);
      files.push(
        ...matches
          .filter((f) => isMaestroFile(f) && !f.includes('/subflows/'))
          .map((f) => resolve(f)),
      );
    }
  }
  return files;
}

export async function runTestCommand(positional: string[], flags: Flags): Promise<number> {
  if (positional.length === 0) {
    console.error('Usage: ennio test <flow.yaml | dir | glob> [options]');
    console.error('');
    console.error('Options:');
    console.error('  --verbose             Per-step inline output');
    console.error('  --lenient             Skip unknown commands with a warning');
    console.error('  --reporter=<kind>     pretty (default) | json');
    console.error('  --safe-mode           Disable all in-app hooks (swizzles/observers).');
    console.error('                        Slower settle, but survives injection conflicts.');
    console.error('');
    console.error('Auto-detection:');
    console.error('  - booted iOS simulator (or auto-boots one)');
    console.error('  - libennio.dylib from /tmp/ennio-build/ or <pkg>/prebuilt/');
    console.error('Overrides: ENNIO_UDID, ENNIO_DYLIB_PATH');
    return 1;
  }

  const files = await expandFiles(positional);
  if (files.length === 0) {
    console.error('No Maestro YAML files found');
    return 1;
  }

  const reporterKind = (flags.reporter as 'pretty' | 'json' | undefined) ?? 'pretty';
  const runner = new EnnioRunner({
    udid: process.env.ENNIO_UDID,
    dylibPath: process.env.ENNIO_DYLIB_PATH || undefined,
    reporterKind,
    verbose: flags.verbose ?? false,
    lenient: flags.lenient ?? false,
    safeMode: flags.safeMode ?? false,
  });

  try {
    const result = await runner.run(files);
    // Nudge about updates after the run, but never on the json path — that
    // reporter owns stdout and the notice goes to stderr regardless.
    if (reporterKind !== 'json') printUpdateNotice(currentVersion());
    return result.passed ? 0 : 1;
  } catch (err) {
    console.error(`✗ ERROR  ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
