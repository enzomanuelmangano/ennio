#!/usr/bin/env node
// Flake-rate baseline harness — the regression gate for the runner
// refactor (see plans/what-about-the-code-scalable-panda.md, Phase 0).
//
// Runs every flow in a directory N times against a booted simulator and
// records per-flow pass counts. The refactor's contract: every later
// phase must match or beat this pass-rate distribution. A single green
// run is NOT sufficient — flake lives in the tail.
//
// Usage:
//   node scripts/flake-baseline.mjs [--dir <e2e-dir>] [--runs N] [--out <file>]
//
// Defaults: --dir ../../examples/showcase/maestro-e2e  --runs 5  --out reports/flake-baseline.json
//
// Requires a booted iOS sim (same prerequisites as `ennio test`).
// Env passthrough: ENNIO_UDID, ENNIO_DYLIB_PATH.

import { spawnSync } from 'node:child_process';
import { readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');

function parseArgs(argv) {
  const a = {
    dir: resolve(pkgRoot, '../../examples/showcase/maestro-e2e'),
    runs: 5,
    out: resolve(pkgRoot, 'reports/flake-baseline.json'),
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') a.dir = resolve(argv[++i]);
    else if (argv[i] === '--runs') a.runs = parseInt(argv[++i], 10);
    else if (argv[i] === '--out') a.out = resolve(argv[++i]);
  }
  return a;
}

function listFlows(dir) {
  // Top-level *.yaml/*.yml only; skip subflows and `_`-prefixed probes,
  // matching the runner's own suite-expansion rules.
  return readdirSync(dir)
    .filter((f) => (f.endsWith('.yaml') || f.endsWith('.yml')) && !f.startsWith('_'))
    .sort()
    .map((f) => join(dir, f));
}

function runOnce(cli, flow) {
  const res = spawnSync('node', [cli, 'test', flow], {
    encoding: 'utf-8',
    env: process.env,
    maxBuffer: 32 * 1024 * 1024,
  });
  const out = (res.stdout ?? '') + (res.stderr ?? '');
  // The runner prints "[PASS]" / "[FAIL]" / "[ERROR]" per flow.
  const passed = /\[PASS\]/.test(out) && !/\[FAIL\]|\[ERROR\]/.test(out);
  return { passed, code: res.status ?? 1 };
}

function main() {
  const { dir, runs, out } = parseArgs(process.argv.slice(2));
  const cli = resolve(pkgRoot, 'dist/cli.js');
  if (!existsSync(cli)) {
    console.error(`Build first: ${cli} not found (run \`bun run build\`).`);
    process.exit(1);
  }
  const flows = listFlows(dir);
  if (flows.length === 0) {
    console.error(`No flows found in ${dir}`);
    process.exit(1);
  }

  console.log(`Flake baseline: ${flows.length} flows × ${runs} runs against ${dir}\n`);
  const results = {};
  for (const flow of flows) {
    const name = basename(flow);
    let passes = 0;
    const codes = [];
    for (let i = 0; i < runs; i++) {
      const { passed, code } = runOnce(cli, flow);
      if (passed) passes++;
      codes.push(code);
      process.stdout.write(passed ? '.' : 'F');
    }
    results[name] = { passes, runs, passRate: passes / runs, codes };
    process.stdout.write(`  ${name}  ${passes}/${runs}\n`);
  }

  const flaky = Object.entries(results).filter(([, r]) => r.passes > 0 && r.passes < r.runs);
  const dead = Object.entries(results).filter(([, r]) => r.passes === 0);
  const summary = {
    dir,
    runs,
    flowCount: flows.length,
    fullyGreen: Object.values(results).filter((r) => r.passes === r.runs).length,
    flaky: flaky.map(([n]) => n),
    dead: dead.map(([n]) => n),
    results,
  };

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(summary, null, 2));
  console.log(
    `\nFully green: ${summary.fullyGreen}/${flows.length}  |  flaky: ${flaky.length}  |  dead: ${dead.length}`,
  );
  console.log(`Baseline written to ${out}`);
}

main();
