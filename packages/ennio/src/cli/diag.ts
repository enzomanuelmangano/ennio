// diag — structured, always-on-in-CI diagnostics for ennio's OWN execution.
//
// The Android inject/connect path is racy on a contended CI emulator in ways
// that don't reproduce off-CI, and the failure wears a different mask each run.
// Inference from a single rotated logcat line is not enough to fix it for real.
// So we over-instrument: every interesting lifecycle event emits a structured
// JSONL record that CI uploads as an artifact. The NEXT failure then ships its
// own forensics (the full per-attempt distribution) instead of a guess.
//
// Scope: this only ever records ennio's own runner activity — it never touches
// or instruments the target app. It's a diagnostic side-channel, not telemetry.
//
// Enablement (a flag, defaulted on in CI):
//   * ENNIO_DIAG=1            → on
//   * ENNIO_DIAG=0|false|off  → off (hard override, even in CI)
//   * otherwise               → on when running in CI (process.env.CI truthy),
//                               off locally
// Sink: ENNIO_DIAG_FILE (a path), else <ENNIO_DIAG_DIR|os.tmpdir()>/ennio-diag.jsonl.
// Mirror to stderr with ENNIO_DIAG_STDERR=1 (handy when watching a run live).

import { appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

type Fields = Record<string, unknown>;

function truthy(v: string | undefined): boolean {
  return v !== undefined && v !== '' && v !== '0' && v !== 'false' && v !== 'off';
}

let enabledCache: boolean | undefined;

/** Is diagnostics recording on for this process? Computed once. */
export function diagEnabled(): boolean {
  if (enabledCache !== undefined) return enabledCache;
  const explicit = process.env.ENNIO_DIAG;
  if (explicit !== undefined) {
    // Hard override in either direction (so CI can force it off too).
    enabledCache = truthy(explicit);
  } else {
    // Default ON in CI, OFF locally.
    enabledCache = truthy(process.env.CI);
  }
  return enabledCache;
}

let resolvedFile: string | undefined;
let warnedSinkError = false;

function sinkFile(): string {
  if (resolvedFile) return resolvedFile;
  resolvedFile =
    process.env.ENNIO_DIAG_FILE || join(process.env.ENNIO_DIAG_DIR || tmpdir(), 'ennio-diag.jsonl');
  return resolvedFile;
}

const startMs = Date.now();

/**
 * Record one structured diagnostic event. No-op (and zero cost beyond the
 * enabled check) when diagnostics are off. `component` groups records (e.g.
 * 'inject'), `event` names the moment ('attempt-start'), `fields` carry the
 * payload. A wall-clock `t` and a process-relative `ms` are added so a single
 * file reconstructs ordering and durations without external clocks.
 */
export function diag(component: string, event: string, fields: Fields = {}): void {
  if (!diagEnabled()) return;
  const rec = {
    ms: Date.now() - startMs,
    // The CLI process pid. Named distinctly so an event's own `pid` field
    // (the on-device app pid) can't shadow it.
    procPid: process.pid,
    component,
    event,
    ...fields,
  };
  let line: string;
  try {
    line = JSON.stringify(rec);
  } catch {
    line = JSON.stringify({ ms: rec.ms, component, event, error: 'unserializable-fields' });
  }
  if (truthy(process.env.ENNIO_DIAG_STDERR)) {
    process.stderr.write(`[diag] ${line}\n`);
  }
  try {
    const f = sinkFile();
    mkdirSync(dirname(f), { recursive: true });
    appendFileSync(f, line + '\n');
  } catch (e) {
    // The sink must never break a run. Warn once to stderr, then stay silent.
    if (!warnedSinkError) {
      warnedSinkError = true;
      process.stderr.write(
        `[diag] could not write ${sinkFile()}: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }
}

/**
 * Time a span and emit a completion record with `durMs`. Returns a `done`
 * callback that records `<event>:done` with the elapsed time plus any extra
 * fields known only at the end (e.g. the outcome). Cheap no-op when off.
 */
export function diagSpan(
  component: string,
  event: string,
  fields: Fields = {},
): (extra?: Fields) => void {
  if (!diagEnabled()) return () => {};
  const t0 = Date.now();
  diag(component, `${event}:start`, fields);
  return (extra: Fields = {}) => {
    diag(component, `${event}:done`, { durMs: Date.now() - t0, ...extra });
  };
}

/** The resolved sink path (for a startup banner / CI artifact wiring). */
export function diagFile(): string {
  return sinkFile();
}
