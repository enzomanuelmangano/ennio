// Maestro YAML runner — socket-first, idb HID for taps.
//
// Scope (v0.1):
//   tapOn        { id | text | point }
//   doubleTapOn  (same selectors)
//   longPress
//   assertVisible / assertNotVisible / waitFor / assertAnyVisible
//   inputText    (current focused field)
//   eraseText    (n chars)
//   back
//   hideKeyboard
//   scroll       (direction)
//   launchApp    ({ clearState?: boolean })
//   takeScreenshot
//   extendedWaitUntil (visible / notVisible)
//
// Deferred to v0.2:
//   spatial / hierarchical selectors (below / above / containsChild / ...)
//   runFlow / runScript / evalScript
//   retry / repeat blocks (we honour the per-step waitFor timeout but
//                          not a full retry block)
//   scrollUntilVisible
//   swipe between testIDs
//   travel / setLocation / setPermissions
//   recordVideo / startRecording

import { execFileSync } from 'node:child_process';

import {
  MaestroCommand,
  MaestroFlow,
  MaestroSelector,
  normalizeSelector,
} from './maestro-parser';
import { EnnioSocketClient } from './socket-client';
import { tap as hidTap, swipe as hidSwipe, typeText as hidType } from './hid';
import { getAppContainer, getTargetUdid, terminateApp } from './sim';

const DEFAULT_WAIT_MS = 5000;
const POLL_MS = 100;
// Minimum fixed wait after every tap. wait_commit can return immediately
// if the frame-hash is stable, but RN often starts the navigation
// animation slightly LATER than the tap (event dispatched → JS handles
// onPress → setState → React commit → mount → animation begins). 800ms
// covers the JS+commit gap; the subsequent wait_commit catches the
// transition itself.
const POST_TAP_SETTLE_MS = 800;
const POST_LAUNCH_SETTLE_MS = 1500;

interface RunContext {
  client: EnnioSocketClient;
  udid: string;
  bundleId: string;
  /** dylib path; only used for clearState relaunch */
  dylibPath: string | null;
  verbose: boolean;
}

export interface RunResult {
  passed: boolean;
  stepsRun: number;
  stepsPassed: number;
  failure?: { step: number; command: string; reason: string };
}

// =====================================================================
// Top-level
// =====================================================================

