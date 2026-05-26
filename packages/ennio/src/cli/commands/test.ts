/**
 * `ennio test <flow.yaml | dir | glob>` — run one or more Maestro YAML
 * flows.
 *
 * v0.1 socket-first runner. Assumes the in-app dylib (libennio) is
 * already loaded into a running iOS Sim app — i.e. the app was launched
 * with `SIMCTL_CHILD_DYLD_INSERT_LIBRARIES=<dylib>` (zero-install path)
 * or the app links EnnioCore via the Pod plugin.
 */

import { existsSync, statSync } from 'fs';
import { basename, join, resolve } from 'path';

import { glob } from 'glob';

import type { Flags } from '../cli/args';
import { parseMaestroFile } from '../maestro-parser';
import { runFlow } from '../runner';

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
      const yamlMatches = await glob(join(pattern, '**/*.yaml'));
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
  const verbose = flags.verbose ?? false;
  const dylibPath = process.env.ENNIO_DYLIB_PATH || null;

  if (positional.length === 0) {
    console.error('Usage: ennio test <flow.yaml | dir | glob> [options]');
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

  console.log('\n🧪 Ennio\n');

  let totalPass = 0;
  let totalFail = 0;
  for (const file of files) {
    const flow = parseMaestroFile(file);
    console.log(`▸ ${basename(file)}`);
    try {
      const result = await runFlow(flow, { dylibPath: dylibPath ?? undefined, verbose });
      if (result.passed) {
        console.log(`  [PASS] ${result.stepsRun} steps\n`);
        totalPass++;
      } else {
        totalFail++;
        const f = result.failure!;
        console.log(
          `  [FAIL] step ${f.step} (${f.command}): ${f.reason}\n` +
            `         ran ${result.stepsPassed}/${result.stepsRun} steps before failure\n`,
        );
      }
    } catch (err) {
      totalFail++;
      console.log(`  [ERROR] ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  console.log('─'.repeat(40));
  console.log(`Total: ${totalPass} passed, ${totalFail} failed`);
  return totalFail > 0 ? 1 : 0;
}
