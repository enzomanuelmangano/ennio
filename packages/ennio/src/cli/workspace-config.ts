/**
 * Maestro workspace config — `config.yaml` (or `config.yml`) at the root of a
 * flows directory. It is configuration, not a flow: running it as one fails
 * with "missing top-level appId". Supported keys, as Maestro reads them:
 *
 *   flows:                  globs (relative to the directory) selecting the
 *     - flows/*.yaml        flows to run; default `*` (top level only), as
 *                           Maestro — without a config ennio keeps walking
 *                           the whole tree
 *   executionOrder:
 *     continueOnFailure: false   a failure skips the rest of the ordered
 *                                flows; the unordered ones still run
 *     flowsOrder:                run these first, in this order — matched by
 *       - Home                   the flow's `name:` or its file name without
 *                                extension; the rest run after, sorted
 */

import { existsSync, readFileSync } from 'fs';
import { basename, extname, join } from 'path';

import { load as parseYaml, loadAll as parseYamlAll } from 'js-yaml';

export const WORKSPACE_CONFIG_NAMES = ['config.yaml', 'config.yml'];

export interface WorkspaceConfig {
  path: string;
  flows?: string[];
  flowsOrder?: string[];
  continueOnFailure?: boolean;
  /** Keys present but not implemented (includeTags, excludeTags…). */
  unsupported: string[];
}

export function readWorkspaceConfig(dir: string): WorkspaceConfig | undefined {
  for (const name of WORKSPACE_CONFIG_NAMES) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    const raw = (parseYaml(readFileSync(path, 'utf8')) ?? {}) as {
      flows?: unknown;
      executionOrder?: { continueOnFailure?: unknown; flowsOrder?: unknown };
    } & Record<string, unknown>;
    const strings = (v: unknown) =>
      Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : undefined;
    return {
      path,
      flows: strings(raw.flows),
      flowsOrder: strings(raw.executionOrder?.flowsOrder),
      continueOnFailure:
        typeof raw.executionOrder?.continueOnFailure === 'boolean'
          ? raw.executionOrder.continueOnFailure
          : undefined,
      unsupported: Object.keys(raw).filter((k) => k !== 'flows' && k !== 'executionOrder'),
    };
  }
  return undefined;
}

/** The flow's `name:` from its config document, if it declares one. */
function flowName(file: string): string | undefined {
  try {
    const [header] = parseYamlAll(readFileSync(file, 'utf8')) as { name?: unknown }[];
    return typeof header?.name === 'string' ? header.name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Put the `flowsOrder` flows first, in order; the rest follow, sorted. An
 * entry matches a flow's `name:` first, then a file name without extension.
 * A name that matches no flow is an error — Maestro fails on it too, and
 * silently skipping it would drop a flow from the suite.
 */
export function orderFlows(files: string[], flowsOrder: string[] | undefined): string[] {
  const sorted = [...files].sort();
  if (!flowsOrder?.length) return sorted;
  const names = new Map(sorted.map((f) => [f, flowName(f)]));
  const ordered: string[] = [];
  for (const entry of flowsOrder) {
    const free = sorted.filter((f) => !ordered.includes(f));
    const match =
      free.find((f) => names.get(f) === entry) ??
      free.find((f) => basename(f, extname(f)) === entry);
    if (!match) throw new Error(`executionOrder.flowsOrder: no flow named "${entry}"`);
    ordered.push(match);
  }
  return [...ordered, ...sorted.filter((f) => !ordered.includes(f))];
}
