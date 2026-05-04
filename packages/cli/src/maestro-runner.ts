/**
 * Maestro YAML Runner
 *
 * Executes Maestro YAML test files using Ennio's WebSocket client.
 * Full Maestro command parity with built-in flakiness handling.
 */

import { EnnioClient } from './client';
import { XCTestClient, type ScreenSize } from './xctest-client';
import type { Writer, StableContext } from './writer';
import type { Reader } from './reader';
import { basename } from 'path';
import { existsSync } from 'fs';
import { execSync, spawn } from 'child_process';
import {
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

/**
 * Parse a Maestro point spec — either "X%,Y%" / "X,Y" string or
 * { x, y } object — into normalised 0..1 screen coords. Percentages
 * map directly. Bare numbers are treated as percentages too (Maestro
 * convention).
 */
function parseMaestroPoint(p: string | { x: number | string; y: number | string }): { x: number; y: number } {
  const parseFrac = (v: string | number): number => {
    if (typeof v === 'number') return v > 1 ? v / 100 : v;
    const m = String(v).trim().replace('%', '');
    const n = parseFloat(m);
    if (!Number.isFinite(n)) throw new Error(`tapOn point: invalid value "${v}"`);
    return n > 1 ? n / 100 : n;
  };
  if (typeof p === 'string') {
    const parts = p.split(',');
    if (parts.length !== 2) throw new Error(`tapOn point: expected "X%,Y%", got "${p}"`);
    return { x: parseFrac(parts[0]), y: parseFrac(parts[1]) };
  }
  return { x: parseFrac(p.x), y: parseFrac(p.y) };
}

const DEFAULT_TIMEOUT = 3000;
const DEFAULT_VISIBLE_TIMEOUT = 5000;
const DEFAULT_RETRY_INTERVAL = 30;
const DEFAULT_RECONNECT_TIMEOUT = 30000;
const DEFAULT_WS_PORT = 9876;

// ============================================
// Simulator Helpers
// ============================================

/**
 * Get the booted iOS simulator device ID
 */
function getBootedSimulatorId(): string | null {
  // Honor ENNIO_UDID env override so tests pin to a specific simulator
  // even when other sims are booted (avoid argent / xcrun picking wrong one).
  if (process.env.ENNIO_UDID) return process.env.ENNIO_UDID;
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
    // simctl terminate returns before the process is fully reaped — the
    // app can still hold open handles on its sandbox for ~150ms. Wait
    // long enough that AsyncStorage's last flush completes before we
    // wipe its files; otherwise the next launch reads stale demo-user
    // state from a half-truncated manifest.
    execSync('sleep 0.4', { stdio: 'pipe' });

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
  writer: Writer,
  reader: Reader,
  xctest: XCTestClient | null,
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

  const executor = new MaestroExecutor(client, writer, reader, xctest, testFilePath, {
    verbose: options.verbose,
    trace: options.trace,
    appId: flow.appId,
    port,
    reconnectClient,
    env: flow.env,
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
    // Snap before xcodebuild cleanup tears down the user app.
    const udid = getBootedSimulatorId();
    if (udid) {
      const shotPath = `/tmp/ennio-shots/${basename(testFilePath, '.yaml')}-fail.png`;
      try {
        execSync(`mkdir -p /tmp/ennio-shots && xcrun simctl io ${udid} screenshot "${shotPath}"`, {
          encoding: 'utf-8',
          stdio: 'pipe',
        });
        console.log(`  (saved screenshot: ${shotPath})`);
      } catch { /* noop */ }
    }
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
  private writer: Writer;
  private reader: Reader;
  private xctest: XCTestClient | null;
  private currentFlowPath: string;
  private executedFlows = new Set<string>();
  private lastTappedSelector: MaestroSelector | null = null;
  private verbose: boolean;
  private trace: boolean;
  private appId: string | null;
  private reconnectClient: () => Promise<EnnioClient>;
  private jsContext: JsContext;
  private flowEnv: Record<string, string> = {};

  constructor(
    client: EnnioClient,
    writer: Writer,
    reader: Reader,
    xctest: XCTestClient | null,
    flowPath: string,
    options: {
      verbose?: boolean;
      trace?: boolean;
      appId?: string;
      port?: number;
      reconnectClient?: () => Promise<EnnioClient>;
      env?: Record<string, string>;
    } = {}
  ) {
    this.client = client;
    this.writer = writer;
    this.reader = reader;
    this.xctest = xctest;
    this.currentFlowPath = flowPath;
    this.verbose = options.verbose ?? false;
    this.trace = options.trace ?? false;
    this.appId = options.appId ?? null;
    this.reconnectClient = options.reconnectClient ?? (async () => this.client);
    this.flowEnv = { ...(options.env || {}) };
    this.jsContext = createContext({
      platform: 'ios',
      appId: options.appId,
      isSimulator: true,
    });
    // Expose flow env vars in the JS context so `${VAR}` interpolation
    // resolves them inline.
    for (const [key, value] of Object.entries(this.flowEnv)) {
      (this.jsContext as Record<string, unknown>)[key] = value;
    }
  }

  private logStart = Date.now();
  private log(msg: string): void {
    if (this.verbose) {
      const ms = Date.now() - this.logStart;
      console.log(`    [+${ms}ms] ${msg}`);
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

    // Native alert check first — UIAlertController contents only the
    // in-app helper sees (not Fabric, not XCUI's label search reliably).
    if (selector.text && !selector.id) {
      if (await this.reader.isAlertPresent()) {
        const alertText = await this.reader.getAlertText();
        if (alertText.includes(selector.text)) return true;
        const buttons = await this.reader.getAlertButtons();
        if (buttons.includes(selector.text)) return true;
      }
    }
    if (ennioSelector.id && Object.keys(ennioSelector).length === 1) {
      return this.reader.existsById(ennioSelector.id as string);
    }
    return this.reader.existsBySelector(ennioSelector);
  }

  private async selectorVisible(selector: MaestroSelector): Promise<boolean> {
    const ennioSelector = toEnnioSelector(selector);

    if (selector.text && !selector.id) {
      if (await this.reader.isAlertPresent()) {
        const alertText = await this.reader.getAlertText();
        if (alertText.includes(selector.text)) return true;
        const buttons = await this.reader.getAlertButtons();
        if (buttons.includes(selector.text)) return true;
      }
    }
    if (ennioSelector.id && Object.keys(ennioSelector).length === 1) {
      return this.reader.isVisibleById(ennioSelector.id as string);
    }
    return this.reader.isVisibleBySelector(ennioSelector);
  }

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
          await this.writer.tapAlertButton(buttonText);
          await this.sleep(150);
          // Drain any queued / re-presented alerts. A synthesized
          // touch can occasionally double-fire the trigger handler,
          // queueing a second alert behind the first one. Dismiss in
          // a tight loop until the stack clears or we hit the cap.
          for (let i = 0; i < 8; i++) {
            if (!(await this.client.isAlertPresent())) return true;
            await this.writer.dismissAlert();
            await this.sleep(120);
          }
          return true;
        }
      }
      await this.sleep(30);
    }
    return false;
  }

  private async tap(selector: MaestroSelector): Promise<void> {
    // Point selector — Maestro `tapOn: { point: "X%,Y%" }`. Resolve to a
    // normalised window coordinate and dispatch directly via the writer.
    if (selector.point) {
      const { x, y } = parseMaestroPoint(selector.point);
      this.log(`tap: point ${(x * 100).toFixed(1)}%,${(y * 100).toFixed(1)}%`);
      await this.writer.tapAt(x, y);
      this.lastTappedSelector = selector;
      await this.sleep(60);
      return;
    }
    // Text-only selectors: try alert button tap first. Polls long enough
    // (2s) for Alert.alert's presentation animation to finish — the
    // dialog typically appears 300-1500ms after the triggering tap.
    if (selector.text && !selector.id) {
      const ok = await this.tryTapAlertButton(selector.text, 2000);
      if (ok) return;
    }

    if (selector.id) {
      await this.waitFor(
        () => this.selectorExists(selector),
        DEFAULT_VISIBLE_TIMEOUT,
        `Element not found: ${JSON.stringify(selector)}`
      );
    }

    const tryOnce = async (): Promise<boolean> => {
      if (selector.id && !selector.text && Object.keys(toEnnioSelector(selector)).length === 1) {
        return this.writer.tap(selector.id);
      }
      if (selector.text && !selector.id) {
        return this.writer.tapByText(selector.text);
      }
      return this.writer.tapBySelector(toEnnioSelector(selector));
    };

    const start = Date.now();
    let ok = false;
    let backAttempts = 0;
    while (Date.now() - start < DEFAULT_VISIBLE_TIMEOUT) {
      ok = await tryOnce();
      if (ok) break;
      // Stack-pushed-over-tab-bar recovery: if a text-only selector keeps
      // missing AND no alert is sitting on top, pop the nav stack and
      // retry. The alert check is critical — without it we'd dismiss an
      // alert whose button we were trying to tap but couldn't see in the
      // 2s window above (e.g. slow simulator).
      const alertUp = !!selector.text && !selector.id && (await this.reader.isAlertPresent());
      if (!ok && selector.text && !selector.id && !alertUp && backAttempts < 3) {
        backAttempts++;
        this.log(`tap retry: popping stack (attempt ${backAttempts})`);
        await this.writer.back();
        await this.sleep(250);
        continue;
      }
      // If an alert IS up and we still can't tap it, retry the alert
      // button path — XCUI may have missed the button on the first sweep.
      if (alertUp) {
        const alertOk = await this.tryTapAlertButton(selector.text!, 1500);
        if (alertOk) return;
      }
      await this.sleep(DEFAULT_RETRY_INTERVAL);
    }
    if (!ok) throw new Error(`Tap failed: ${JSON.stringify(selector)}`);
    this.log(`tap: ${JSON.stringify(selector)} via ${this.writer.describe('tap')}`);
    this.lastTappedSelector = selector;
    // Tiny settle: lets React commit the synchronous onPress side
    // effect (state update, immediate router.push). Async chains that
    // wait on network / setTimeout / Promise need an explicit
    // `waitForAnimationToEnd` in the flow YAML — auto-waiting on every
    // tap punishes flows that don't need it.
    await this.sleep(60);
  }

  private async doubleTap(selector: MaestroSelector): Promise<void> {
    await this.waitFor(
      () => this.selectorExists(selector),
      DEFAULT_VISIBLE_TIMEOUT,
      `Element not found: ${JSON.stringify(selector)}`
    );
    let ok = false;
    if (selector.id && !selector.text) ok = await this.writer.doubleTap(selector.id);
    else ok = await this.writer.doubleTapBySelector(toEnnioSelector(selector));
    if (!ok) throw new Error(`DoubleTap failed: ${JSON.stringify(selector)}`);
    this.lastTappedSelector = selector;
  }

  private async typeText(text: string, selector?: MaestroSelector): Promise<void> {
    const targetSelector = selector || this.lastTappedSelector;
    if (targetSelector) {
      await this.waitFor(
        () => this.selectorExists(targetSelector),
        DEFAULT_VISIBLE_TIMEOUT,
        `Element not found: ${JSON.stringify(targetSelector)}`
      );
      const sameAsLast = this.lastTappedSelector
        && JSON.stringify(this.lastTappedSelector) === JSON.stringify(targetSelector);
      if (!sameAsLast) {
        if (targetSelector.id && !targetSelector.text) {
          await this.writer.tap(targetSelector.id);
        } else if (targetSelector.text && !targetSelector.id) {
          await this.writer.tapByText(targetSelector.text);
        } else {
          await this.writer.tapBySelector(toEnnioSelector(targetSelector));
        }
        this.lastTappedSelector = targetSelector;
        await this.sleep(120);
      }
      // Direct typeText into the targeted field (fast path) or focused
      // field (stable path - testID is ignored by XCTestWriter).
      const id = targetSelector.id ?? null;
      await this.writer.typeText(id, text);
    } else {
      await this.writer.typeText(null, text);
    }
    await this.sleep(60);
  }

  private async clearText(selector: MaestroSelector): Promise<void> {
    await this.waitFor(
      () => this.selectorExists(selector),
      DEFAULT_VISIBLE_TIMEOUT,
      `Element not found: ${JSON.stringify(selector)}`
    );
    if (selector.id) {
      const ok = await this.writer.clearText(selector.id);
      if (!ok) throw new Error(`ClearText failed: ${JSON.stringify(selector)}`);
    } else {
      const ok = await this.writer.clearTextBySelector(toEnnioSelector(selector));
      if (!ok) throw new Error(`ClearText failed: ${JSON.stringify(selector)}`);
    }
    this.lastTappedSelector = selector;
  }

  private async longPress(selector: MaestroSelector, duration = 500): Promise<void> {
    await this.waitFor(
      () => this.selectorExists(selector),
      DEFAULT_VISIBLE_TIMEOUT,
      `Element not found: ${JSON.stringify(selector)}`
    );
    let ok = false;
    if (selector.id && !selector.text) ok = await this.writer.longPress(selector.id, duration);
    else ok = await this.writer.longPressBySelector(toEnnioSelector(selector), duration);
    if (!ok) throw new Error(`LongPress failed: ${JSON.stringify(selector)}`);
    this.lastTappedSelector = selector;
  }

  private async scroll(direction: string, amount: number): Promise<void> {
    const dir = direction.toLowerCase() as 'up' | 'down' | 'left' | 'right';
    if (dir !== 'up' && dir !== 'down' && dir !== 'left' && dir !== 'right') {
      this.log(`scroll: unknown direction ${direction}`);
      return;
    }
    await this.writer.scroll(null, dir, amount);
    await this.sleep(120);
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
        await this.writer.back();
        await this.sleep(120);
        return;
      }
      if (processedCmd === 'hideKeyboard') {
        await this.writer.hideKeyboard();
        return;
      }
      if (processedCmd === 'pasteText') {
        await this.writer.pasteToFocused();
        return;
      }
      if (processedCmd === 'waitForAnimationToEnd') {
        // Bare string `- waitForAnimationToEnd`. Maestro's default is 5s
        // but most RN transitions settle in 200-400ms — the long tail is
        // network spinners that the test isn't waiting on anyway. Cap
        // at 500ms so flows on apps that never fully idle (Reanimated at
        // 60Hz, looped springs, polling timers) don't pay 5s per step.
        try { await this.client.waitForIdle(500); } catch { /* timeouts ignored */ }
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
      // Merge flow-level env with per-command env (per-command wins).
      const mergedEnv = { ...this.flowEnv, ...(runCmd.env || {}) };
      jsRunScript(runCmd.file, mergedEnv, this.jsContext, this.currentFlowPath);
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
      if (swipeCmd.direction) {
        const amount = swipeCmd.duration || 400;
        await this.scroll(swipeCmd.direction.toLowerCase(), amount);
      } else if (swipeCmd.start && swipeCmd.end && this.xctest) {
        // Coordinate-form swipe is only meaningful with the XCTest helper
        // (drag from absolute (x,y) to absolute (x,y) requires HID injection).
        // In fast mode, fall back to a directional scroll guess.
        const screen = await this.xctest.getScreenSize();
        const toNorm = (p: string | { x: number; y: number }): { x: number; y: number } => {
          if (typeof p === 'string') {
            const [xs, ys] = p.split(',').map((s) => s.trim());
            const x = xs.endsWith('%') ? parseFloat(xs) / 100 : parseFloat(xs) / screen.width;
            const y = ys.endsWith('%') ? parseFloat(ys) / 100 : parseFloat(ys) / screen.height;
            return { x, y };
          }
          return { x: p.x / screen.width, y: p.y / screen.height };
        };
        const from = toNorm(swipeCmd.start);
        const to = toNorm(swipeCmd.end);
        await this.xctest.swipe(from.x, from.y, to.x, to.y, swipeCmd.duration ?? 300);
      } else if (swipeCmd.start && swipeCmd.end) {
        // Fast mode: best-effort vertical scroll inferred from y-delta.
        const dy = (typeof swipeCmd.end === 'object' ? swipeCmd.end.y : 0) - (typeof swipeCmd.start === 'object' ? swipeCmd.start.y : 0);
        await this.writer.scroll(null, dy >= 0 ? 'down' : 'up', Math.abs(dy) || 200);
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

      // Brief settle so the simulator finishes wiping data containers
      // before we launch the next instance. Skipping this on iOS 26 sim
      // can produce a Hermes BCProvider SIGSEGV when the new process
      // races the previous one's teardown.
      await this.sleep(800);

      launchAppOnSimulator(deviceId, targetAppId);

      // Reconnect with patience. App needs to: cold-start, load JS bundle
      // (Metro served), fire RCTHost.start, then bind WS server.
      let connected = false;
      const startTime = Date.now();
      while (!connected && Date.now() - startTime < DEFAULT_RECONNECT_TIMEOUT) {
        try {
          this.client = await this.reconnectClient();
          connected = true;
        } catch {
          await this.sleep(200);
        }
      }

      if (!connected) {
        throw new Error('launchApp: Failed to reconnect to app after restart');
      }

      // Wait for first shadow tree commit so the next assertVisible has
      // something to query.
      await this.sleep(400);
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
      await this.writer.eraseText(this.lastTappedSelector?.id ?? null, chars);
      return;
    }

    // hideKeyboard
    if ('hideKeyboard' in cmd) {
      this.log('hideKeyboard');
      await this.writer.hideKeyboard();
      return;
    }

    // pressKey
    if ('pressKey' in cmd) {
      const keyName = cmd.pressKey as string;
      this.log(`pressKey: ${keyName}`);
      await this.writer.pressKey(this.lastTappedSelector?.id ?? null, keyName);
      return;
    }

    // copyTextFrom
    if ('copyTextFrom' in cmd) {
      const target = cmd.copyTextFrom as MaestroSelector;
      this.log(`copyTextFrom: ${JSON.stringify(target)}`);
      const selector = toEnnioSelector(target);
      const text = await this.client.getTextBySelector(selector);
      if (text) {
        await this.writer.setClipboard(text);
      }
      return;
    }

    // pasteText
    if ('pasteText' in cmd) {
      this.log('pasteText');
      await this.writer.pasteToFocused();
      return;
    }

    // setClipboard
    if ('setClipboard' in cmd) {
      const text = cmd.setClipboard as string;
      this.log(`setClipboard: ${text}`);
      await this.writer.setClipboard(text);
      return;
    }

    // back (iOS back gesture)
    if ('back' in cmd) {
      this.log('back gesture');
      await this.writer.back();
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
      const timeout = typeof waitCmd === 'object' && waitCmd.timeout ? waitCmd.timeout : 500;
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
   * Print a one-line trace marker between commands. We used to dump the
   * iOS a11y tree here via `argent describe`, but argent is no longer a
   * dependency. Keep the hook so flows can stay verbose-instrumented; the
   * caller can extend this to call `client.findBySelector` for richer info.
   */
  private async snapshotState(cmd: MaestroCommand): Promise<void> {
    if (!this.trace) return;
    const cmdName = typeof cmd === 'string' ? cmd : Object.keys(cmd as object)[0];
    console.log(`    [trace ${cmdName}]`);
  }
}
