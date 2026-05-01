/**
 * Test Runner
 *
 * Executes test files by interpreting them and sending
 * commands to the app via WebSocket.
 *
 * Built-in flakiness handling with configurable retries and timeouts.
 */

import { TastoClient } from './client';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

// Default configuration for flakiness handling
const DEFAULT_TIMEOUT = 5000;
const DEFAULT_RETRY_COUNT = 3;
const DEFAULT_RETRY_INTERVAL = 100;
const DEFAULT_VISIBLE_TIMEOUT = 10000;

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  ms: number;
}

interface RunResults {
  passed: number;
  failed: number;
  tests: TestResult[];
}

/**
 * Process imports and inline local dependencies
 */
function processFile(filePath: string, processed = new Set<string>()): string {
  if (processed.has(filePath)) return '';
  processed.add(filePath);

  let code = readFileSync(filePath, 'utf-8');
  const dir = dirname(filePath);

  // Find and process local imports
  const localImportRegex = /^import\s+\{([^}]+)\}\s+from\s+['"](\.[^'"]+)['"]\s*;?\s*$/gm;
  const localImports: Array<{ fullMatch: string; importPath: string }> = [];

  let match;
  while ((match = localImportRegex.exec(code)) !== null) {
    localImports.push({
      fullMatch: match[0],
      importPath: match[2],
    });
  }

  // Process each local import
  let inlinedCode = '';
  for (const { fullMatch, importPath } of localImports) {
    code = code.replace(fullMatch, '');

    const extensions = ['.ts', '.tsx', '.js', ''];
    for (const ext of extensions) {
      const tryPath = join(dir, importPath + ext);
      if (existsSync(tryPath)) {
        inlinedCode += processFile(tryPath, processed);
        break;
      }
    }
  }

  // Remove @tasto/test imports (we provide these)
  code = code.replace(/^import\s+\{[^}]+\}\s+from\s+['"]@tasto\/test['"]\s*;?\s*$/gm, '');

  // Remove export keywords
  code = code.replace(/^export\s+default\s+/gm, '');
  code = code.replace(/^export\s+/gm, '');

  return inlinedCode + code;
}

/**
 * Run tests from a test file using the WebSocket client
 */
export async function runTests(
  client: TastoClient,
  testFilePath: string
): Promise<RunResults> {
  const results: RunResults = { passed: 0, failed: 0, tests: [] };

  // Process the test file
  const code = processFile(testFilePath);

  // Create the test context with API functions
  const context = createTestContext(client, results);

  // Execute the test code
  try {
    // Create an async function from the code
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const testFn = new AsyncFunction(
      'element',
      'elements',
      'sleep',
      'runTest',
      'waitFor',
      'waitForElement',
      'waitForVisible',
      'waitForNotVisible',
      'retry',
      'Alert',
      code
    );

    await testFn(
      context.element,
      context.elements,
      context.sleep,
      context.runTest,
      context.waitFor,
      context.waitForElement,
      context.waitForVisible,
      context.waitForNotVisible,
      context.retry,
      context.Alert
    );
  } catch (err) {
    console.error(`  Test execution error: ${err}`);
  }

  return results;
}

/**
 * Check if selector is id-only
 */
function isIdOnlySelector(selector: unknown): boolean {
  if (typeof selector !== 'object' || selector === null) return false;
  const keys = Object.keys(selector);
  return keys.length === 1 && keys[0] === 'id';
}

/**
 * Get selector description for error messages
 */
function getSelectorDescription(selector: string | Record<string, unknown>): string {
  if (typeof selector === 'string') {
    return selector;
  }
  if (isIdOnlySelector(selector)) {
    return `testID: ${(selector as { id: string }).id}`;
  }
  return `selector: ${JSON.stringify(selector)}`;
}

/**
 * Create the test context with API functions bound to the client
 * Includes built-in flakiness handling with retries and waits
 */
