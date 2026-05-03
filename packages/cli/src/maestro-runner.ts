/**
 * Maestro YAML Runner
 *
 * Executes Maestro YAML test files using Ennio's WebSocket client.
 * Full Maestro command parity with built-in flakiness handling.
 */

import { EnnioClient } from './client';
import { dirname, basename, resolve } from 'path';
import { existsSync, readFileSync } from 'fs';
import { execSync, spawn } from 'child_process';
import { load as parseYaml, loadAll as parseYamlAll } from 'js-yaml';
import {
  MaestroFlow,
  MaestroCommand,
  MaestroSelector,
  MaestroCondition,
  RunFlowCommand,
  parseMaestroFile,
  normalizeSelector,
  toEnnioSelector,
  resolveSubflowPath,
} from './maestro-parser';
import {
  JsContext,
  createContext,
  preprocessCommand,
  evalScript as jsEvalScript,
  runScript as jsRunScript,
} from './js-evaluator';

// ============================================
// Configuration
// ============================================

const DEFAULT_TIMEOUT = 3000;
const DEFAULT_VISIBLE_TIMEOUT = 5000;
const DEFAULT_RETRY_INTERVAL = 30;
const DEFAULT_RECONNECT_TIMEOUT = 10000;
const DEFAULT_WS_PORT = 9876;

// ============================================
// Simulator Helpers
// ============================================

/**
 * Get the booted iOS simulator device ID
 */
