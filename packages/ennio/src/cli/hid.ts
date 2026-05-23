// Device interaction via Argent's tool-server (direct HTTP) or CLI.
//
// Single source of truth for taps, swipes, keystrokes. Argent's
// CoreSimulator HID injection fires RN Pressable.onPress reliably
// on iOS 26 sim — idb's gRPC HID variants intermittently swallowed
// presses on RN sheet/dropdown buttons, so we no longer ship them
// in this binary.
//
// Fast path: POST to http://127.0.0.1:<port>/tools/<name> on the
// long-running argent tool-server (~80 ms/call). Slow fallback:
// `argent run <name>` subprocess (~150 ms/call cold start). The
// HTTP path saves ~70 ms per HID event — across a 60-step flow
// that's ~4 s, and the speedup compounds with self-heal retaps.
//
// Both paths produce the same RN responder events; the difference
// is purely process-spawn overhead.

import { execFileSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';

const screenSizeCache = new Map<string, { w: number; h: number }>();

async function getScreenSize(udid: string): Promise<{ w: number; h: number }> {
  const cached = screenSizeCache.get(udid);
  if (cached) return cached;
  try {
    const { EnnioSocketClient } = await import('./socket-client');
    const c = new EnnioSocketClient();
    if (await c.connectWithRetry(2_000)) {
      const r = await c.call('window_size').catch(() => undefined);
      c.close();
      if (r && r.ok && r.data) {
        const d = r.data as { w: number; h: number };
        if (d.w > 0 && d.h > 0) {
          screenSizeCache.set(udid, d);
          return d;
        }
      }
    }
  } catch {
    /* fall through */
  }
  const fb = { w: 402, h: 874 };
  screenSizeCache.set(udid, fb);
  return fb;
}

function trace(line: string): void {
  process.stderr.write(`${line}\n`);
}

// Tool-server port discovery. argent's server runs on a stable
// random port for the lifetime of the user's session; cache it
// once. Fall back to CLI if the server isn't reachable.
let toolServerPort: number | null | undefined;

function discoverToolServerPort(): number | null {
  if (toolServerPort !== undefined) return toolServerPort;
  try {
    const out = execFileSync('argent', ['server', 'status', '--json'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
    }).toString();
    const j = JSON.parse(out) as { port?: number; healthy?: boolean };
    if (j.healthy && typeof j.port === 'number') {
      toolServerPort = j.port;
      trace(`[argent-http] tool-server port=${j.port}`);
      return j.port;
    }
  } catch {
    /* ignore */
  }
  toolServerPort = null;
  return null;
}

function postToolJSON(
  port: number,
  toolName: string,
  payload: Record<string, unknown>,
  timeoutMs = 5000,
): Promise<{ ok: boolean; status: number; body: string }> {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: `/tools/${encodeURIComponent(toolName)}`,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let chunks = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          chunks += c;
        });
        res.on('end', () => {
          resolve({
            ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
            status: res.statusCode ?? 0,
            body: chunks,
          });
        });
      },
    );
    req.on('error', () => resolve({ ok: false, status: 0, body: '' }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, status: 0, body: '' });
    });
    req.write(body);
    req.end();
  });
}

function runArgentCLI(args: string[]): void {
  // Subprocess fallback — used only when the tool-server HTTP path
  // is unavailable. Inherit stdin/stderr; pipe stdout (argent prints
  // result JSON there).
  execFileSync('argent', args, { stdio: ['ignore', 'pipe', 'inherit'] });
}

interface AXNode {
  role?: string;
  label?: string;
  value?: string;
  identifier?: string;
  frame?: { x: number; y: number; width: number; height: number };
  children?: AXNode[];
}

export interface AXMatchRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Query argent's `describe` endpoint and find the first AX element
 * whose label, value, or identifier matches `text`. Returns a window-
 * space pixel rect (compatible with `tap`/`hidTap` callers).
 *
 * This is a cross-process AX fallback for selectors that miss the
 * dylib's in-process UIView walk — typically native UIKit views like
 * PHPickerViewController whose process boundary blocks our finder.
 * Maestro hits these through XCUITest's a11y query; we reach the same
 * data via argent's simulator-server bridge.
 *
 * Search order:
 *   1. exact identifier match
 *   2. exact label match
 *   3. substring label/value match
 * On-screen elements (frame inside [0,1]) outrank off-screen.
 */
