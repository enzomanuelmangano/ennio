// diag-report — aggregate a diag JSONL stream into metrics, and diff two runs
// (a PR run vs a main BASELINE) to surface regressions.
//
// The diag sink (diag.ts) emits one JSON record per lifecycle event. On its own
// that's a haystack. This turns a run into a compact, comparable METRICS object:
// how many inject attempts per connect, how long binds took, how often the agent
// had to relaunch and why, suite pass/fail and timings. CI uploads the metrics
// and diffs every PR against the latest main baseline so a regression (more
// attempts, slower binds, new failure modes) is caught the moment it appears —
// not inferred from a rotated log three failures later.

export interface DiagEvent {
  ms: number;
  pid: number;
  component: string;
  event: string;
  [k: string]: unknown;
}

export interface Metrics {
  /** inject/connect lifecycle */
  inject: {
    connects: number; // establish:start
    ready: number; // establish succeeded
    failed: number; // establish:fail (budget exhausted)
    attempts: number; // total attempt:start
    attemptsPerConnect: number;
    maxAttemptsInAConnect: number;
    bindMs: Percentiles; // time dlopen→@ennio bound
    readyTotalMs: Percentiles; // whole establish duration on success
    relaunches: number;
    /** why an attempt ended, counted */
    outcomes: Record<string, number>; // ready|no-pid|dlopen-fail|no-bind|pid-died|not-ready
    /** why awaitReadyWhileAlive gave up */
    readyWaitBail: Record<string, number>; // pid-gone|wedged|budget
    reuseExisting: number;
    reuseFailed: number;
  };
  flows: {
    total: number;
    passed: number;
    failed: number;
    durationMs: Percentiles;
    failures: { name: string; step?: number; command?: string; reason?: string }[];
  };
  // App-reset lifecycle. The key signal on iOS (which has no inject retry
  // loop): how long clearState / relaunch / soft-reset take, and how often.
  lifecycle: {
    clearState: number;
    clearStateMs: Percentiles;
    relaunchMs: Percentiles;
    softResetMs: Percentiles;
  };
  totalEvents: number;
}

export interface Percentiles {
  n: number;
  p50: number;
  p95: number;
  max: number;
  sum: number;
}

function pct(values: number[]): Percentiles {
  if (values.length === 0) return { n: 0, p50: 0, p95: 0, max: 0, sum: 0 };
  const s = [...values].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))];
  return {
    n: s.length,
    p50: at(0.5),
    p95: at(0.95),
    max: s[s.length - 1],
    sum: s.reduce((a, b) => a + b, 0),
  };
}

/** Parse a diag JSONL blob into events, skipping blank/garbage lines. */
export function parseDiag(text: string): DiagEvent[] {
  const out: DiagEvent[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t);
      if (o && typeof o === 'object' && typeof o.event === 'string') out.push(o as DiagEvent);
    } catch {
      /* skip non-JSON noise */
    }
  }
  return out;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Roll a diag event stream up into comparable metrics. */
