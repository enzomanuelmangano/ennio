#!/usr/bin/env bun
/**
 * Ennio CLI
 *
 * Runs E2E tests by connecting to the app.
 * Supports two connection modes:
 * 1. WebSocket (preferred) - connects to app's Ennio server on port 9876
 * 2. CDP (fallback) - connects to Metro's debugger on port 8081
 *
 * Supports test file formats:
 * - TypeScript (.test.ts) - Ennio native tests
 * - Maestro YAML (.yaml) - Maestro tests executed via Ennio internals
 *
 * Usage:
 *   npx ennio e2e/test.ts        # Run TypeScript test
 *   npx ennio e2e/flow.yaml      # Run Maestro YAML test
 *   npx ennio e2e/               # Runs all *.test.ts and *.yaml files
 */

import { existsSync, statSync } from 'fs';
import { resolve, basename, join } from 'path';
import { glob } from 'glob';
import { EnnioClient } from './client';
import { runTests } from './runner';
import { runMaestroTests } from './maestro-runner';

const DEFAULT_WS_PORT = 9876;
const METRO_PORT = 8081;

interface TestFileResult {
  file: string;
  passed: number;
  failed: number;
}


/**
 * Try to connect via WebSocket to Ennio server
 */
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

/**
 * Check if file is a Maestro YAML file
 */
function isMaestroFile(filePath: string): boolean {
  return filePath.endsWith('.yaml') || filePath.endsWith('.yml');
}

/**
 * Check if file is a TypeScript test file
 */
function isTestTsFile(filePath: string): boolean {
  return filePath.endsWith('.test.ts');
}

interface TestFileResultWithClient extends TestFileResult {
  client?: EnnioClient;  // Potentially updated client from launchApp/clearState
}

/**
 * Run a test file (TypeScript or Maestro YAML)
 */
async function runTestFile(
  client: EnnioClient,
  filePath: string,
  options: { verbose?: boolean; trace?: boolean; port?: number } = {}
): Promise<TestFileResultWithClient> {
  const fileName = basename(filePath);
  const isMaestro = isMaestroFile(filePath);

  console.log(`▸ ${fileName}${isMaestro ? ' (maestro)' : ''}`);

  try {
    const results = isMaestro
      ? await runMaestroTests(client, filePath, { verbose: options.verbose, trace: options.trace, port: options.port })
      : await runTests(client, filePath);

    for (const test of results.tests) {
      if (test.passed) {
        console.log(`  [PASS] ${test.name}`);
      } else {
        console.log(`  [FAIL] ${test.name}: ${test.error || 'unknown error'}`);
      }
    }

    console.log(`  ${results.passed} passed, ${results.failed} failed\n`);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resultsWithClient = results as any;
    return {
      file: fileName,
      passed: results.passed,
      failed: results.failed,
      client: 'client' in results ? resultsWithClient.client : undefined,
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
  const verbose = process.argv.includes('--verbose') || process.argv.includes('-v');
  const trace = process.argv.includes('--trace');

  if (args.length === 0) {
    console.log('Usage: ennio <test-file.ts|flow.yaml> [options]');
    console.log('       ennio e2e/           # Runs all *.test.ts and *.yaml files');
    console.log('\nOptions:');
    console.log('  --port=9876    WebSocket port (default: 9876)');
    console.log('  --verbose, -v  Show detailed command execution');
    process.exit(0);
  }

  // Find test files (both .test.ts and .yaml)
  const files: string[] = [];
  for (let pattern of args) {
    const resolved = resolve(pattern);

    if (existsSync(resolved) && statSync(resolved).isDirectory()) {
      // Get both TypeScript tests and Maestro YAML files
      const tsPattern = join(pattern, '**/*.test.ts');
      const yamlPattern = join(pattern, '**/*.yaml');

      const tsMatches = await glob(tsPattern);
      const yamlMatches = await glob(yamlPattern);

      // Filter out subflows (files in subflows/ directory)
      const tsFiles = tsMatches
        .filter((f) => f.endsWith('.test.ts'))
        .map((f) => resolve(f));
      const yamlFiles = yamlMatches
        .filter((f) => f.endsWith('.yaml') && !f.includes('/subflows/'))
        .map((f) => resolve(f));

      files.push(...tsFiles, ...yamlFiles);
    } else {
      // Single file or glob pattern
      const matches = await glob(pattern);
      const testFiles = matches
        .filter((f) => f.endsWith('.test.ts') || (f.endsWith('.yaml') && !f.includes('/subflows/')))
        .map((f) => resolve(f));
      files.push(...testFiles);
    }
  }

  if (files.length === 0) {
    console.error('No test files found');
    process.exit(1);
  }

  console.log('\n🧪 Ennio\n');

  // Try to connect via WebSocket first
  const client = await tryWebSocketConnection(port);

  if (!client) {
    console.log(`(WebSocket server not available, using CDP fallback)\n`);

    // Check if there are YAML files - they require WebSocket mode
    const yamlFiles = files.filter(isMaestroFile);
    const tsFiles = files.filter(isTestTsFile);

    if (yamlFiles.length > 0) {
      console.log(`⚠️  Skipping ${yamlFiles.length} Maestro YAML file(s) - requires WebSocket mode`);
      for (const f of yamlFiles) {
        console.log(`   - ${basename(f)}`);
      }
      console.log('');
    }

    if (tsFiles.length === 0) {
      console.error('No TypeScript test files to run in CDP mode');
      process.exit(1);
    }

    // Fall back to CDP mode - import dynamically to avoid loading if not needed
    const { runTestsViaCDP } = await import('./cdp-runner');

    let totalPassed = 0;
    let totalFailed = 0;

    for (const file of tsFiles) {
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
  }

  console.log(`(Connected via WebSocket on port ${port})\n`);

  let totalPassed = 0;
  let totalFailed = 0;
  let currentClient = client;

  try {
    for (const file of files) {
      const result = await runTestFile(currentClient, file, { verbose, trace, port });
      totalPassed += result.passed;
      totalFailed += result.failed;
      // Update client if it was replaced by launchApp/clearState
      if (result.client) {
        currentClient = result.client;
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
