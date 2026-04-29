#!/usr/bin/env node

import { glob } from 'glob';
import path from 'path';
import { connect, disconnect, configure } from '../index';

interface CliOptions {
  host: string;
  port: number;
  timeout: number;
  verbose: boolean;
  pattern: string;
}

interface TestModule {
  default?: () => Promise<void>;
  [key: string]: unknown;
}

const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
};

function log(message: string, color?: keyof typeof colors): void {
  if (color) {
    console.log(`${colors[color]}${message}${colors.reset}`);
  } else {
    console.log(message);
  }
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const options: CliOptions = {
    host: 'localhost',
    port: 9876,
    timeout: 30000,
    verbose: false,
    pattern: '',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--host' || arg === '-h') {
      options.host = args[++i] || 'localhost';
    } else if (arg === '--port' || arg === '-p') {
      options.port = parseInt(args[++i], 10) || 9876;
    } else if (arg === '--timeout' || arg === '-t') {
      options.timeout = parseInt(args[++i], 10) || 30000;
    } else if (arg === '--verbose' || arg === '-v') {
      options.verbose = true;
    } else if (arg === '--help') {
      printHelp();
      process.exit(0);
    } else if (!arg.startsWith('-')) {
      options.pattern = arg;
    }
  }

  return options;
}

function printHelp(): void {
  console.log(`
${colors.bold}Tasto - React Native E2E Test Runner${colors.reset}

${colors.yellow}Usage:${colors.reset}
  tasto <pattern> [options]
  tasto e2e/**/*.test.ts

${colors.yellow}Options:${colors.reset}
  --host, -h     Server host (default: localhost)
  --port, -p     Server port (default: 9876)
  --timeout, -t  Default timeout in ms (default: 30000)
  --verbose, -v  Verbose output
  --help         Show this help message

${colors.yellow}Examples:${colors.reset}
  tasto e2e/              Run all tests in e2e/
  tasto "**/*.test.ts"    Run all .test.ts files
  tasto e2e/home.test.ts  Run a specific test file
`);
}

async function findTestFiles(pattern: string): Promise<string[]> {
  // If pattern is a directory, add glob pattern
  if (pattern && !pattern.includes('*')) {
    if (pattern.endsWith('/')) {
      pattern = pattern + '**/*.test.{ts,js}';
    } else {
      // Check if it's a file or directory
      try {
        const stats = await import('fs').then((fs) =>
          fs.promises.stat(pattern)
        );
        if (stats.isDirectory()) {
          pattern = pattern + '/**/*.test.{ts,js}';
        }
      } catch {
        // Treat as glob pattern
      }
    }
  }

  if (!pattern) {
    pattern = 'e2e/**/*.test.{ts,js}';
  }

  const files = await glob(pattern, {
    cwd: process.cwd(),
    absolute: true,
  });

  return files.sort();
}

async function runTestFile(filePath: string, verbose: boolean): Promise<boolean> {
  const fileName = path.relative(process.cwd(), filePath);
  log(`\n${colors.blue}▸${colors.reset} ${fileName}`);

  try {
    // Bun can run TypeScript natively, no loader needed
    const testModule: TestModule = await import(filePath);

    // Run default export if it's a function
    if (typeof testModule.default === 'function') {
      await testModule.default();
    }

    // Run any exported test functions
    for (const [name, fn] of Object.entries(testModule)) {
      if (typeof fn === 'function' && name.startsWith('test')) {
        if (verbose) {
          log(`  Running ${name}...`, 'dim');
        }
        await fn();
      }
    }

    log(`  ${colors.green}✓${colors.reset} Passed`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`  ${colors.red}✗${colors.reset} Failed: ${message}`);

    if (verbose && error instanceof Error && error.stack) {
      log(error.stack, 'dim');
    }

    return false;
  }
}

async function main(): Promise<void> {
  const options = parseArgs();

  log(`${colors.bold}Tasto Test Runner${colors.reset}`, 'blue');
  log(`Connecting to ${options.host}:${options.port}...`, 'dim');

  // Configure the test runner
  configure({
    defaultTimeout: options.timeout,
    verbose: options.verbose,
  });

  // Connect to the server
  try {
    await connect({
      host: options.host,
      port: options.port,
      timeout: options.timeout,
    });
    log(`Connected!`, 'green');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Failed to connect: ${message}`, 'red');
    log('\nMake sure your React Native app is running with Tasto enabled.', 'yellow');
    process.exit(1);
  }

  // Find test files
  const testFiles = await findTestFiles(options.pattern);

  if (testFiles.length === 0) {
    log(`\nNo test files found matching "${options.pattern || 'e2e/**/*.test.{ts,js}'}"`, 'yellow');
    disconnect();
    process.exit(1);
  }

  log(`\nFound ${testFiles.length} test file(s)`, 'dim');

  // Run tests
  let passed = 0;
  let failed = 0;
  const startTime = Date.now();

  for (const file of testFiles) {
    const success = await runTestFile(file, options.verbose);
    if (success) {
      passed++;
    } else {
      failed++;
    }
  }

  const duration = Date.now() - startTime;

  // Summary
  log('\n' + '─'.repeat(50));
  log(`${colors.bold}Results:${colors.reset}`);

  if (failed === 0) {
    log(`  ${colors.green}✓ ${passed} passed${colors.reset} (${duration}ms)`);
  } else {
    log(`  ${colors.green}✓ ${passed} passed${colors.reset}`);
    log(`  ${colors.red}✗ ${failed} failed${colors.reset}`);
    log(`  Total: ${duration}ms`);
  }

  // Cleanup
  disconnect();

  // Exit with error code if tests failed
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Unexpected error:', error);
  disconnect();
  process.exit(1);
});
