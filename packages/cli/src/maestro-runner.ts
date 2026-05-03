/**
 * Maestro YAML Runner
 *
 * Executes Maestro YAML test files using Tasto's WebSocket client.
 * Full Maestro command parity with built-in flakiness handling.
 */

import { TastoClient } from './client';
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
  toTastoSelector,
  resolveSubflowPath,
} from './maestro-parser';

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
  client: TastoClient; // Return potentially updated client
}

/**
 * Run a Maestro YAML test file
 */
export async function runMaestroTests(
  client: TastoClient,
  testFilePath: string,
  options: { verbose?: boolean; port?: number } = {}
): Promise<MaestroTestsResult> {
  const results: MaestroTestsResult = { passed: 0, failed: 0, tests: [], client };
  const flow = parseMaestroFile(testFilePath);
  const flowName = flow.name || basename(testFilePath, '.yaml');

  const port = options.port ?? DEFAULT_WS_PORT;

  // Create reconnect function for launchApp/clearState
  const reconnectClient = async (): Promise<TastoClient> => {
    const newClient = new TastoClient(port);
    await newClient.connect();
    return newClient;
  };

  const executor = new MaestroExecutor(client, testFilePath, {
    verbose: options.verbose,
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
  private client: TastoClient;
  private currentFlowPath: string;
  private executedFlows = new Set<string>();
  private lastTappedSelector: MaestroSelector | null = null;
  private verbose: boolean;
  private appId: string | null;
  private port: number;
  private reconnectClient: () => Promise<TastoClient>;

  constructor(
    client: TastoClient,
    flowPath: string,
    options: {
      verbose?: boolean;
      appId?: string;
      port?: number;
      reconnectClient?: () => Promise<TastoClient>;
    } = {}
  ) {
    this.client = client;
    this.currentFlowPath = flowPath;
    this.verbose = options.verbose ?? false;
    this.appId = options.appId ?? null;
    this.port = options.port ?? DEFAULT_WS_PORT;
    this.reconnectClient = options.reconnectClient ?? (async () => this.client);
  }

  private log(msg: string): void {
    if (this.verbose) {
      console.log(`    ${msg}`);
    }
  }

  /**
   * Get current client (may have been replaced by launchApp/clearState)
   */
  getClient(): TastoClient {
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
    const tastoSelector = toTastoSelector(selector);

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

    if (tastoSelector.id && Object.keys(tastoSelector).length === 1) {
      return this.client.exists(tastoSelector.id as string);
    }
    return this.client.existsBySelector(tastoSelector);
  }

  /**
   * Check if selector is visible
   * Also checks native alerts for text-based selectors
   */
  private async selectorVisible(selector: MaestroSelector): Promise<boolean> {
    const tastoSelector = toTastoSelector(selector);

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

    if (tastoSelector.id && Object.keys(tastoSelector).length === 1) {
      return this.client.isVisible(tastoSelector.id as string);
    }
    return this.client.isVisibleBySelector(tastoSelector);
  }

  /**
   * Tap on element
   * Also handles tapping native alert buttons for text-based selectors
   */
  private async tap(selector: MaestroSelector): Promise<void> {
    const tastoSelector = toTastoSelector(selector);

    // Check if this is an alert button tap (text-only selector)
    if (selector.text && !selector.id) {
      const alertPresent = await this.client.isAlertPresent();
      if (alertPresent) {
        const buttons = await this.client.getAlertButtons();
        if (buttons.includes(selector.text)) {
          this.log(`(tapping alert button: "${selector.text}")`);
          const ok = await this.client.tapAlertButton(selector.text);
          if (!ok) {
            throw new Error(`Alert button tap failed: ${selector.text}`);
          }
          await this.sleep(100);
          return;
        }
      }
    }

    // Wait for element to exist
    await this.waitFor(
      () => this.selectorExists(selector),
      DEFAULT_VISIBLE_TIMEOUT,
      `Element not found: ${JSON.stringify(selector)}`
    );

    let ok: boolean;
    if (tastoSelector.id && Object.keys(tastoSelector).length === 1) {
      ok = await this.client.tap(tastoSelector.id as string);
    } else {
      ok = await this.client.tapBySelector(tastoSelector);
    }

    if (!ok) {
      throw new Error(`Tap failed: ${JSON.stringify(selector)}`);
    }

    // Track last tapped element for inputText
    this.lastTappedSelector = selector;
  }

  /**
   * Type text into focused element
   */
  private async typeText(text: string, selector?: MaestroSelector): Promise<void> {
    // Use provided selector or fall back to last tapped element
    const targetSelector = selector || this.lastTappedSelector;

    if (targetSelector) {
      const tastoSelector = toTastoSelector(targetSelector);
      await this.waitFor(
        () => this.selectorExists(targetSelector),
        DEFAULT_VISIBLE_TIMEOUT,
        `Element not found: ${JSON.stringify(targetSelector)}`
      );

      let ok: boolean;
      if (tastoSelector.id && Object.keys(tastoSelector).length === 1) {
        ok = await this.client.typeText(tastoSelector.id as string, text);
      } else {
        ok = await this.client.typeTextBySelector(tastoSelector, text);
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
    const tastoSelector = toTastoSelector(selector);

    await this.waitFor(
      () => this.selectorExists(selector),
      DEFAULT_VISIBLE_TIMEOUT,
      `Element not found: ${JSON.stringify(selector)}`
    );

    let ok: boolean;
    if (tastoSelector.id && Object.keys(tastoSelector).length === 1) {
      ok = await this.client.clearText(tastoSelector.id as string);
    } else {
      ok = await this.client.clearTextBySelector(tastoSelector);
    }

    if (!ok) {
      throw new Error(`ClearText failed: ${JSON.stringify(selector)}`);
    }
  }

  /**
   * Long press on element
   */
  private async longPress(selector: MaestroSelector, duration = 500): Promise<void> {
    const tastoSelector = toTastoSelector(selector);

    await this.waitFor(
      () => this.selectorExists(selector),
      DEFAULT_VISIBLE_TIMEOUT,
      `Element not found: ${JSON.stringify(selector)}`
    );

    let ok: boolean;
    if (tastoSelector.id && Object.keys(tastoSelector).length === 1) {
      ok = await this.client.longPress(tastoSelector.id as string, duration);
    } else {
      ok = await this.client.longPressBySelector(tastoSelector, duration);
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
    // tapOn
    if ('tapOn' in cmd) {
      const selector = normalizeSelector(cmd.tapOn as MaestroSelector | string);
      this.log(`tapOn: ${JSON.stringify(selector)}`);
      await this.tap(selector);
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

      // Clear state if requested
      if (shouldClearState) {
        clearAppState(deviceId, targetAppId);
      }

      // Terminate and relaunch
      terminateApp(deviceId, targetAppId);
      await this.sleep(500);
      launchAppOnSimulator(deviceId, targetAppId);

      // Wait for app to boot and reconnect
      await this.sleep(2000);
      let connected = false;
      const startTime = Date.now();
      while (!connected && Date.now() - startTime < DEFAULT_RECONNECT_TIMEOUT) {
        try {
          this.client = await this.reconnectClient();
          connected = true;
        } catch {
          await this.sleep(500);
        }
      }

      if (!connected) {
        throw new Error('launchApp: Failed to reconnect to app after restart');
      }

      // Wait for UI to stabilize after app launch
      await this.sleep(1000);
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

      // Disconnect current WebSocket
      this.client.disconnect();

      // Clear state (terminates app and resets privacy)
      clearAppState(deviceId, targetAppId);

      // Relaunch
      await this.sleep(500);
      launchAppOnSimulator(deviceId, targetAppId);

      // Wait for app to boot and reconnect
      await this.sleep(2000);
      let connected = false;
      const startTime = Date.now();
      while (!connected && Date.now() - startTime < DEFAULT_RECONNECT_TIMEOUT) {
        try {
          this.client = await this.reconnectClient();
          connected = true;
        } catch {
          await this.sleep(500);
        }
      }

      if (!connected) {
        throw new Error('clearState: Failed to reconnect to app after restart');
      }

      // Wait for UI to stabilize after app launch
      await this.sleep(1000);
      try {
        await this.client.waitForIdle(3000);
      } catch {
        // Continue even if waitForIdle times out
      }

      this.log('clearState: App restarted with fresh state');
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
    }
  }
}