/**
 * Take a compact signature of the OS a11y tree. Used by callers that
 * need to wait for cross-process animations (PHPicker dismiss, share
 * sheet) to settle — our in-process commit observer can't see them,
 * but the OS a11y describe shape changes during the transition.
 */
export async function axTreeSnapshot(udid: string): Promise<string> {
  const port = discoverToolServerPort();
  if (port === null) return '';
  const r = await postToolJSON(port, 'describe', { udid });
  if (!r.ok || !r.body) return '';
  try {
    const parsed = JSON.parse(r.body) as { data?: { tree?: AXNode } };
    const tree = parsed?.data?.tree;
    if (!tree) return '';
    const parts: string[] = [];
    const walk = (n: AXNode | undefined): void => {
      if (!n) return;
      const f = n.frame;
      parts.push(
        `${n.role ?? ''}|${n.label ?? ''}|${f ? `${f.x.toFixed(3)},${f.y.toFixed(3)},${f.width.toFixed(3)},${f.height.toFixed(3)}` : ''}`,
      );
      for (const c of n.children ?? []) walk(c);
    };
    walk(tree);
    return parts.join('\n');
  } catch {
    return '';
  }
}

export async function axQueryByText(udid: string, text: string): Promise<AXMatchRect | null> {
  // argent describe queries the OS a11y service. The service can
  // return an empty/transitioning tree for ~50-150 ms while a sheet
  // animates in (PHPicker first frame, share sheet, etc.). Retry up
  // to ~1.5 s on miss so flow-level retries don't have to.
  const deadline = Date.now() + 1500;
  let attempt = 0;
  while (Date.now() < deadline) {
    const r = await axQueryOnce(udid, text);
    if (r) return r;
    attempt++;
    if (Date.now() >= deadline) break;
    await new Promise((res) => setTimeout(res, 120));
  }
  if (attempt > 0) {
    process.stderr.write(
      `[ax-fallback] no match for ${JSON.stringify(text)} after ${attempt} polls\n`,
    );
  }
  return null;
}

async function axQueryOnce(udid: string, text: string): Promise<AXMatchRect | null> {
  const port = discoverToolServerPort();
  if (port === null) {
    trace(`[ax-once] no port for ${text}`);
    return null;
  }
  const r = await postToolJSON(port, 'describe', { udid });
  if (!r.ok || !r.body) {
    trace(`[ax-once] HTTP ${r.status} for ${text}`);
    return null;
  }
  let parsed: { data?: { tree?: AXNode } };
  try {
    parsed = JSON.parse(r.body);
  } catch {
    return null;
  }
  const root = parsed?.data?.tree;
  if (!root) return null;
  const { w, h } = await getScreenSize(udid);
  type Match = { node: AXNode; rank: number };
  const matches: Match[] = [];
  const lc = text.toLowerCase();
  const walk = (n: AXNode | undefined): void => {
    if (!n) return;
    const id = n.identifier ?? '';
    const lbl = n.label ?? '';
    const val = n.value ?? '';
    let rank = 0;
    if (id === text) rank = 4;
    else if (lbl === text) rank = 3;
    else if (lbl.toLowerCase() === lc) rank = 3;
    else if (val === text || val.toLowerCase() === lc) rank = 2;
    else if (lbl.toLowerCase().includes(lc)) rank = 1;
    else if (val.toLowerCase().includes(lc)) rank = 1;
    if (rank > 0 && n.frame) matches.push({ node: n, rank });
    for (const c of n.children ?? []) walk(c);
  };
  walk(root);
  if (matches.length === 0) {
    let nodeCount = 0;
    const count = (n: AXNode | undefined): void => {
      if (!n) return;
      nodeCount++;
      for (const c of n.children ?? []) count(c);
    };
    count(root);
    trace(`[ax-once] tree=${nodeCount} nodes, no match for ${JSON.stringify(text)}`);
    return null;
  }
  // Prefer on-screen + interactive role + highest rank.
  const interactive = new Set([
    'AXButton',
    'AXLink',
    'AXMenuItem',
    'AXCell',
    'AXSearchField',
    'AXTextField',
    'AXSwitch',
    'AXCheckBox',
  ]);
  matches.sort((a, b) => {
    const onA =
      !!a.node.frame &&
      a.node.frame.x >= 0 &&
      a.node.frame.x < 1 &&
      a.node.frame.y >= 0 &&
      a.node.frame.y < 1;
    const onB =
      !!b.node.frame &&
      b.node.frame.x >= 0 &&
      b.node.frame.x < 1 &&
      b.node.frame.y >= 0 &&
      b.node.frame.y < 1;
    if (onA !== onB) return onA ? -1 : 1;
    if (a.rank !== b.rank) return b.rank - a.rank;
    const intA = interactive.has(a.node.role ?? '') ? 1 : 0;
    const intB = interactive.has(b.node.role ?? '') ? 1 : 0;
    if (intA !== intB) return intB - intA;
    return 0;
  });
  const f = matches[0].node.frame!;
  return {
    x: f.x * w,
    y: f.y * h,
    w: f.width * w,
    h: f.height * h,
  };
}

