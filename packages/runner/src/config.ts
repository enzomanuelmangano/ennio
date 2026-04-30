import { existsSync } from 'fs';
import { resolve, join } from 'path';
import { pathToFileURL } from 'url';

/**
 * iOS-specific configuration
 */
export interface IOSConfig {
  /**
   * Simulator name or UDID
   * @default "iPhone 16"
   */
  simulator?: string;

  /**
   * App bundle identifier
   */
  bundleId?: string;

  /**
   * Path to .app bundle
   */
  appPath?: string;
}

/**
 * Android-specific configuration
 */
export interface AndroidConfig {
  /**
   * Emulator name
   */
  emulator?: string;

  /**
   * App package name
   */
  packageName?: string;

  /**
   * Path to .apk file
   */
  apkPath?: string;
}

/**
 * Tasto configuration
 */
export interface TastoConfig {
  /**
   * WebSocket server port
   * @default 9876
   */
  port?: number;

  /**
   * Default test timeout in milliseconds
   * @default 30000
   */
  timeout?: number;

  /**
   * Test file patterns to match
   * @default ["e2e/**\/*.test.{ts,js}"]
   */
  testMatch?: string[];

  /**
   * iOS-specific configuration
   */
  ios?: IOSConfig;

  /**
   * Android-specific configuration
   */
  android?: AndroidConfig;

  /**
   * Custom setup function to run before tests
   */
  setup?: () => Promise<void>;

  /**
   * Custom teardown function to run after tests
   */
  teardown?: () => Promise<void>;
}

/**
 * Config file names to search for, in order of priority
 */
const CONFIG_FILE_NAMES = [
  'tasto.config.js',
  'tasto.config.mjs',
  'tasto.config.cjs',
  'tasto.config.ts',
];

/**
 * Find config file in the given directory or parent directories
 */
function findConfigFile(startDir: string): string | null {
  let currentDir = startDir;

  while (currentDir !== '/') {
    for (const fileName of CONFIG_FILE_NAMES) {
      const configPath = join(currentDir, fileName);
      if (existsSync(configPath)) {
        return configPath;
      }
    }

    // Check for package.json with tasto key
    const packageJsonPath = join(currentDir, 'package.json');
    if (existsSync(packageJsonPath)) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const pkg = require(packageJsonPath);
        if (pkg.tasto) {
          return packageJsonPath;
        }
      } catch {
        // Ignore parse errors
      }
    }

    // Move to parent directory
    const parentDir = resolve(currentDir, '..');
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  return null;
}

/**
 * Load config from a file
 */
export async function loadConfig(
  configPath?: string
): Promise<TastoConfig | undefined> {
  // If explicit path provided, use it
  let resolvedPath: string | null = configPath
    ? resolve(configPath)
    : findConfigFile(process.cwd());

  if (!resolvedPath) {
    return undefined;
  }

  // Handle package.json
  if (resolvedPath.endsWith('package.json')) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require(resolvedPath);
    return pkg.tasto as TastoConfig;
  }

  // Handle JS/TS config files
  try {
    // Use dynamic import for ESM compatibility
    const configUrl = pathToFileURL(resolvedPath).href;
    const module = await import(configUrl);

    // Support both default export and named export
    const config = module.default || module.config || module;

    // If it's a function, call it
    if (typeof config === 'function') {
      return await config();
    }

    return config as TastoConfig;
  } catch (error) {
    throw new Error(
      `Failed to load config from ${resolvedPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Create a config helper for better type inference
 */
export function defineConfig(config: TastoConfig): TastoConfig {
  return config;
}
