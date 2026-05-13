// iOS accessibility-tree query via `maestro hierarchy`. Required for
// elements outside the React fiber tree AND outside the app's UIView
// tree — namely native UIMenu items (zeego DropdownMenu choices),
// system pickers, SpringBoard alerts. idb's own `ui describe-all` is
// broken on iOS 26 (idb_companion 1.1.8 predates the new XCAccessibility
// API), so we shell out to maestro's wrapper, which uses WebDriverAgent
// under the hood. Slow (~1-2 s per query) — used as last resort only.

import { execFile } from 'node:child_process';

interface HierarchyNode {
  attributes?: {
    accessibilityText?: string;
    title?: string;
    value?: string;
    text?: string;
    hintText?: string;
    'resource-id'?: string;
    bounds?: string;
    enabled?: string;
  };
  children?: HierarchyNode[];
}

function parseBounds(b: string | undefined): { x: number; y: number; width: number; height: number } | null {
  if (!b) return null;
  const m = b.match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
  if (!m) return null;
  const x1 = Number(m[1]);
  const y1 = Number(m[2]);
  const x2 = Number(m[3]);
  const y2 = Number(m[4]);
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

function nodeTexts(n: HierarchyNode): string[] {
  const a = n.attributes || {};
  return [a.accessibilityText, a.text, a.title, a.value, a.hintText]
    .filter((s): s is string => typeof s === 'string' && s.length > 0);
}

function nodeId(n: HierarchyNode): string | null {
  const a = n.attributes || {};
  const id = a['resource-id'];
  return id && id.length > 0 ? id : null;
}

function* walk(n: HierarchyNode): IterableIterator<HierarchyNode> {
  yield n;
  for (const c of n.children || []) yield* walk(c);
}

async function fetchHierarchy(): Promise<HierarchyNode | null> {
  return new Promise((resolve) => {
    execFile(
      'maestro',
      ['hierarchy'],
      { timeout: 20_000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        const text = String(stdout);
        const start = text.indexOf('{');
        if (start < 0) {
          resolve(null);
          return;
        }
        try {
          const parsed: unknown = JSON.parse(text.slice(start));
          resolve(parsed as HierarchyNode);
        } catch {
          resolve(null);
        }
      },
    );
  });
}

export interface HierarchyMatch {
  cx: number;
  cy: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export async function findByText(text: string): Promise<HierarchyMatch | null> {
  const root = await fetchHierarchy();
  if (!root) return null;
  const re = new RegExp(text);
  for (const n of walk(root)) {
    const texts = nodeTexts(n);
    if (texts.some((t) => re.test(t))) {
      const bounds = parseBounds(n.attributes?.bounds);
      if (bounds && bounds.width > 0 && bounds.height > 0) {
        return {
          cx: bounds.x + bounds.width / 2,
          cy: bounds.y + bounds.height / 2,
          ...bounds,
        };
      }
    }
  }
  return null;
}

export async function findById(id: string): Promise<HierarchyMatch | null> {
  const root = await fetchHierarchy();
  if (!root) return null;
  for (const n of walk(root)) {
    if (nodeId(n) === id) {
      const bounds = parseBounds(n.attributes?.bounds);
      if (bounds && bounds.width > 0 && bounds.height > 0) {
        return {
          cx: bounds.x + bounds.width / 2,
          cy: bounds.y + bounds.height / 2,
          ...bounds,
        };
      }
    }
  }
  return null;
}