function getBootedSimulatorId(): string | null {
  try {
    const output = execSync('xcrun simctl list devices booted -j', { encoding: 'utf-8' });
    const data = JSON.parse(output);
    for (const runtime of Object.values(data.devices) as Array<Array<{ udid: string; state: string }>>) {
      for (const device of runtime) {
        if (device.state === 'Booted') {
          return device.udid;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Terminate an app on simulator
 */
function terminateApp(deviceId: string, appId: string): void {
  try {
    execSync(`xcrun simctl terminate ${deviceId} ${appId}`, { encoding: 'utf-8', stdio: 'pipe' });
  } catch {
    // App may not be running - that's OK
  }
}

/**
 * Launch an app on simulator
 */
function launchAppOnSimulator(deviceId: string, appId: string): void {
  execSync(`xcrun simctl launch ${deviceId} ${appId}`, { encoding: 'utf-8', stdio: 'pipe' });
}

/**
 * Clear app state on simulator
 * This terminates the app and clears its data container (Library, Documents, tmp)
 */
function clearAppState(deviceId: string, appId: string): void {
  try {
    // Terminate first
    terminateApp(deviceId, appId);

    // Get app data container path
    const dataContainer = execSync(
      `xcrun simctl get_app_container ${deviceId} ${appId} data`,
      { encoding: 'utf-8', stdio: 'pipe' }
    ).trim();

    if (dataContainer) {
      // Clear Library (AsyncStorage, UserDefaults, etc.)
      execSync(`rm -rf "${dataContainer}/Library"/*`, { encoding: 'utf-8', stdio: 'pipe', shell: '/bin/bash' });
      // Clear Documents
      execSync(`rm -rf "${dataContainer}/Documents"/*`, { encoding: 'utf-8', stdio: 'pipe', shell: '/bin/bash' });
      // Clear tmp
      execSync(`rm -rf "${dataContainer}/tmp"/*`, { encoding: 'utf-8', stdio: 'pipe', shell: '/bin/bash' });
    }

    // Also reset privacy permissions
    execSync(`xcrun simctl privacy ${deviceId} reset all ${appId}`, { encoding: 'utf-8', stdio: 'pipe' });
  } catch {
    // Continue even if some commands fail
  }
}

// ============================================
// Types
// ============================================

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

// ============================================
// Runner
// ============================================

interface MaestroTestsResult extends RunResults {
  client: EnnioClient; // Return potentially updated client
}

/**
 * Run a Maestro YAML test file
 */
export async function runMaestroTests(
  client: EnnioClient,
  testFilePath: string,
  options: { verbose?: boolean; trace?: boolean; port?: number } = {}
): Promise<MaestroTestsResult> {
  const results: MaestroTestsResult = { passed: 0, failed: 0, tests: [], client };
  const flow = parseMaestroFile(testFilePath);
  const flowName = flow.name || basename(testFilePath, '.yaml');

  const port = options.port ?? DEFAULT_WS_PORT;

  // Create reconnect function for launchApp/clearState
  const reconnectClient = async (): Promise<EnnioClient> => {
    const newClient = new EnnioClient(port);
    await newClient.connect();
    return newClient;
  };

  const executor = new MaestroExecutor(client, testFilePath, {
    verbose: options.verbose,
    trace: options.trace,
    appId: flow.appId,
    port,
    reconnectClient,
  });

  const start = Date.now();
  try {
    await executor.executeCommands(flow.commands);
    results.passed = 1;
    results.tests.push({
      name: flowName,
      passed: true,
      ms: Date.now() - start,
    });
  } catch (err) {
    results.failed = 1;
    results.tests.push({
      name: flowName,
      passed: false,
      error: err instanceof Error ? err.message : String(err),
      ms: Date.now() - start,
    });
  }

  // Return potentially updated client (may have been replaced by launchApp/clearState)
  results.client = executor.getClient();
  return results;
}

/**
 * Maestro command executor
 */
class MaestroExecutor {
  private client: EnnioClient;
  private currentFlowPath: string;
  private executedFlows = new Set<string>();
  private lastTappedSelector: MaestroSelector | null = null;
  private verbose: boolean;
  private trace: boolean;
  private appId: string | null;
  private port: number;
  private reconnectClient: () => Promise<EnnioClient>;
  private jsContext: JsContext;

  constructor(
    client: EnnioClient,
    flowPath: string,
    options: {
      verbose?: boolean;
      trace?: boolean;
      appId?: string;
      port?: number;
      reconnectClient?: () => Promise<EnnioClient>;
    } = {}
  ) {
    this.client = client;
    this.currentFlowPath = flowPath;
    this.verbose = options.verbose ?? false;
    this.trace = options.trace ?? false;
    this.appId = options.appId ?? null;
    this.port = options.port ?? DEFAULT_WS_PORT;
    this.reconnectClient = options.reconnectClient ?? (async () => this.client);
    this.jsContext = createContext({
      platform: 'ios',
      appId: options.appId,
      isSimulator: true,
    });
  }

  private log(msg: string): void {
    if (this.verbose) {
      console.log(`    ${msg}`);
    }
  }

  /**
   * Get current client (may have been replaced by launchApp/clearState)
   */
  getClient(): EnnioClient {
    return this.client;
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /**
   * Wait for a condition to be true
   */
  private async waitFor(
    condition: () => Promise<boolean>,
    timeout: number,
    message: string
  ): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (await condition()) return;
      await this.sleep(DEFAULT_RETRY_INTERVAL);
    }
    throw new Error(`Timeout (${timeout}ms): ${message}`);
  }

  /**
   * Check if selector matches any element
   * Also checks native alerts for text-based selectors
   */
  private async selectorExists(selector: MaestroSelector): Promise<boolean> {
    const ennioSelector = toEnnioSelector(selector);

    // Check native alert for text-based selectors
    if (selector.text && !selector.id) {
      const alertPresent = await this.client.isAlertPresent();
      if (alertPresent) {
        // Check if text matches alert content or buttons
        const alertText = await this.client.getAlertText();
        if (alertText.includes(selector.text)) {
          return true;
        }
        const buttons = await this.client.getAlertButtons();
        if (buttons.includes(selector.text)) {
          return true;
        }
      }
    }

    if (ennioSelector.id && Object.keys(ennioSelector).length === 1) {
      return this.client.exists(ennioSelector.id as string);
    }
    return this.client.existsBySelector(ennioSelector);
  }

  /**
   * Check if selector is visible
   * Also checks native alerts for text-based selectors
   */
  private async selectorVisible(selector: MaestroSelector): Promise<boolean> {
    const ennioSelector = toEnnioSelector(selector);

    // Check native alert for text-based selectors
    if (selector.text && !selector.id) {
      const alertPresent = await this.client.isAlertPresent();
      if (alertPresent) {
        // Check if text matches alert content or buttons
        const alertText = await this.client.getAlertText();
        if (alertText.includes(selector.text)) {
          return true;
        }
        const buttons = await this.client.getAlertButtons();
        if (buttons.includes(selector.text)) {
          return true;
        }
      }
    }

    if (ennioSelector.id && Object.keys(ennioSelector).length === 1) {
      return this.client.isVisible(ennioSelector.id as string);
    }
    return this.client.isVisibleBySelector(ennioSelector);
  }

  /**
   * Tap on element
   * Also handles tapping native alert buttons for text-based selectors
   */
  /**
   * Best-effort tap on a native alert/action-sheet button by exact title.
   * Polls up to `pollMs` (~30ms granularity) so callers can race the alert
   * presentation. Returns true only if the button was actually tapped.
   */
  private async tryTapAlertButton(buttonText: string, pollMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < pollMs) {
      if (await this.client.isAlertPresent()) {
        const buttons = await this.client.getAlertButtons();
        if (buttons.includes(buttonText)) {
          this.log(`(tapping alert button: "${buttonText}")`);
          const ok = await this.client.tapAlertButton(buttonText);
          if (!ok) {
            throw new Error(`Alert button tap failed: ${buttonText}`);
          }
          await this.sleep(150);
          return true;
        }
      }
      await this.sleep(30);
    }
    return false;
  }

  private async tap(selector: MaestroSelector): Promise<void> {
    const ennioSelector = toEnnioSelector(selector);

    // Text-only selectors: try alert button tap first. Polls briefly because
    // Alert.alert presentation has a small animation lag after the trigger tap.
    if (selector.text && !selector.id) {
      const ok = await this.tryTapAlertButton(selector.text, 800);
      if (ok) return;
    }

    // Wait for element to exist
    await this.waitFor(
      () => this.selectorExists(selector),
      DEFAULT_VISIBLE_TIMEOUT,
      `Element not found: ${JSON.stringify(selector)}`
    );

    let ok: boolean;
    if (ennioSelector.id && Object.keys(ennioSelector).length === 1) {
      ok = await this.client.tap(ennioSelector.id as string);
    } else {
      ok = await this.client.tapBySelector(ennioSelector);
    }

    if (!ok) {
      throw new Error(`Tap failed: ${JSON.stringify(selector)}`);
    }

    // Track last tapped element for inputText
    this.lastTappedSelector = selector;
  }

  /**
   * Double tap on element
   */
  private async doubleTap(selector: MaestroSelector): Promise<void> {
    const ennioSelector = toEnnioSelector(selector);

    // Wait for element to exist
    await this.waitFor(
      () => this.selectorExists(selector),
      DEFAULT_VISIBLE_TIMEOUT,
      `Element not found: ${JSON.stringify(selector)}`
    );

    let ok: boolean;
    if (ennioSelector.id && Object.keys(ennioSelector).length === 1) {
      ok = await this.client.doubleTap(ennioSelector.id as string);
    } else {
      ok = await this.client.doubleTapBySelector(ennioSelector);
    }

    if (!ok) {
      throw new Error(`DoubleTap failed: ${JSON.stringify(selector)}`);
    }
  }

  /**
   * Type text into focused element
   */
  private async typeText(text: string, selector?: MaestroSelector): Promise<void> {
    // Use provided selector or fall back to last tapped element
    const targetSelector = selector || this.lastTappedSelector;

    if (targetSelector) {
      const ennioSelector = toEnnioSelector(targetSelector);
      await this.waitFor(
        () => this.selectorExists(targetSelector),
        DEFAULT_VISIBLE_TIMEOUT,
        `Element not found: ${JSON.stringify(targetSelector)}`
      );

      let ok: boolean;
      if (ennioSelector.id && Object.keys(ennioSelector).length === 1) {
        ok = await this.client.typeText(ennioSelector.id as string, text);
      } else {
        ok = await this.client.typeTextBySelector(ennioSelector, text);
      }

      if (!ok) {
        throw new Error(`TypeText failed: ${JSON.stringify(targetSelector)}`);
      }
    } else {
      // Try to find a focused element
      const focused = await this.client.findBySelector({ focused: true });
      if (focused?.testID) {
        const ok = await this.client.typeText(focused.testID, text);
        if (!ok) {
          throw new Error('TypeText into focused element failed');
        }
      } else {
        throw new Error('inputText: no selector provided and no focused element found');
      }
    }
  }

  /**
   * Clear text from element
   */
  private async clearText(selector: MaestroSelector): Promise<void> {
    const ennioSelector = toEnnioSelector(selector);

    await this.waitFor(
      () => this.selectorExists(selector),
      DEFAULT_VISIBLE_TIMEOUT,
      `Element not found: ${JSON.stringify(selector)}`
    );

    let ok: boolean;
    if (ennioSelector.id && Object.keys(ennioSelector).length === 1) {
      ok = await this.client.clearText(ennioSelector.id as string);
    } else {
      ok = await this.client.clearTextBySelector(ennioSelector);
    }

    if (!ok) {
      throw new Error(`ClearText failed: ${JSON.stringify(selector)}`);
    }
  }

  /**
   * Long press on element
   */
  private async longPress(selector: MaestroSelector, duration = 500): Promise<void> {
    const ennioSelector = toEnnioSelector(selector);

    await this.waitFor(
      () => this.selectorExists(selector),
      DEFAULT_VISIBLE_TIMEOUT,
      `Element not found: ${JSON.stringify(selector)}`
    );

    let ok: boolean;
    if (ennioSelector.id && Object.keys(ennioSelector).length === 1) {
      ok = await this.client.longPress(ennioSelector.id as string, duration);
    } else {
      ok = await this.client.longPressBySelector(ennioSelector, duration);
    }

    if (!ok) {
      throw new Error(`LongPress failed: ${JSON.stringify(selector)}`);
    }
  }

  /**
   * Scroll in a direction
   * Maestro scroll applies to the current visible scrollable view
   */
  private async scroll(direction: string, amount: number): Promise<void> {
    const dir = direction.toLowerCase() as 'up' | 'down' | 'left' | 'right';

    // Try common scrollable container IDs
    const scrollableIds = [
      'scroll-view',
      'scrollview',
      'flatlist',
      'profile-screen',
      'products-list',
      'cart-items-list',
      'orders-list',
      'settings-screen',
    ];

    for (const id of scrollableIds) {
      const exists = await this.client.exists(id);
      if (exists) {
        await this.client.scroll(id, dir, amount);
        await this.sleep(150);
        return;
      }
    }

    // Last resort - log warning
    this.log('scroll: no scrollable container found');
    await this.sleep(100);
  }

  /**
   * Check a condition
   */
  private async checkCondition(condition: MaestroCondition): Promise<boolean> {
    if (condition.visible) {
      return this.selectorVisible(normalizeSelector(condition.visible));
    }
    if (condition.notVisible) {
      return !(await this.selectorVisible(normalizeSelector(condition.notVisible)));
    }
    return true;
  }

  /**
   * Execute a runFlow command
   */
  private async executeRunFlow(cmd: RunFlowCommand): Promise<void> {
    // Check condition first
    if (cmd.when) {
      const conditionMet = await this.checkCondition(cmd.when);
      if (!conditionMet) {
        // Condition not met, skip this flow
        return;
      }
    }

    // Execute inline commands or file
    if (cmd.commands) {
      await this.executeCommands(cmd.commands);
    } else if (cmd.file) {
      const subflowPath = resolveSubflowPath(this.currentFlowPath, cmd.file);
      if (!existsSync(subflowPath)) {
        throw new Error(`Subflow not found: ${cmd.file}`);
      }

      // Prevent infinite recursion
      if (this.executedFlows.has(subflowPath)) {
        console.log(`  (skipping already executed flow: ${cmd.file})`);
        return;
      }

      // Execute subflow
      const savedPath = this.currentFlowPath;
      this.currentFlowPath = subflowPath;

      const subflow = parseMaestroFile(subflowPath);
      await this.executeCommands(subflow.commands);

      this.currentFlowPath = savedPath;
    }
  }

  /**
   * Execute a single command
   */
  async executeCommand(cmd: MaestroCommand): Promise<void> {
    // Preprocess command to evaluate ${} expressions
    const processedCmd = preprocessCommand(cmd, this.jsContext);

    // YAML may produce string-form commands (e.g. `- back`) or null entries.
    // Handle them before any `in` operator runs against a non-object.
    if (processedCmd == null) return;
    if (typeof processedCmd === 'string') {
      if (processedCmd === 'back') {
        await this.client.backGesture();
        await this.sleep(150);
        return;
      }
      if (processedCmd === 'hideKeyboard') {
        await this.client.hideKeyboard();
        return;
      }
      if (processedCmd === 'pasteText') {
        await this.client.pasteFromClipboard();
        return;
      }
      throw new Error(`Unknown string command: ${processedCmd}`);
    }
    if (typeof processedCmd !== 'object') {
      throw new Error(`Unsupported command type: ${typeof processedCmd}`);
    }

    // evalScript
    if ('evalScript' in processedCmd) {
      const script = (processedCmd as { evalScript: string }).evalScript;
      this.log(`evalScript: ${script.substring(0, 50)}...`);
      jsEvalScript(script, this.jsContext);
      return;
    }

    // runScript
    if ('runScript' in processedCmd) {
      const runCmd = (processedCmd as { runScript: { file: string; env?: Record<string, string> } }).runScript;
      this.log(`runScript: ${runCmd.file}`);
      jsRunScript(runCmd.file, runCmd.env || {}, this.jsContext, this.currentFlowPath);
      return;
    }

    // assertTrue
    if ('assertTrue' in processedCmd) {
      const expr = (processedCmd as { assertTrue: string }).assertTrue;
      this.log(`assertTrue: ${expr}`);
      // Remove ${} wrapper if present
      let code = expr;
      if (code.startsWith('${') && code.endsWith('}')) {
        code = code.slice(2, -1);
      }
      const result = require('vm').runInContext(code, this.jsContext, { timeout: 1000 });
      if (!result) {
        throw new Error(`assertTrue failed: ${expr}`);
      }
      return;
    }

    // Use processedCmd for the rest (expressions already evaluated)
    cmd = processedCmd;

    // tapOn
    if ('tapOn' in cmd) {
      const selector = normalizeSelector(cmd.tapOn as MaestroSelector | string);
      this.log(`tapOn: ${JSON.stringify(selector)}`);
      await this.tap(selector);
      return;
    }

    // doubleTapOn
    if ('doubleTapOn' in cmd) {
      const selector = normalizeSelector(cmd.doubleTapOn as MaestroSelector | string);
      this.log(`doubleTapOn: ${JSON.stringify(selector)}`);
      await this.doubleTap(selector);
      return;
    }

    // assertVisible (with anyOf support)
    if ('assertVisible' in cmd) {
      const assertCmd = cmd.assertVisible as MaestroSelector & { timeout?: number; anyOf?: MaestroSelector[] };
      const timeout = assertCmd.timeout ?? DEFAULT_VISIBLE_TIMEOUT;
      this.log(`assertVisible: ${JSON.stringify(assertCmd)}`);

      // Handle anyOf
      if (assertCmd.anyOf) {
        await this.waitFor(
          async () => {
            for (const selector of assertCmd.anyOf!) {
              if (await this.selectorVisible(normalizeSelector(selector))) {
                return true;
              }
            }
            return false;
          },
          timeout,
          `None of the elements visible: ${JSON.stringify(assertCmd.anyOf)}`
        );
        return;
      }

      // Standard single selector
      const { timeout: _, anyOf: __, ...selector } = assertCmd;
      await this.waitFor(
        () => this.selectorVisible(selector),
        timeout,
        `Element not visible: ${JSON.stringify(selector)}`
      );
      return;
    }

    // assertNotVisible
    if ('assertNotVisible' in cmd) {
      const { timeout = DEFAULT_TIMEOUT, ...selector } = cmd.assertNotVisible;
      await this.waitFor(
        () => this.selectorVisible(selector).then((v) => !v),
        timeout,
        `Element still visible: ${JSON.stringify(selector)}`
      );
      return;
    }

    // inputText (types into last tapped or focused element)
    if ('inputText' in cmd) {
      const text = cmd.inputText;
      this.log(`inputText: "${text}"`);
      await this.typeText(text);
      return;
    }

    // clearText
    if ('clearText' in cmd) {
      const selector = normalizeSelector(cmd.clearText as MaestroSelector | string);
      await this.clearText(selector);
      return;
    }

    // scroll
    if ('scroll' in cmd) {
      const { direction, amount = 200 } = cmd.scroll;
      await this.scroll(direction, amount);
      return;
    }

    // scrollUntilVisible
    if ('scrollUntilVisible' in cmd) {
      const scrollCmd = cmd.scrollUntilVisible as
        | MaestroSelector
        | { element: MaestroSelector; direction?: string; timeout?: number };
      const hasElement = typeof scrollCmd === 'object' && 'element' in scrollCmd;
      const selector = normalizeSelector(hasElement ? scrollCmd.element : scrollCmd as MaestroSelector);
      const direction = (hasElement ? scrollCmd.direction || 'DOWN' : 'DOWN').toLowerCase();
      const timeout = hasElement ? scrollCmd.timeout || 10000 : 10000;
      const scrollAmount = 300;

      this.log(`scrollUntilVisible: ${JSON.stringify(selector)}`);

      const startTime = Date.now();
      while (Date.now() - startTime < timeout) {
        // Check if element is visible
        if (await this.selectorVisible(selector)) {
          return;
        }
        // Scroll in direction
        await this.scroll(direction, scrollAmount);
        await this.sleep(200);
      }

      throw new Error(`scrollUntilVisible timeout: ${JSON.stringify(selector)}`);
    }

    // swipe
    if ('swipe' in cmd) {
      const swipeCmd = cmd.swipe;
      // Maestro swipe can be:
      // - { start: "50%,80%", end: "50%,20%" }
      // - { direction: "UP", duration: 500 }
      // - { start: { x: 100, y: 500 }, end: { x: 100, y: 200 } }
      if (swipeCmd.direction) {
        // Use direction-based scroll (same as scroll command)
        const amount = swipeCmd.duration || 400;
        await this.scroll(swipeCmd.direction.toLowerCase(), amount);
      } else if (swipeCmd.start && swipeCmd.end) {
        // Coordinate-based swipe - TODO: implement with native gesture
        this.log(`swipe: from ${JSON.stringify(swipeCmd.start)} to ${JSON.stringify(swipeCmd.end)}`);
        // For now, approximate with scroll
        await this.sleep(100);
      }
      return;
    }

    // longPress
    if ('longPress' in cmd) {
      const selector = normalizeSelector(cmd.longPress as MaestroSelector | string);
      await this.longPress(selector);
      return;
    }

    // back (hardware back button)
    if ('back' in cmd) {
      // Send back command - this may need native implementation
      console.log('  (back command - simulating)');
      await this.sleep(100);
      return;
    }

    // runFlow
    if ('runFlow' in cmd) {
      if (cmd.runFlow.file) {
        this.log(`runFlow: ${cmd.runFlow.file}`);
      } else if (cmd.runFlow.when) {
        this.log(`runFlow (conditional): ${JSON.stringify(cmd.runFlow.when)}`);
      }
      await this.executeRunFlow(cmd.runFlow);
      return;
    }

    // waitFor
    if ('waitFor' in cmd) {
      const { timeout = DEFAULT_VISIBLE_TIMEOUT, ...selector } = cmd.waitFor;
      await this.waitFor(
        () => this.selectorExists(selector),
        timeout,
        `Element not found: ${JSON.stringify(selector)}`
      );
      return;
    }

    // launchApp - restart the app
    if ('launchApp' in cmd) {
      const launchCmd = cmd.launchApp;
      const shouldClearState = typeof launchCmd === 'object' && launchCmd.clearState === true;
      const targetAppId = (typeof launchCmd === 'object' && launchCmd.appId) || this.appId;

      if (!targetAppId) {
        throw new Error('launchApp: No appId specified in command or flow metadata');
      }

      const deviceId = getBootedSimulatorId();
      if (!deviceId) {
        throw new Error('launchApp: No booted iOS simulator found');
      }

      this.log(`launchApp: ${targetAppId}${shouldClearState ? ' (clearState)' : ''}`);

      // Disconnect current WebSocket
      this.client.disconnect();

      // Clear state if requested. clearAppState already terminates the app.
      if (shouldClearState) {
        clearAppState(deviceId, targetAppId);
      } else {
        terminateApp(deviceId, targetAppId);
      }

      // Launch immediately. simctl launch is synchronous-ish; the app is
      // running by the time it returns. No fixed pre-sleep needed.
      launchAppOnSimulator(deviceId, targetAppId);

      // Tight reconnect loop. Native auto-init binds WS once the JS bundle
      // boots and RCTHost.start fires. With a warm Metro this is ~1-2s.
      let connected = false;
      const startTime = Date.now();
      while (!connected && Date.now() - startTime < DEFAULT_RECONNECT_TIMEOUT) {
        try {
          this.client = await this.reconnectClient();
          connected = true;
        } catch {
          await this.sleep(100);
        }
      }

      if (!connected) {
        throw new Error('launchApp: Failed to reconnect to app after restart');
      }

      // Settle: wait for shadow tree to commit at least once.
      try {
        await this.client.waitForIdle(3000);
      } catch {
        // Continue even if waitForIdle times out
      }

      this.log('launchApp: Reconnected');
      return;
    }

    // clearState - clear app data without full restart
    if ('clearState' in cmd) {
      const clearCmd = cmd.clearState;
      const targetAppId = (typeof clearCmd === 'object' && clearCmd.appId) || this.appId;

      if (!targetAppId) {
        throw new Error('clearState: No appId specified in command or flow metadata');
      }

      const deviceId = getBootedSimulatorId();
      if (!deviceId) {
        throw new Error('clearState: No booted iOS simulator found');
      }

      this.log(`clearState: ${targetAppId}`);

      this.client.disconnect();
      clearAppState(deviceId, targetAppId);
      launchAppOnSimulator(deviceId, targetAppId);

      let connected = false;
      const startTime = Date.now();
      while (!connected && Date.now() - startTime < DEFAULT_RECONNECT_TIMEOUT) {
        try {
          this.client = await this.reconnectClient();
          connected = true;
        } catch {
          await this.sleep(100);
        }
      }
      if (!connected) {
        throw new Error('clearState: Failed to reconnect to app after restart');
      }
      try {
        await this.client.waitForIdle(3000);
      } catch {
        // Continue even if waitForIdle times out
      }

      this.log('clearState: App restarted with fresh state');
      return;
    }

    // stopApp
    if ('stopApp' in cmd) {
      const stopCmd = cmd.stopApp;
      const targetAppId = (typeof stopCmd === 'object' && stopCmd.appId) || this.appId;

      if (!targetAppId) {
        throw new Error('stopApp: No appId specified in command or flow metadata');
      }

      const deviceId = getBootedSimulatorId();
      if (!deviceId) {
        throw new Error('stopApp: No booted iOS simulator found');
      }

      this.log(`stopApp: ${targetAppId}`);
      terminateApp(deviceId, targetAppId);
      return;
    }

    // openLink
    if ('openLink' in cmd) {
      const linkCmd = cmd.openLink;
      const url = typeof linkCmd === 'string' ? linkCmd : linkCmd.link;

      const deviceId = getBootedSimulatorId();
      if (!deviceId) {
        throw new Error('openLink: No booted iOS simulator found');
      }

      this.log(`openLink: ${url}`);
      execSync(`xcrun simctl openurl ${deviceId} "${url}"`, { encoding: 'utf-8', stdio: 'pipe' });
      await this.sleep(500);
      return;
    }

    // takeScreenshot
    if ('takeScreenshot' in cmd) {
      const screenshotCmd = cmd.takeScreenshot;
      const path = typeof screenshotCmd === 'string' ? screenshotCmd : screenshotCmd.path;

      const deviceId = getBootedSimulatorId();
      if (!deviceId) {
        throw new Error('takeScreenshot: No booted iOS simulator found');
      }

      this.log(`takeScreenshot: ${path}`);
      execSync(`xcrun simctl io ${deviceId} screenshot "${path}"`, { encoding: 'utf-8', stdio: 'pipe' });
      return;
    }

    // eraseText
    if ('eraseText' in cmd) {
      const eraseCmd = cmd.eraseText;
      const chars = typeof eraseCmd === 'number' ? eraseCmd : (eraseCmd.characters || 50);
      this.log(`eraseText: ${chars} characters`);
      await this.client.eraseText(chars);
      return;
    }

    // hideKeyboard
    if ('hideKeyboard' in cmd) {
      this.log('hideKeyboard');
      await this.client.hideKeyboard();
      return;
    }

    // pressKey
    if ('pressKey' in cmd) {
      const keyName = cmd.pressKey as string;
      this.log(`pressKey: ${keyName}`);
      await this.client.pressKey(keyName);
      return;
    }

    // copyTextFrom
    if ('copyTextFrom' in cmd) {
      const target = cmd.copyTextFrom as MaestroSelector;
      this.log(`copyTextFrom: ${JSON.stringify(target)}`);
      // Get text from element and copy to clipboard
      const selector = toEnnioSelector(target);
      const text = await this.client.getTextBySelector(selector);
      if (text) {
        await this.client.copyToClipboard(text);
      }
      return;
    }

    // pasteText
    if ('pasteText' in cmd) {
      this.log('pasteText');
      await this.client.pasteFromClipboard();
      return;
    }

    // setClipboard
    if ('setClipboard' in cmd) {
      const text = cmd.setClipboard as string;
      this.log(`setClipboard: ${text}`);
      await this.client.copyToClipboard(text);
      return;
    }

    // back (iOS back gesture)
    if ('back' in cmd) {
      this.log('back gesture');
      await this.client.backGesture();
      return;
    }

    // repeat
    if ('repeat' in cmd) {
      const { times, commands } = cmd.repeat;
      this.log(`repeat: ${times} times`);
      for (let i = 0; i < times; i++) {
        await this.executeCommands(commands);
      }
      return;
    }

    // retry
    if ('retry' in cmd) {
      const { maxRetries = 3, commands } = cmd.retry;
      this.log(`retry: max ${maxRetries}`);
      let lastError: Error | null = null;
      for (let i = 0; i <= maxRetries; i++) {
        try {
          await this.executeCommands(commands);
          return; // Success
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          if (i < maxRetries) {
            this.log(`retry: attempt ${i + 1} failed, retrying...`);
            await this.sleep(500);
          }
        }
      }
      throw lastError || new Error('retry: all attempts failed');
    }

    // setLocation
    if ('setLocation' in cmd) {
      const locCmd = cmd.setLocation;
      let lat: number, lon: number;

      if (typeof locCmd === 'string') {
        // Parse "lat,lon" string
        const [latStr, lonStr] = locCmd.split(',');
        lat = parseFloat(latStr);
        lon = parseFloat(lonStr);
      } else {
        lat = locCmd.latitude;
        lon = locCmd.longitude;
      }

      const deviceId = getBootedSimulatorId();
      if (!deviceId) {
        throw new Error('setLocation: No booted iOS simulator found');
      }

      this.log(`setLocation: ${lat}, ${lon}`);
      execSync(`xcrun simctl location ${deviceId} set ${lat},${lon}`, { encoding: 'utf-8', stdio: 'pipe' });
      return;
    }

    // setPermissions
    if ('setPermissions' in cmd) {
      const permissions = cmd.setPermissions;
      const deviceId = getBootedSimulatorId();
      if (!deviceId) {
        throw new Error('setPermissions: No booted iOS simulator found');
      }

      const targetAppId = this.appId;
      if (!targetAppId) {
        throw new Error('setPermissions: No appId specified');
      }

      this.log(`setPermissions: ${JSON.stringify(permissions)}`);

      // Map permission names to simctl privacy service names
      const permissionMap: Record<string, string> = {
        notifications: 'notifications',
        photos: 'photos',
        camera: 'camera',
        microphone: 'microphone',
        location: 'location',
        contacts: 'contacts',
        calendar: 'calendar',
        reminders: 'reminders',
        medialibrary: 'media-library',
        bluetooth: 'bluetooth',
      };

      for (const [perm, action] of Object.entries(permissions)) {
        const service = permissionMap[perm.toLowerCase()] || perm;
        const simctlAction = action === 'allow' ? 'grant' : action === 'deny' ? 'revoke' : 'reset';
        try {
          execSync(`xcrun simctl privacy ${deviceId} ${simctlAction} ${service} ${targetAppId}`, {
            encoding: 'utf-8',
            stdio: 'pipe',
          });
        } catch {
          // Some permissions may not be supported
          this.log(`setPermissions: ${perm} - ${action} (may not be supported)`);
        }
      }
      return;
    }

    // startRecording
    if ('startRecording' in cmd) {
      const recCmd = cmd.startRecording;
      const path = typeof recCmd === 'string' ? recCmd : recCmd.path;

      const deviceId = getBootedSimulatorId();
      if (!deviceId) {
        throw new Error('startRecording: No booted iOS simulator found');
      }

      this.log(`startRecording: ${path}`);
      // Start recording in background - spawn without waiting
      spawn('xcrun', ['simctl', 'io', deviceId, 'recordVideo', path], {
        detached: true,
        stdio: 'ignore',
      }).unref();
      await this.sleep(500);
      return;
    }

    // stopRecording
    if ('stopRecording' in cmd) {
      this.log('stopRecording');
      // Kill any running simctl recordVideo processes
      try {
        execSync('pkill -f "simctl io.*recordVideo"', { encoding: 'utf-8', stdio: 'pipe' });
      } catch {
        // Process may not exist
      }
      await this.sleep(500);
      return;
    }

    // addMedia
    if ('addMedia' in cmd) {
      const mediaCmd = cmd.addMedia;
      const files = Array.isArray(mediaCmd) ? mediaCmd : mediaCmd.files;

      const deviceId = getBootedSimulatorId();
      if (!deviceId) {
        throw new Error('addMedia: No booted iOS simulator found');
      }

      this.log(`addMedia: ${files.join(', ')}`);
      for (const file of files) {
        execSync(`xcrun simctl addmedia ${deviceId} "${file}"`, { encoding: 'utf-8', stdio: 'pipe' });
      }
      return;
    }

    // waitForAnimationToEnd
    if ('waitForAnimationToEnd' in cmd) {
      const waitCmd = cmd.waitForAnimationToEnd;
      const timeout = typeof waitCmd === 'object' && waitCmd.timeout ? waitCmd.timeout : 5000;
      this.log(`waitForAnimationToEnd: timeout=${timeout}ms`);
      try {
        await this.client.waitForIdle(timeout);
      } catch {
        // Continue even if idle detection times out
      }
      return;
    }

    // extendedWaitUntil
    if ('extendedWaitUntil' in cmd) {
      const { visible, notVisible, timeout = 10000 } = cmd.extendedWaitUntil;
      this.log(`extendedWaitUntil: timeout=${timeout}ms`);

      if (visible) {
        const selector = normalizeSelector(visible);
        await this.waitFor(
          () => this.selectorVisible(selector),
          timeout,
          `Element not visible: ${JSON.stringify(selector)}`
        );
      }
      if (notVisible) {
        const selector = normalizeSelector(notVisible);
        await this.waitFor(
          () => this.selectorVisible(selector).then((v) => !v),
          timeout,
          `Element still visible: ${JSON.stringify(selector)}`
        );
      }
      return;
    }

    console.log(`  (unknown command: ${JSON.stringify(cmd)})`);
  }

  /**
   * Execute a list of commands
   */
  async executeCommands(commands: MaestroCommand[]): Promise<void> {
    for (const cmd of commands) {
      await this.executeCommand(cmd);
      if (this.trace) {
        await this.snapshotState(cmd);
      }
    }
  }

  /**
   * Capture the booted-simulator accessibility tree via the `argent` CLI and
   * print a one-line summary of the top labels. Used in --trace mode so the
   * runner makes its expectations of state explicit between every step,
   * letting us catch state drift the moment it happens (instead of waiting
   * for the next assertVisible to time out).
   */
  private async snapshotState(cmd: MaestroCommand): Promise<void> {
    try {
      const udid = getBootedSimulatorId();
      if (!udid) return;
      const out = execSync(`argent run describe --udid ${udid} --json`, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 8000,
      });
      const tree = JSON.parse(out);
      const labels: string[] = [];
      const walk = (node: { label?: string; value?: string; children?: unknown[] }) => {
        if (labels.length >= 12) return;
        const txt = node.label ?? node.value;
        if (txt) labels.push(String(txt).slice(0, 30));
        if (Array.isArray(node.children)) {
          for (const c of node.children) walk(c as never);
        }
      };
      if (tree && typeof tree === 'object' && 'tree' in tree) walk(tree.tree as never);
      else if (tree && typeof tree === 'object') walk(tree as never);
      const cmdName = typeof cmd === 'string' ? cmd : Object.keys(cmd)[0];
      console.log(`    [trace ${cmdName}] ${labels.join(' | ')}`);
    } catch {
      // Trace is best-effort; never break a flow.
    }
  }
}