function createTestContext(client: TastoClient, results: RunResults) {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /**
   * Retry an async operation with exponential backoff
   */
  const retry = async <T>(
    fn: () => Promise<T>,
    opts: { retries?: number; interval?: number; backoff?: number } = {}
  ): Promise<T> => {
    const { retries = DEFAULT_RETRY_COUNT, interval = DEFAULT_RETRY_INTERVAL, backoff = 1.5 } = opts;
    let lastError: Error | undefined;
    let currentInterval = interval;

    for (let i = 0; i <= retries; i++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (i < retries) {
          await sleep(currentInterval);
          currentInterval *= backoff;
        }
      }
    }
    throw lastError;
  };

  /**
   * Wait for a condition to be true
   */
  const waitFor = async (
    condition: () => Promise<boolean>,
    opts: { timeout?: number; interval?: number; message?: string } = {}
  ): Promise<void> => {
    const { timeout = DEFAULT_TIMEOUT, interval = DEFAULT_RETRY_INTERVAL, message = 'Condition not met' } = opts;
    const start = Date.now();

    while (Date.now() - start < timeout) {
      if (await condition()) return;
      await sleep(interval);
    }
    throw new Error(`Timeout (${timeout}ms): ${message}`);
  };

  /**
   * Element function supporting both string testID and Selector objects
   * All actions include built-in retry logic for flakiness
   */
  const element = (selector: string | Record<string, unknown>) => {
    const isString = typeof selector === 'string';
    const selectorObj = isString ? { id: selector } : selector;
    const testID = isString ? selector : (isIdOnlySelector(selector) ? (selector as { id: string }).id : null);
    const desc = getSelectorDescription(selector);

    // Helper to check existence with optional wait
    const checkExists = async () => {
      if (testID) return client.exists(testID);
      return client.existsBySelector(selectorObj);
    };

    // Helper to check visibility
    const checkVisible = async () => {
      if (testID) return client.isVisible(testID);
      return client.isVisibleBySelector(selectorObj);
    };

    return {
      /**
       * Tap element with automatic retry on failure
       */
      async tap() {
        await retry(async () => {
          // Wait for element to exist before tapping
          await waitFor(checkExists, { timeout: DEFAULT_VISIBLE_TIMEOUT, message: `Element not found: ${desc}` });

          let ok: boolean;
          if (testID) {
            ok = await client.tap(testID);
          } else {
            ok = await client.tapBySelector(selectorObj);
          }
          if (!ok) throw new Error(`Tap failed: ${desc}`);
        });
        await sleep(50);
      },

      /**
       * Long press element
       */
      async longPress(duration = 500) {
        await retry(async () => {
          await waitFor(checkExists, { timeout: DEFAULT_VISIBLE_TIMEOUT, message: `Element not found: ${desc}` });

          let ok: boolean;
          if (testID) {
            ok = await client.longPress(testID, duration);
          } else {
            ok = await client.longPressBySelector(selectorObj, duration);
          }
          if (!ok) throw new Error(`LongPress failed: ${desc}`);
        });
        await sleep(50);
      },

      /**
       * Type text into element with retry
       */
      async typeText(text: string) {
        await retry(async () => {
          await waitFor(checkExists, { timeout: DEFAULT_VISIBLE_TIMEOUT, message: `Element not found: ${desc}` });

          let ok: boolean;
          if (testID) {
            ok = await client.typeText(testID, text);
          } else {
            ok = await client.typeTextBySelector(selectorObj, text);
          }
          if (!ok) throw new Error(`TypeText failed: ${desc}`);
        });
        await sleep(50);
      },

      /**
       * Clear text from element
       */
      async clearText() {
        await retry(async () => {
          await waitFor(checkExists, { timeout: DEFAULT_VISIBLE_TIMEOUT, message: `Element not found: ${desc}` });

          let ok: boolean;
          if (testID) {
            ok = await client.clearText(testID);
          } else {
            ok = await client.clearTextBySelector(selectorObj);
          }
          if (!ok) throw new Error(`ClearText failed: ${desc}`);
        });
        await sleep(50);
      },

      /**
       * Check if element exists (no wait)
       */
      async exists() {
        return checkExists();
      },

      /**
       * Check if element is visible (no wait)
       */
      async isVisible() {
        return checkVisible();
      },

      /**
       * Assert element is visible with automatic wait
       */
      async toBeVisible(opts: { timeout?: number } = {}) {
        const timeout = opts.timeout ?? DEFAULT_VISIBLE_TIMEOUT;
        await waitFor(checkVisible, { timeout, message: `Not visible: ${desc}` });
      },

      /**
       * Assert element exists with automatic wait
       */
      async toExist(opts: { timeout?: number } = {}) {
        const timeout = opts.timeout ?? DEFAULT_VISIBLE_TIMEOUT;
        await waitFor(checkExists, { timeout, message: `Element does not exist: ${desc}` });
      },

      /**
       * Assert element does not exist
       */
      async toNotExist(opts: { timeout?: number } = {}) {
        const timeout = opts.timeout ?? DEFAULT_TIMEOUT;
        await waitFor(async () => !(await checkExists()), { timeout, message: `Element still exists: ${desc}` });
      },

      /**
       * Get element text
       */
      async getText() {
        await waitFor(checkExists, { timeout: DEFAULT_VISIBLE_TIMEOUT, message: `Element not found: ${desc}` });
        if (testID) return client.getText(testID);
        return client.getTextBySelector(selectorObj);
      },

      /**
       * Assert element has specific text
       */
      async toHaveText(expected: string, opts: { timeout?: number } = {}) {
        const timeout = opts.timeout ?? DEFAULT_TIMEOUT;
        await waitFor(async () => {
          const text = testID ? await client.getText(testID) : await client.getTextBySelector(selectorObj);
          return text === expected;
        }, { timeout, message: `Expected text "${expected}" but element has different text` });
      },

      /**
       * Assert element contains text
       */
      async toContainText(substring: string, opts: { timeout?: number } = {}) {
        const timeout = opts.timeout ?? DEFAULT_TIMEOUT;
        await waitFor(async () => {
          const text = testID ? await client.getText(testID) : await client.getTextBySelector(selectorObj);
          return text?.includes(substring) ?? false;
        }, { timeout, message: `Expected to contain "${substring}"` });
      },

      /**
       * Scroll element
       */
      async scroll(direction: 'up' | 'down' | 'left' | 'right', amount = 200) {
        await retry(async () => {
          if (testID) {
            await client.scroll(testID, direction, amount);
          } else {
            const info = await client.findBySelector(selectorObj);
            if (info?.testID) {
              await client.scroll(info.testID, direction, amount);
            } else {
              throw new Error(`Cannot scroll element without testID: ${desc}`);
            }
          }
        });
        await sleep(100);
      },

      /**
       * Scroll until another element is visible
       */
      async scrollUntilVisible(
        targetSelector: string | Record<string, unknown>,
        opts: { direction?: 'up' | 'down'; maxScrolls?: number; amount?: number } = {}
      ) {
        const { direction = 'down', maxScrolls = 10, amount = 300 } = opts;
        const targetObj = typeof targetSelector === 'string' ? { id: targetSelector } : targetSelector;
        const targetID = typeof targetSelector === 'string' ? targetSelector : null;

        for (let i = 0; i < maxScrolls; i++) {
          const visible = targetID
            ? await client.isVisible(targetID)
            : await client.isVisibleBySelector(targetObj);
          if (visible) return;

          if (testID) {
            await client.scroll(testID, direction, amount);
          } else {
            const info = await client.findBySelector(selectorObj);
            if (info?.testID) await client.scroll(info.testID, direction, amount);
          }
          await sleep(200);
        }
        throw new Error(`Element not found after ${maxScrolls} scrolls`);
      },

      /**
       * Get element info
       */
      async getInfo() {
        if (testID) return client.getElementInfo(testID);
        return client.findBySelector(selectorObj);
      },

      /**
       * Get layout metrics
       */
      async getLayout() {
        const info = testID ? await client.getElementInfo(testID) : await client.findBySelector(selectorObj);
        return info?.layout ?? null;
      },
    };
  };

  /**
   * Find all elements matching a selector
   */
  const elements = async (selector: string | Record<string, unknown>) => {
    const selectorObj = typeof selector === 'string' ? { id: selector } : selector;
    return client.findAllBySelector(selectorObj);
  };

  /**
   * Wait for element to exist (supports string or selector)
   */
  const waitForElement = async (
    selector: string | Record<string, unknown>,
    opts: { timeout?: number } = {}
  ) => {
    const timeout = opts.timeout ?? DEFAULT_VISIBLE_TIMEOUT;
    const isString = typeof selector === 'string';
    const selectorObj = isString ? { id: selector } : selector;
    const testID = isString ? selector : (isIdOnlySelector(selector) ? (selector as { id: string }).id : null);

    await waitFor(
      async () => testID ? await client.exists(testID) : await client.existsBySelector(selectorObj),
      { timeout, message: `Element not found: ${getSelectorDescription(selector)}` }
    );
  };

  /**
   * Wait for element to be visible (supports string or selector)
   */
  const waitForVisible = async (
    selector: string | Record<string, unknown>,
    opts: { timeout?: number } = {}
  ) => {
    const timeout = opts.timeout ?? DEFAULT_VISIBLE_TIMEOUT;
    const isString = typeof selector === 'string';
    const selectorObj = isString ? { id: selector } : selector;
    const testID = isString ? selector : (isIdOnlySelector(selector) ? (selector as { id: string }).id : null);

    await waitFor(
      async () => testID ? await client.isVisible(testID) : await client.isVisibleBySelector(selectorObj),
      { timeout, message: `Element not visible: ${getSelectorDescription(selector)}` }
    );
  };

  /**
   * Wait for element to disappear
   */
  const waitForNotVisible = async (
    selector: string | Record<string, unknown>,
    opts: { timeout?: number } = {}
  ) => {
    const timeout = opts.timeout ?? DEFAULT_TIMEOUT;
    const isString = typeof selector === 'string';
    const selectorObj = isString ? { id: selector } : selector;
    const testID = isString ? selector : (isIdOnlySelector(selector) ? (selector as { id: string }).id : null);

    await waitFor(
      async () => !(testID ? await client.isVisible(testID) : await client.isVisibleBySelector(selectorObj)),
      { timeout, message: `Element still visible: ${getSelectorDescription(selector)}` }
    );
  };

  const Alert = {
    async isPresent() {
      return client.isAlertPresent();
    },
    async getText() {
      return client.getAlertText();
    },
    async tap(buttonText: string) {
      const ok = await client.tapAlertButton(buttonText);
      if (!ok) throw new Error(`Alert tap failed: ${buttonText}`);
      await sleep(100);
    },
    async dismiss() {
      await client.dismissAlert();
      await sleep(100);
    },
  };

  const runTest = async (name: string, fn: () => Promise<void>) => {
    const start = Date.now();
    try {
      await fn();
      results.passed++;
      results.tests.push({ name, passed: true, ms: Date.now() - start });
    } catch (err) {
      results.failed++;
      results.tests.push({
        name,
        passed: false,
        error: err instanceof Error ? err.message : String(err),
        ms: Date.now() - start,
      });
    }
  };

  return {
    element,
    elements,
    sleep,
    runTest,
    waitFor,
    waitForElement,
    waitForVisible,
    waitForNotVisible,
    retry,
    Alert,
  };
}
