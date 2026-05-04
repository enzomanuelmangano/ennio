#!/usr/bin/env bun
/**
 * Ennio CLI
 *
 * Runs Maestro YAML flows against a React Native app on the iOS simulator.
 *
 * Architecture:
 *   - reads always go through the in-app Ennio WebSocket server (Fabric).
 *   - writes go through one of two backends:
 *       --fast   (default) -> in-app sanctioned UIKit / accessibility APIs.
 *                             ~5-15ms per action. No xcodebuild. Reliable
 *                             for tap / typeText / scroll / alert. Will not
 *                             cover RNGH gestures (pinch, pan, swipe-to-
 *                             dismiss, drag-to-reorder).
 *       --stable           -> XCTest helper (XCUI HID injection).
 *                             ~30ms per action plus a one-time ~15s
 *                             cold-start. Reliable for everything.
 *
 * Usage:
 *   ennio e2e/flow.yaml                # run a single flow (fast)
 *   ennio e2e/                         # every *.yaml in directory
 *   ennio e2e/ --stable                # use the XCTest helper
 */

import { existsSync, statSync } from 'fs';
import { resolve, basename, join } from 'path';
import { glob } from 'glob';
import { EnnioClient, type Selector } from './client';
import { XCTestClient } from './xctest-client';
import { launchHelper, teardownHelper, isPortBound, killHelperDaemon, HELPER_TCP_PORT, type HelperHandle } from './xctest-helper';
import { runMaestroTests } from './maestro-runner';
import { NitroWriter, XCTestWriter, HybridWriter, type Writer, type StableContext } from './writer';
import { NitroReader, XCTestReader, HybridReader, type Reader } from './reader';

const DEFAULT_WS_PORT = 9876;

interface TestFileResult {
  file: string;
  passed: number;
  failed: number;
}

async function tryWebSocketConnection(port: number): Promise<EnnioClient | null> {
  const client = new EnnioClient(port);
  try {
    await Promise.race([
      client.connect(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
    ]);
    return client;
  } catch {
    return null;
  }
}

function isMaestroFile(filePath: string): boolean {
  return filePath.endsWith('.yaml') || filePath.endsWith('.yml');
}

interface TestFileResultWithClient extends TestFileResult {
  client?: EnnioClient;
}

async function runTestFile(
  client: EnnioClient,
  writer: Writer,
  reader: Reader,
  xctest: XCTestClient | null,
  filePath: string,
  options: { verbose?: boolean; trace?: boolean; port?: number } = {}
): Promise<TestFileResultWithClient> {
  const fileName = basename(filePath);
  console.log(`▸ ${fileName}`);
  try {
    const results = await runMaestroTests(client, writer, reader, xctest, filePath, {
      verbose: options.verbose,
      trace: options.trace,
      port: options.port,
    });
    for (const test of results.tests) {
      if (test.passed) {
        console.log(`  [PASS] ${test.name}`);
      } else {
        console.log(`  [FAIL] ${test.name}: ${test.error || 'unknown error'}`);
      }
    }
    console.log(`  ${results.passed} passed, ${results.failed} failed\n`);
    return {
      file: fileName,
      passed: results.passed,
      failed: results.failed,
      client: results.client,
    };
  } catch (err) {
    console.error(`  Error: ${err}\n`);
    return { file: fileName, passed: 0, failed: 1 };
  }
}

function buildStableContext(client: EnnioClient, xctest: XCTestClient): StableContext {
  let cachedScreen: import('./xctest-client').ScreenSize | null = null;
  return {
    async resolveByIdViaXCUI(testID) {
      const r = await xctest.findById(testID);
      return r.found && r.frame ? r.frame : null;
    },
    async resolveByLabel(text) {
      const r = await xctest.findByLabel(text);
      return r.found && r.frame ? r.frame : null;
    },
    async getScreen() {
      if (cachedScreen) return cachedScreen;
      cachedScreen = await xctest.getScreenSize();
      return cachedScreen;
    },
    async getLayoutMetrics(testID) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await (client as any).send('getLayoutMetrics', { testID });
      if (!res?.success || res.data == null || res.data === 'null') return null;
      return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
    },
    async findBySelectorLayout(selector: Selector) {
      const found = await client.findBySelector(selector);
      return found?.layout ?? null;
    },
    async hideKeyboardViaNitro() {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r: any = await (client as any).send('hideKeyboard', {});
      return r?.success === true;
    },
  };
}

