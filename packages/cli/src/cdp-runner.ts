/**
 * CDP Test Runner (Fallback)
 *
 * Runs tests via Chrome DevTools Protocol through Metro.
 * Used when the native WebSocket server is not available.
 */

import { readFileSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import * as esbuild from 'esbuild';

const METRO_PORT = 8081;

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  ms: number;
}

interface Results {
  passed: number;
  failed: number;
  tests: TestResult[];
}

async function getDebuggerUrl(): Promise<string> {
  const res = await fetch(`http://localhost:${METRO_PORT}/json`);
  const targets = await res.json();
  const target = targets.find((t: { webSocketDebuggerUrl?: string }) => t.webSocketDebuggerUrl);
  if (!target?.webSocketDebuggerUrl) {
    throw new Error('No debugger found. Is the app running with Metro?');
  }
  return target.webSocketDebuggerUrl;
}

/**
 * Transform async/await to promises using esbuild
 */
async function transformAsyncAwait(code: string): Promise<string> {
  const result = await esbuild.transform(code, {
    loader: 'ts',
    target: 'es2017',
    supported: { 'async-await': false },
  });
  return result.code;
}

function processFile(filePath: string, processed = new Set<string>()): string {
  if (processed.has(filePath)) return '';
  processed.add(filePath);

  let code = readFileSync(filePath, 'utf-8');
  const dir = dirname(filePath);

  const localImportRegex = /^import\s+\{([^}]+)\}\s+from\s+['"](\.[^'"]+)['"]\s*;?\s*$/gm;
  const localImports: Array<{ fullMatch: string; importPath: string }> = [];

  let match;
  while ((match = localImportRegex.exec(code)) !== null) {
    localImports.push({ fullMatch: match[0], importPath: match[2] });
  }

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

  code = code.replace(/^import\s+\{[^}]+\}\s+from\s+['"]@tasto\/test['"]\s*;?\s*$/gm, '');
  code = code.replace(/^export\s+default\s+/gm, '');
  code = code.replace(/^export\s+/gm, '');

  return inlinedCode + code;
}

const RUNTIME_HELPERS = `
var g = typeof globalThis !== 'undefined' ? globalThis : this;
g.__TASTO_RESULTS__ = { passed: 0, failed: 0, tests: [] };
var __results = g.__TASTO_RESULTS__;

var Tasto = g.__TASTO_MODULE__;
if (!Tasto) throw new Error('Tasto not initialized.');

function sleep(ms) {
  return new Promise(function(r) { setTimeout(r, ms); });
}

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
    exists: function() { return Promise.resolve(Tasto.exists(testID)); },
    isVisible: function() { return Promise.resolve(Tasto.isVisible(testID)); },
    toBeVisible: function() {
      return new Promise(function(resolve, reject) {
        if (!Tasto.isVisible(testID)) reject(new Error('Not visible: ' + testID));
        else resolve();
      });
    },
    getText: function() { return Promise.resolve(Tasto.getText(testID)); },
    scroll: function(direction, amount) {
      var dx = direction === 'left' ? -(amount||200) : direction === 'right' ? (amount||200) : 0;
      var dy = direction === 'up' ? -(amount||200) : direction === 'down' ? (amount||200) : 0;
      Tasto.scroll(testID, dx, dy);
      return sleep(100);
    }
  };
}

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

var Alert = {
  isPresent: function() { return Promise.resolve(Tasto.isAlertPresent ? Tasto.isAlertPresent() : false); },
  getText: function() { return Promise.resolve(Tasto.getAlertText ? Tasto.getAlertText() : ''); },
  tap: function(btn) {
    var ok = Tasto.tapAlertButton ? Tasto.tapAlertButton(btn) : false;
    if (!ok) throw new Error('Alert tap failed: ' + btn);
    return sleep(100);
  },
  dismiss: function() {
    if (Tasto.dismissAlert) Tasto.dismissAlert();
    return sleep(100);
  }
};

function runTest(name, fn) {
  var start = Date.now();
  return fn().then(function() {
    __results.passed++;
    __results.tests.push({ name: name, passed: true, ms: Date.now() - start });
  }).catch(function(e) {
    __results.failed++;
    __results.tests.push({ name: name, passed: false, error: e.message, ms: Date.now() - start });
  });
}
`;