export function aggregate(events: DiagEvent[]): Metrics {
  const inj = events.filter((e) => e.component === 'inject');
  const bindMs: number[] = [];
  const readyTotalMs: number[] = [];
  const outcomes: Record<string, number> = {};
  const readyWaitBail: Record<string, number> = {};
  let attemptsInCurrentConnect = 0;
  let maxAttempts = 0;

  for (const e of inj) {
    switch (e.event) {
      case 'establish:start':
        attemptsInCurrentConnect = 0;
        break;
      case 'attempt:start':
        attemptsInCurrentConnect++;
        maxAttempts = Math.max(maxAttempts, attemptsInCurrentConnect);
        break;
      case 'bound': {
        const v = num(e.bindMs);
        if (v !== undefined) bindMs.push(v);
        break;
      }
      case 'ready': {
        const v = num(e.totalMs);
        if (v !== undefined) readyTotalMs.push(v);
        break;
      }
      case 'attempt:done': {
        const o = str(e.outcome) ?? 'unknown';
        outcomes[o] = (outcomes[o] ?? 0) + 1;
        break;
      }
      case 'ready-wait:pid-gone':
        readyWaitBail['pid-gone'] = (readyWaitBail['pid-gone'] ?? 0) + 1;
        break;
      case 'ready-wait:wedged':
        readyWaitBail['wedged'] = (readyWaitBail['wedged'] ?? 0) + 1;
        break;
      case 'ready-wait:budget':
        readyWaitBail['budget'] = (readyWaitBail['budget'] ?? 0) + 1;
        break;
    }
  }

  const connects = inj.filter((e) => e.event === 'establish:start').length;
  const attempts = inj.filter((e) => e.event === 'attempt:start').length;

  const flowEnds = events.filter((e) => e.component === 'flow' && e.event === 'end');
  const durations = flowEnds.map((e) => num(e.durationMs) ?? 0);
  const failures = flowEnds
    .filter((e) => e.passed === false)
    .map((e) => ({
      name: str(e.name) ?? '?',
      step: num(e.failStep),
      command: str(e.failCommand),
      reason: str(e.failReason),
    }));

  return {
    inject: {
      connects,
      ready: inj.filter((e) => e.event === 'ready').length,
      failed: inj.filter((e) => e.event === 'establish:fail').length,
      attempts,
      attemptsPerConnect: connects ? round2(attempts / connects) : 0,
      maxAttemptsInAConnect: maxAttempts,
      bindMs: pct(bindMs),
      readyTotalMs: pct(readyTotalMs),
      relaunches: inj.filter((e) => e.event === 'relaunch').length,
      outcomes,
      readyWaitBail,
      reuseExisting: inj.filter((e) => e.event === 'reuse-existing').length,
      reuseFailed: inj.filter((e) => e.event === 'reuse-failed').length,
    },
    flows: {
      total: flowEnds.length,
      passed: flowEnds.filter((e) => e.passed === true).length,
      failed: failures.length,
      durationMs: pct(durations),
      failures,
    },
    lifecycle: {
      clearState: events.filter((e) => e.component === 'lifecycle' && e.event === 'clearState')
        .length,
      clearStateMs: pct(lifecycleDurations(events, 'clearState:done')),
      relaunchMs: pct(lifecycleDurations(events, 'relaunch:done')),
      softResetMs: pct(lifecycleDurations(events, 'softReset:done')),
    },
    totalEvents: events.length,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function lifecycleDurations(events: DiagEvent[], event: string): number[] {
  return events
    .filter((e) => e.component === 'lifecycle' && e.event === event)
    .map((e) => num(e.durMs))
    .filter((v): v is number => v !== undefined);
}

/** Human-readable single-run report. */
export function formatReport(m: Metrics): string {
  const L: string[] = [];
  L.push('═══ ennio diag report ═══');
  L.push(`events: ${m.totalEvents}`);
  L.push('');
  L.push('── inject / connect ──');
  L.push(
    `connects=${m.inject.connects} ready=${m.inject.ready} failed=${m.inject.failed} ` +
      `reuse(ok/fail)=${m.inject.reuseExisting}/${m.inject.reuseFailed}`,
  );
  L.push(
    `attempts=${m.inject.attempts} per-connect=${m.inject.attemptsPerConnect} ` +
      `max-in-a-connect=${m.inject.maxAttemptsInAConnect} relaunches=${m.inject.relaunches}`,
  );
  L.push(`bind ms: ${fmtPct(m.inject.bindMs)}`);
  L.push(`establish ms: ${fmtPct(m.inject.readyTotalMs)}`);
  L.push(`attempt outcomes: ${fmtCounts(m.inject.outcomes)}`);
  L.push(`ready-wait bail: ${fmtCounts(m.inject.readyWaitBail)}`);
  L.push('');
  L.push('── flows ──');
  L.push(`total=${m.flows.total} passed=${m.flows.passed} failed=${m.flows.failed}`);
  L.push(`flow ms: ${fmtPct(m.flows.durationMs)}`);
  if (m.flows.failures.length) {
    L.push('failures:');
    for (const f of m.flows.failures) {
      L.push(`  ✗ ${f.name}${f.step ? ` @step ${f.step}` : ''} — ${f.reason ?? '?'}`);
    }
  }
  L.push('');
  L.push('── lifecycle (app reset) ──');
  L.push(`clearState count=${m.lifecycle.clearState}`);
  L.push(`clearState ms: ${fmtPct(m.lifecycle.clearStateMs)}`);
  L.push(`relaunch ms:   ${fmtPct(m.lifecycle.relaunchMs)}`);
  L.push(`softReset ms:  ${fmtPct(m.lifecycle.softResetMs)}`);
  return L.join('\n');
}

function fmtPct(p: Percentiles): string {
  return `n=${p.n} p50=${p.p50} p95=${p.p95} max=${p.max}`;
}
function fmtCounts(c: Record<string, number>): string {
  const keys = Object.keys(c).sort();
  return keys.length ? keys.map((k) => `${k}=${c[k]}`).join(' ') : '(none)';
}

// ── comparison vs baseline ─────────────────────────────────────────────────

export interface Regression {
  metric: string;
  base: number;
  cur: number;
  delta: number;
  severity: 'regression' | 'improvement' | 'info';
}

/**
 * Diff a current run against a baseline. A regression on this substrate means
 * the runner had to work HARDER or got SLOWER (more attempts/relaunches, slower
 * binds, new failures). Flags only meaningful moves (small noise is ignored via
 * relative + absolute thresholds). Pure data — the caller decides whether to
 * warn or fail CI.
 */
export function compare(base: Metrics, cur: Metrics): Regression[] {
  const out: Regression[] = [];
  const judge = (
    metric: string,
    b: number,
    c: number,
    opts: { higherIsWorse: boolean; absMin?: number; relMin?: number },
  ) => {
    const delta = round2(c - b);
    if (delta === 0) return;
    const absMin = opts.absMin ?? 0;
    const relMin = opts.relMin ?? 0;
    const rel = b === 0 ? (c === 0 ? 0 : 1) : Math.abs(delta) / Math.abs(b);
    if (Math.abs(delta) < absMin && rel < relMin) {
      out.push({ metric, base: b, cur: c, delta, severity: 'info' });
      return;
    }
    const worse = opts.higherIsWorse ? delta > 0 : delta < 0;
    out.push({ metric, base: b, cur: c, delta, severity: worse ? 'regression' : 'improvement' });
  };

  judge(
    'inject.attemptsPerConnect',
    base.inject.attemptsPerConnect,
    cur.inject.attemptsPerConnect,
    {
      higherIsWorse: true,
      absMin: 0.2,
      relMin: 0.15,
    },
  );
  judge(
    'inject.maxAttemptsInAConnect',
    base.inject.maxAttemptsInAConnect,
    cur.inject.maxAttemptsInAConnect,
    {
      higherIsWorse: true,
      absMin: 1,
    },
  );
  judge('inject.relaunches', base.inject.relaunches, cur.inject.relaunches, {
    higherIsWorse: true,
    absMin: 2,
    relMin: 0.25,
  });
  judge('inject.failed', base.inject.failed, cur.inject.failed, { higherIsWorse: true, absMin: 1 });
  judge('inject.bindMs.p95', base.inject.bindMs.p95, cur.inject.bindMs.p95, {
    higherIsWorse: true,
    absMin: 300,
    relMin: 0.3,
  });
  judge('inject.readyTotalMs.p95', base.inject.readyTotalMs.p95, cur.inject.readyTotalMs.p95, {
    higherIsWorse: true,
    absMin: 1000,
    relMin: 0.3,
  });
  judge('flows.failed', base.flows.failed, cur.flows.failed, { higherIsWorse: true, absMin: 1 });
  judge('flows.durationMs.p95', base.flows.durationMs.p95, cur.flows.durationMs.p95, {
    higherIsWorse: true,
    absMin: 2000,
    relMin: 0.25,
  });
  // App-reset cost (the dominant per-flow lifecycle signal, esp. on iOS).
  judge(
    'lifecycle.clearStateMs.p95',
    base.lifecycle.clearStateMs.p95,
    cur.lifecycle.clearStateMs.p95,
    {
      higherIsWorse: true,
      absMin: 1500,
      relMin: 0.3,
    },
  );
  judge('lifecycle.relaunchMs.p95', base.lifecycle.relaunchMs.p95, cur.lifecycle.relaunchMs.p95, {
    higherIsWorse: true,
    absMin: 1500,
    relMin: 0.3,
  });
  return out;
}

/** Render a compare result as a table; returns { text, hasRegression }. */
export function formatCompare(diffs: Regression[]): { text: string; hasRegression: boolean } {
  const sev = { regression: '🔴 REGRESSION', improvement: '🟢 improved', info: '·' } as const;
  const rank = (s: Regression['severity']) => (s === 'regression' ? 0 : 1);
  const rows = diffs
    .filter((d) => d.severity !== 'info')
    .sort((a, b) => rank(a.severity) - rank(b.severity));
  const L: string[] = ['═══ diag compare (PR vs main baseline) ═══'];
  if (rows.length === 0) {
    L.push('no significant change vs baseline');
  } else {
    for (const d of rows) {
      const sign = d.delta > 0 ? '+' : '';
      L.push(`${sev[d.severity]}  ${d.metric}: ${d.base} → ${d.cur} (${sign}${d.delta})`);
    }
  }
  return { text: L.join('\n'), hasRegression: rows.some((d) => d.severity === 'regression') };
}
