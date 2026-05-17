/**
 * Maestro YAML Runner
 *
 * Executes Maestro YAML test files. Talks to the app over Hermes
 * Inspector CDP (via `client.ts`) and actuates touches via the
 * persistent HID daemon (via `writer.ts`). Full Maestro command parity
 * with built-in flakiness handling.
 */

import { EnnioClient } from './client';
import type { Writer } from './writer';
import type { Reader } from './reader';
import { basename } from 'path';
import { existsSync } from 'fs';
import { execSync, spawn } from 'child_process';
import { runInContext } from 'vm';
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

// Maestro convention: a bare number "50" is interpreted as 50% (not as
// 50 pixels), so values > 1 are normalised to 0..1 fractions. A trailing
// "%" is accepted but not required.
function parseMaestroPoint(p: string | { x: number | string; y: number | string }): {
  x: number;
  y: number;
} {
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

// Per-command timing constants. All in ms unless noted. Pulled from the
// magic numbers the audit flagged inside executeCommand — naming them
// here makes intent explicit and the values tune-able from one place.
const ALERT_TAP_SETTLE_MS = 150; // Wait for alert-button tap to dismiss the alert.
const ALERT_DISMISS_DELAY_MS = 120; // Settle between dismissAlert and the next assertion.
const RUNLOOP_TICK_MS = 30; // UITouch begin→end gap; matches the native sendSynth tick.
const TAP_NAV_SETTLE_MS = 150; // Tab/Link nav settle. prepareTap's stable-coord + hit-test verify catches the "responder chain not yet bound" race on the next tap, so this only covers commands that don't go through prepareTap (e.g. assertVisible). Kept short.
const TAP_BACK_RECOVER_DELAY_MS = 250; // Pause between back-pop and retry tap.
const KEYBOARD_DISMISS_SETTLE_MS = 120; // Settle after hideKeyboard before re-tapping the field.
const POST_LAUNCH_SETTLE_MS = 400; // Wait for sim teardown after clearState before relaunch.
const POST_LAUNCH_IDLE_BUDGET_MS = 1500; // First waitForIdle after a launch.
const TYPE_TEXT_IDLE_BUDGET_MS = 600; // Drain RN bridge after typeText so onChangeText commits before the next tap reads `value`.
const POST_LAUNCH_SHADOW_COMMIT_MS = 250; // First shadow-tree commit settle after reconnect.
const RETRY_POLL_MS = 100; // Predicate retry tick for waitFor / extendedWaitUntil.
const POINT_TAP_SETTLE_MS = 60; // Quick settle after tapAt — no tab-nav animation.
const RECORDING_SETTLE_MS = 500; // Settle after start/stopRecording so the next step sees a stable IO state.
const RETRY_BACKOFF_MS = 500; // Pause between retry attempts inside `retry` block.
const TRAVEL_WAYPOINT_GAP_MS = 200; // Gap between successive simctl location fixes during `travel`.
const OPENLINK_SETTLE_MS = 500; // Wait for SpringBoard to switch contexts after openurl.
const SWIPE_SETTLE_MS = 800; // Post-swipe settle. Covers onMomentumEnd → tree-reconcile gap on 120 Hz devices, where a shorter wait left the next frame query reading the mid-decel position.

/**
 * Maestro per-command `optional: true`. Lives at the command level
 * (e.g. `tapOn: { id: cookie-banner, optional: true }`) and at the
 * action level for some commands (`assertVisible: { id: x, optional: true }`).
 * We treat any nested object that has `optional === true` on its
 * top level as flagging the whole command optional.
 */
function isOptional(cmd: unknown): boolean {
  if (!cmd || typeof cmd !== 'object') return false;
  const values = Object.values(cmd as Record<string, unknown>);
  for (const v of values) {
    if (v && typeof v === 'object' && (v as { optional?: boolean }).optional === true) {
      return true;
    }
  }
  return false;
}

// ============================================
// Target Helpers (Simulator + Physical Device)
// ============================================

type TargetType = 'simulator' | 'device';

/**
 * Detect whether the chosen UDID is a Simulator or a physical device.
 * Returns 'simulator' if the UDID appears in `xcrun simctl list devices`,
 * 'device' otherwise (anything reachable via idb / devicectl).
 */
export function getTargetType(udid: string): TargetType {
  try {
    const out = execSync(`xcrun simctl list devices ${udid} -j`, {
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    const data = JSON.parse(out);
    for (const runtime of Object.values(data.devices) as { udid: string }[][]) {
      for (const d of runtime) {
        if (d.udid === udid) return 'simulator';
      }
    }
  } catch {
    /* fall through */
  }
  return 'device';
}

/**
 * Resolve the active iOS target UDID. Honours ENNIO_UDID, then falls
 * back to the first booted Simulator.
 */
export function getBootedSimulatorId(): string | null {
  // Honor ENNIO_UDID env override so tests pin to a specific simulator
  // even when other sims are booted (xcrun's first-booted heuristic
  // can otherwise pick the wrong one on multi-sim setups).
  if (process.env.ENNIO_UDID) return process.env.ENNIO_UDID;
  try {
    const output = execSync('xcrun simctl list devices booted -j', { encoding: 'utf-8' });
    const data = JSON.parse(output);
    for (const runtime of Object.values(data.devices) as { udid: string; state: string }[][]) {
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
 * Terminate an app on the active target. Sim → simctl; device → devicectl.
 * idb is avoided on iOS 26+ — its bundled DeveloperDiskImage tops out
 * at 16.4 and rejects launches with "not suitable for 26.x".
 */
function terminateApp(deviceId: string, appId: string): void {
  try {
    if (getTargetType(deviceId) === 'simulator') {
      execSync(`xcrun simctl terminate ${deviceId} ${appId}`, { encoding: 'utf-8', stdio: 'pipe' });
    } else {
      // devicectl wants the bundle's PID — resolve via list, then signal.
      // Falls back silently if process isn't running.
      execSync(
        `xcrun devicectl device process terminate --device ${deviceId} --bundle-identifier ${appId}`,
        { encoding: 'utf-8', stdio: 'pipe' },
      );
    }
  } catch {
    // App may not be running — that's OK
  }
}

/**
 * Launch an app on the active target. Sim → simctl; device → devicectl.
 * Same iOS 26 reasoning as terminateApp above.
 */
export function launchAppOnSimulator(deviceId: string, appId: string): void {
  if (getTargetType(deviceId) === 'simulator') {
    execSync(`xcrun simctl launch ${deviceId} ${appId}`, { encoding: 'utf-8', stdio: 'pipe' });
  } else {
    execSync(`xcrun devicectl device process launch --device ${deviceId} ${appId}`, {
      encoding: 'utf-8',
      stdio: 'pipe',
    });
  }
}

/**
 * Throw a consistent error when a command is sim-only and the active
 * target is a physical device. iOS doesn't expose simctl-equivalents for
 * status_bar / location / privacy / keychain on real hardware — instead
 * of failing with a cryptic shell error, we surface the gap loudly so a
 * device-mode run can either skip the flow or fall back manually.
 */
function requireSimulator(deviceId: string, label: string): void {
  if (getTargetType(deviceId) !== 'simulator') {
    throw new Error(`${label}: not supported on physical device (simulator-only API)`);
  }
}

/**
 * Capture a screenshot from the active target. Sim → simctl io; device → idb screenshot.
 * Returns true on success, false on any failure (caller treats as best-effort).
 */
export function captureScreenshot(deviceId: string, path: string): boolean {
  try {
    if (getTargetType(deviceId) === 'simulator') {
      execSync(`xcrun simctl io ${deviceId} screenshot "${path}"`, {
        encoding: 'utf-8',
        stdio: 'pipe',
      });
    } else {
      // No supported on-device screenshot path under iOS 26: devicectl
      // exposes none, idb's `screenshotr` service errors with 0xe8000022,
      // and pymobiledevice3 isn't a hard dependency. Treat as a no-op so
      // failure-diagnostics screenshots don't kill the run.
      return false;
    }
    return true;
  } catch {
    return false;
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
  testFilePath: string,
  options: { verbose?: boolean; trace?: boolean } = {},
): Promise<MaestroTestsResult> {
  const results: MaestroTestsResult = { passed: 0, failed: 0, tests: [], client };
  const flow = parseMaestroFile(testFilePath);
  const flowName = flow.name || basename(testFilePath, '.yaml');

  // Initial socket attach. Bootstrap connected CDP; the socket is opened
  // here so the first tab tap of the first flow doesn't pay the CDP
  // queue. If it fails (older Ennio build with no socket server, or
  // sim/path resolution issue), CDP is the fallback for every dispatch.
  if (flow.appId) {
    await client.ensureSocketConnected(flow.appId, process.env.ENNIO_UDID);
  }

  // Re-attach to the Inspector after launchApp/clearState. Same
  // transport (CDP), but device id changes when Metro re-attaches.
  // Also re-opens the Unix-domain control socket against the fresh
  // app process — its tmp dir path changes per launch.
  const reconnectClient = async (): Promise<EnnioClient> => {
    const newClient = new EnnioClient();
    await newClient.connect();
    if (flow.appId) {
      // Best-effort. Socket discovery shells out to simctl; if it
      // fails (no booted sim, app not yet installed, etc.), CDP is
      // the fallback for every dispatch.
      await newClient.ensureSocketConnected(flow.appId, process.env.ENNIO_UDID);
    }
    return newClient;
  };

  const executor = new MaestroExecutor(client, writer, reader, testFilePath, {
    verbose: options.verbose,
    trace: options.trace,
    appId: flow.appId,
    reconnectClient,
    env: flow.env,
  });

  const start = Date.now();
  try {
    // onFlowStart — run setup hooks before main commands. Failures here
    // are fatal: the flow's invariants haven't been established, so the
    // body would be testing the wrong state.
    if (flow.onFlowStart && flow.onFlowStart.length > 0) {
      await executor.executeCommands(flow.onFlowStart);
    }
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
        execSync('mkdir -p /tmp/ennio-shots', { encoding: 'utf-8', stdio: 'pipe' });
      } catch {
        /* noop */
      }
      if (captureScreenshot(udid, shotPath)) {
        console.log(`  (saved screenshot: ${shotPath})`);
      }
    }
    results.failed = 1;
    results.tests.push({
      name: flowName,
      passed: false,
      error: err instanceof Error ? err.message : String(err),
      ms: Date.now() - start,
    });
  } finally {
    // onFlowComplete — always runs (success or failure). Failures here
    // are logged, never propagated: a teardown hook breaking shouldn't
    // mask a flow's real result.
    if (flow.onFlowComplete && flow.onFlowComplete.length > 0) {
      try {
        await executor.executeCommands(flow.onFlowComplete);
      } catch (e) {
        console.log(`  (onFlowComplete failed: ${(e as Error).message})`);
      }
    }
  }

  // Surface the per-bucket timing breakdown in --verbose mode so the
  // operator can see which op-types dominated this flow without
  // grepping through the per-step log. Cheap — runs once per flow.
  executor.printProfileSummary();

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
  private currentFlowPath: string;
  private executedFlows = new Set<string>();
  private lastTappedSelector: MaestroSelector | null = null;
  private verbose: boolean;
  private trace: boolean;
  private appId: string | null;
  private reconnectClient: () => Promise<EnnioClient>;
  private jsContext: JsContext;
  private flowEnv: Record<string, string> = {};
  // Tracks airplane-mode state so `toggleAirplaneMode` knows which way to
  // flip without parsing `simctl status_bar list` output. Initialised to
  // false because every fresh sim boots without an override.
  private airplaneOn: boolean = false;

  constructor(
    client: EnnioClient,
    writer: Writer,
    reader: Reader,
    flowPath: string,
    options: {
      verbose?: boolean;
      trace?: boolean;
      appId?: string;
      reconnectClient?: () => Promise<EnnioClient>;
      env?: Record<string, string>;
    } = {},
  ) {
    this.client = client;
    this.writer = writer;
    this.reader = reader;
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
  private logPrev = Date.now();
  // Per-step timing breadcrumbs. Each verbose log line gets its delta
  // recorded here, then `printProfileSummary` buckets them by op-type
  // at flow end so the operator sees "tab tap: 6× = 21 ms, id tap: 14×
  // = 3287 ms" without grepping. Always collected when verbose is on.
  private profileEvents: { msg: string; delta: number }[] = [];

  private log(msg: string): void {
    if (this.verbose) {
      const now = Date.now();
      const ms = now - this.logStart;
      const delta = now - this.logPrev;
      this.logPrev = now;
      // `+NNNms` = cumulative wall clock from runner start.
      // `ΔNNNms` = time since previous log line — surfaces per-step
      // cost without grepping. Padded so the columns align in a
      // verbose dump for visual scanning.
      const cum = `+${ms}ms`.padStart(8);
      const d = `Δ${delta}ms`.padStart(7);
      console.log(`    [${cum} ${d}] ${msg}`);
      this.profileEvents.push({ msg, delta });
    }
  }

  /**
   * Classify a log message into a coarse op-type bucket. Regex-based
   * so call sites don't have to change. New categories should mirror
   * what an operator naturally groups when reading the verbose dump.
   */
  private bucketFor(msg: string): string {
    if (msg.startsWith('launchApp')) return 'launchApp';
    if (msg.startsWith('tap: ') && /text/.test(msg) && /Cart|Products|Home|Profile/.test(msg))
      return 'tab tap (text)';
    if (msg.startsWith('tap: ') && /"id"/.test(msg)) return 'id tap';
    if (msg.startsWith('tap: point')) return 'point tap';
    if (msg.startsWith('tapOn: ') && /"id"/.test(msg)) return 'tapOn (auto-scroll + setup)';
    if (msg.startsWith('tapOn: ') && /text/.test(msg)) return 'tapOn (text)';
    if (msg.startsWith('assertVisible') || msg.startsWith('assertNotVisible'))
      return 'assertVisible';
    if (msg.startsWith('scrollUntilVisible')) return 'scrollUntilVisible';
    if (msg.startsWith('scroll') || msg.startsWith('swipe')) return 'scroll/swipe';
    if (msg.startsWith('runFlow')) return 'runFlow';
    if (msg.startsWith('(tapping alert button')) return 'alert tap';
    if (msg.startsWith('hideKeyboard')) return 'hideKeyboard';
    if (msg.startsWith('inputText') || msg.startsWith('typeText')) return 'typeText';
    return 'other';
  }

  printProfileSummary(): void {
    if (!this.verbose || this.profileEvents.length === 0) return;
    const buckets = new Map<string, { total: number; count: number }>();
    let total = 0;
    for (const e of this.profileEvents) {
      total += e.delta;
      const b = this.bucketFor(e.msg);
      const cur = buckets.get(b) ?? { total: 0, count: 0 };
      cur.total += e.delta;
      cur.count += 1;
      buckets.set(b, cur);
    }
    const rows = Array.from(buckets.entries())
      .map(([name, { total: t, count }]) => ({ name, total: t, count }))
      .sort((a, b) => b.total - a.total);
    console.log('');
    console.log('  ── Profile (verbose) ─────────────────────────');
    console.log(
      `    ${'bucket'.padEnd(34)} ${'count'.padStart(5)}  ${'total'.padStart(8)}  ${'avg'.padStart(6)}   pct`,
    );
    for (const r of rows) {
      const pct = total > 0 ? ((r.total / total) * 100).toFixed(1) : '0.0';
      const avg = r.count > 0 ? Math.round(r.total / r.count) : 0;
      console.log(
        `    ${r.name.padEnd(34)} ${String(r.count).padStart(5)}  ${`${r.total}ms`.padStart(8)}  ${`${avg}ms`.padStart(6)}  ${pct.padStart(4)}%`,
      );
    }
    console.log(`    ${'TOTAL'.padEnd(34)} ${' '.padStart(5)}  ${`${total}ms`.padStart(8)}`);
    console.log('  ──────────────────────────────────────────────');
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
   * Wake the moment React fires onCommitFiberRoot, capped at maxMs.
   * Replaces blind sleep settles after React-driven mutations (taps,
   * navigations, keyboard dismissals). The cap is the safety floor —
   * worst case is identical to a sleep of the same duration.
   */
  private async waitCommit(maxMs: number): Promise<void> {
    // Fixed sleep — the React-commit signal (`__ennio_native_onCommit`)
    // races React's own devtools-hook binding on Bridgeless and often
    // never fires, and IdleMonitor doesn't observe UIKit transitions
    // (router.push, modal present). The caller's `maxMs` is sized for
    // the worst case of whatever it just did (tap-nav: 500 ms;
    // alert/keyboard: 120-250 ms; point-tap: 60 ms).
    await this.sleep(maxMs);
  }

  /**
   * Wait for a condition to be true
   */
  private async waitFor(
    condition: () => Promise<boolean>,
    timeout: number,
    message: string,
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

    // Native alert check first — UIAlertController contents are visible
    // to the in-app helper but not to Fabric's shadow tree.
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
          await this.waitCommit(ALERT_TAP_SETTLE_MS);
          // Drain any queued / re-presented alerts. A synthesized
          // touch can occasionally double-fire the trigger handler,
          // queueing a second alert behind the first one. Dismiss in
          // a tight loop until the stack clears or we hit the cap.
          for (let i = 0; i < 8; i++) {
            if (!(await this.client.isAlertPresent())) return true;
            await this.writer.dismissAlert();
            await this.waitCommit(ALERT_DISMISS_DELAY_MS);
          }
          return true;
        }
      }
      await this.sleep(RUNLOOP_TICK_MS);
    }
    return false;
  }

  private async tap(selector: MaestroSelector, opts: { optional?: boolean } = {}): Promise<void> {
    // Point selector — Maestro `tapOn: { point: "X%,Y%" }`. Resolve to a
    // normalised window coordinate and dispatch directly via the writer.
    if (selector.point) {
      const { x, y } = parseMaestroPoint(selector.point);
      this.log(`tap: point ${(x * 100).toFixed(1)}%,${(y * 100).toFixed(1)}%`);
      await this.writer.tapAt(x, y);
      this.lastTappedSelector = selector;
      await this.waitCommit(POINT_TAP_SETTLE_MS);
      return;
    }
    // Text-only selectors: tab-bar fast path FIRST. tapTabByName runs
    // via the Unix-domain control socket — ~5 ms, bypasses CDP / JS
    // thread. If the text matches a tab name, this short-circuits the
    // ~2 s alert-poll below entirely. Tab swaps account for ~44% of
    // a typical flow's wall clock, so this is the biggest single win.
    //
    // Falls through to the alert-poll + tryOnce loop when the text
    // isn't a tab name (regular button labels, alert buttons, etc.).
    if (selector.text && !selector.id) {
      // Guard: skip the fast-path when an alert is presented. Otherwise
      // tapping a tab whose name collides with an alert button text
      // would swap tabs behind the still-presented alert — the test
      // would silently target the wrong screen. isAlertPresent itself
      // routes via the socket (~3 ms) so the guard is cheap.
      const alertUp = await this.reader.isAlertPresent();
      if (!alertUp) {
        const r = await this.client.send('tapTabByName', { name: selector.text });
        if (r?.success === true) {
          this.log(`tap: ${JSON.stringify(selector)} via ${this.writer.describe('tap')}`);
          this.lastTappedSelector = selector;
          // Minimal post-tap settle — prepareTap on the next tap polls
          // its own stable-coord + hit-test verify, absorbing the
          // destination-tab first-commit gap.
          await new Promise((r) => setTimeout(r, 100));
          return;
        }
      }
    }
    // Text-only selectors: try native UISearchBar focus. The RNScreens
    // UISearchBar isn't in the React view tree — placeholder text
    // matches don't resolve via the shadow-tree text walk and the
    // HID fallback enters a slow back-stack-pop retry loop (~19 s on
    // iOS 26 sim). focusSearchBar returns true only when a visible
    // search bar's placeholder matches; otherwise we fall through.
    if (selector.text && !selector.id) {
      const sb = await this.client.send('focusSearchBar', {
        placeholder: selector.text,
      });
      if (sb?.success === true) {
        this.log(`tap: ${JSON.stringify(selector)} via search bar focus`);
        this.lastTappedSelector = selector;
        await this.waitCommit(TAP_NAV_SETTLE_MS);
        return;
      }
    }

    // Text-only selectors: try native UIPickerView wheel selection.
    // HID swipes against a UIPickerView spinner are flaky on iOS 26
    // simulator (touch begin/end timing doesn't always cross the pan
    // recogniser threshold and the wheel snaps back). When a picker
    // is visible and the requested text matches a row label, drive
    // the wheel via [picker selectRow:] + delegate didSelectRow so
    // RNCPicker emits onValueChange deterministically. Cheap UIKit
    // walk (~3 ms) — runs before the 2s alert poll so picker taps
    // don't pay alert-poll latency. No-op when no picker on screen.
    if (selector.text && !selector.id) {
      const r = await this.client.send('selectPickerValueByLabel', {
        label: selector.text,
      });
      if (r?.success === true) {
        this.log(`tap: ${JSON.stringify(selector)} via picker selectRow`);
        this.lastTappedSelector = selector;
        await this.waitCommit(TAP_NAV_SETTLE_MS);
        return;
      }
    }

    // Text-only selectors: try alert button tap. Polls long enough
    // (2s) for Alert.alert's presentation animation to finish — the
    // dialog typically appears 300-1500ms after the triggering tap.
    // Optional taps cap at 200ms — we don't want to wait for an alert
    // that the test never expected to be present.
    if (selector.text && !selector.id) {
      const alertPoll = opts.optional ? 200 : 2000;
      const ok = await this.tryTapAlertButton(selector.text, alertPoll);
      if (ok) return;
    }

    if (selector.id) {
      // id-based taps target an in-tree React view, not a native alert
      // button. If a native alert is sitting on top from a prior step
      // (Alert.alert(...) inside an onPress that the test didn't tap
      // through) it blocks every touch. Dismiss it first so the next
      // step doesn't get stuck on it forever.
      if (await this.reader.isAlertPresent()) {
        this.log('(auto-dismissing stale alert before id-tap)');
        await this.writer.dismissAlert();
        await this.waitCommit(TAP_NAV_SETTLE_MS);
      }
      await this.waitFor(
        () => this.selectorExists(selector),
        opts.optional ? 500 : DEFAULT_VISIBLE_TIMEOUT,
        `Element not found: ${JSON.stringify(selector)}`,
      );
    }

    const tryOnce = async (): Promise<boolean> => {
      if (selector.id && !selector.text && Object.keys(toEnnioSelector(selector)).length === 1) {
        return this.writer.tap(selector.id);
      }
      if (selector.text && !selector.id) {
        return this.writer.tapByText(selector.text, { fast: opts.optional === true });
      }
      return this.writer.tapBySelector(toEnnioSelector(selector));
    };

    const start = Date.now();
    // Optional taps shouldn't burn the full visible-element timeout when
    // the element is missing — that's the expected outcome. Cap at 500ms
    // and disable the stack-pop recovery loop entirely.
    const tapTimeout = opts.optional ? 500 : DEFAULT_VISIBLE_TIMEOUT;
    const allowStackPop = !opts.optional;
    let ok = false;
    let backAttempts = 0;
    while (Date.now() - start < tapTimeout) {
      ok = await tryOnce();
      if (ok) break;
      const alertUp = !!selector.text && !selector.id && (await this.reader.isAlertPresent());
      if (allowStackPop && !ok && selector.text && !selector.id && !alertUp && backAttempts < 3) {
        backAttempts++;
        this.log(`tap retry: popping stack (attempt ${backAttempts})`);
        await this.writer.back();
        await this.waitCommit(TAP_BACK_RECOVER_DELAY_MS);
        continue;
      }
      // If an alert IS up and we still can't tap it, retry the alert
      // button path — the alert may have appeared mid-poll and the first
      // sweep raced its presentation.
      if (alertUp) {
        const alertOk = await this.tryTapAlertButton(selector.text!, 1500);
        if (alertOk) return;
      }
      await this.sleep(DEFAULT_RETRY_INTERVAL);
    }
    if (!ok) throw new Error(`Tap failed: ${JSON.stringify(selector)}`);
    this.log(`tap: ${JSON.stringify(selector)} via ${this.writer.describe('tap')}`);
    this.lastTappedSelector = selector;
    // Direct onPress dispatch (writer's primary path) is synchronous, but
    // the resulting React work — setState, transition commit, native tab
    // switch animation — is not. Tab-switching taps and Link navigation
    // need ~150-250 ms before the destination surface is queryable. The
    // commit-signal wake fires the moment React finishes the commit
    // triggered by onPress, capped by TAP_NAV_SETTLE_MS for safety.
    await this.waitCommit(TAP_NAV_SETTLE_MS);
  }

  /**
   * waitFor with exponential-backoff retry. If `predicate` returns false
   * for `maxMs` total, re-runs `recover` and tries again. Used by
   * assertVisible/assertNotVisible-after-tap so a dropped synth touch
   * (RNGH coordinator race on a fresh modal Pressable) gets the tap
   * re-fired automatically instead of failing the flow.
   */

  private async doubleTap(selector: MaestroSelector): Promise<void> {
    await this.waitFor(
      () => this.selectorExists(selector),
      DEFAULT_VISIBLE_TIMEOUT,
      `Element not found: ${JSON.stringify(selector)}`,
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
        `Element not found: ${JSON.stringify(targetSelector)}`,
      );
      const sameAsLast =
        this.lastTappedSelector &&
        JSON.stringify(this.lastTappedSelector) === JSON.stringify(targetSelector);
      if (!sameAsLast) {
        if (targetSelector.id && !targetSelector.text) {
          await this.writer.tap(targetSelector.id);
        } else if (targetSelector.text && !targetSelector.id) {
          await this.writer.tapByText(targetSelector.text);
        } else {
          await this.writer.tapBySelector(toEnnioSelector(targetSelector));
        }
        this.lastTappedSelector = targetSelector;
        await this.waitCommit(KEYBOARD_DISMISS_SETTLE_MS);
      }
      // typeText into the resolved field's testID. Falls back to the
      // currently-focused responder (id=null) if no testID was found.
      const id = targetSelector.id ?? null;
      await this.writer.typeText(id, text);
    } else {
      await this.writer.typeText(null, text);
    }
    // Allow the iOS bridge to flush onChangeText for the last few keys —
    // RN commits text input asynchronously and a tight subsequent button
    // tap (e.g. submit) reads stale state otherwise. waitForIdle drains
    // the JS thread + Fabric commits; the sleep is a hedge against the
    // last onChangeText being scheduled just after waitForIdle returned.
    try {
      await this.client.waitForIdle(TYPE_TEXT_IDLE_BUDGET_MS);
    } catch {
      /* tolerate */
    }
    await this.waitCommit(TAP_BACK_RECOVER_DELAY_MS);
  }

  private async clearText(selector: MaestroSelector): Promise<void> {
    await this.waitFor(
      () => this.selectorExists(selector),
      DEFAULT_VISIBLE_TIMEOUT,
      `Element not found: ${JSON.stringify(selector)}`,
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
      `Element not found: ${JSON.stringify(selector)}`,
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
    // setContentOffset:animated:NO returns synchronously but RN's
    // onScroll / onMomentumEnd fire on the next runloop tick; gesture
    // recognizers inside scrolled-in cells (Pressable, etc.) need that
    // tick before they'll honour the next touch. 250 ms covers it on
    // both Bridgeless and the legacy bridge.
    await this.sleep(250);
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
    let processedCmd = preprocessCommand(cmd, this.jsContext);

    // YAML may produce string-form commands (e.g. `- back`) or null entries.
    // Handle them before any `in` operator runs against a non-object.
    if (processedCmd == null) return;
    if (typeof processedCmd === 'string') {
      // Maestro accepts a number of commands in either bare-string
      // form (`- clearState`) or object form (`- clearState: { appId: x }`).
      // Two of them carry custom inline behaviour we want to preserve
      // (back's alert preflight, waitForAnimationToEnd's 500ms cap),
      // so they handle themselves below. Everything else just normalises
      // the bare string into an empty-payload object and falls through
      // to the same handler the object form uses — one code path per
      // command, no duplicate inline branches.
      if (processedCmd === 'back') {
        // Dismiss any native alert first — backGesture's nav-pop path
        // can race with a presented UIAlertController and silently
        // become a no-op, leaving a stale alert blocking subsequent taps.
        if (await this.reader.isAlertPresent()) {
          await this.writer.dismissAlert();
          await this.waitCommit(ALERT_TAP_SETTLE_MS);
        }
        await this.writer.back();
        await this.waitCommit(KEYBOARD_DISMISS_SETTLE_MS);
        return;
      }
      if (processedCmd === 'waitForAnimationToEnd') {
        // Bare string `- waitForAnimationToEnd`. Maestro's default is 5s
        // but most RN transitions settle in 200-400ms — the long tail is
        // network spinners that the test isn't waiting on anyway. Cap
        // at 500ms so flows on apps that never fully idle (Reanimated at
        // 60Hz, looped springs, polling timers) don't pay 5s per step.
        try {
          await this.client.waitForIdle(500);
        } catch {
          /* timeouts ignored */
        }
        return;
      }
      const STRING_FORM_COMMANDS = new Set([
        'hideKeyboard',
        'pasteText',
        'launchApp',
        'clearState',
        'stopApp',
        'killApp',
        'dismissAlert',
        'clearKeychain',
        'stopRecording',
        'inputRandomEmail',
        'inputRandomNumber',
        'inputRandomText',
        'inputRandomPersonName',
        'toggleAirplaneMode',
        'eraseText',
      ]);
      if (!STRING_FORM_COMMANDS.has(processedCmd)) {
        throw new Error(`Unknown string command: ${processedCmd}`);
      }
      processedCmd = { [processedCmd]: {} } as MaestroCommand;
    }
    if (typeof processedCmd !== 'object') {
      throw new Error(`Unsupported command type: ${typeof processedCmd}`);
    }

    if ('evalScript' in processedCmd) {
      const script = (processedCmd as { evalScript: string }).evalScript;
      this.log(`evalScript: ${script.substring(0, 50)}...`);
      jsEvalScript(script, this.jsContext);
      return;
    }

    if ('runScript' in processedCmd) {
      const runCmd = (processedCmd as { runScript: { file: string; env?: Record<string, string> } })
        .runScript;
      this.log(`runScript: ${runCmd.file}`);
      // Merge flow-level env with per-command env (per-command wins).
      const mergedEnv = { ...this.flowEnv, ...(runCmd.env || {}) };
      jsRunScript(runCmd.file, mergedEnv, this.jsContext, this.currentFlowPath);
      return;
    }

    if ('assertTrue' in processedCmd) {
      const expr = (processedCmd as { assertTrue: string }).assertTrue;
      this.log(`assertTrue: ${expr}`);
      // Remove ${} wrapper if present
      let code = expr;
      if (code.startsWith('${') && code.endsWith('}')) {
        code = code.slice(2, -1);
      }
      const result = runInContext(code, this.jsContext, { timeout: 1000 });
      if (!result) {
        throw new Error(`assertTrue failed: ${expr}`);
      }
      return;
    }

    // Use processedCmd for the rest (expressions already evaluated)
    cmd = processedCmd;

    if ('tapOn' in cmd) {
      const selector = normalizeSelector(cmd.tapOn as MaestroSelector | string);
      this.log(`tapOn: ${JSON.stringify(selector)}`);
      await this.tap(selector, { optional: isOptional(cmd) });
      return;
    }

    if ('doubleTapOn' in cmd) {
      const selector = normalizeSelector(cmd.doubleTapOn as MaestroSelector | string);
      this.log(`doubleTapOn: ${JSON.stringify(selector)}`);
      await this.doubleTap(selector);
      return;
    }

    // assertVisible (with anyOf support)
    if ('assertVisible' in cmd) {
      // Bare-string form `assertVisible: "Foo"` is text-shorthand —
      // normalize before reading `timeout`/`anyOf` so we don't spread the
      // string into per-character keys.
      const raw = cmd.assertVisible as MaestroSelector | string;
      const normalized = normalizeSelector(raw);
      const assertCmd = normalized as MaestroSelector & {
        timeout?: number;
        anyOf?: MaestroSelector[];
      };
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
          `None of the elements visible: ${JSON.stringify(assertCmd.anyOf)}`,
        );
        return;
      }

      // Standard single selector
      const { timeout: _, anyOf: __, ...selector } = assertCmd;
      await this.waitFor(
        () => this.selectorVisible(selector),
        timeout,
        `Element not visible: ${JSON.stringify(selector)}`,
      );
      return;
    }

    if ('assertNotVisible' in cmd) {
      // Bare-string form `assertNotVisible: "Foo"` is a Maestro shorthand
      // for `text: "Foo"` — normalize before destructuring `timeout` so we
      // don't spread the string into per-character keys.
      const raw = cmd.assertNotVisible as MaestroSelector | string;
      const normalized = normalizeSelector(raw) as MaestroSelector & { timeout?: number };
      const { timeout = DEFAULT_TIMEOUT, ...selector } = normalized;
      await this.waitFor(
        () => this.selectorVisible(selector).then((v) => !v),
        timeout,
        `Element still visible: ${JSON.stringify(selector)}`,
      );
      return;
    }

    // inputText (types into last tapped or focused element)
    if ('inputText' in cmd) {
      const text = cmd.inputText;
      this.log(`inputText: "${text}"`);
      // Native UISearchBar fast-path: RNScreens headerSearchBarOptions
      // wraps a UISearchBar that idb HID can't reach reliably on iOS 26
      // simulator. When a search bar is the current first responder,
      // append directly via the bar's delegate textDidChange so React
      // state mirrors the input. No-op when no bar is focused — falls
      // through to the regular HID typeText path.
      const sbar = await this.client.send('appendSearchBarText', { text });
      if (sbar?.success === true) {
        this.log(`inputText: via UISearchBar delegate`);
        await this.waitCommit(TAP_BACK_RECOVER_DELAY_MS);
        return;
      }
      await this.typeText(text);
      return;
    }

    if ('clearText' in cmd) {
      const selector = normalizeSelector(cmd.clearText as MaestroSelector | string);
      await this.clearText(selector);
      return;
    }

    if ('scroll' in cmd) {
      const { direction, amount = 200 } = cmd.scroll;
      await this.scroll(direction, amount);
      return;
    }

    if ('scrollUntilVisible' in cmd) {
      await this.handleScrollUntilVisible(
        cmd.scrollUntilVisible as
          | MaestroSelector
          | { element: MaestroSelector; direction?: string; timeout?: number },
      );
      return;
    }

    if ('swipe' in cmd) {
      const swipeCmd = cmd.swipe;
      const duration = swipeCmd.duration || 400;

      // Path 1: `from: <selector>` — anchor the swipe at the element's
      // centre axis but span the screen, not the element. The element
      // gives the gesture's y (for horizontal) or x (for vertical), so
      // the pan recogniser of the right inner scroller sees the touch;
      // the actual finger travel uses the screen so the swipe is long
      // enough to move a card and never clamps to a near-edge no-op.
      if (swipeCmd.from) {
        const sel = normalizeSelector(swipeCmd.from);
        const frame = sel.id ? await this.client.getViewWindowFrame(sel.id) : null;
        if (frame && frame.width > 0 && frame.height > 0) {
          const screen = await this.writer.getScreenSize();
          const cx = frame.x + frame.width / 2;
          const cy = frame.y + frame.height / 2;
          const dir = (swipeCmd.direction || 'LEFT').toLowerCase();
          const hPad = 40;
          const vPad = 80;
          let x1: number, y1: number, x2: number, y2: number;
          if (dir === 'left') {
            x1 = screen.width - hPad;
            x2 = hPad;
            y1 = y2 = cy;
          } else if (dir === 'right') {
            x1 = hPad;
            x2 = screen.width - hPad;
            y1 = y2 = cy;
          } else if (dir === 'up') {
            x1 = x2 = cx;
            y1 = screen.height - vPad;
            y2 = vPad;
          } else {
            // down
            x1 = x2 = cx;
            y1 = vPad;
            y2 = screen.height - vPad;
          }
          await this.writer.swipeAt(x1, y1, x2, y2, duration);
          await this.sleep(SWIPE_SETTLE_MS);
          return;
        }
        // Frame lookup failed — fall through to direction-only path so
        // the swipe still happens (best-effort, may miss the carousel).
      }

      // Path 2: raw `start`/`end` coords — pass straight to idb HID.
      // Accepts absolute pixels in either object `{x,y}` or string
      // `"x,y"` form. (Percentage form is not supported here; use a
      // `from:` selector for resolution-independent swipes.)
      if (swipeCmd.start && swipeCmd.end) {
        const screen = await this.writer.getScreenSize();
        const parseAxis = (raw: string, range: number): number => {
          const t = raw.trim();
          if (t.endsWith('%')) {
            const n = parseFloat(t.slice(0, -1));
            return Number.isFinite(n) ? (n / 100) * range : NaN;
          }
          return parseFloat(t);
        };
        const parsePt = (p: string | { x: number; y: number }): { x: number; y: number } | null => {
          if (typeof p === 'object') return { x: p.x, y: p.y };
          const parts = String(p).split(',');
          if (parts.length !== 2) return null;
          const x = parseAxis(parts[0], screen.width);
          const y = parseAxis(parts[1], screen.height);
          return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
        };
        const s = parsePt(swipeCmd.start);
        const e = parsePt(swipeCmd.end);
        if (s && e) {
          await this.writer.swipeAt(s.x, s.y, e.x, e.y, duration);
          await this.sleep(SWIPE_SETTLE_MS);
          return;
        }
      }

      // Path 3: bare `direction` — finger-semantic in Maestro.
      // `writer.scroll` is finger-semantic for horizontal (idb HID
      // swipe) but scroll-direction-semantic for vertical (native
      // setContentOffset). Invert only the vertical axis; horizontal
      // passes through unchanged.
      if (swipeCmd.direction) {
        const inv: Record<string, string> = { up: 'down', down: 'up' };
        const dir = inv[swipeCmd.direction.toLowerCase()] ?? swipeCmd.direction.toLowerCase();
        await this.scroll(dir, duration);
      }
      return;
    }

    if ('longPress' in cmd || 'longPressOn' in cmd) {
      const raw = ('longPressOn' in cmd ? cmd.longPressOn : cmd.longPress) as
        | MaestroSelector
        | string;
      const selector = normalizeSelector(raw);
      await this.longPress(selector);
      return;
    }

    if ('runFlow' in cmd) {
      if (cmd.runFlow.file) {
        this.log(`runFlow: ${cmd.runFlow.file}`);
      } else if (cmd.runFlow.when) {
        this.log(`runFlow (conditional): ${JSON.stringify(cmd.runFlow.when)}`);
      }
      await this.executeRunFlow(cmd.runFlow);
      return;
    }

    if ('waitFor' in cmd) {
      const { timeout = DEFAULT_VISIBLE_TIMEOUT, ...selector } = cmd.waitFor;
      await this.waitFor(
        () => this.selectorExists(selector),
        timeout,
        `Element not found: ${JSON.stringify(selector)}`,
      );
      return;
    }

    // launchApp - restart the app
    if ('launchApp' in cmd) {
      await this.handleLaunchApp(cmd.launchApp);
      return;
    }

    if ('clearState' in cmd) {
      await this.handleClearState(cmd.clearState);
      return;
    }

    // stopApp / killApp (maestro alias — same behaviour, different name).
    if ('stopApp' in cmd || 'killApp' in cmd) {
      const subCmd = (
        'stopApp' in cmd
          ? cmd.stopApp
          : (cmd as { killApp: typeof cmd extends { stopApp: infer S } ? S : unknown }).killApp
      ) as true | { appId?: string } | undefined;
      this.handleStopApp(subCmd);
      return;
    }

    if ('clearKeychain' in cmd) {
      this.handleClearKeychain();
      return;
    }

    // dismissAlert — first-class command. Inline alert handling already
    // covers most flows; this is the standalone-command form maestro
    // exposes for explicit `- dismissAlert` steps.
    if ('dismissAlert' in cmd) {
      this.log('dismissAlert');
      try {
        await this.writer.dismissAlert();
      } catch {
        /* noop — no alert presented */
      }
      return;
    }

    if ('setAirplaneMode' in cmd) {
      const value = (cmd as { setAirplaneMode: boolean | 'enabled' | 'disabled' }).setAirplaneMode;
      this.applyAirplaneMode(value === true || value === 'enabled', 'setAirplaneMode');
      return;
    }
    if ('toggleAirplaneMode' in cmd) {
      this.airplaneOn = !this.airplaneOn;
      this.applyAirplaneMode(this.airplaneOn, 'toggleAirplaneMode');
      return;
    }

    if ('travel' in cmd) {
      const travelCmd = (
        cmd as {
          travel: {
            points: ({ latitude: number; longitude: number } | string)[];
            speed?: number;
          };
        }
      ).travel;
      await this.handleTravel(travelCmd);
      return;
    }

    // inputRandomEmail / Number / Text / PersonName — generate a value
    // and route through typeText so the field receives a normal change.
    if (
      'inputRandomEmail' in cmd ||
      'inputRandomNumber' in cmd ||
      'inputRandomText' in cmd ||
      'inputRandomPersonName' in cmd
    ) {
      await this.handleInputRandom(cmd as MaestroCommand);
      return;
    }

    if ('openLink' in cmd) {
      await this.handleOpenLink(cmd.openLink);
      return;
    }
    if ('takeScreenshot' in cmd) {
      this.handleTakeScreenshot(cmd.takeScreenshot);
      return;
    }

    if ('eraseText' in cmd) {
      const eraseCmd = cmd.eraseText;
      const chars = typeof eraseCmd === 'number' ? eraseCmd : eraseCmd.characters || 50;
      this.log(`eraseText: ${chars} characters`);
      // Native UISearchBar fast-path — matches the inputText routing.
      const sbar = await this.client.send('eraseSearchBarText', { count: String(chars) });
      if (sbar?.success === true) {
        this.log(`eraseText: via UISearchBar delegate`);
        await this.waitCommit(TAP_BACK_RECOVER_DELAY_MS);
        return;
      }
      await this.writer.eraseText(this.lastTappedSelector?.id ?? null, chars);
      return;
    }

    if ('hideKeyboard' in cmd) {
      this.log('hideKeyboard');
      await this.writer.hideKeyboard();
      return;
    }

    if ('pressKey' in cmd) {
      const keyName = cmd.pressKey as string;
      this.log(`pressKey: ${keyName}`);
      await this.writer.pressKey(this.lastTappedSelector?.id ?? null, keyName);
      return;
    }

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

    if ('pasteText' in cmd) {
      this.log('pasteText');
      await this.writer.pasteToFocused();
      return;
    }

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

    if ('repeat' in cmd) {
      const { times, commands } = cmd.repeat;
      this.log(`repeat: ${times} times`);
      for (let i = 0; i < times; i++) {
        await this.executeCommands(commands);
      }
      return;
    }

    if ('retry' in cmd) {
      await this.handleRetry(cmd.retry);
      return;
    }

    if ('setLocation' in cmd) {
      this.handleSetLocation(cmd.setLocation);
      return;
    }

    if ('setPermissions' in cmd) {
      this.handleSetPermissions(cmd.setPermissions);
      return;
    }

    if ('startRecording' in cmd) {
      await this.handleStartRecording(cmd.startRecording);
      return;
    }
    if ('stopRecording' in cmd) {
      await this.handleStopRecording();
      return;
    }

    if ('addMedia' in cmd) {
      this.handleAddMedia(cmd.addMedia);
      return;
    }

    if ('waitForAnimationToEnd' in cmd) {
      const waitCmd = cmd.waitForAnimationToEnd;
      // Bare-form `- waitForAnimationToEnd:` parses to `null`; typeof null
      // === 'object' so the prior check let null through and `null.timeout`
      // threw. Explicit null guard.
      const timeout =
        waitCmd && typeof waitCmd === 'object' && waitCmd.timeout ? waitCmd.timeout : 500;
      this.log(`waitForAnimationToEnd: timeout=${timeout}ms`);
      try {
        await this.client.waitForIdle(timeout);
      } catch {
        // Continue even if idle detection times out
      }
      return;
    }

    if ('extendedWaitUntil' in cmd) {
      await this.handleExtendedWaitUntil(cmd.extendedWaitUntil);
      return;
    }

    console.log(`  (unknown command: ${JSON.stringify(cmd)})`);
  }

  // ============================================
  // Per-command handlers (extracted from executeCommand)
  //
  // Long blocks were lifted out one at a time; each preserves the
  // original semantics 1:1. Thin handlers (≤ 15 lines, no quirks) stay
  // inline in executeCommand to avoid pointless indirection.
  // ============================================

  // Map maestro permission names to `xcrun simctl privacy` service names.
  // Most are 1:1 except medialibrary → media-library.
  private static readonly PERMISSION_SERVICE_MAP: Record<string, string> = {
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

  private handleSetPermissions(permissions: Record<string, 'allow' | 'deny' | 'unset'>): void {
    const deviceId = getBootedSimulatorId();
    if (!deviceId) throw new Error('setPermissions: No booted iOS target found');
    requireSimulator(deviceId, 'setPermissions');
    const targetAppId = this.appId;
    if (!targetAppId) throw new Error('setPermissions: No appId specified');

    this.log(`setPermissions: ${JSON.stringify(permissions)}`);
    for (const [perm, action] of Object.entries(permissions)) {
      const service = MaestroExecutor.PERMISSION_SERVICE_MAP[perm.toLowerCase()] || perm;
      const simctlAction = action === 'allow' ? 'grant' : action === 'deny' ? 'revoke' : 'reset';
      try {
        execSync(`xcrun simctl privacy ${deviceId} ${simctlAction} ${service} ${targetAppId}`, {
          encoding: 'utf-8',
          stdio: 'pipe',
        });
      } catch {
        // Some permissions aren't supported on every iOS version — log + continue.
        this.log(`setPermissions: ${perm} - ${action} (may not be supported)`);
      }
    }
  }

  private async handleScrollUntilVisible(
    scrollCmd: MaestroSelector | { element: MaestroSelector; direction?: string; timeout?: number },
  ): Promise<void> {
    const hasElement = typeof scrollCmd === 'object' && 'element' in scrollCmd;
    const selector = normalizeSelector(
      hasElement ? scrollCmd.element : (scrollCmd as MaestroSelector),
    );
    const direction = (hasElement ? scrollCmd.direction || 'DOWN' : 'DOWN').toLowerCase();
    const timeout = hasElement ? scrollCmd.timeout || 10000 : 10000;
    const scrollAmount = 300;

    this.log(`scrollUntilVisible: ${JSON.stringify(selector)}`);
    const startTime = Date.now();
    const isHorizontal = direction === 'left' || direction === 'right';
    // For id-targeted scrolls, require the element's center to land
    // inside the viewport before exiting — partial-edge visibility
    // satisfies `selectorVisible` but a subsequent `tapOn` would
    // dispatch at an off-screen center and miss. The strict check
    // matches what a real `tapOn` cares about.
    const isCenterInViewport = async (): Promise<boolean> => {
      if (!selector.id) return false;
      const frame = await this.client.getViewWindowFrame(selector.id);
      if (!frame || frame.width <= 0 || frame.height <= 0) return false;
      const screen = await this.writer.getScreenSize();
      const cx = frame.x + frame.width / 2;
      const cy = frame.y + frame.height / 2;
      if (!(cx >= 0 && cx <= screen.width && cy >= 0 && cy <= screen.height)) return false;
      // Soft safe-tap-zone gates. iPhone tab bar (~49) + home
      // indicator (~34) take ~83px at the bottom; status bar +
      // collapsed nav bar take ~100px at the top. Without these
      // scrollUntilVisible exits when the target row is technically
      // inside the window but obscured by the navbar / tab bar —
      // the subsequent tap then lands on the wrong view (switches
      // tabs / hits the title overlay). Conservative for
      // unobstructed screens — just under-utilises ~180px of
      // vertical space, harmless.
      if (cy < 130) return false;
      if (cy > screen.height - 90) return false;
      return true;
    };
    let stuckIters = 0;
    let prevFrameY: number | null = null;
    while (Date.now() - startTime < timeout) {
      if (await this.selectorVisible(selector)) {
        if (!selector.id || (await isCenterInViewport())) {
          // Final settle so the next step (typically tapOn) sees a
          // stationary frame — paged scrollers and momentum decel keep
          // the frame moving for a few hundred ms after the last
          // swipe, even when the on-screen + center checks pass.
          await this.sleep(300);
          return;
        }
        // Selector is visible but center sits in the safe-tap-zone
        // buffer (under navbar / above tab bar). If the frame is no
        // longer moving across loop iterations the scrollview has
        // reached its content edge — further swipes won't help.
        // Accept "best effort" position and exit; the next step gets
        // whatever frame the runner can read at tap time.
        if (selector.id) {
          const frame = await this.client.getViewWindowFrame(selector.id);
          if (frame) {
            if (prevFrameY !== null && Math.abs(prevFrameY - frame.y) < 1) {
              stuckIters++;
              if (stuckIters >= 2) {
                await this.sleep(300);
                return;
              }
            } else {
              stuckIters = 0;
            }
            prevFrameY = frame.y;
          }
        }
      }
      // For horizontal scrolls on a testID target, anchor the swipe
      // at the target's center y (looked up via UIKit window-frame).
      // Without this we'd swipe at the screen-center y, which lands
      // in the outer (vertical) scroller of a page that hosts a
      // horizontal carousel — the carousel never advances. Frame.y
      // is valid even when the element is currently off-screen
      // horizontally (its row is on the visible viewport).
      let anchored = false;
      if (isHorizontal && selector.id) {
        const frame = await this.client.getViewWindowFrame(selector.id);
        if (frame && frame.width > 0 && frame.height > 0) {
          const screen = await this.writer.getScreenSize();
          const cy = frame.y + frame.height / 2;
          const hPad = 40;
          const x1 = direction === 'left' ? screen.width - hPad : hPad;
          const x2 = direction === 'left' ? hPad : screen.width - hPad;
          await this.writer.swipeAt(x1, cy, x2, cy, 400);
          await this.sleep(SWIPE_SETTLE_MS);
          anchored = true;
        }
      }
      if (!anchored) {
        await this.scroll(direction, scrollAmount);
        await this.waitCommit(TAP_NAV_SETTLE_MS);
      }
    }
    throw new Error(`scrollUntilVisible timeout: ${JSON.stringify(selector)}`);
  }

  private async handleOpenLink(linkCmd: string | { link: string }): Promise<void> {
    const url = typeof linkCmd === 'string' ? linkCmd : linkCmd.link;
    const deviceId = getBootedSimulatorId();
    if (!deviceId) throw new Error('openLink: No booted iOS target found');
    this.log(`openLink: ${url}`);
    if (getTargetType(deviceId) === 'simulator') {
      execSync(`xcrun simctl openurl ${deviceId} "${url}"`, { encoding: 'utf-8', stdio: 'pipe' });
    } else {
      execSync(`idb url-scheme open --udid ${deviceId} "${url}"`, {
        encoding: 'utf-8',
        stdio: 'pipe',
      });
    }
    await this.sleep(OPENLINK_SETTLE_MS);
  }

  private handleTakeScreenshot(screenshotCmd: string | { path: string }): void {
    const path = typeof screenshotCmd === 'string' ? screenshotCmd : screenshotCmd.path;
    const deviceId = getBootedSimulatorId();
    if (!deviceId) throw new Error('takeScreenshot: No booted iOS target found');
    this.log(`takeScreenshot: ${path}`);
    if (!captureScreenshot(deviceId, path)) {
      throw new Error(`takeScreenshot: capture failed for ${path}`);
    }
  }

  private handleAddMedia(mediaCmd: string[] | { files: string[] }): void {
    const files = Array.isArray(mediaCmd) ? mediaCmd : mediaCmd.files;
    const deviceId = getBootedSimulatorId();
    if (!deviceId) throw new Error('addMedia: No booted iOS target found');
    this.log(`addMedia: ${files.join(', ')}`);
    const isSim = getTargetType(deviceId) === 'simulator';
    for (const file of files) {
      if (isSim) {
        execSync(`xcrun simctl addmedia ${deviceId} "${file}"`, {
          encoding: 'utf-8',
          stdio: 'pipe',
        });
      } else {
        execSync(`idb add-media --udid ${deviceId} "${file}"`, {
          encoding: 'utf-8',
          stdio: 'pipe',
        });
      }
    }
  }

  // Tiny fixed pool — deterministic enough for tests, varied enough not
  // to clash with hardcoded "Test User" assertions.
  private static readonly RANDOM_FIRST_NAMES = [
    'Alex',
    'Jordan',
    'Sam',
    'Casey',
    'Robin',
    'Taylor',
  ];
  private static readonly RANDOM_LAST_NAMES = [
    'Smith',
    'Jones',
    'Brown',
    'Davis',
    'Wilson',
    'Miller',
  ];

  private async handleInputRandom(cmd: MaestroCommand): Promise<void> {
    if ('inputRandomEmail' in cmd) {
      const text = `e2e-${Math.random().toString(36).slice(2, 10)}@example.com`;
      this.log(`inputRandomEmail: "${text}"`);
      await this.typeText(text);
      return;
    }
    if ('inputRandomNumber' in cmd) {
      const numCmd = (cmd as { inputRandomNumber: true | { length?: number } }).inputRandomNumber;
      const length = (typeof numCmd === 'object' && numCmd?.length) || 8;
      let text = '';
      for (let i = 0; i < length; i++) text += Math.floor(Math.random() * 10).toString();
      this.log(`inputRandomNumber: "${text}"`);
      await this.typeText(text);
      return;
    }
    if ('inputRandomText' in cmd) {
      const tCmd = (cmd as { inputRandomText: true | { length?: number } }).inputRandomText;
      const length = (typeof tCmd === 'object' && tCmd?.length) || 8;
      const chars = 'abcdefghijklmnopqrstuvwxyz';
      let text = '';
      for (let i = 0; i < length; i++) text += chars[Math.floor(Math.random() * chars.length)];
      this.log(`inputRandomText: "${text}"`);
      await this.typeText(text);
      return;
    }
    if ('inputRandomPersonName' in cmd) {
      const first = MaestroExecutor.RANDOM_FIRST_NAMES;
      const last = MaestroExecutor.RANDOM_LAST_NAMES;
      const name = `${first[Math.floor(Math.random() * first.length)]} ${last[Math.floor(Math.random() * last.length)]}`;
      this.log(`inputRandomPersonName: "${name}"`);
      await this.typeText(name);
    }
  }

  private handleStopApp(subCmd: true | { appId?: string } | undefined): void {
    const targetAppId = (typeof subCmd === 'object' && subCmd?.appId) || this.appId;
    if (!targetAppId) throw new Error('stopApp: No appId specified in command or flow metadata');
    const deviceId = getBootedSimulatorId();
    if (!deviceId) throw new Error('stopApp: No booted iOS simulator found');
    this.log(`stopApp: ${targetAppId}`);
    terminateApp(deviceId, targetAppId);
  }

  // Sim-wide keychain wipe. No appId — `simctl keychain reset` is a
  // per-device operation, not per-app. Older sims occasionally return
  // non-zero on a no-op reset; tolerated since the next launch sees a
  // fresh keychain anyway via the rm-rf+launch path in clearState.
  private handleClearKeychain(): void {
    const deviceId = getBootedSimulatorId();
    if (!deviceId) throw new Error('clearKeychain: No booted iOS target found');
    requireSimulator(deviceId, 'clearKeychain');
    this.log('clearKeychain');
    try {
      execSync(`xcrun simctl keychain ${deviceId} reset`, { encoding: 'utf-8', stdio: 'pipe' });
    } catch (e) {
      if (process.env.ENNIO_VERBOSE) console.error(`clearKeychain: ${e}`);
    }
  }

  // Sim-only via `simctl status_bar`. There's no `simctl status_bar list`
  // we can read back reliably, so toggleAirplaneMode tracks state in
  // `airplaneOn` and flips it. setAirplaneMode passes the explicit value.
  private applyAirplaneMode(enabled: boolean, label: string): void {
    const deviceId = getBootedSimulatorId();
    if (!deviceId) throw new Error(`${label}: No booted iOS target found`);
    requireSimulator(deviceId, label);
    this.log(`${label}: ${enabled ? 'on' : 'off'}`);
    try {
      if (enabled) {
        execSync(
          `xcrun simctl status_bar ${deviceId} override --dataNetworkType none --wifiMode failed --cellularMode notSupported`,
          { encoding: 'utf-8', stdio: 'pipe' },
        );
      } else {
        execSync(`xcrun simctl status_bar ${deviceId} clear`, { encoding: 'utf-8', stdio: 'pipe' });
      }
    } catch (e) {
      if (process.env.ENNIO_VERBOSE) console.error(`${label}: ${e}`);
    }
  }

  // Walk maestro waypoints with a 200 ms gap so a CLLocationManagerDelegate
  // sees a sequence of fixes rather than a teleport. `speed` is informational;
  // simctl location takes one fix at a time, no velocity model.
  private async handleTravel(travelCmd: {
    points: ({ latitude: number; longitude: number } | string)[];
    speed?: number;
  }): Promise<void> {
    const deviceId = getBootedSimulatorId();
    if (!deviceId) throw new Error('travel: No booted iOS target found');
    requireSimulator(deviceId, 'travel');
    this.log(`travel: ${travelCmd.points.length} waypoints`);
    for (const p of travelCmd.points) {
      let lat: number, lon: number;
      if (typeof p === 'string') {
        const [latStr, lonStr] = p.split(',').map((s) => s.trim());
        lat = parseFloat(latStr);
        lon = parseFloat(lonStr);
      } else {
        lat = p.latitude;
        lon = p.longitude;
      }
      try {
        execSync(`xcrun simctl location ${deviceId} set ${lat},${lon}`, {
          encoding: 'utf-8',
          stdio: 'pipe',
        });
      } catch (e) {
        if (process.env.ENNIO_VERBOSE) console.error(`travel: ${e}`);
      }
      await this.sleep(TRAVEL_WAYPOINT_GAP_MS);
    }
  }

  private async handleRetry(retryCmd: {
    maxRetries?: number;
    commands: MaestroCommand[];
  }): Promise<void> {
    const { maxRetries = 3, commands } = retryCmd;
    this.log(`retry: max ${maxRetries}`);
    let lastError: Error | null = null;
    for (let i = 0; i <= maxRetries; i++) {
      try {
        await this.executeCommands(commands);
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (i < maxRetries) {
          this.log(`retry: attempt ${i + 1} failed, retrying...`);
          await this.sleep(RETRY_BACKOFF_MS);
        }
      }
    }
    throw lastError || new Error('retry: all attempts failed');
  }

  private handleSetLocation(locCmd: string | { latitude: number; longitude: number }): void {
    let lat: number, lon: number;
    if (typeof locCmd === 'string') {
      const [latStr, lonStr] = locCmd.split(',');
      lat = parseFloat(latStr);
      lon = parseFloat(lonStr);
    } else {
      lat = locCmd.latitude;
      lon = locCmd.longitude;
    }
    const deviceId = getBootedSimulatorId();
    if (!deviceId) throw new Error('setLocation: No booted iOS target found');
    requireSimulator(deviceId, 'setLocation');
    this.log(`setLocation: ${lat}, ${lon}`);
    execSync(`xcrun simctl location ${deviceId} set ${lat},${lon}`, {
      encoding: 'utf-8',
      stdio: 'pipe',
    });
  }

  private async handleStartRecording(recCmd: string | { path: string }): Promise<void> {
    const path = typeof recCmd === 'string' ? recCmd : recCmd.path;
    const deviceId = getBootedSimulatorId();
    if (!deviceId) throw new Error('startRecording: No booted iOS target found');
    requireSimulator(deviceId, 'startRecording');
    this.log(`startRecording: ${path}`);
    // Background recording — `simctl io recordVideo` blocks until killed.
    // unref() so the child doesn't keep the test runner alive after exit.
    spawn('xcrun', ['simctl', 'io', deviceId, 'recordVideo', path], {
      detached: true,
      stdio: 'ignore',
    }).unref();
    await this.sleep(RECORDING_SETTLE_MS);
  }

  private async handleStopRecording(): Promise<void> {
    this.log('stopRecording');
    try {
      execSync('pkill -f "simctl io.*recordVideo"', { encoding: 'utf-8', stdio: 'pipe' });
    } catch {
      // No recording process — fine.
    }
    await this.sleep(RECORDING_SETTLE_MS);
  }

  private async handleExtendedWaitUntil(waitCmd: {
    visible?: MaestroSelector;
    notVisible?: MaestroSelector;
    timeout?: number;
  }): Promise<void> {
    const { visible, notVisible, timeout = 10000 } = waitCmd;
    this.log(`extendedWaitUntil: timeout=${timeout}ms`);
    if (visible) {
      const selector = normalizeSelector(visible);
      await this.waitFor(
        () => this.selectorVisible(selector),
        timeout,
        `Element not visible: ${JSON.stringify(selector)}`,
      );
    }
    if (notVisible) {
      const selector = normalizeSelector(notVisible);
      await this.waitFor(
        () => this.selectorVisible(selector).then((v) => !v),
        timeout,
        `Element still visible: ${JSON.stringify(selector)}`,
      );
    }
  }

  private async handleClearState(clearCmd: true | { appId?: string }): Promise<void> {
    const targetAppId = (typeof clearCmd === 'object' && clearCmd.appId) || this.appId;
    if (!targetAppId) throw new Error('clearState: No appId specified in command or flow metadata');
    const deviceId = getBootedSimulatorId();
    if (!deviceId) throw new Error('clearState: No booted iOS target found');

    this.log(`clearState: ${targetAppId}`);
    // In-process sandbox wipe via WS while the app is still running.
    // Works identically on Sim + device (no host filesystem access).
    try {
      await this.client.clearAppData();
    } catch {
      /* best effort */
    }
    this.client.disconnect();
    terminateApp(deviceId, targetAppId);
    await this.sleep(POST_LAUNCH_SETTLE_MS);
    launchAppOnSimulator(deviceId, targetAppId);

    let connected = false;
    const startTime = Date.now();
    while (!connected && Date.now() - startTime < DEFAULT_RECONNECT_TIMEOUT) {
      try {
        this.client = await this.reconnectClient();
        connected = true;
      } catch {
        await this.sleep(RETRY_POLL_MS);
      }
    }
    if (!connected) throw new Error('clearState: Failed to reconnect to app after restart');
    // Fresh client = fresh WebSocket + fresh control socket. Writer +
    // reader still hold the OLD client reference from construction;
    // hand them the new one so dispatch routes via the live transports.
    this.writer.setClient(this.client);
    this.reader.setClient(this.client);
    // Fresh process = fresh key window. Drop the writer's cached window
    // size + surface offset so the next tap math doesn't use values from
    // the previous app instance.
    this.writer.invalidateViewportCache();
    try {
      await this.client.waitForIdle(POST_LAUNCH_IDLE_BUDGET_MS);
    } catch {
      /* tolerate */
    }
    this.log('clearState: App restarted with fresh state');
  }

  private async handleLaunchApp(
    launchCmd: true | { clearState?: boolean; appId?: string },
  ): Promise<void> {
    const shouldClearState = typeof launchCmd === 'object' && launchCmd.clearState === true;
    const targetAppId = (typeof launchCmd === 'object' && launchCmd.appId) || this.appId;
    if (!targetAppId) throw new Error('launchApp: No appId specified in command or flow metadata');
    const deviceId = getBootedSimulatorId();
    if (!deviceId) throw new Error('launchApp: No booted iOS simulator found');

    this.log(`launchApp: ${targetAppId}${shouldClearState ? ' (clearState)' : ''}`);
    if (shouldClearState) {
      // In-process sandbox wipe via WS before disconnect — works on
      // Sim + device with no host filesystem access.
      try {
        await this.client.clearAppData();
      } catch {
        /* best effort */
      }
    }
    this.client.disconnect();
    terminateApp(deviceId, targetAppId);

    // Brief settle so the simulator finishes wiping data containers
    // before relaunch. Skipping this on iOS 26 sim can produce a Hermes
    // BCProvider SIGSEGV when the new process races the prior teardown.
    await this.sleep(POST_LAUNCH_SETTLE_MS);
    launchAppOnSimulator(deviceId, targetAppId);

    // Reconnect with patience. App must cold-start, load JS bundle, then
    // RCTHost.start fires and Hermes Inspector exposes the JS runtime
    // page Metro can hand us over CDP.
    let connected = false;
    const startTime = Date.now();
    while (!connected && Date.now() - startTime < DEFAULT_RECONNECT_TIMEOUT) {
      try {
        this.client = await this.reconnectClient();
        connected = true;
      } catch {
        await this.sleep(TAP_NAV_SETTLE_MS);
      }
    }
    if (!connected) throw new Error('launchApp: Failed to reconnect to app after restart');
    // Hot-swap writer + reader onto the new client. See handleClearState
    // for the same dance — the old client's transports are dead.
    this.writer.setClient(this.client);
    this.reader.setClient(this.client);
    // Fresh process — see comment in handleClearState.
    this.writer.invalidateViewportCache();

    // Wait for first shadow tree commit so the next assertVisible has
    // something to query.
    await this.sleep(POST_LAUNCH_SHADOW_COMMIT_MS);
    try {
      await this.client.waitForIdle(POST_LAUNCH_IDLE_BUDGET_MS);
    } catch {
      /* tolerate */
    }
    this.log('launchApp: Reconnected');
  }

  /**
   * Execute a list of commands
   */
  async executeCommands(commands: MaestroCommand[]): Promise<void> {
    for (const cmd of commands) {
      // Maestro per-command `optional: true` — failures swallow + log
      // instead of bubbling. Lets flows like `- tapOn: { id: cookie-banner-x, optional: true }`
      // tolerate missing UI without an explicit runFlow + when wrapper.
      const optional = isOptional(cmd);
      try {
        await this.executeCommand(cmd);
      } catch (err) {
        // Reset post-tap recovery state so a downstream `tap nearest` /
        // `assertVisible` retry path doesn't re-tap a stale selector
        // from the failed command.
        this.lastTappedSelector = null;
        if (optional) {
          const cmdName = typeof cmd === 'string' ? cmd : Object.keys(cmd as object)[0];
          this.log(`  (optional ${cmdName} failed, continuing): ${(err as Error).message}`);
        } else {
          throw err;
        }
      }
      if (this.trace) {
        await this.snapshotState(cmd);
      }
    }
  }

  // Hook for verbose-trace runs. Extended via `client.findBySelector` in
  // forks that want a per-command shadow-tree dump; default is a marker.
  private async snapshotState(cmd: MaestroCommand): Promise<void> {
    if (!this.trace) return;
    const cmdName = typeof cmd === 'string' ? cmd : Object.keys(cmd as object)[0];
    console.log(`    [trace ${cmdName}]`);
  }
}
