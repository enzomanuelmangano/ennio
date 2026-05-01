#!/usr/bin/env bun
/**
 * Tasto CLI
 *
 * Runs tests in a React Native app via Hermes CDP.
 *
 * Test files import from @tasto/test for TypeScript support,
 * but at runtime the CLI provides these functions.
 *
 * Usage:
 *   npx tasto e2e/test.ts
 */

import { readFileSync, existsSync, statSync } from 'fs';
import { resolve, basename, dirname, join } from 'path';
import { glob } from 'glob';

const METRO_PORT = 8081;

interface Target {
  webSocketDebuggerUrl?: string;
  title?: string;
}

async function getDebuggerUrl(): Promise<string> {
  const res = await fetch(`http://localhost:${METRO_PORT}/json`);
  const targets: Target[] = await res.json();
  const target = targets.find(t => t.webSocketDebuggerUrl);
  if (!target?.webSocketDebuggerUrl) {
    throw new Error('No debugger found. Is the app running?');
  }
  return target.webSocketDebuggerUrl;
}

/**
 * Process a file and inline its local imports recursively
 */
function processFile(filePath: string, processed: Set<string> = new Set()): string {
  if (processed.has(filePath)) return '';
  processed.add(filePath);

  let code = readFileSync(filePath, 'utf-8');
  const dir = dirname(filePath);

  // Find and process local imports (./shared, ../utils, etc.)
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
    // Remove the import statement
    code = code.replace(fullMatch, '');

    // Find and process the imported file
    const extensions = ['.ts', '.tsx', '.js', ''];
    for (const ext of extensions) {
      const tryPath = join(dir, importPath + ext);
      if (existsSync(tryPath)) {
        inlinedCode += processFile(tryPath, processed);
        break;
      }
    }
  }

  // Remove @tasto/test imports (these are provided by CLI at runtime)
  code = code.replace(/^import\s+\{[^}]+\}\s+from\s+['"]@tasto\/test['"]\s*;?\s*$/gm, '');

  // Remove other external imports
  code = code.replace(/^import\s+[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '');

  // Remove export keywords
  code = code.replace(/^export\s+default\s+/gm, '');
  code = code.replace(/^export\s+/gm, '');

  return inlinedCode + code;
}

/**
 * Transform async arrow function bodies into Promise chains
 * Converts: async () => { await a(); await b(); }
 * Into: () => { return a().then(() => b()); }
 */
function transformAsyncAwait(code: string): string {
  // Transform async arrow functions with block bodies
  // Match: async () => { ... }
  // This is complex to do with regex, so we'll use a simpler approach:
  // Convert each `await expr;` into `return expr.then(function() { ... rest ... })`

  // First, convert top-level await statements (like `await runTest(...)`)
  // These should just be the call without await since runTest already handles promises
  code = code.replace(/^await\s+/gm, '');

  // For async arrow function callbacks, we need to chain the awaits
  // Pattern: async () => { await a(); await b(); }
  // This requires proper parsing, so let's use a simple approach:
  // Replace the pattern piece by piece

  // Find async arrow functions and transform them
  const asyncArrowRegex = /async\s*\(\s*\)\s*=>\s*\{([^}]+)\}/g;

  code = code.replace(asyncArrowRegex, (_match, body: string) => {
    // Parse the body statements (await expr;)
    const statements = body.trim().split(/;\s*/).filter(s => s.trim());

    if (statements.length === 0) {
      return '() => { return Promise.resolve(); }';
    }

    // Chain the statements with .then()
    let chain = statements[0].replace(/^\s*await\s+/, '').trim();

    for (let i = 1; i < statements.length; i++) {
      const stmt = statements[i].replace(/^\s*await\s+/, '').trim();
      if (stmt) {
        chain += `.then(function() { return ${stmt}; })`;
      }
    }

    return `() => { return ${chain}; }`;
  });

  // Clean up remaining async/await
  code = code.replace(/async\s*\(/g, '(');
  code = code.replace(/async\s+function/g, 'function');
  code = code.replace(/await\s+/g, '');

  return code;
}

/**
 * Runtime helpers injected into the app
 * These match the @tasto/test API
 */
const RUNTIME_HELPERS = `
var g = typeof globalThis !== 'undefined' ? globalThis : this;
g.__TASTO_RESULTS__ = g.__TASTO_RESULTS__ || { passed: 0, failed: 0, tests: [] };
var __results = g.__TASTO_RESULTS__;
__results.passed = 0;
__results.failed = 0;
__results.tests = [];

// Get Tasto from global (initialized by expo plugin or app import)
var Tasto = (typeof globalThis !== 'undefined' ? globalThis : this).__TASTO_MODULE__;
if (!Tasto) throw new Error('Tasto not initialized. Make sure @tasto/expo-plugin is configured or import @tasto/nitro in your app.');

// Utilities
function sleep(ms) {
  return new Promise(function(r) { setTimeout(r, ms); });
}

// Element API
function element(testID) {
  return {
    tap: function() {
      return new Promise(function(resolve, reject) {
        var ok = Tasto.tap(testID);
        if (!ok) reject(new Error('Tap failed: ' + testID));
        else resolve();
      }).then(function() { return sleep(50); });
    },
    typeText: function(text) {
      return new Promise(function(resolve, reject) {
        var ok = Tasto.typeText(testID, text);
        if (!ok) reject(new Error('TypeText failed: ' + testID));
        else resolve();
      }).then(function() { return sleep(50); });
    },
    clearText: function() {
      return new Promise(function(resolve, reject) {
        var ok = Tasto.clearText(testID);
        if (!ok) reject(new Error('ClearText failed: ' + testID));
        else resolve();
      }).then(function() { return sleep(50); });
    },
    exists: function() {
      return Promise.resolve(Tasto.exists(testID));
    },
    isVisible: function() {
      return Promise.resolve(Tasto.isVisible(testID));
    },
    toBeVisible: function() {
      return new Promise(function(resolve, reject) {
        var visible = Tasto.isVisible(testID);
        if (!visible) reject(new Error('Not visible: ' + testID));
        else resolve();
      });
    },
    getText: function() {
      return Promise.resolve(Tasto.getText(testID));
    },
    scroll: function(direction, amount) {
      Tasto.scroll(testID, direction, amount || 200);
      return sleep(100);
    }
  };
}

// Wait utilities
function waitForElement(testID, opts) {
  opts = opts || {};
  var timeout = opts.timeout || 5000;
  var start = Date.now();
  return new Promise(function(resolve, reject) {
    function check() {
      if (Tasto.exists(testID)) return resolve();
      if (Date.now() - start > timeout) return reject(new Error('Timeout: ' + testID));
      setTimeout(check, 100);
    }
    check();
  });
}

function waitForVisible(testID, opts) {
  opts = opts || {};
  var timeout = opts.timeout || 5000;
  var start = Date.now();
  return new Promise(function(resolve, reject) {
    function check() {
      if (Tasto.isVisible(testID)) return resolve();
      if (Date.now() - start > timeout) return reject(new Error('Timeout visible: ' + testID));
      setTimeout(check, 100);
    }
    check();
  });
}

// Alert API
var Alert = {
  isPresent: function() { return Promise.resolve(Tasto.isAlertPresent()); },
  getText: function() { return Promise.resolve(Tasto.getAlertText()); },
  getButtons: function() { return Promise.resolve(Tasto.getAlertButtons()); },
  tap: function(btn) {
    var ok = Tasto.tapAlertButton(btn);
    if (!ok) throw new Error('Alert tap failed: ' + btn);
    return sleep(100);
  },
  dismiss: function() {
    Tasto.dismissAlert();
    return sleep(100);
  }
};

// Test runner
function runTest(name, fn) {
  var start = Date.now();
  return fn().then(function() {
    __results.passed++;
    __results.tests.push({ name: name, passed: true, ms: Date.now() - start });
    console.log('[PASS] ' + name);
  }).catch(function(e) {
    __results.failed++;
    __results.tests.push({ name: name, passed: false, error: e.message, ms: Date.now() - start });
    console.log('[FAIL] ' + name + ': ' + e.message);
  });
}
`;

async function connectAndRun(testCode: string): Promise<{ passed: number; failed: number }> {
  const wsUrl = await getDebuggerUrl();

  return new Promise((resolvePromise, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map<number, (result: unknown) => void>();

    const send = (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
      return new Promise(res => {
        const msgId = ++id;
        pending.set(msgId, res);
        ws.send(JSON.stringify({ id: msgId, method, params }));
      });
    };

    const seenMessages = new Set<string>();

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data as string);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)!(msg.result);
        pending.delete(msg.id);
      }
      // Handle console messages - show test results and errors
      if (msg.method === 'Runtime.consoleAPICalled') {
        const args = msg.params.args.map((a: { value?: unknown; description?: string }) => a.value ?? a.description).join(' ');
        if ((args.includes('[PASS]') || args.includes('[FAIL]') || args.includes('Error') || args.includes('error')) && !seenMessages.has(args)) {
          seenMessages.add(args);
          console.log('  ' + args);
        }
      }
    };

    ws.onerror = () => reject(new Error('WebSocket error'));

    ws.onopen = async () => {
      try {
        await send('Runtime.enable');

        // Chain runTest calls so they execute sequentially
        // Find all top-level runTest(...) calls and chain them with .then()
        let chainedTestCode = testCode;

        // Find all runTest calls by matching balanced parentheses
        const runTestCalls: string[] = [];
        let idx = 0;
        while (idx < testCode.length) {
          const start = testCode.indexOf('runTest(', idx);
          if (start === -1) break;

          // Find matching closing paren
          let depth = 0;
          let end = start + 8; // after 'runTest('
          depth = 1;
          while (end < testCode.length && depth > 0) {
            if (testCode[end] === '(') depth++;
            else if (testCode[end] === ')') depth--;
            end++;
          }

          // Skip trailing semicolon and whitespace
          while (end < testCode.length && (testCode[end] === ';' || testCode[end] === ' ' || testCode[end] === '\n')) {
            end++;
          }

          const call = testCode.slice(start, end).trim().replace(/;$/, '');
          runTestCalls.push(call);
          idx = end;
        }

        if (runTestCalls.length > 0) {
          // Remove individual runTest calls from the code
          for (const call of runTestCalls) {
            chainedTestCode = chainedTestCode.replace(call + ';', '');
            chainedTestCode = chainedTestCode.replace(call, '');
          }

          // Chain them: runTest1.then(() => runTest2).then(() => runTest3)
          let chain = runTestCalls[0];
          for (let i = 1; i < runTestCalls.length; i++) {
            chain += `.then(function() { return ${runTestCalls[i]}; })`;
          }
          chain += '.then(function() { return __results; })';

          chainedTestCode += '\nreturn ' + chain + ';';
        } else {
          chainedTestCode += '\nreturn __results;';
        }

        // Combine helpers + test code
        const fullCode = RUNTIME_HELPERS + '\n' + chainedTestCode;

        if (process.argv.includes('--debug')) {
          console.log('--- Chained Code ---');
          console.log(chainedTestCode);
          console.log('------------');
        }

        // Execute using Promise and store result in global for retrieval
        const evalCode = `
(function() {
  ${fullCode}
})()
`;

        // First execute the code
        await send('Runtime.evaluate', {
          expression: evalCode,
          awaitPromise: true,
        });

        // Wait for all tests to complete
        // Poll until all tests have completed or timeout
        const testCount = runTestCalls.length;
        const startTime = Date.now();
        const timeout = 30000; // 30 seconds max

        while (Date.now() - startTime < timeout) {
          const check = await send('Runtime.evaluate', {
            expression: '(typeof globalThis !== "undefined" ? globalThis : this).__TASTO_RESULTS__',
            returnByValue: true,
          }) as { result?: { value?: { passed: number; failed: number; tests: unknown[] } } };

          const results = check.result?.value;
          if (results && results.tests && results.tests.length >= testCount) {
            break;
          }
          await new Promise(r => setTimeout(r, 200));
        }

        // Then get the results from global
        const result = await send('Runtime.evaluate', {
          expression: '(typeof globalThis !== "undefined" ? globalThis : this).__TASTO_RESULTS__',
          returnByValue: true,
        }) as { result?: { value?: { passed: number; failed: number } }; exceptionDetails?: { text: string; exception?: { description?: string } } };

        if (result.exceptionDetails) {
          const errMsg = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
          console.error('  Runtime error:', errMsg);
        }

        if (process.argv.includes('--debug')) {
          console.log('--- Result ---');
          console.log(JSON.stringify(result, null, 2));
          console.log('------------');
        }

        ws.close();
        resolvePromise(result.result?.value || { passed: 0, failed: 0 });
      } catch (err) {
        ws.close();
        reject(err);
      }
    };

    setTimeout(() => {
      ws.close();
      reject(new Error('Timeout'));
    }, 120000);
  });
}

