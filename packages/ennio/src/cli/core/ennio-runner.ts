// Top-level orchestrator. Composes SimulatorSession, EnnioConnection,
// FlowExecutor, and Reporter. The CLI entry point (commands/test.ts)
// constructs one EnnioRunner and calls run() with the resolved YAML
// file list.
//
// Lifecycle:
//   1. Pick reporter (default PrettyReporter).
//   2. For each flow:
//      a. Build SimulatorSession (UDID + bundleId + dylib path).
//      b. Build EnnioConnection (Unix socket).
//      c. If connection.open() fails, the dylib isn't loaded yet —
//         have SimulatorSession launch the app with DYLD injection,
//         then retry the connection.
//      d. Build FlowExecutor with session + connection + reporter.
//      e. Run the flow. ALWAYS close the connection in finally.
//   3. Aggregate FlowResults into a SuiteResult and emit suiteEnd.

import { execFileSync } from 'node:child_process';

import type { GestureDriver } from '../driver';
import type { MaestroFlow } from '../maestro-parser';
import { parseMaestroFile } from '../maestro-parser';
import type { Platform } from '../platform';
import { selectPlatform } from '../platform';
import { pickReporter } from '../reporters';
import type { Reporter, SuiteResult, FlowResult } from '../reporters';

import { FlowExecutor } from './flow-executor';

export interface EnnioRunnerOptions {
  udid?: string;
  dylibPath?: string;
  reporter?: Reporter;
  verbose?: boolean;
  lenient?: boolean;
  /** Launch with ENNIO_SAFE_MODE set — the dylib skips all in-app
   *  hooks (testID index, settle ticker, RN observer). Escape hatch
   *  for injection conflicts (issue #44). */
  safeMode?: boolean;
  /** Route taps/swipes through in-process dylib ops with per-gesture
   *  HID fallback (the fast driver). Default: real HID every gesture. */
  fast?: boolean;
  /** Reporter kind when no explicit reporter is passed. Default 'pretty'. */
  reporterKind?: 'pretty' | 'json';
  /** Device backend. Default: iOS simulator. */
  platform?: Platform;
}

export class EnnioRunner {
  private udid?: string;
  private dylibPath?: string;
  private reporter: Reporter;
  private verbose: boolean;
  private lenient: boolean;
  private safeMode: boolean;
  private platform: Platform;
  private driver: GestureDriver;

  constructor(opts: EnnioRunnerOptions = {}) {
    this.udid = opts.udid;
    this.dylibPath = opts.dylibPath;
    this.verbose = opts.verbose ?? false;
    this.lenient = opts.lenient ?? false;
    this.safeMode = opts.safeMode ?? false;
    this.platform = opts.platform ?? selectPlatform('ios');
    this.driver = this.platform.createDriver(opts.fast ?? false);
    this.reporter =
      opts.reporter ?? pickReporter({ kind: opts.reporterKind ?? 'pretty', verbose: this.verbose });
  }

  /**
   * Run a batch of flow files. Returns aggregated SuiteResult and
   * emits all Reporter events along the way.
   */
  async run(flowFiles: string[]): Promise<SuiteResult> {
    const flows = flowFiles.map((f) => parseMaestroFile(f));

    this.reporter.suiteStart(flows);
    const suiteStart = Date.now();

    const results: FlowResult[] = [];
    let pass = 0;
    let fail = 0;

    for (const flow of flows) {
      const result = await this.runFlow(flow);
      results.push(result);
      if (result.passed) pass++;
      else fail++;
    }

    const suiteResult: SuiteResult = {
      passed: fail === 0,
      totalFlows: flows.length,
      flowsPassed: pass,
      flowsFailed: fail,
      durationMs: Date.now() - suiteStart,
      flows: results,
    };
    this.reporter.suiteEnd(suiteResult);
    return suiteResult;
  }

  /**
   * Run a single parsed flow. The platform establishes a ready
   * connection (launching the app if needed); we always close it after.
   */
  async runFlow(flow: MaestroFlow): Promise<FlowResult> {
    if (!flow.appId) {
      throw new Error(`Flow ${flow.filePath} is missing top-level appId`);
    }

    const { session, connection } = await this.platform.connect({
      udid: this.udid,
      bundleId: flow.appId,
      dylibPath: this.dylibPath ?? null,
      safeMode: this.safeMode,
    });
    try {
      const executor = new FlowExecutor({
        session,
        connection,
        platform: this.platform,
        reporter: this.reporter,
        verbose: this.verbose,
        lenient: this.lenient,
        driver: this.driver,
      });
      // ennio: { animations: true } restores animations for this flow
      // when --no-animations is the global default. Useful for flows
      // that test animation behaviour or assert mid-animation state.
      const restoreAnimations =
        process.env.ENNIO_NO_ANIMATIONS === '1' && flow.ennio?.animations === true;
      if (restoreAnimations) {
        await connection.socket
          .call('set_no_animations', { enabled: false })
          .catch(() => undefined);
      }
      try {
        return await executor.run(flow);
      } finally {
        if (restoreAnimations) {
          await connection.socket
            .call('set_no_animations', { enabled: true })
            .catch(() => undefined);
        }
      }
    } finally {
      connection.close();
    }
  }
}

// Re-export so callers don't need to deep-import.
export { execFileSync };
