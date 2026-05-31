// Residual runner utilities — describeCommand + runMaestroScript.
//
// Historically a 2000-line god module; OOP migration split everything
// into core/ (EnnioRunner / FlowExecutor / etc) and commands/handlers/.
// What stays here:
//   - describeCommand: pure formatter, used by FlowExecutor and reporters.
//   - runMaestroScript: Node `vm` + curl shim for Maestro's runScript
//     sandbox; still called by commands/handlers/control-flow.ts.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';

import type { MaestroCommand } from '../maestro-parser';

import type { RunContext, RunResult } from './context';
import { recordPhase } from './context';

// Re-export for legacy importers.
export type { RunContext, RunResult };
export { recordPhase };

export function describeCommand(cmd: MaestroCommand): string {
  const key = Object.keys(cmd)[0];
  const value = (cmd as Record<string, unknown>)[key];
  if (typeof value === 'string') return `${key}: ${value}`;
  if (typeof value === 'boolean') return key;
  if (value && typeof value === 'object') {
    return `${key}: ${JSON.stringify(value)}`;
  }
  return key;
}

// =====================================================================
// runScript — Maestro JS sandbox
// =====================================================================
//
// Maestro's runScript executes JS in a GraalVM sandbox with custom
// globals: http.{get,post,put,delete}, output (mutable bag), json
// (synchronous parse), env (script-step env block). We use Node's `vm`
// module + a curl-backed synchronous http shim — covers the surface
// area real flows actually use.

function maestroHttpSyncOnce(
  method: string,
  url: string,
  opts?: { headers?: Record<string, string>; body?: string },
): { status: number; body: string; headers: Record<string, string> } {
  const args = ['-sS', '-X', method.toUpperCase(), '-w', '\n%{http_code}', url];
  if (opts?.headers) {
    for (const [k, v] of Object.entries(opts.headers)) {
      args.push('-H', `${k}: ${v}`);
    }
  }
  if (opts?.body !== undefined) {
    args.push('--data-binary', opts.body);
  }
  const res = spawnSync('curl', args, { encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 });
  const out = (res.stdout ?? '') + (res.stderr ?? '');
  const nl = out.lastIndexOf('\n');
  let status = 0;
  let body = out;
  if (nl >= 0) {
    const tail = out.slice(nl + 1).trim();
    if (/^\d{3}$/.test(tail)) {
      status = parseInt(tail, 10);
      body = out.slice(0, nl);
    }
  }
  return { status, body, headers: {} };
}

function maestroHttpSync(
  method: string,
  url: string,
  opts?: { headers?: Record<string, string>; body?: string },
): { status: number; body: string; headers: Record<string, string> } {
  // Mock PDS cycles its process on each setupServer POST — first call
  // after a cycle can land mid-restart and return empty body + 500.
  // Retry with backoff before giving up.
  let last = maestroHttpSyncOnce(method, url, opts);
  for (let i = 0; i < 4 && (last.status >= 500 || last.body.trim() === ''); i++) {
    const sleepMs = 500 * (i + 1);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleepMs);
    last = maestroHttpSyncOnce(method, url, opts);
  }
  return last;
}

export async function runMaestroScript(
  ctx: RunContext,
  script: { file: string; env?: Record<string, string> },
): Promise<void> {
  const scriptPath = resolve(dirname(ctx.flowPath), script.file);
  const src = readFileSync(scriptPath, 'utf-8');
  const sandbox = {
    output: ctx.outputs,
    http: {
      get: (url: string, opts?: { headers?: Record<string, string>; body?: string }) =>
        maestroHttpSync('GET', url, opts),
      post: (url: string, opts?: { headers?: Record<string, string>; body?: string }) =>
        maestroHttpSync('POST', url, opts),
      put: (url: string, opts?: { headers?: Record<string, string>; body?: string }) =>
        maestroHttpSync('PUT', url, opts),
      delete: (url: string, opts?: { headers?: Record<string, string>; body?: string }) =>
        maestroHttpSync('DELETE', url, opts),
    },
    json: (s: string) => JSON.parse(s),
    console: { log: (...a: unknown[]) => process.stderr.write(`[script] ${a.join(' ')}\n`) },
    ...(script.env ?? {}),
  };
  const vmCtx = createContext(sandbox);
  runInContext(src, vmCtx, { filename: scriptPath, timeout: 30_000 });
}
