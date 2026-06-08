// Turn the dylib's `dump_views` snapshot into the flat, agent-friendly
// inventory the MCP surface promises: every on-screen element with its
// role, testID, accessibility text, and value. This is the "transparent
// app view" — an agent reads the screen from here instead of guessing from
// a screenshot, then targets an element by testID or text.
//
// `dump_views` reports identity, not geometry (one element per line:
// "<class> | aL=<label> | aV=<value> | t=<testID>"). Precise coordinates
// for a specific element come from ennio_find, which resolves one selector
// to a normalized rect in a single roundtrip — so describe stays a fast,
// single-roundtrip read.

export interface DescribedElement {
  role: string;
  testID?: string;
  text?: string;
  value?: string;
  enabled: boolean;
}

export interface ScreenDescription {
  screen: { w: number; h: number };
  elements: DescribedElement[];
}

/**
 * Parse one `dump_views` line. Fields are ` | `-separated: the leading
 * token is the view class, followed by `aL=` (accessibility label), `aV=`
 * (value), and `t=` (testID). Empty fields are dropped. A line with no
 * identity (neither testID nor text) is structural — returns null.
 */
export function parseDumpViewLine(line: string): DescribedElement | null {
  const parts = line.split(' | ');
  const role = parts[0]?.trim();
  if (!role) return null;
  let testID: string | undefined;
  let text: string | undefined;
  let value: string | undefined;
  for (const part of parts.slice(1)) {
    if (part.startsWith('aL=')) text = part.slice(3) || undefined;
    else if (part.startsWith('aV=')) value = part.slice(3) || undefined;
    else if (part.startsWith('t=')) testID = part.slice(2) || undefined;
  }
  if (!testID && !text) return null;
  return {
    role,
    ...(testID && { testID }),
    ...(text && { text }),
    ...(value && { value }),
    enabled: true,
  };
}

/** Flatten a `dump_views` result (array of lines) into the screen description. */
export function describeViews(
  lines: string[],
  screen: { w: number; h: number },
): ScreenDescription {
  const elements: DescribedElement[] = [];
  for (const line of lines) {
    if (typeof line !== 'string') continue;
    const el = parseDumpViewLine(line);
    if (el) elements.push(el);
  }
  return { screen, elements };
}
