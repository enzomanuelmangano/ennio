// Top-level orchestrator. Composes SimulatorSession, EnnioConnection,
// FlowExecutor, and Reporter. The CLI entry point (commands/test.ts)
// constructs one EnnioRunner and calls run() with the resolved YAML
// file list.
//
// Lifecycle:
//   1. Pick reporter (default PrettyReporter).
//   2. For each flow:
//      a. Build SimulatorSession (UDID + bundleId + dylib path).
//      b. Build EnnioConnection (Unix socket + idb pool).
//      c. If connection.open() fails, the dylib isn't loaded yet —
//         have SimulatorSession launch the app with DYLD injection,
//         then retry the connection.
//      d. Build FlowExecutor with session + connection + reporter.
//      e. Run the flow. ALWAYS close the connection in finally.
//   3. Aggregate FlowResults into a SuiteResult and emit suiteEnd.

import { execFileSync } from 'node:child_process';

import { enableAccessibility } from '../sim';
import { createDriver } from '../driver';
import type { GestureDriver } from '../driver';
import { ensureIdb, defaultIdbDeps } from '../idb-setup';
import type { MaestroFlow } from '../maestro-parser';
import { parseMaestroFile } from '../maestro-parser';
import { pickReporter } from '../reporters';
import type { Reporter, SuiteResult, FlowResult } from '../reporters';

import { EnnioConnection } from './ennio-connection';
import { FlowExecutor } from './flow-executor';
import { SimulatorSession } from './simulator-session';

export interface EnnioRunnerOptions {
  udid?: string;
  dylibPath?: string;
  reporter?: Reporter;
  verbose?: boolean;
  lenient?: boolean;
  /** Route taps/swipes through in-process dylib ops, HID fallback. */
  fast?: boolean;
  /** Reporter kind when no explicit reporter is passed. Default 'pretty'. */
  reporterKind?: 'pretty' | 'json';
}

export class EnnioRunner {
  private udid?: string;
  private dylibPath?: string;
  private reporter: Reporter;
  private verbose: boolean;
  private lenient: boolean;
  private fast: boolean;
  private driver: GestureDriver;

  constructor(opts: EnnioRunnerOptions = {}) {
    this.udid = opts.udid;
    this.dylibPath = opts.dylibPath;
    this.verbose = opts.verbose ?? false;
    this.lenient = opts.lenient ?? false;
    this.fast = opts.fast ?? false;
    this.driver = createDriver(this.fast);
    this.reporter =
      opts.reporter ?? pickReporter({ kind: opts.reporterKind ?? 'pretty', verbose: this.verbose });
  }

  /**
   * Run a batch of flow files. Returns aggregated SuiteResult and
   * emits all Reporter events along the way.
   */
  async run(flowFiles: string[]): Promise<SuiteResult> {
    const flows = flowFiles.map((f) => parseMaestroFile(f));

    // Preflight: idb_companion + the idb CLI back every tap and the app
    // lifecycle. Check once up front and (with consent) install what's
    // missing, so a fresh machine doesn't fail cryptically at the first tap.
    await ensureIdb(defaultIdbDeps());

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
   * Run a single parsed flow. Manages connection lifecycle around
   * one flow run.
   */
  async runFlow(flow: MaestroFlow): Promise<FlowResult> {
    if (!flow.appId) {
      throw new Error(`Flow ${flow.filePath} is missing top-level appId`);
    }

    const session = new SimulatorSession({
      udid: this.udid,
      bundleId: flow.appId,
      dylibPath: this.dylibPath ?? null,
    });

    // Make SwiftUI / native apps readable by ennio's in-process AX
    // walk. Off by default, SwiftUI builds no accessibility tree, so
    // a screen like iOS Settings is invisible to find_ax_by_text.
    enableAccessibility(session.udid);

    const connection = new EnnioConnection({ udid: session.udid });
    try {
      if (!(await connection.open(2_000))) {
        // App isn't running with the dylib loaded. Launch + retry.
        session.terminate();
        session.launch();
        if (!(await connection.open(15_000))) {
          throw new Error(
            'Auto-launched the app with DYLD injection but libennio socket ' +
              'never came up. Check the app is a Debug build and the dylib ' +
              'path is correct.',
          );
        }
        await this.waitBootstrapReady(connection);
      }

      const executor = new FlowExecutor({
        session,
        connection,
        reporter: this.reporter,
        verbose: this.verbose,
        lenient: this.lenient,
        driver: this.driver,
      });
      if (this.fast) this.driver.resetStats();
      const result = await executor.run(flow);
      if (this.fast) {
        const s = this.driver.stats();
        process.stderr.write(
          `[fast] ${flow.name ?? flow.filePath}: ${s.hits} in-process, ${s.fallbacks} HID fallbacks\n`,
        );
      }
      return result;
    } finally {
      connection.close();
    }
  }

  /**
   * Poll for the dylib's `bootstrap=ready` ping reply. Bounded at
   * 5s. Best-effort — if the ping path isn't available we don't
   * block the flow.
   */
  private async waitBootstrapReady(connection: EnnioConnection): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try {
        const r = await connection.socket.call('ping');
        const ready = r.ok && r.data && (r.data as { bootstrap?: string }).bootstrap === 'ready';
        if (ready) return;
      } catch {
        /* retry */
      }
      await new Promise((res) => setTimeout(res, 100));
    }
  }
}

// Re-export so callers don't need to deep-import.
export { execFileSync };
