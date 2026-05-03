/**
 * @ennio/test - Simple E2E testing for React Native
 *
 * Uses Nitro for direct shadow tree access.
 */

// Element API
export { Element, element, elements } from './element';

// Utilities
export {
  sleep,
  waitForElement,
  waitForVisible,
  waitForElementToDisappear,
  waitForIdle,
  Alert,
} from './utils';

// Re-export types from nitro
export type {
  ElementInfo,
  ExtendedElementInfo,
  LayoutMetrics,
  Selector,
  TextMatcher,
  TextMatchMode,
  Point,
  Trait,
} from '@ennio/core';

/**
 * Test results tracker
 */
interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  ms: number;
}

interface TestResults {
  passed: number;
  failed: number;
  tests: TestResult[];
}

// Global results object
const __testResults: TestResults = { passed: 0, failed: 0, tests: [] };

/**
 * Run a single test
 */
export async function runTest(name: string, fn: () => Promise<void>): Promise<void> {
  const start = Date.now();
  try {
    await fn();
    __testResults.passed++;
    __testResults.tests.push({ name, passed: true, ms: Date.now() - start });
    console.log(`[PASS] ${name}`);
  } catch (e) {
    __testResults.failed++;
    const error = e instanceof Error ? e.message : String(e);
    __testResults.tests.push({ name, passed: false, error, ms: Date.now() - start });
    console.log(`[FAIL] ${name}: ${error}`);
  }
}

/**
 * Get test results
 */
export function getTestResults(): TestResults {
  return __testResults;
}

/**
 * Reset test results
 */
export function resetTestResults(): void {
  __testResults.passed = 0;
  __testResults.failed = 0;
  __testResults.tests = [];
}
