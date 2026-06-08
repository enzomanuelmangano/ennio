// Turn the dylib's raw accessibility-tree snapshot into the flat,
// agent-friendly view the MCP surface promises: a list of targetable
// elements, each with a role, its testID and text, a normalized [0,1]
// rect, and whether it's enabled. This is the "transparent app view" — an
// agent reads the screen from here instead of guessing from a screenshot.
//
// The native snapshot's exact field names vary by build, so the walker is
// deliberately tolerant: it recognises the common spellings of id / text /
// frame / children rather than hard-coding one schema. Nodes that carry
// neither a testID nor any text are structural — dropped from the flat
// list (their geometry still constrains nothing the agent can target).

export interface ElementRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DescribedElement {
  role: string;
  testID?: string;
  text?: string;
  rect: ElementRect;
  enabled: boolean;
}

export interface ScreenDescription {
  screen: { w: number; h: number };
  elements: DescribedElement[];
}

type Node = Record<string, unknown>;

function str(node: Node, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = node[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Pull an {x,y,w,h} rect from the several shapes builds emit. */
function rectOf(node: Node): ElementRect | undefined {
  const frame = (node.frame ?? node.rect ?? node.bounds ?? node) as Node;
  if (!frame || typeof frame !== 'object') return undefined;
  const x = num(frame.x);
  const y = num(frame.y);
  const w = num(frame.w ?? frame.width);
  const h = num(frame.h ?? frame.height);
  if (x === undefined || y === undefined || w === undefined || h === undefined) return undefined;
  return { x, y, w, h };
}

function childrenOf(node: Node): Node[] {
  const kids = node.children ?? node.subviews ?? node.nodes ?? node.elements;
  return Array.isArray(kids) ? (kids.filter((c) => c && typeof c === 'object') as Node[]) : [];
}

function roleOf(node: Node): string {
  return (
    str(node, ['role', 'type', 'class', 'viewClass', 'className']) ??
    (Array.isArray(node.traits) && node.traits.length ? String(node.traits[0]) : 'view')
  );
}

function normalize(rect: ElementRect, screen: { w: number; h: number }): ElementRect {
  const sw = screen.w || 1;
  const sh = screen.h || 1;
  return {
    x: +(rect.x / sw).toFixed(4),
    y: +(rect.y / sh).toFixed(4),
    w: +(rect.w / sw).toFixed(4),
    h: +(rect.h / sh).toFixed(4),
  };
}

function walk(node: Node, screen: { w: number; h: number }, out: DescribedElement[]): void {
  const testID = str(node, ['testID', 'id', 'identifier', 'accessibilityIdentifier']);
  const text = str(node, ['label', 'text', 'value', 'title', 'accessibilityLabel']);
  const rect = rectOf(node);
  // Targetable iff it has an identity (testID or text) and a geometry.
  if ((testID || text) && rect) {
    const enabledVal = node.enabled;
    out.push({
      role: roleOf(node),
      ...(testID && { testID }),
      ...(text && { text }),
      rect: normalize(rect, screen),
      enabled: enabledVal === undefined ? true : enabledVal !== false,
    });
  }
  for (const child of childrenOf(node)) walk(child, screen, out);
}

/**
 * Parse the raw snapshot (a JSON string) and flatten it into the screen
 * description. A snapshot that won't parse yields an empty element list
 * rather than throwing — an empty screen is a valid, reportable answer.
 */
export function describeTree(raw: string, screen: { w: number; h: number }): ScreenDescription {
  const elements: DescribedElement[] = [];
  if (raw) {
    try {
      const root = JSON.parse(raw) as unknown;
      const roots = Array.isArray(root) ? root : [root];
      for (const r of roots) {
        if (r && typeof r === 'object') walk(r as Node, screen, elements);
      }
    } catch {
      /* unparseable snapshot → empty list */
    }
  }
  return { screen, elements };
}
