#!/usr/bin/env node

import { glob } from 'glob';
import path from 'path';
import { connect, disconnect, configure } from '../index';
import {
  launchIOS,
  launchAndroid,
  getIOSSimulators,
  getAndroidEmulators,
  waitForTastoServer,
  type IOSLaunchOptions,
  type AndroidLaunchOptions,
} from '../launcher';
import { loadConfig, type TastoConfig } from '../config';

interface CliOptions {
  host: string;
  port: number;
  timeout: number;
  verbose: boolean;
  pattern: string;
  command: 'test' | 'launch' | 'list-devices';
  platform: 'ios' | 'android';
  simulator?: string;
  bundleId?: string;
  appPath?: string;
  configPath?: string;
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
    command: 'test',
    platform: 'ios',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === 'launch') {
      options.command = 'launch';
    } else if (arg === 'list-devices') {
      options.command = 'list-devices';
    } else if (arg === '--ios') {
      options.platform = 'ios';
    } else if (arg === '--android') {
      options.platform = 'android';
    } else if (arg === '--simulator' || arg === '-s') {
      options.simulator = args[++i];
    } else if (arg === '--bundle-id' || arg === '-b') {
      options.bundleId = args[++i];
    } else if (arg === '--app-path' || arg === '-a') {
      options.appPath = args[++i];
    } else if (arg === '--config' || arg === '-c') {
      options.configPath = args[++i];
    } else if (arg === '--host' || arg === '-h') {
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
  tasto <pattern> [options]        Run tests
  tasto launch [options]           Launch app in simulator
  tasto list-devices               List available simulators/emulators

${colors.yellow}Test Options:${colors.reset}
  --host, -h       Server host (default: localhost)
  --port, -p       Server port (default: 9876)
  --timeout, -t    Default timeout in ms (default: 30000)
  --verbose, -v    Verbose output
  --config, -c     Path to config file

${colors.yellow}Launch Options:${colors.reset}
  --ios            Target iOS simulator (default)
  --android        Target Android emulator
  --simulator, -s  Simulator name or UDID (default: iPhone 16)
  --bundle-id, -b  App bundle identifier
  --app-path, -a   Path to .app or .apk file

${colors.yellow}Examples:${colors.reset}
  ${colors.dim}# Run all tests${colors.reset}
  tasto e2e/

  ${colors.dim}# Run a specific test file${colors.reset}
  tasto e2e/home.test.ts

  ${colors.dim}# Launch iOS app${colors.reset}
  tasto launch --ios --simulator "iPhone 15" --bundle-id com.myapp

  ${colors.dim}# Launch and run tests${colors.reset}
  tasto launch --ios -b com.myapp && tasto e2e/

  ${colors.dim}# List available devices${colors.reset}
  tasto list-devices
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

async function runTestFile(
  filePath: string,
  verbose: boolean
): Promise<boolean> {
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

async function runTests(options: CliOptions, config?: TastoConfig): Promise<void> {
  const host = options.host;
  const port = config?.port ?? options.port;

  log(`${colors.bold}Tasto Test Runner${colors.reset}`, 'blue');
  log(`Connecting to ${host}:${port}...`, 'dim');

  // Configure the test runner
  configure({
    defaultTimeout: options.timeout,
    verbose: options.verbose,
  });

  // Connect to the server
  try {
    await connect({
      host: host,
      port: port,
      timeout: options.timeout,
    });
    log(`Connected!`, 'green');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Failed to connect: ${message}`, 'red');
    log(
      '\nMake sure your React Native app is running with Tasto enabled.',
      'yellow'
    );
    process.exit(1);
  }

  // Find test files
  const testFiles = await findTestFiles(options.pattern);

  if (testFiles.length === 0) {
    log(
      `\nNo test files found matching "${options.pattern || 'e2e/**/*.test.{ts,js}'}"`,
      'yellow'
    );
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

async function runLaunch(options: CliOptions, config?: TastoConfig): Promise<void> {
  log(`${colors.bold}Tasto App Launcher${colors.reset}`, 'blue');

  if (options.platform === 'ios') {
    // Get launch options from CLI or config
    const launchOptions: IOSLaunchOptions = {
      simulator: options.simulator ?? config?.ios?.simulator ?? 'iPhone 16',
      bundleId: options.bundleId ?? config?.ios?.bundleId ?? '',
      appPath: options.appPath ?? config?.ios?.appPath,
      port: config?.port ?? options.port,
    };

    if (!launchOptions.bundleId) {
      log('Error: Bundle ID is required. Use --bundle-id or set in tasto.config.js', 'red');
      process.exit(1);
    }

    const result = await launchIOS(launchOptions);
    if (!result.success) {
      log(`Error: ${result.error}`, 'red');
      process.exit(1);
    }
  } else {
    // Android
    const launchOptions: AndroidLaunchOptions = {
      emulator: options.simulator ?? config?.android?.emulator,
      packageName: options.bundleId ?? config?.android?.packageName ?? '',
      apkPath: options.appPath ?? config?.android?.apkPath,
      port: config?.port ?? options.port,
    };

    if (!launchOptions.packageName) {
      log('Error: Package name is required. Use --bundle-id or set in tasto.config.js', 'red');
      process.exit(1);
    }

    const result = await launchAndroid(launchOptions);
    if (!result.success) {
      log(`Error: ${result.error}`, 'red');
      process.exit(1);
    }
  }
}

async function runListDevices(): Promise<void> {
  log(`${colors.bold}Available Devices${colors.reset}`, 'blue');

  // iOS simulators
  log('\n' + colors.yellow + 'iOS Simulators:' + colors.reset);
  const simulators = await getIOSSimulators();

  if (simulators.length === 0) {
    log('  No iOS simulators found', 'dim');
  } else {
    for (const sim of simulators) {
      if (!sim.isAvailable) continue;
      const state = sim.state === 'Booted' ? colors.green + '(Booted)' + colors.reset : colors.dim + '(Shutdown)' + colors.reset;
      log(`  ${sim.name} ${state}`);
      log(`    ${colors.dim}${sim.udid}${colors.reset}`);
    }
  }

  // Android emulators
  log('\n' + colors.yellow + 'Android Emulators:' + colors.reset);
  const emulators = await getAndroidEmulators();

  if (emulators.length === 0) {
    log('  No Android emulators found', 'dim');
  } else {
    for (const emu of emulators) {
      log(`  ${emu}`);
    }
  }
}

async function main(): Promise<void> {
  const options = parseArgs();

  // Load config file
  let config: TastoConfig | undefined;
  try {
    config = await loadConfig(options.configPath);
    if (config && options.verbose) {
      log('Loaded config file', 'dim');
    }
  } catch {
    // Config file not found, continue with defaults
  }

  switch (options.command) {
    case 'launch':
      await runLaunch(options, config);
      break;
    case 'list-devices':
      await runListDevices();
      break;
    case 'test':
    default:
      await runTests(options, config);
      break;
  }
}

main().catch((error) => {
  console.error('Unexpected error:', error);
  disconnect();
  process.exit(1);
});