export async function runFlow(
  flow: MaestroFlow,
  options: { udid?: string; dylibPath?: string; verbose?: boolean } = {},
): Promise<RunResult> {
  const udid = options.udid || getTargetUdid();
  if (!udid) {
    throw new Error('No booted iOS simulator found. Boot one or set ENNIO_UDID.');
  }
  if (!flow.appId) {
    throw new Error(`Flow ${flow.filePath} is missing top-level appId`);
  }

  const client = new EnnioSocketClient();
  if (!(await client.connectWithRetry(15_000))) {
    throw new Error(
      'Could not connect to libennio socket at /tmp/ennio-control.sock. ' +
        'Did you launch the app with SIMCTL_CHILD_DYLD_INSERT_LIBRARIES?',
    );
  }

  const ctx: RunContext = {
    client,
    udid,
    bundleId: flow.appId,
    dylibPath: options.dylibPath ?? null,
    verbose: options.verbose ?? false,
  };

  log(ctx, `▶ ${flow.name || flow.filePath} (${flow.commands.length} steps)`);

  let stepsPassed = 0;
  for (let i = 0; i < flow.commands.length; i++) {
    const cmd = flow.commands[i];
    try {
      await runCommand(ctx, cmd);
      stepsPassed++;
    } catch (err) {
      client.close();
      return {
        passed: false,
        stepsRun: i + 1,
        stepsPassed,
        failure: {
          step: i + 1,
          command: describeCommand(cmd),
          reason: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }
  client.close();
  return { passed: true, stepsRun: flow.commands.length, stepsPassed };
}

// =====================================================================
// Per-command dispatch
// =====================================================================

async function runCommand(ctx: RunContext, cmd: MaestroCommand): Promise<void> {
  const desc = describeCommand(cmd);
  log(ctx, `· ${desc}`);

  if ('tapOn' in cmd) {
    const sel = normalizeSelector(cmd.tapOn);
    // Pre-tap settle: wait for the screen to stop animating so we tap
    // a stable button frame, not a half-transitioned one. Without this,
    // the tap can land on a view that's still sliding in from a tab
    // switch and RNGH's gesture recognizer rejects the touch.
    await ctx.client.call('wait_commit', { maxMs: 1500, stableMs: 250 }).catch(() => undefined);
    await execTapOn(ctx, sel);
    await sleep(POST_TAP_SETTLE_MS);
    // Post-tap settle: wait for the navigation / state-change transition
    // to complete before the next find. RN navigation animations + Hermes
    // mount + UIKit layout can take ~600-1000ms on iOS 26 sims.
    await ctx.client.call('wait_commit', { maxMs: 1500, stableMs: 200 }).catch(() => undefined);
    return;
  }
  if ('doubleTapOn' in cmd) {
    const sel = normalizeSelector(cmd.doubleTapOn);
    const { x, y } = await resolveCenter(ctx, sel);
    hidTap(ctx.udid, x, y);
    await sleep(80);
    hidTap(ctx.udid, x, y);
    await sleep(POST_TAP_SETTLE_MS);
    return;
  }
  if ('longPress' in cmd || 'longPressOn' in cmd) {
    const sel = normalizeSelector(('longPress' in cmd ? cmd.longPress : cmd.longPressOn) as any);
    const { x, y } = await resolveCenter(ctx, sel);
    // idb ui tap with --duration approximates long press; absent that
    // we shell out to a swipe-in-place. Use a tiny swipe.
    hidSwipe(ctx.udid, x, y, x, y, 700);
    await sleep(POST_TAP_SETTLE_MS);
    return;
  }
  if ('assertVisible' in cmd) {
    const sel = normalizeSelector(cmd.assertVisible);
    const timeout = cmd.assertVisible.timeout ?? DEFAULT_WAIT_MS;
    await waitUntilVisible(ctx, sel, timeout);
    return;
  }
  if ('assertNotVisible' in cmd) {
    const sel = normalizeSelector(cmd.assertNotVisible);
    const timeout = cmd.assertNotVisible.timeout ?? DEFAULT_WAIT_MS;
    await waitUntilNotVisible(ctx, sel, timeout);
    return;
  }
  if ('waitFor' in cmd) {
    const sel = normalizeSelector(cmd.waitFor);
    const timeout = cmd.waitFor.timeout ?? DEFAULT_WAIT_MS;
    await waitUntilVisible(ctx, sel, timeout);
    return;
  }
  if ('assertAnyVisible' in cmd) {
    const timeout = DEFAULT_WAIT_MS;
    const selectors = cmd.assertAnyVisible.anyOf.map(normalizeSelector);
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      for (const s of selectors) {
        if (await isVisible(ctx, s)) return;
      }
      await sleep(POLL_MS);
    }
    throw new Error(`assertAnyVisible: none of the ${selectors.length} selectors became visible`);
  }
  if ('extendedWaitUntil' in cmd) {
    const timeout = cmd.extendedWaitUntil.timeout ?? DEFAULT_WAIT_MS;
    if (cmd.extendedWaitUntil.visible) {
      await waitUntilVisible(ctx, cmd.extendedWaitUntil.visible, timeout);
    } else if (cmd.extendedWaitUntil.notVisible) {
      await waitUntilNotVisible(ctx, cmd.extendedWaitUntil.notVisible, timeout);
    }
    return;
  }
  if ('inputText' in cmd) {
    hidType(ctx.udid, cmd.inputText);
    await sleep(200);
    await ctx.client.call('wait_commit', { maxMs: 500, stableMs: 80 });
    return;
  }
  if ('eraseText' in cmd) {
    const count = typeof cmd.eraseText === 'number' ? cmd.eraseText : (cmd.eraseText.characters ?? 1);
    for (let i = 0; i < count; i++) await ctx.client.call('hardware_key', { keyCode: 42 });
    return;
  }
  if ('clearText' in cmd) {
    // Best effort: erase a generous chunk via backspace key on the dylib's
    // hardware-key handler. Real Maestro semantics: erase until the field
    // is empty.
    for (let i = 0; i < 200; i++) await ctx.client.call('hardware_key', { keyCode: 42 });
    return;
  }
  if ('back' in cmd) {
    await ctx.client.call('back');
    await sleep(POST_TAP_SETTLE_MS);
    return;
  }
  if ('hideKeyboard' in cmd) {
    await ctx.client.call('hide_keyboard');
    await sleep(150);
    return;
  }
  if ('scroll' in cmd) {
    const dir = (cmd.scroll.direction || 'DOWN').toLowerCase();
    // Centre swipe approximation. Window size assumed 390x844 — good
    // enough for v0.1, replaced with real key-window size later.
    const cx = 195;
    const cy = 422;
    const dist = 300;
    let x1 = cx, y1 = cy, x2 = cx, y2 = cy;
    if (dir === 'down') { y1 = cy + dist / 2; y2 = cy - dist / 2; }
    else if (dir === 'up') { y1 = cy - dist / 2; y2 = cy + dist / 2; }
    else if (dir === 'left') { x1 = cx + dist / 2; x2 = cx - dist / 2; }
    else if (dir === 'right') { x1 = cx - dist / 2; x2 = cx + dist / 2; }
    hidSwipe(ctx.udid, x1, y1, x2, y2, 250);
    await sleep(400);
    return;
  }
  if ('launchApp' in cmd) {
    const opts =
      cmd.launchApp === true ? { clearState: false } : (cmd.launchApp as { clearState?: boolean });
    if (opts.clearState) {
      await clearStateAndRelaunch(ctx);
    } else {
      // No-op when app is already running; the +load swizzle ensures
      // the dylib is already attached.
    }
    await sleep(POST_LAUNCH_SETTLE_MS);
    return;
  }
  if ('clearState' in cmd) {
    await clearStateAndRelaunch(ctx);
    await sleep(POST_LAUNCH_SETTLE_MS);
    return;
  }
  if ('stopApp' in cmd || 'killApp' in cmd) {
    terminateApp(ctx.udid, ctx.bundleId);
    return;
  }
  if ('takeScreenshot' in cmd) {
    const path =
      typeof cmd.takeScreenshot === 'string' ? cmd.takeScreenshot : cmd.takeScreenshot.path;
    execFileSync('xcrun', ['simctl', 'io', ctx.udid, 'screenshot', path]);
    return;
  }
  if ('dismissAlert' in cmd) {
    await ctx.client.call('alert_dismiss');
    return;
  }
  if ('openLink' in cmd) {
    const link = typeof cmd.openLink === 'string' ? cmd.openLink : cmd.openLink.link;
    execFileSync('xcrun', ['simctl', 'openurl', ctx.udid, link]);
    await sleep(POST_LAUNCH_SETTLE_MS);
    return;
  }
  if ('waitForAnimationToEnd' in cmd) {
    const timeout =
      cmd.waitForAnimationToEnd === true
        ? 3000
        : (cmd.waitForAnimationToEnd.timeout ?? 3000);
    await ctx.client.call('wait_commit', { maxMs: timeout, stableMs: 150 });
    return;
  }

  // Anything else: warn and skip rather than fail loudly. v0.1 covers
  // ~80% of common Maestro grammar; unsupported ops are documented as
  // such in ARCHITECTURE.md.
  log(ctx, `  (unsupported in v0.1, skipped: ${desc})`);
}

// =====================================================================
// Helpers
// =====================================================================

async function execTapOn(ctx: RunContext, sel: MaestroSelector): Promise<void> {
  // Point-tap fast path — no discovery needed.
  if (sel.point !== undefined) {
    const { x, y } = parsePoint(sel.point);
    hidTap(ctx.udid, x, y);
    return;
  }
  const center = await resolveCenter(ctx, sel);
  hidTap(ctx.udid, center.x, center.y);
}

async function resolveCenter(
  ctx: RunContext,
  sel: MaestroSelector,
): Promise<{ x: number; y: number }> {
  const rect = await resolveRect(ctx, sel);
  if (!rect) {
    throw new Error(`element not found: ${JSON.stringify(sel)}`);
  }
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

async function resolveRect(ctx: RunContext, sel: MaestroSelector): Promise<Rect | null> {
  // Match Maestro's implicit-wait semantics on tapOn: keep retrying the
  // find for ~7s before giving up. Layout passes after a clearState
  // relaunch or navigation transition often take 1-3s to settle.
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    if (sel.id) {
      const r = await ctx.client.call('find_by_testid', { testID: sel.id });
      if (r.ok) return r.data as Rect;
    }
    if (sel.text) {
      const r = await ctx.client.call('find_by_text', { text: sel.text });
      if (r.ok) return r.data as Rect;
    }
    await sleep(POLL_MS);
  }
  return null;
}

async function isVisible(ctx: RunContext, sel: MaestroSelector): Promise<boolean> {
  if (sel.id) {
    const r = await ctx.client.call('visible', { testID: sel.id });
    if (r.ok && r.data && (r.data as { visible: boolean }).visible) return true;
  }
  if (sel.text) {
    const r = await ctx.client.call('find_by_text', { text: sel.text });
    if (r.ok) return true;
  }
  return false;
}

async function waitUntilVisible(
  ctx: RunContext,
  sel: MaestroSelector,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isVisible(ctx, sel)) return;
    await sleep(POLL_MS);
  }
  throw new Error(`assertVisible/waitFor timeout: ${JSON.stringify(sel)}`);
}