/**
 * Convenience accessor mirroring axQueryByText for callers that
 * already have a window size cached.
 */
export async function getCachedScreenSize(udid: string): Promise<{ w: number; h: number }> {
  return getScreenSize(udid);
}

async function callTool(
  toolName: string,
  payload: Record<string, unknown>,
  cliArgs: string[],
): Promise<void> {
  const port = discoverToolServerPort();
  if (port !== null) {
    const r = await postToolJSON(port, toolName, payload);
    if (r.ok) return;
    // If the server returns a 4xx/5xx, surface it like the CLI would
    // — don't silently fall back to CLI on logic errors.
    if (r.status >= 400 && r.status < 600 && r.body) {
      throw new Error(`argent ${toolName} HTTP ${r.status}: ${r.body}`);
    }
    // Network-level failure: tool-server may have died mid-flow.
    // Invalidate the cached port so the next call re-discovers, and
    // fall through to CLI for this one event.
    toolServerPort = undefined;
  }
  runArgentCLI(cliArgs);
}

export async function tap(udid: string, x: number, y: number): Promise<void> {
  const { w, h } = await getScreenSize(udid);
  const nx = Math.max(0, Math.min(1, x / w));
  const ny = Math.max(0, Math.min(1, y / h));
  trace(
    `[argent-tap] px=(${x.toFixed(1)},${y.toFixed(1)}) norm=(${nx.toFixed(4)},${ny.toFixed(4)})`,
  );
  await callTool('gesture-tap', { udid, x: nx, y: ny }, [
    'run',
    'gesture-tap',
    '--udid',
    udid,
    '--x',
    String(nx),
    '--y',
    String(ny),
  ]);
}

export const tapFast = tap;
export const tapPureFast = tap;
export const tapArgent = tap;

/**
 * Press: Down → ~50 ms hold → Up. Higher reliability for buttons
 * whose gesture-recogniser ignores 0 ms-gap taps as event-loop
 * glitches (Bluesky's "Go back" nav-header back-arrow). Costs ~30 ms
 * more per call than tap() but worth it on targets where the simpler
 * tap() doesn't reliably fire onPress.
 */
export async function press(udid: string, x: number, y: number): Promise<void> {
  const { w, h } = await getScreenSize(udid);
  const nx = Math.max(0, Math.min(1, x / w));
  const ny = Math.max(0, Math.min(1, y / h));
  trace(
    `[argent-press] px=(${x.toFixed(1)},${y.toFixed(1)}) norm=(${nx.toFixed(4)},${ny.toFixed(4)})`,
  );
  const events = [
    { type: 'Down' as const, x: nx, y: ny },
    { type: 'Up' as const, x: nx, y: ny, delayMs: 50 },
  ];
  await callTool('gesture-custom', { udid, events }, [
    'run',
    'gesture-custom',
    '--udid',
    udid,
    '--events-json',
    JSON.stringify(events),
  ]);
}