async function main() {
  const args = process.argv.slice(2).filter(a => !a.startsWith('-'));

  if (args.length === 0) {
    console.log('Usage: tasto <test-file.ts>');
    process.exit(0);
  }

  // Find test files
  const files: string[] = [];
  for (let pattern of args) {
    // If pattern is a directory, look for test files inside
    const resolved = resolve(pattern);
    if (existsSync(resolved) && statSync(resolved).isDirectory()) {
      pattern = join(pattern, '**/*.test.ts');
    }

    const matches = await glob(pattern);
    // Filter to only .test.ts files and exclude shared.ts
    const testFiles = matches
      .filter(f => f.endsWith('.test.ts'))
      .map(f => resolve(f));
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
    console.log(`▸ ${basename(file)}`);

    // Process the file (inline local imports, strip @tasto/test imports)
    let code = processFile(file);

    // Transform async/await for Hermes
    code = transformAsyncAwait(code);

    try {
      if (process.argv.includes('--debug')) {
        console.log('--- Processed Code ---');
        console.log(code);
        console.log('------------');
      }

      const result = await connectAndRun(code);
      totalPassed += result.passed;
      totalFailed += result.failed;
      console.log(`  ${result.passed} passed, ${result.failed} failed\n`);
    } catch (err) {
      console.error(`  Error: ${err}\n`);
      totalFailed++;
    }
  }

  console.log('─'.repeat(40));
  console.log(`Total: ${totalPassed} passed, ${totalFailed} failed`);
  process.exit(totalFailed > 0 ? 1 : 0);
}

main();
