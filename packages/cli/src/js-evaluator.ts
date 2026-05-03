/**
 * JavaScript Evaluator for Maestro YAML
 *
 * Provides sandboxed JavaScript evaluation for:
 * - Inline expressions: ${expression}
 * - evalScript command: ${VARIABLE = value}
 * - runScript command: Execute external .js files
 *
 * Uses Node.js vm module for sandboxed evaluation with
 * a Maestro-compatible global context.
 */

import * as vm from 'vm';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';

// ============================================
// Types
// ============================================

export interface JsContext {
  maestro: MaestroGlobal;
  output: Record<string, unknown>;
  [key: string]: unknown;
}

export interface MaestroGlobal {
  platform: 'ios' | 'android';
  deviceInfo: {
    platform: 'ios' | 'android';
    osVersion: string;
    model: string;
    isSimulator: boolean;
  };
  appId?: string;
  copiedText?: string;
}

// ============================================
// Context Management
// ============================================

/**
 * Create a new JS evaluation context with Maestro globals
 */
export function createContext(options: {
  platform?: 'ios' | 'android';
  appId?: string;
  isSimulator?: boolean;
} = {}): JsContext {
  const platform = options.platform || 'ios';

  const context: JsContext = {
    maestro: {
      platform,
      deviceInfo: {
        platform,
        osVersion: platform === 'ios' ? '17.0' : '14',
        model: platform === 'ios' ? 'iPhone 15' : 'Pixel 7',
        isSimulator: options.isSimulator ?? true,
      },
      appId: options.appId,
      copiedText: '',
    },
    output: {},
    // Common utilities
    Date,
    Math,
    JSON,
    console: {
      log: (...args: unknown[]) => console.log('[JS]', ...args),
      warn: (...args: unknown[]) => console.warn('[JS]', ...args),
      error: (...args: unknown[]) => console.error('[JS]', ...args),
    },
    parseInt,
    parseFloat,
    String,
    Number,
    Boolean,
    Array,
    Object,
    RegExp,
    // setTimeout/setInterval are dangerous in tests, omit them
  };

  // Create VM context
  vm.createContext(context);

  return context;
}

// ============================================
// Expression Evaluation
// ============================================

// Regex to match ${...} expressions
const EXPR_REGEX = /\$\{([^}]+)\}/g;

/**
 * Check if a string contains ${} expressions
 */
export function hasExpressions(value: string): boolean {
  EXPR_REGEX.lastIndex = 0;
  return EXPR_REGEX.test(value);
}

/**
 * Evaluate ${...} expressions in a string
 *
 * @param value - String potentially containing ${} expressions
 * @param context - JS evaluation context
 * @returns Evaluated string with expressions replaced
 */
export function evaluateExpressions(value: string, context: JsContext): string {
  EXPR_REGEX.lastIndex = 0;

  return value.replace(EXPR_REGEX, (match, expr) => {
    try {
      const result = vm.runInContext(expr, context, {
        timeout: 1000,
        displayErrors: true,
      });
      return String(result);
    } catch (err) {
      console.warn(`JS expression error: ${expr}`, err);
      return match; // Return original if evaluation fails
    }
  });
}

/**
 * Evaluate a pure expression (without ${} wrapper)
 */
export function evaluate(expr: string, context: JsContext): unknown {
  try {
    return vm.runInContext(expr, context, {
      timeout: 1000,
      displayErrors: true,
    });
  } catch (err) {
    throw new Error(`JS evaluation error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ============================================
// evalScript Command
// ============================================

/**
 * Execute an evalScript command
 *
 * evalScript runs JS code that can set variables for later use.
 * Example: evalScript: ${MY_VAR = 42}
 *
 * @param script - JavaScript code to execute (may be wrapped in ${})
 * @param context - JS evaluation context
 */
export function evalScript(script: string, context: JsContext): void {
  // Remove ${} wrapper if present
  let code = script;
  if (code.startsWith('${') && code.endsWith('}')) {
    code = code.slice(2, -1);
  }

  try {
    vm.runInContext(code, context, {
      timeout: 5000,
      displayErrors: true,
    });
  } catch (err) {
    throw new Error(`evalScript error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ============================================
// runScript Command
// ============================================

/**
 * Execute a runScript command
 *
 * runScript loads and executes an external .js file.
 * Environment variables are made available in the script.
 *
 * @param filePath - Path to the .js file (relative to current flow)
 * @param env - Environment variables to pass to the script
 * @param context - JS evaluation context
 * @param basePath - Base path for resolving relative file paths
 */
export function runScript(
  filePath: string,
  env: Record<string, string> = {},
  context: JsContext,
  basePath: string
): void {
  const absolutePath = resolve(dirname(basePath), filePath);

  let code: string;
  try {
    code = readFileSync(absolutePath, 'utf-8');
  } catch (err) {
    throw new Error(`runScript: Could not read file ${filePath}`);
  }

  // Add env variables to context
  for (const [key, value] of Object.entries(env)) {
    (context as Record<string, unknown>)[key] = value;
  }

  try {
    vm.runInContext(code, context, {
      filename: filePath,
      timeout: 30000, // Longer timeout for scripts
      displayErrors: true,
    });
  } catch (err) {
    throw new Error(`runScript error in ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ============================================
// Value Preprocessing
// ============================================

/**
 * Recursively preprocess a value, evaluating all ${} expressions
 */
export function preprocessValue(value: unknown, context: JsContext): unknown {
  if (typeof value === 'string') {
    if (hasExpressions(value)) {
      return evaluateExpressions(value, context);
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => preprocessValue(item, context));
  }

  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = preprocessValue(val, context);
    }
    return result;
  }

  return value;
}

/**
 * Preprocess a Maestro command, evaluating all ${} expressions in string values
 */
export function preprocessCommand<T>(cmd: T, context: JsContext): T {
  return preprocessValue(cmd, context) as T;
}
