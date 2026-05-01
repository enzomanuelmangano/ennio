/**
 * Chrome DevTools Protocol Client
 *
 * Connects to Metro's debugger endpoint to execute JavaScript
 * in the Hermes runtime.
 */

const METRO_PORT = 8081;

interface CDPTarget {
  webSocketDebuggerUrl?: string;
  title?: string;
}

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

/**
 * Get the WebSocket debugger URL from Metro.
 */
async function getDebuggerUrl(): Promise<string> {
  const res = await fetch(`http://localhost:${METRO_PORT}/json`);
  const targets: CDPTarget[] = await res.json();
  const target = targets.find((t) => t.webSocketDebuggerUrl);

  if (!target?.webSocketDebuggerUrl) {
    throw new Error('No debugger found. Is the app running with Metro?');
  }

  return target.webSocketDebuggerUrl;
}

/**
 * Execute test code in the app via CDP and return results.
 */
export async function executeTests(
  bundledCode: string,
  expectedTestCount: number
): Promise<Results> {
  const wsUrl = await getDebuggerUrl();

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

    ws.onerror = () => reject(new Error('WebSocket connection error'));

    ws.onopen = async () => {
      try {
        await send('Runtime.enable');

        // Execute the bundled test code
        const evalCode = `
(function() {
  try {
    ${bundledCode}
    return (typeof globalThis !== 'undefined' ? globalThis : this).__TASTO_RESULTS__;
  } catch (e) {
    return { passed: 0, failed: 0, tests: [], error: e.message };
  }
})()
`;

        const execResult = (await send('Runtime.evaluate', {
          expression: evalCode,
          awaitPromise: true,
          returnByValue: true,
        })) as {
          result?: { value?: Results & { error?: string } };
          exceptionDetails?: { text: string; exception?: { description?: string } };
        };

        if (execResult.exceptionDetails) {
          const errMsg =
            execResult.exceptionDetails.exception?.description || execResult.exceptionDetails.text;
          console.error('  Execution error:', errMsg);
          ws.close();
          resolvePromise({ passed: 0, failed: 0, tests: [] });
          return;
        }

        // Wait for all tests to complete
        const startTime = Date.now();
        const timeout = 60000; // 60 seconds max per file

        while (Date.now() - startTime < timeout) {
          const check = (await send('Runtime.evaluate', {
            expression:
              '(typeof globalThis !== "undefined" ? globalThis : this).__TASTO_RESULTS__',
            returnByValue: true,
          })) as { result?: { value?: Results } };

          const results = check.result?.value;
          if (results?.tests && results.tests.length >= expectedTestCount) {
            break;
          }
          await new Promise((r) => setTimeout(r, 200));
        }

        // Get final results
        const finalResult = (await send('Runtime.evaluate', {
          expression:
            '(typeof globalThis !== "undefined" ? globalThis : this).__TASTO_RESULTS__',
          returnByValue: true,
        })) as { result?: { value?: Results } };

        ws.close();
        resolvePromise(finalResult.result?.value || { passed: 0, failed: 0, tests: [] });
      } catch (err) {
        ws.close();
        reject(err);
      }
    };

    // Global timeout
    setTimeout(() => {
      ws.close();
      reject(new Error('Test execution timeout'));
    }, 120000);
  });
}