async function handleDaemonSubcommand(sub: string, verbose: boolean): Promise<boolean> {
  if (sub === 'start') {
    if (await isPortBound(HELPER_TCP_PORT)) {
      console.log(`xctest helper already running on :${HELPER_TCP_PORT}`);
      return true;
    }
    console.log('Spawning XCTest helper as daemon...');
    try {
      const h = await launchHelper({ verbose, detach: true });
      console.log(`xctest helper running on :${h.port}. Stop with \`ennio stop\`.`);
    } catch (err) {
      console.error(`Failed to start: ${err}`);
      process.exit(1);
    }
    return true;
  }
  if (sub === 'stop') {
    const killed = killHelperDaemon();
    if (killed.length === 0) {
      console.log('No xctest helper running.');
    } else {
      console.log(`Stopped xctest helper (pid ${killed.join(', ')})`);
    }
    return true;
  }
  if (sub === 'status') {
    const bound = await isPortBound(HELPER_TCP_PORT);
    console.log(bound ? `xctest helper RUNNING on :${HELPER_TCP_PORT}` : 'xctest helper NOT running');
    return true;
  }
  return false;
}

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const portArg = process.argv.find((a) => a.startsWith('--port='));
  const port = portArg ? parseInt(portArg.split('=')[1], 10) : DEFAULT_WS_PORT;
  const verbose = process.argv.includes('--verbose') || process.argv.includes('-v');
  const trace = process.argv.includes('--trace');
  const stable = process.argv.includes('--stable');
  const fastFlag = process.argv.includes('--fast');
  // --fast is the default; --stable opts in to the XCTest helper path.
  const mode: 'fast' | 'stable' = stable && !fastFlag ? 'stable' : 'fast';

  // Daemon subcommands. `ennio start | stop | status` manage a long-
  // lived helper so subsequent flow runs skip the ~15s xcodebuild
  // cold-start.
  if (args.length === 1 && ['start', 'stop', 'status'].includes(args[0])) {
    const handled = await handleDaemonSubcommand(args[0], verbose);
    if (handled) process.exit(0);
  }

  if (args.length === 0) {
    console.log('Usage: ennio <flow.yaml> [options]');
    console.log('       ennio e2e/           # runs every *.yaml under the directory');
    console.log('       ennio start          # spawn helper daemon (one-time ~15s cost)');
    console.log('       ennio stop           # kill daemon');
    console.log('       ennio status         # is daemon running?');
    console.log('\nOptions:');
    console.log('  --fast         (default) in-app writes via accessibilityActivate / UIKit');
    console.log('  --stable       writes through the bundled XCTest helper (slower, more thorough)');
    console.log('  --port=9876    WebSocket port (default: 9876)');
    console.log('  --verbose, -v  show detailed command execution');
    console.log('  --trace        emit a trace marker between commands');
    process.exit(0);
  }

  const files: string[] = [];
  for (const pattern of args) {
    const resolved = resolve(pattern);
    if (existsSync(resolved) && statSync(resolved).isDirectory()) {
      const yamlMatches = await glob(join(pattern, '**/*.yaml'));
      const yamlFiles = yamlMatches
        .filter((f) => isMaestroFile(f) && !f.includes('/subflows/'))
        .map((f) => resolve(f));
      files.push(...yamlFiles);
    } else {
      const matches = await glob(pattern);
      files.push(
        ...matches
          .filter((f) => isMaestroFile(f) && !f.includes('/subflows/'))
          .map((f) => resolve(f))
      );
    }
  }

  if (files.length === 0) {
    console.error('No Maestro YAML files found');
    process.exit(1);
  }

  console.log('\n🧪 Ennio (' + mode + ' mode)\n');

  const client = await tryWebSocketConnection(port);
  if (!client) {
    console.error(
      `Could not connect to the in-app Ennio server on port ${port}.\n` +
        `Make sure the user app is running on the iOS simulator before invoking ennio.`
    );
    process.exit(1);
  }
  console.log(`(Connected via WebSocket on port ${port})\n`);

  let helper: HelperHandle | null = null;
  let xctest: XCTestClient | null = null;
  let writer: Writer;

  // Both modes need the XCTest helper:
  //   - stable: every write goes through it.
  //   - fast (default): used as fallback when an in-app Nitro write
  //     fails or a text-only selector hits a native UI element outside
  //     the Fabric tree. Without it the runner can't recover.
  console.log('(Launching XCTest helper...)');
  try {
    helper = await launchHelper({ verbose });
    xctest = new XCTestClient(helper.port);
    await xctest.connect(15_000);
    await xctest.ping();
    console.log(`(XCTest helper ready on :${helper.port})\n`);
  } catch (err) {
    console.error(`Failed to launch XCTest helper: ${err}`);
    if (helper) await teardownHelper(helper);
    client.disconnect();
    process.exit(1);
  }

  // Auto-respawn: when the helper dies mid-suite (testmanagerd reaps the
  // runner after a hard XCUI failure), the client triggers a relaunch.
  // Without this every flow after the death would fail with
  // "xctest-client: not connected" until the user restarts the daemon.
  xctest.setRespawnHandler(async () => {
    if (verbose) console.log('(xctest helper died — respawning...)');
    if (helper) await teardownHelper(helper);
    helper = await launchHelper({ verbose });
    if (verbose) console.log(`(xctest helper respawned on :${helper.port})`);
  });

  const ctx = buildStableContext(client, xctest!);
  let reader: Reader;
  if (mode === 'stable') {
    // Stable = HID-driven writes (XCUI) but reads still come from
    // Fabric's shadow tree. RN Text and similar nodes aren't always
    // exposed in the iOS accessibility tree, so XCUI alone misses
    // visibility checks that the runner relies on.
    writer = new XCTestWriter(xctest!, ctx);
    reader = new HybridReader(
      new NitroReader(client),
      new XCTestReader(xctest!)
    );
  } else {
    const onWriterFallback = (op: string, sel: unknown) => {
      if (verbose) console.log(`    (fallback to xctest: ${op} ${JSON.stringify(sel)})`);
    };
    const onReaderFallback = (op: string, arg: unknown) => {
      if (verbose) console.log(`    (read fallback to xctest: ${op} ${JSON.stringify(arg)})`);
    };
    writer = new HybridWriter(
      new NitroWriter(client),
      new XCTestWriter(xctest!, ctx),
      ctx,
      onWriterFallback
    );
    reader = new HybridReader(
      new NitroReader(client),
      new XCTestReader(xctest!),
      onReaderFallback
    );
  }

  let totalPassed = 0;
  let totalFailed = 0;
  let currentClient = client;

  try {
    for (const file of files) {
      const result = await runTestFile(currentClient, writer, reader, xctest, file, { verbose, trace, port });
      totalPassed += result.passed;
      totalFailed += result.failed;
      if (result.client) {
        currentClient = result.client;
        const newCtx = buildStableContext(currentClient, xctest!);
        if (mode === 'stable') {
          writer = new XCTestWriter(xctest!, newCtx);
          reader = new XCTestReader(xctest!);
        } else {
          const onWriterFallback = (op: string, sel: unknown) => {
            if (verbose) console.log(`    (fallback to xctest: ${op} ${JSON.stringify(sel)})`);
          };
          const onReaderFallback = (op: string, arg: unknown) => {
            if (verbose) console.log(`    (read fallback to xctest: ${op} ${JSON.stringify(arg)})`);
          };
          writer = new HybridWriter(
            new NitroWriter(currentClient),
            new XCTestWriter(xctest!, newCtx),
            newCtx,
            onWriterFallback
          );
          reader = new HybridReader(
            new NitroReader(currentClient),
            new XCTestReader(xctest!),
            onReaderFallback
          );
        }
      }
    }
  } finally {
    currentClient.disconnect();
    // Only send `quit` to the helper if WE spawned it. A pre-existing
    // daemon (started via `ennio start`) keeps running across many CLI
    // invocations; quitting it would force a 15s cold-start on the
    // next flow.
    if (xctest && helper && !helper.preExisting) {
      try { await xctest.quit(); } catch { /* noop */ }
    } else if (xctest) {
      xctest.disconnect();
    }
    if (helper) await teardownHelper(helper);
  }

  console.log('─'.repeat(40));
  console.log(`Total: ${totalPassed} passed, ${totalFailed} failed`);
  process.exit(totalFailed > 0 ? 1 : 0);
}

main();