export async function runTestsViaCDP(testFilePath: string): Promise<Results> {
  const wsUrl = await getDebuggerUrl();

  // Process the test file
  let code = processFile(testFilePath);

  // Strip top-level await
  code = code.replace(/^await\s+/gm, '');

  // Transform async/await to promises
  code = await transformAsyncAwait(code);

  // Find all runTest calls
  const runTestCalls: string[] = [];
  let idx = 0;
  while (idx < code.length) {
    const start = code.indexOf('runTest(', idx);
    if (start === -1) break;

    let depth = 1;
    let end = start + 8;
    while (end < code.length && depth > 0) {
      if (code[end] === '(') depth++;
      else if (code[end] === ')') depth--;
      end++;
    }

    while (end < code.length && (code[end] === ';' || code[end] === ' ' || code[end] === '\n')) {
      end++;
    }

    runTestCalls.push(code.slice(start, end).trim().replace(/;$/, ''));
    idx = end;
  }

  // Remove individual runTest calls and chain them
  let chainedCode = code;
  for (const call of runTestCalls) {
    chainedCode = chainedCode.replace(call + ';', '');
    chainedCode = chainedCode.replace(call, '');
  }

  if (runTestCalls.length > 0) {
    let chain = runTestCalls[0];
    for (let i = 1; i < runTestCalls.length; i++) {
      chain += `.then(function() { return ${runTestCalls[i]}; })`;
    }
    chain += '.then(function() { return __results; })';
    chainedCode += '\nreturn ' + chain + ';';
  } else {
    chainedCode += '\nreturn __results;';
  }

  const fullCode = RUNTIME_HELPERS + '\n' + chainedCode;

  return new Promise((resolvePromise, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map<number, (result: unknown) => void>();

    const send = (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
      return new Promise((res) => {
        const msgId = ++id;
        pending.set(msgId, res);
        ws.send(JSON.stringify({ id: msgId, method, params }));
      });
    };

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data as string);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)!(msg.result);
        pending.delete(msg.id);
      }
    };

    ws.onerror = () => reject(new Error('WebSocket error'));

    ws.onopen = async () => {
      try {
        await send('Runtime.enable');

        const evalCode = `(function() { ${fullCode} })()`;
        const execResult = await send('Runtime.evaluate', {
          expression: evalCode,
          awaitPromise: true,
        }) as { exceptionDetails?: { text: string; exception?: { description?: string } } };

        if (execResult.exceptionDetails) {
          const errMsg = execResult.exceptionDetails.exception?.description || execResult.exceptionDetails.text;
          console.error('  Execution error:', errMsg);
        }

        // Wait for tests to complete
        const testCount = runTestCalls.length;
        const startTime = Date.now();
        const timeout = 60000;

        while (Date.now() - startTime < timeout) {
          const check = await send('Runtime.evaluate', {
            expression: '(typeof globalThis !== "undefined" ? globalThis : this).__TASTO_RESULTS__',
            returnByValue: true,
          }) as { result?: { value?: Results } };

          if (check.result?.value?.tests?.length >= testCount) {
            break;
          }
          await new Promise((r) => setTimeout(r, 200));
        }

        const result = await send('Runtime.evaluate', {
          expression: '(typeof globalThis !== "undefined" ? globalThis : this).__TASTO_RESULTS__',
          returnByValue: true,
        }) as { result?: { value?: Results } };

        ws.close();
        resolvePromise(result.result?.value || { passed: 0, failed: 0, tests: [] });
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
