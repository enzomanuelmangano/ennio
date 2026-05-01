#!/usr/bin/env bun
/**
 * Tasto CLI
 *
 * Runs E2E tests in a React Native app via Hermes CDP.
 *
 * Usage:
 *   npx tasto e2e/test.ts
 *   npx tasto e2e/           # Runs all *.test.ts files in directory
 */

import { existsSync, statSync } from 'fs';
import { resolve, basename, join } from 'path';
import { glob } from 'glob';
import { bundleTestFile, extractTestNames } from './bundler';
import { executeTests } from './cdp';

interface TestFileResult {
  file: string;
  passed: number;
  failed: number;
}

async function runTestFile(filePath: string, debug: boolean): Promise<TestFileResult> {
  const fileName = basename(filePath);
  console.log(`▸ ${fileName}`);

  try {
    // Bundle the test file with the runtime
    const bundledCode = await bundleTestFile(filePath);

    if (debug) {
      console.log('--- Bundled Code ---');
      console.log(bundledCode.slice(0, 2000) + (bundledCode.length > 2000 ? '\n... truncated' : ''));
      console.log('------------');
    }

    // Extract test names for progress tracking
    const testNames = extractTestNames(bundledCode);

    if (debug) {
      console.log(`  Found ${testNames.length} tests: ${testNames.join(', ')}`);
    }

    // Execute tests via CDP
    const results = await executeTests(bundledCode, testNames.length);

    // Print results
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
  const debug = process.argv.includes('--debug');

  if (args.length === 0) {
    console.log('Usage: tasto <test-file.ts> [--debug]');
    console.log('       tasto e2e/           # Runs all *.test.ts files');
    process.exit(0);
  }

  // Find test files
  const files: string[] = [];
  for (let pattern of args) {
    const resolved = resolve(pattern);

    // If pattern is a directory, look for test files inside
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

  let totalPassed = 0;
  let totalFailed = 0;

  for (const file of files) {
    const result = await runTestFile(file, debug);
    totalPassed += result.passed;
    totalFailed += result.failed;
  }

  console.log('─'.repeat(40));
  console.log(`Total: ${totalPassed} passed, ${totalFailed} failed`);
  process.exit(totalFailed > 0 ? 1 : 0);
}

main();