async function waitUntilNotVisible(
  ctx: RunContext,
  sel: MaestroSelector,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isVisible(ctx, sel))) return;
    await sleep(POLL_MS);
  }
  throw new Error(`assertNotVisible timeout: ${JSON.stringify(sel)}`);
}

async function clearStateAndRelaunch(ctx: RunContext): Promise<void> {
  // In-process wipe of Library/Documents/tmp.
  await ctx.client.call('clear_state').catch(() => undefined);
  // Hard relaunch — close socket so the reconnect picks up the new
  // process's socket binding.
  ctx.client.close();
  terminateApp(ctx.udid, ctx.bundleId);
  await sleep(300);
  if (!ctx.dylibPath) {
    throw new Error('clearState requires --dylib (or ENNIO_DYLIB_PATH) to relaunch with injection');
  }
  execFileSync(
    'xcrun',
    ['simctl', 'launch', '--terminate-running-process', ctx.udid, ctx.bundleId],
    {
      env: { ...process.env, SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: ctx.dylibPath },
      stdio: 'pipe',
    },
  );
  // Re-open the socket against the new process.
  const reopen = new EnnioSocketClient();
  if (!(await reopen.connectWithRetry(15_000))) {
    throw new Error('socket reconnect failed after clearState relaunch');
  }
  ctx.client = reopen;
  // Wait for the new process's UIApplicationDidFinishLaunchingNotification
  // observer to fire — bootstrap=ready means the key UIWindow has been
  // captured and discovery handlers will see real UIViews. Without this
  // we race the launch and the first find returns empty.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const r = await reopen.call('ping');
      const ready =
        r.ok && r.data && (r.data as { bootstrap?: string }).bootstrap === 'ready';
      if (ready) break;
    } catch {
      /* try again */
    }
    await sleep(100);
  }
  // Past bootstrap=ready, but React Native + view layout pass needs a
  // beat to populate the first frame. Wait_commit polls the visible
  // UIView hash; we hold until it's stable for 200ms or we cap at 6s.
  await reopen.call('wait_commit', { maxMs: 6000, stableMs: 200 }).catch(() => undefined);
  // Discard the app-data path cache — sandbox UUID may have rotated.
  getAppContainer(ctx.udid, ctx.bundleId);
}

function parsePoint(p: MaestroSelector['point']): { x: number; y: number } {
  if (typeof p === 'string') {
    const [xs, ys] = p.split(',').map((s) => s.trim());
    return { x: parseFloat(xs), y: parseFloat(ys) };
  }
  if (p && typeof p === 'object') {
    const x = typeof p.x === 'number' ? p.x : parseFloat(p.x);
    const y = typeof p.y === 'number' ? p.y : parseFloat(p.y);
    return { x, y };
  }
  throw new Error('tapOn point: invalid');
}

function describeCommand(cmd: MaestroCommand): string {
  const key = Object.keys(cmd)[0];
  const value = (cmd as Record<string, unknown>)[key];
  if (typeof value === 'string') return `${key}: ${value}`;
  if (typeof value === 'boolean') return key;
  if (value && typeof value === 'object') {
    return `${key}: ${JSON.stringify(value)}`;
  }
  return key;
}

function log(ctx: RunContext, msg: string): void {
  if (ctx.verbose || msg.startsWith('▶') || msg.startsWith('FAIL')) {
    process.stderr.write(`[ennio] ${msg}\n`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
