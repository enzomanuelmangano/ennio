#!/usr/bin/env bun
/**
 * Ennio CLI
 *
 * Runs Maestro YAML flows against a React Native app on the iOS simulator.
 *
 * Architecture:
 *   - one channel: WebSocket to the in-app @ennio/core module on :9876.
 *     Reads (assertVisible, layout, alerts) traverse the Fabric shadow
 *     tree. Writes (tap, typeText, scroll, alert button tap) run inside
 *     the user app via UIKit / accessibilityActivate / sendActions —
 *     no XCTest helper, no HID injection, no xcodebuild cold-start.
 *
 * Usage:
 *   ennio e2e/flow.yaml                # run a single flow
 *   ennio e2e/                         # every *.yaml in directory
 */

import { existsSync, statSync } from 'fs';
import { resolve, basename, join } from 'path';
import { glob } from 'glob';
import { EnnioClient } from './client';
import { runMaestroTests } from './maestro-runner';
import { NitroWriter, type Writer } from './writer';
import { NitroReader, type Reader } from './reader';

const DEFAULT_WS_PORT = 9876;

interface TestFileResult {
  file: string;
  passed: number;
  failed: number;
}

async function tryWebSocketConnection(port: number): Promise<EnnioClient | null> {
  const client = new EnnioClient(port);
  try {
    await Promise.race([
      client.connect(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
    ]);
    return client;
  } catch {
    return null;
  }
}

function isMaestroFile(filePath: string): boolean {
  return filePath.endsWith('.yaml') || filePath.endsWith('.yml');
}

interface TestFileResultWithClient extends TestFileResult {
  client?: EnnioClient;
}

async function runTestFile(
  client: EnnioClient,
  writer: Writer,
  reader: Reader,
  filePath: string,
  options: { verbose?: boolean; trace?: boolean; port?: number } = {}
): Promise<TestFileResultWithClient> {
  const fileName = basename(filePath);
  console.log(`▸ ${fileName}`);
  try {
    const results = await runMaestroTests(client, writer, reader, filePath, {
      verbose: options.verbose,
      trace: options.trace,
      port: options.port,
    });
    for (const test of results.tests) {
      if (test.passed) {
        console.log(`  [PASS] ${test.name}`);
      } else {
        console.log(`  [FAIL] ${test.name}: ${test.error || 'unknown error'}`);
      }
    }
    console.log(`  ${results.passed} passed, ${results.failed} failed\n`);
    return {
      file: fileName,
      passed: results.passed,
      failed: results.failed,
      client: results.client,
    };
  } catch (err) {
    console.error(`  Error: ${err}\n`);
    return { file: fileName, passed: 0, failed: 1 };
  }
}

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const portArg = process.argv.find((a) => a.startsWith('--port='));
  const port = portArg ? parseInt(portArg.split('=')[1], 10) : DEFAULT_WS_PORT;
  const verbose = process.argv.includes('--verbose') || process.argv.includes('-v');
  const trace = process.argv.includes('--trace');

  if (args.length === 0) {
    console.log('Usage: ennio <flow.yaml> [options]');
    console.log('       ennio e2e/           # runs every *.yaml under the directory');
    console.log('\nOptions:');
    console.log('  --port=9876    WebSocket port (default: 9876)');
    console.log('  --verbose, -v  show detailed command execution');
    console.log('  --trace        emit a trace marker between commands');
    process.exit(0);
  }

  const files: string[] = [];
  for (const pattern of args) {
    const resolved = resolve(pattern);
    if (existsSync(resolved) && statSync(resolved).isDirectory()) {
      const yamlMatches = await glob(join(pattern, '**/*.yaml'));
      const yamlFiles = yamlMatches
        .filter((f) => isMaestroFile(f) && !f.includes('/subflows/'))
        .map((f) => resolve(f));
      files.push(...yamlFiles);
    } else {
      const matches = await glob(pattern);
      files.push(
        ...matches
          .filter((f) => isMaestroFile(f) && !f.includes('/subflows/'))
          .map((f) => resolve(f))
      );
    }
  }

  if (files.length === 0) {
    console.error('No Maestro YAML files found');
    process.exit(1);
  }

  console.log('\n🧪 Ennio\n');

  const client = await tryWebSocketConnection(port);
  if (!client) {
    console.error(
      `Could not connect to the in-app Ennio server on port ${port}.\n` +
        `Make sure the user app is running on the iOS simulator before invoking ennio.`
    );
    process.exit(1);
  }
  console.log(`(Connected via WebSocket on port ${port})\n`);

  let writer: Writer = new NitroWriter(client);
  let reader: Reader = new NitroReader(client);

  let totalPassed = 0;
  let totalFailed = 0;
  let currentClient = client;

  try {
    for (const file of files) {
      const result = await runTestFile(currentClient, writer, reader, file, { verbose, trace, port });
      totalPassed += result.passed;
      totalFailed += result.failed;
      if (result.client) {
        currentClient = result.client;
        writer = new NitroWriter(currentClient);
        reader = new NitroReader(currentClient);
      }
    }
  } finally {
    currentClient.disconnect();
  }

  console.log('─'.repeat(40));
  console.log(`Total: ${totalPassed} passed, ${totalFailed} failed`);
  process.exit(totalFailed > 0 ? 1 : 0);
}

main();
