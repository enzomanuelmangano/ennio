/**
 * `ennio test <flow.yaml | dir | glob>` — run one or more Maestro YAML flows.
 *
 * Bare invocation (`ennio <flow.yaml>`) routes here too via the dispatcher.
 */

import { existsSync, statSync } from 'fs';
import { resolve, basename, join } from 'path';
import { glob } from 'glob';
import { runMaestroTests } from '../maestro-runner';
import { parseMaestroFile } from '../maestro-parser';
import { NitroWriter, type Writer } from '../writer';
import { NitroReader, type Reader } from '../reader';
import type { EnnioClient } from '../client';
import { connectOrLaunch, DEFAULT_WS_PORT } from '../cli/bootstrap';
import type { Flags } from '../cli/args';

function isMaestroFile(filePath: string): boolean {
  return filePath.endsWith('.yaml') || filePath.endsWith('.yml');
}

async function expandFiles(patterns: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const pattern of patterns) {
    const resolved = resolve(pattern);
    if (existsSync(resolved) && statSync(resolved).isDirectory()) {
      const yamlMatches = await glob(join(pattern, '**/*.yaml'));
      files.push(
        ...yamlMatches
          .filter((f) => isMaestroFile(f) && !f.includes('/subflows/'))
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

interface TestFileResultWithClient {
  file: string;
  passed: number;
  failed: number;
  client?: EnnioClient;
}

async function runTestFile(
  client: EnnioClient,
  writer: Writer,
  reader: Reader,
  filePath: string,
  options: { verbose?: boolean; trace?: boolean; port?: number },
): Promise<TestFileResultWithClient> {
  const fileName = basename(filePath);
  console.log(`▸ ${fileName}`);
  // Don't catch here. `runMaestroTests` returns assertion failures as
  // `results.tests[i].passed === false`; a thrown error means the runner
  // itself crashed (bad yaml, WS dead, etc.) and is not a flow failure.
  // Surfacing it as one would mask infrastructure breakage.
  const results = await runMaestroTests(client, writer, reader, filePath, options);
  for (const test of results.tests) {
    if (test.passed) console.log(`  [PASS] ${test.name}`);
    else console.log(`  [FAIL] ${test.name}: ${test.error || 'unknown error'}`);
  }
  console.log(`  ${results.passed} passed, ${results.failed} failed\n`);
  return { file: fileName, passed: results.passed, failed: results.failed, client: results.client };
}

export async function runTestCommand(positional: string[], flags: Flags): Promise<number> {
  const port = flags.port ?? DEFAULT_WS_PORT;
  const verbose = flags.verbose ?? false;
  const trace = flags.trace ?? false;

  if (positional.length === 0) {
    console.error('Usage: ennio test <flow.yaml | dir | glob> [options]');
    return 1;
  }

  const files = await expandFiles(positional);
  if (files.length === 0) {
    console.error('No Maestro YAML files found');
    return 1;
  }

  console.log('\n🧪 Ennio\n');

  let appId: string | undefined;
  try {
    appId = parseMaestroFile(files[0]).appId;
  } catch {
    /* tolerate; bootstrap will surface */
  }

  const result = await connectOrLaunch({ port, appId });
  if (!result.ok) {
    console.error(result.reason);
    return 1;
  }
  console.log(`(Connected via WebSocket on port ${port})\n`);

  let writer: Writer = new NitroWriter(result.client);
  let reader: Reader = new NitroReader(result.client);
  let currentClient = result.client;

  let totalPassed = 0;
  let totalFailed = 0;
  try {
    for (const file of files) {
      const r = await runTestFile(currentClient, writer, reader, file, { verbose, trace, port });
      totalPassed += r.passed;
      totalFailed += r.failed;
      if (r.client) {
        currentClient = r.client;
        writer = new NitroWriter(currentClient);
        reader = new NitroReader(currentClient);
      }
    }
  } finally {
    currentClient.disconnect();
  }

  console.log('─'.repeat(40));
  console.log(`Total: ${totalPassed} passed, ${totalFailed} failed`);
  return totalFailed > 0 ? 1 : 0;
}
