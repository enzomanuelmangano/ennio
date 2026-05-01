/**
 * Test Runner
 *
 * Executes test files by interpreting them and sending
 * commands to the app via WebSocket.
 */

import { TastoClient } from './client';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

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
      'waitForElement',
      'waitForVisible',
      'Alert',
      code
    );

    await testFn(
      context.element,
      context.elements,
      context.sleep,
      context.runTest,
      context.waitForElement,
      context.waitForVisible,
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
 */
function createTestContext(client: TastoClient, results: RunResults) {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /**
   * Element function supporting both string testID and Selector objects
   */
  const element = (selector: string | Record<string, unknown>) => {
    // Normalize string to id selector for internal use
    const isString = typeof selector === 'string';
    const selectorObj = isString ? { id: selector } : selector;
    const testID = isString ? selector : (isIdOnlySelector(selector) ? (selector as { id: string }).id : null);

    return {
      async tap() {
        let ok: boolean;
        if (testID) {
          ok = await client.tap(testID);
        } else {
          ok = await client.tapBySelector(selectorObj);
        }
        if (!ok) throw new Error(`Tap failed: ${getSelectorDescription(selector)}`);
        await sleep(50);
      },

      async typeText(text: string) {
        let ok: boolean;
        if (testID) {
          ok = await client.typeText(testID, text);
        } else {
          ok = await client.typeTextBySelector(selectorObj, text);
        }
        if (!ok) throw new Error(`TypeText failed: ${getSelectorDescription(selector)}`);
        await sleep(50);
      },

      async clearText() {
        let ok: boolean;
        if (testID) {
          ok = await client.clearText(testID);
        } else {
          ok = await client.clearTextBySelector(selectorObj);
        }
        if (!ok) throw new Error(`ClearText failed: ${getSelectorDescription(selector)}`);
        await sleep(50);
      },

      async exists() {
        if (testID) {
          return client.exists(testID);
        }
        return client.existsBySelector(selectorObj);
      },

      async isVisible() {
        if (testID) {
          return client.isVisible(testID);
        }
        return client.isVisibleBySelector(selectorObj);
      },

      async toBeVisible() {
        let visible: boolean;
        if (testID) {
          visible = await client.isVisible(testID);
        } else {
          visible = await client.isVisibleBySelector(selectorObj);
        }
        if (!visible) throw new Error(`Not visible: ${getSelectorDescription(selector)}`);
      },

      async getText() {
        if (testID) {
          return client.getText(testID);
        }
        return client.getTextBySelector(selectorObj);
      },

      async scroll(direction: string, amount = 200) {
        if (testID) {
          await client.scroll(testID, direction, amount);
        } else {
          // For complex selectors, need to get info first to find testID
          const info = await client.findBySelector(selectorObj);
          if (info?.testID) {
            await client.scroll(info.testID, direction, amount);
          } else {
            throw new Error(`Cannot scroll element without testID: ${getSelectorDescription(selector)}`);
          }
        }
        await sleep(100);
      },

      async getInfo() {
        if (testID) {
          return client.getElementInfo(testID);
        }
        return client.findBySelector(selectorObj);
      },

      async toExist() {
        const exists = testID ? await client.exists(testID) : await client.existsBySelector(selectorObj);
        if (!exists) throw new Error(`Element does not exist: ${getSelectorDescription(selector)}`);
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

  const waitForElement = async (testID: string, opts: { timeout?: number } = {}) => {
    const timeout = opts.timeout || 5000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (await client.exists(testID)) return;
      await sleep(100);
    }
    throw new Error(`Timeout waiting for: ${testID}`);
  };

  const waitForVisible = async (testID: string, opts: { timeout?: number } = {}) => {
    const timeout = opts.timeout || 5000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (await client.isVisible(testID)) return;
      await sleep(100);
    }
    throw new Error(`Timeout waiting for visible: ${testID}`);
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

  return { element, elements, sleep, runTest, waitForElement, waitForVisible, Alert };
}