export async function swipe(
  udid: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  durationMs: number,
): Promise<void> {
  const { w, h } = await getScreenSize(udid);
  const fromX = Math.max(0, Math.min(1, x1 / w));
  const fromY = Math.max(0, Math.min(1, y1 / h));
  const toX = Math.max(0, Math.min(1, x2 / w));
  const toY = Math.max(0, Math.min(1, y2 / h));
  const dur = Math.max(50, durationMs || 250);
  trace(
    `[argent-swipe] from=(${x1.toFixed(0)},${y1.toFixed(0)}) to=(${x2.toFixed(0)},${y2.toFixed(0)}) dur=${dur}`,
  );
  await callTool('gesture-swipe', { udid, fromX, fromY, toX, toY, durationMs: dur }, [
    'run',
    'gesture-swipe',
    '--udid',
    udid,
    '--fromX',
    String(fromX),
    '--fromY',
    String(fromY),
    '--toX',
    String(toX),
    '--toY',
    String(toY),
    '--durationMs',
    String(dur),
  ]);
}

/**
 * Long-press-then-drag. Drag-to-sort list rows (e.g. RNGH
 * draggable-flatlist) only enter drag mode after a long-press
 * threshold — ~400 ms hold without motion. A plain swipe with
 * gesture-swipe distributes Move events from frame 1 onward, which
 * the recogniser interprets as a scroll, not a sort drag.
 *
 * Construct the gesture explicitly: Down at start, hold stationary
 * for `holdMs`, then interpolate Move events over `moveMs` to the
 * end coordinate, Up at end.
 */
export async function longPressDrag(
  udid: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  holdMs: number,
  moveMs: number,
): Promise<void> {
  const { w, h } = await getScreenSize(udid);
  const norm = (px: number, dim: number) => Math.max(0, Math.min(1, px / dim));
  const fromX = norm(x1, w);
  const fromY = norm(y1, h);
  const toX = norm(x2, w);
  const toY = norm(y2, h);
  trace(
    `[argent-long-drag] from=(${x1.toFixed(0)},${y1.toFixed(0)}) to=(${x2.toFixed(0)},${y2.toFixed(0)}) hold=${holdMs} move=${moveMs}`,
  );
  // Event sequence: Down → stationary Move stack (drives hold timer
  // without changing position) → keyframe Move sequence to target →
  // Up. interpolate inserts intermediate frames between adjacent
  // keyframes for a smooth glide.
  const events: {
    type: 'Down' | 'Move' | 'Up';
    x: number;
    y: number;
    delayMs?: number;
  }[] = [];
  events.push({ type: 'Down', x: fromX, y: fromY });
  // Hold stationary: emit Move events at the same point with
  // cumulative delays summing to holdMs. The recogniser sees the
  // touch held in place long enough to trip the long-press detector.
  const holdSlices = 4;
  for (let i = 0; i < holdSlices; i++) {
    events.push({ type: 'Move', x: fromX, y: fromY, delayMs: Math.round(holdMs / holdSlices) });
  }
  // Glide to target.
  const moveSlices = 8;
  for (let i = 1; i <= moveSlices; i++) {
    const t = i / moveSlices;
    events.push({
      type: 'Move',
      x: fromX + (toX - fromX) * t,
      y: fromY + (toY - fromY) * t,
      delayMs: Math.round(moveMs / moveSlices),
    });
  }
  events.push({ type: 'Up', x: toX, y: toY, delayMs: 80 });
  await callTool('gesture-custom', { udid, events, interpolate: 4 }, [
    'run',
    'gesture-custom',
    '--udid',
    udid,
    '--events-json',
    JSON.stringify(events),
    '--interpolate',
    '4',
  ]);
}

export async function typeText(udid: string, text: string): Promise<void> {
  trace(`[argent-keyboard] text=${JSON.stringify(text)}`);
  await callTool('keyboard', { udid, text }, ['run', 'keyboard', '--udid', udid, '--text', text]);
}

export async function pressKey(udid: string, keyName: string): Promise<void> {
  trace(`[argent-keyboard] key=${keyName}`);
  await callTool('keyboard', { udid, key: keyName }, [
    'run',
    'keyboard',
    '--udid',
    udid,
    '--key',
    keyName,
  ]);
}
