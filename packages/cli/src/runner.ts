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
      'sleep',
      'runTest',
      'waitForElement',
      'waitForVisible',
      'Alert',
      code
    );

    await testFn(
      context.element,
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
 * Create the test context with API functions bound to the client
 */
function createTestContext(client: TastoClient, results: RunResults) {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const element = (testID: string) => ({
    async tap() {
      const ok = await client.tap(testID);
      if (!ok) throw new Error(`Tap failed: ${testID}`);
      await sleep(50);
    },

    async typeText(text: string) {
      const ok = await client.typeText(testID, text);
      if (!ok) throw new Error(`TypeText failed: ${testID}`);
      await sleep(50);
    },

    async clearText() {
      const ok = await client.clearText(testID);
      if (!ok) throw new Error(`ClearText failed: ${testID}`);
      await sleep(50);
    },

    async exists() {
      return client.exists(testID);
    },

    async isVisible() {
      return client.isVisible(testID);
    },

    async toBeVisible() {
      const visible = await client.isVisible(testID);
      if (!visible) throw new Error(`Not visible: ${testID}`);
    },

    async getText() {
      return client.getText(testID);
    },

    async scroll(direction: string, amount = 200) {
      await client.scroll(testID, direction, amount);
      await sleep(100);
    },
  });

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

  return { element, sleep, runTest, waitForElement, waitForVisible, Alert };
}
