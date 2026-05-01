#!/usr/bin/env bun
/**
 * Tasto CLI
 *
 * Runs E2E tests by connecting to the app.
 * Supports two connection modes:
 * 1. WebSocket (preferred) - connects to app's Tasto server on port 9876
 * 2. CDP (fallback) - connects to Metro's debugger on port 8081
 *
 * Usage:
 *   npx tasto e2e/test.ts
 *   npx tasto e2e/           # Runs all *.test.ts files in directory
 */

import { existsSync, statSync } from 'fs';
import { resolve, basename, join } from 'path';
import { glob } from 'glob';
import { TastoClient } from './client';
import { runTests } from './runner';

const DEFAULT_WS_PORT = 9876;
const METRO_PORT = 8081;

interface TestFileResult {
  file: string;
  passed: number;
  failed: number;
}

type ConnectionMode = 'websocket' | 'cdp';

/**
 * Try to connect via WebSocket to Tasto server
 */
async function tryWebSocketConnection(port: number): Promise<TastoClient | null> {
  const client = new TastoClient(port);
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

/**
 * Run a test file
 */
async function runTestFile(
  client: TastoClient,
  filePath: string
): Promise<TestFileResult> {
  const fileName = basename(filePath);
  console.log(`▸ ${fileName}`);

  try {
    const results = await runTests(client, filePath);

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
    };
  } catch (err) {
    console.error(`  Error: ${err}\n`);
    return {
      file: fileName,
      passed: 0,
      failed: 1,
    };
  }
}

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const portArg = process.argv.find((a) => a.startsWith('--port='));
  const port = portArg ? parseInt(portArg.split('=')[1], 10) : DEFAULT_WS_PORT;

  if (args.length === 0) {
    console.log('Usage: tasto <test-file.ts> [--port=9876]');
    console.log('       tasto e2e/           # Runs all *.test.ts files');
    process.exit(0);
  }

  // Find test files
  const files: string[] = [];
  for (let pattern of args) {
    const resolved = resolve(pattern);

    if (existsSync(resolved) && statSync(resolved).isDirectory()) {
      pattern = join(pattern, '**/*.test.ts');
    }

    const matches = await glob(pattern);
    const testFiles = matches
      .filter((f) => f.endsWith('.test.ts'))
      .map((f) => resolve(f));
    files.push(...testFiles);
  }

  if (files.length === 0) {
    console.error('No test files found');
    process.exit(1);
  }

  console.log('\n🧪 Tasto\n');

  // Try to connect via WebSocket first
  let client = await tryWebSocketConnection(port);
  let mode: ConnectionMode = 'websocket';

  if (!client) {
    console.log(`(WebSocket server not available, using CDP fallback)\n`);
    // Fall back to CDP mode - import dynamically to avoid loading if not needed
    const { runTestsViaCDP } = await import('./cdp-runner');

    let totalPassed = 0;
    let totalFailed = 0;

    for (const file of files) {
      const fileName = basename(file);
      console.log(`▸ ${fileName}`);

      try {
        const results = await runTestsViaCDP(file);

        for (const test of results.tests) {
          if (test.passed) {
            console.log(`  [PASS] ${test.name}`);
          } else {
            console.log(`  [FAIL] ${test.name}: ${test.error || 'unknown error'}`);
          }
        }

        console.log(`  ${results.passed} passed, ${results.failed} failed\n`);
        totalPassed += results.passed;
        totalFailed += results.failed;
      } catch (err) {
        console.error(`  Error: ${err}\n`);
        totalFailed++;
      }
    }

    console.log('─'.repeat(40));
    console.log(`Total: ${totalPassed} passed, ${totalFailed} failed`);
    process.exit(totalFailed > 0 ? 1 : 0);
    return;
  }

  console.log(`(Connected via WebSocket on port ${port})\n`);

  let totalPassed = 0;
  let totalFailed = 0;

  try {
    for (const file of files) {
      const result = await runTestFile(client, file);
      totalPassed += result.passed;
      totalFailed += result.failed;
    }
  } finally {
    client.disconnect();
  }

  console.log('─'.repeat(40));
  console.log(`Total: ${totalPassed} passed, ${totalFailed} failed`);
  process.exit(totalFailed > 0 ? 1 : 0);
}

main();
