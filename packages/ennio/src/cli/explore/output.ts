// Exploration artifacts — written for two readers at once:
//   * a human: map.mmd (mermaid graph), screenshots per screen
//   * an agent/tool: app-map.json — keys sorted, arrays in deterministic
//     order, no timestamps in the body, so re-runs diff cleanly and the
//     map doubles as a regression artifact (new/lost screens show in git).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ExploreResult } from './types';

export interface AppMap {
  appId: string;
  root: string;
  nodes: Array<{
    sig: string;
    title?: string;
    depth: number;
    screenshot?: string;
    actions: string[];
    untried: string[];
    elements: Array<{ role: string; testID?: string; text?: string }>;
  }>;
  edges: Array<{ from: string; action: string; to: string; kind: string; detail?: string }>;
  warnings: Array<{ kind: string; detail: string }>;
  stats: { screens: number; edges: number; steps: number };
}

export function buildAppMap(appId: string, result: ExploreResult): AppMap {
  const nodes = [...result.nodes]
    .sort((a, b) => a.sig.localeCompare(b.sig))
    .map((n) => ({
      sig: n.sig,
      ...(n.title && { title: n.title }),
      depth: n.depth,
      ...(n.screenshot && { screenshot: n.screenshot }),
      actions: n.actions.map((a) => a.key),
      untried: n.actions.filter((a) => !n.tried.includes(a.key)).map((a) => a.key),
      elements: n.elements.map((e) => ({
        role: e.role,
        ...(e.testID && { testID: e.testID }),
        ...(e.text && { text: e.text }),
      })),
    }));
  const edges = [...result.edges]
    .map((e) => ({ ...e }))
    .sort(
    (a, b) =>
      a.from.localeCompare(b.from) || a.action.localeCompare(b.action) || a.to.localeCompare(b.to),
  );
  return {
    appId,
    root: result.root,
    nodes,
    edges,
    warnings: result.warnings,
    stats: { screens: nodes.length, edges: edges.length, steps: result.steps },
  };
}

/** Mermaid flowchart of the nav edges (state self-loops omitted). */
export function toMermaid(map: AppMap): string {
  const lines = ['flowchart TD'];
  for (const n of map.nodes) {
    const label = (n.title ?? n.sig).replace(/[\[\]"|{}]/g, ' ').slice(0, 32);
    lines.push(`  ${n.sig}["${label}"]`);
  }
  for (const e of map.edges) {
    if (e.kind !== 'nav') continue;
    const label = e.action.replace(/[\[\]"|{}]/g, ' ').slice(0, 28);
    lines.push(`  ${e.from} -->|${label}| ${e.to}`);
  }
  return lines.join('\n') + '\n';
}

/** Write app-map.json + map.mmd into outDir. Returns the JSON path. */
export function writeArtifacts(outDir: string, map: AppMap): string {
  mkdirSync(join(outDir, 'screens'), { recursive: true });
  const jsonPath = join(outDir, 'app-map.json');
  writeFileSync(jsonPath, JSON.stringify(map, null, 2) + '\n');
  writeFileSync(join(outDir, 'map.mmd'), toMermaid(map));
  return jsonPath;
}
