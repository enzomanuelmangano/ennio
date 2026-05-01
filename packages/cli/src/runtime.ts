/**
 * Tasto Test Runtime
 *
 * This module provides the test API that runs inside the React Native app.
 * It's bundled with test files and executed via Hermes CDP.
 */

// Results accumulator - stored globally for retrieval
const g = typeof globalThis !== 'undefined' ? globalThis : (this as typeof globalThis);

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

// Initialize or reset results
g.__TASTO_RESULTS__ = { passed: 0, failed: 0, tests: [] };
const __results: Results = g.__TASTO_RESULTS__;

// Get Tasto native module from global
const Tasto = g.__TASTO_MODULE__;
if (!Tasto) {
  throw new Error(
    'Tasto not initialized. Make sure @tasto/expo-plugin is configured or import @tasto/nitro in your app.'
  );
}

// ============================================
// Public API - exported for use in test files
// ============================================

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ElementAPI {
  tap(): Promise<void>;
  typeText(text: string): Promise<void>;
  clearText(): Promise<void>;
  exists(): Promise<boolean>;
  isVisible(): Promise<boolean>;
  toBeVisible(): Promise<void>;
  getText(): Promise<string>;
  scroll(direction: 'up' | 'down' | 'left' | 'right', amount?: number): Promise<void>;
}

export function element(testID: string): ElementAPI {
  return {
    tap(): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        const ok = Tasto.tap(testID);
        if (!ok) reject(new Error(`Tap failed: ${testID}`));
        else resolve();
      }).then(() => sleep(50));
    },

    typeText(text: string): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        const ok = Tasto.typeText(testID, text);
        if (!ok) reject(new Error(`TypeText failed: ${testID}`));
        else resolve();
      }).then(() => sleep(50));
    },

    clearText(): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        const ok = Tasto.clearText(testID);
        if (!ok) reject(new Error(`ClearText failed: ${testID}`));
        else resolve();
      }).then(() => sleep(50));
    },

    exists(): Promise<boolean> {
      return Promise.resolve(Tasto.exists(testID));
    },

    isVisible(): Promise<boolean> {
      return Promise.resolve(Tasto.isVisible(testID));
    },

    toBeVisible(): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        const visible = Tasto.isVisible(testID);
        if (!visible) reject(new Error(`Not visible: ${testID}`));
        else resolve();
      });
    },

    getText(): Promise<string> {
      return Promise.resolve(Tasto.getText(testID));
    },

    scroll(direction: 'up' | 'down' | 'left' | 'right', amount = 200): Promise<void> {
      Tasto.scroll(testID, direction, amount);
      return sleep(100);
    },
  };
}

export interface WaitOptions {
  timeout?: number;
}

export function waitForElement(testID: string, opts: WaitOptions = {}): Promise<void> {
  const timeout = opts.timeout || 5000;
  const start = Date.now();

  return new Promise((resolve, reject) => {
    function check() {
      if (Tasto.exists(testID)) return resolve();
      if (Date.now() - start > timeout) return reject(new Error(`Timeout: ${testID}`));
      setTimeout(check, 100);
    }
    check();
  });
}

export function waitForVisible(testID: string, opts: WaitOptions = {}): Promise<void> {
  const timeout = opts.timeout || 5000;
  const start = Date.now();

  return new Promise((resolve, reject) => {
    function check() {
      if (Tasto.isVisible(testID)) return resolve();
      if (Date.now() - start > timeout) return reject(new Error(`Timeout visible: ${testID}`));
      setTimeout(check, 100);
    }
    check();
  });
}

export const Alert = {
  isPresent(): Promise<boolean> {
    return Promise.resolve(Tasto.isAlertPresent?.() ?? false);
  },

  getText(): Promise<string> {
    return Promise.resolve(Tasto.getAlertText?.() ?? '');
  },

  getButtons(): Promise<string[]> {
    return Promise.resolve(Tasto.getAlertButtons?.() ?? []);
  },

  tap(buttonText: string): Promise<void> {
    const ok = Tasto.tapAlertButton?.(buttonText);
    if (!ok) throw new Error(`Alert tap failed: ${buttonText}`);
    return sleep(100);
  },

  dismiss(): Promise<void> {
    Tasto.dismissAlert?.();
    return sleep(100);
  },
};

export function runTest(name: string, fn: () => Promise<void>): Promise<void> {
  const start = Date.now();

  return fn()
    .then(() => {
      __results.passed++;
      __results.tests.push({ name, passed: true, ms: Date.now() - start });
    })
    .catch((e: Error) => {
      __results.failed++;
      __results.tests.push({ name, passed: false, error: e.message, ms: Date.now() - start });
    });
}

// Export results getter for the CLI to retrieve
export function __getResults(): Results {
  return __results;
}
