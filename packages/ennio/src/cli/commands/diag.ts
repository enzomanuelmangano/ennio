// `ennio diag` — analyze diag JSONL produced by an instrumented run.
//
//   ennio diag report  <run.jsonl>                 → human-readable metrics
//   ennio diag report  <run.jsonl> --json          → metrics as JSON (baseline)
//   ennio diag compare <baseline.json> <run.jsonl>  → diff PR run vs main baseline
//   ennio diag compare ... --fail-on-regression     → exit 1 if anything regressed
//
// `compare` accepts either a raw JSONL run or an already-aggregated metrics
// JSON for each side, so CI can cache the cheap metrics JSON as the baseline
// and diff the PR's raw run against it. Pure file-in / report-out; no device.

import { readFileSync } from 'node:fs';

import type { Flags } from '../cli/args';
import {
  aggregate,
  compare,
  formatCompare,
  formatReport,
  parseDiag,
  type Metrics,
} from '../diag-report';

/** Load a path as either a diag JSONL run or a pre-aggregated metrics JSON. */
function loadMetrics(path: string): Metrics {
  const raw = readFileSync(path, 'utf-8');
  const trimmed = raw.trimStart();
  // A metrics JSON is a single object with an `inject` key; a run is JSONL.
  if (trimmed.startsWith('{') && !trimmed.includes('\n{')) {
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object' && 'inject' in obj && 'flows' in obj) {
        return obj as Metrics;
      }
    } catch {
      /* fall through to JSONL parse */
    }
  }
  return aggregate(parseDiag(raw));
}

export function runDiagCommand(positional: string[], flags: Flags): number {
  const [action, ...rest] = positional;

  if (action === 'report') {
    const file = rest[0];
    if (!file) {
      console.error('usage: ennio diag report <run.jsonl> [--json]');
      return 1;
    }
    const metrics = loadMetrics(file);
    if (flags.reporter === 'json') {
      console.log(JSON.stringify(metrics, null, 2));
    } else {
      console.log(formatReport(metrics));
    }
    return 0;
  }

  if (action === 'compare') {
    const [basePath, curPath] = rest;
    if (!basePath || !curPath) {
      console.error(
        'usage: ennio diag compare <baseline.json|run.jsonl> <run.jsonl> [--fail-on-regression]',
      );
      return 1;
    }
    const base = loadMetrics(basePath);
    const cur = loadMetrics(curPath);
    const { text, hasRegression } = formatCompare(compare(base, cur));
    console.log(text);
    // Opt-in gate: by default compare is INFORMATIONAL (it must not flip a
    // green suite red on its own). --fail-on-regression makes it enforcing.
    return flags.failOnRegression && hasRegression ? 1 : 0;
  }

  console.error('usage: ennio diag <report|compare> ...');
  return 1;
}
