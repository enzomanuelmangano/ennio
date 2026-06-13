// EnnioMcpSession — a single device attachment held open across many MCP
// tool calls. Where a flow run opens a connection, executes a fixed list
// of commands, and tears down, an MCP session does the same setup once and
// then dispatches commands on demand as the agent decides them.
//
// Crucially it reuses the *exact* runtime an `ennio test` run uses: the
// same Platform, the same CommandRegistry (every handler), the same
// RunContext, the same GestureDriver. So an MCP `ennio_tap` and a YAML
// `tapOn` take an identical path through find → settle → actuate. Taps and
// swipes go through the HID driver by default — ennio is always the
// actuator, never a passthrough.

import { registerAllHandlers } from '../commands/handlers';
import { CommandRegistry } from '../core/command-registry';
import type { EnnioConnection } from '../core/ennio-connection';
import { FlowExecutor } from '../core/flow-executor';
import { getScreenSize } from '../hid';
import type { MaestroCommand, MaestroFlow, MaestroSelector } from '../maestro-parser';
import type { Platform } from '../platform';
import { selectPlatform } from '../platform';
import type { DeviceSession } from '../platform/types';
import { SilentReporter } from '../reporters';
import type { RunContext } from '../runner/context';
import { setSimLaunchEnv } from '../sim';

import { describeViews } from './describe';
import type { ScreenDescription } from './describe';
import { classifyError, err, ok } from './result';
import type { EnnioResult } from './result';

export interface FoundElement {
  /** Element bounds, normalized [0,1]. */
  rect: { x: number; y: number; w: number; h: number };
  /** Tap point at the rect center, normalized [0,1]. */
  center: { x: number; y: number };
}

export interface EnnioMcpSessionOptions {
  platform?: Platform;
  udid?: string;
  dylibPath?: string | null;
  /** Actuate via in-process dylib activation instead of real HID. Default
   *  false: real HID, so ennio is genuinely in the tap path. */
  inProcessTap?: boolean;
  safeMode?: boolean;
}

interface Attachment {
  bundleId: string;
  session: DeviceSession;
  connection: EnnioConnection;
  ctx: RunContext;
}

export class EnnioMcpSession {
  private readonly platform: Platform;
  private readonly opts: EnnioMcpSessionOptions;
  private readonly registry: CommandRegistry;
  private attachment: Attachment | null = null;

  constructor(opts: EnnioMcpSessionOptions = {}) {
    this.opts = opts;
    this.platform = opts.platform ?? selectPlatform('ios');
    // Unknown commands throw — same default as a non-lenient flow run.
    this.registry = new CommandRegistry();
    registerAllHandlers(this.registry);
  }

  get attached(): boolean {
    return this.attachment !== null && this.attachment.connection.isOpen();
  }

  get bundleId(): string | null {
    return this.attachment?.bundleId ?? null;
  }

  get udid(): string | null {
    return this.attachment?.session.udid ?? null;
  }

  get platformName(): 'ios' | 'android' {
    return this.platform.name;
  }

  /** How taps/swipes are actuated. The default 'hid' means real OS-level
   *  events — ennio is genuinely in the tap path. */
  get actuation(): 'hid' | 'in-process' | 'motion-event' {
    if (this.opts.inProcessTap) return 'in-process';
    return this.platform.name === 'android' ? 'motion-event' : 'hid';
  }

  /** How the agent is injected into the target process. */
  get attachMode(): 'dyld-inject' | 'ptrace-inject' {
    return this.platform.name === 'android' ? 'ptrace-inject' : 'dyld-inject';
  }

  /** Whether a cross-process accessibility bridge is available (native
   *  sheets / system dialogs the in-app agent can't see). */
  get crossProcessAx(): boolean {
    return this.platform.name === 'ios';
  }

  /**
   * Attach to `bundleId`, launching the app with the dylib injected if it
   * isn't already running under ennio. Idempotent for the same bundleId;
   * switching bundleId tears the previous attachment down first.
   */
  async attach(bundleId: string): Promise<EnnioResult<{ bundleId: string; udid: string }>> {
    if (this.attachment && this.attachment.bundleId === bundleId && this.attached) {
      return ok({ bundleId, udid: this.attachment.session.udid });
    }
    this.detach();
    try {
      const { session, connection } = await this.platform.connect({
        udid: this.opts.udid,
        bundleId,
        dylibPath: this.opts.dylibPath ?? null,
        safeMode: this.opts.safeMode,
      });
      const driver = this.platform.createDriver(this.opts.inProcessTap ?? false);
      const ctx: RunContext = {
        client: connection.socket,
        udid: session.udid,
        bundleId: session.bundleId,
        dylibPath: session.dylibPath,
        verbose: false,
        lenient: false,
        driver,
        platform: this.platform,
        // Synthetic flow path: only used to resolve runFlow subflows,
        // which the MCP surface never issues.
        flowPath: process.cwd() + '/mcp-session.yaml',
        outputs: {},
        flowEnv: {},
      };
      this.attachment = { bundleId, session, connection, ctx };
      // --show-touches: enable explicitly — the env-at-launch gate misses
      // a warm attach to an already-running process (smoke's default).
      // Counterpart of disableShowTouches(); best-effort on old dylibs.
      if (process.env.ENNIO_SHOW_TOUCHES === '1' && this.platform.name === 'ios') {
        await connection.socket.call('set_show_touches', { enabled: true }).catch(() => undefined);
      }
      // platform.connect returns once the socket is up — but a cold launch's
      // JS tree may still be mounting. Without this gate, a describe / tap /
      // run_flow fired right after ennio_launch_app races a half-built screen
      // (an assertVisible then times out against a screen that hasn't
      // rendered). Block until the tree looks settled, the same readiness
      // guard improvise applies before it crawls.
      await this.waitUntilReady();
      return ok({ bundleId, udid: session.udid });
    } catch (e) {
      return classifyError(e);
    }
  }

  /**
   * Block until the attached app's JS tree looks mounted: two element dumps
   * 250ms apart agree on a non-empty inventory, or `maxMs` elapses. Readiness
   * is best-effort — a genuinely empty (or non-RN) screen falls through at
   * the deadline rather than failing the attach.
   */
  private async waitUntilReady(maxMs = 8000): Promise<void> {
    const deadline = Date.now() + maxMs;
    let prev = '';
    while (Date.now() < deadline) {
      const d = await this.describe();
      const now = d.ok ? JSON.stringify(d.data.elements) : '';
      if (now && now !== '[]' && now === prev) return;
      prev = now;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /**
   * Dispatch a single Maestro command against the live session, exactly as
   * the flow executor would. Returns the structured envelope; never throws.
   */
  async dispatch(cmd: MaestroCommand): Promise<EnnioResult<{ command: string }>> {
    const a = this.attachment;
    if (!a) return err('invalid', 'not attached to an app — call ennio_launch_app first');
    const key = Object.keys(cmd)[0] ?? '<empty>';
    const buildDctx = (nextCmd: MaestroCommand | undefined) => ({
      ctx: a.ctx,
      nextCmd,
      dispatch: (c: MaestroCommand) => this.registry.dispatch(c, buildDctx(undefined)),
    });
    try {
      await this.registry.dispatch(cmd, buildDctx(undefined));
      return ok({ command: key });
    } catch (e) {
      return classifyError(e);
    }
  }

  /**
   * Fast point-to-point swipe: the raw HID gesture plus a tight in-process
   * commit-wait, skipping the flow handler's pre-swipe idle gate and
   * advance-verification. Coordinates are normalized [0,1]. This is the
   * actuation primitive the MCP exposes — an agent that decides its own
   * gestures doesn't need the e2e scroll machinery (that lives in
   * ennio_scroll). Being in-process, the commit-wait returns the instant
   * the React commit lands rather than polling a black-box screen.
   */
  async rawSwipe(
    from: { x: number; y: number },
    to: { x: number; y: number },
    durationMs = 120,
  ): Promise<EnnioResult<{ swiped: true }>> {
    const a = this.attachment;
    if (!a) return err('invalid', 'not attached to an app — call ennio_launch_app first');
    try {
      const { w, h } = await getScreenSize(a.session.udid);
      // Commit-aware confirm: note the universal commit timestamp before
      // the gesture, then wait for the NEXT commit after it. The commit
      // signal is renderer-agnostic (a frame-hash change through
      // CoreAnimation), so this works for Paper, Fabric, SwiftUI and
      // UIKit alike — and returns the instant the new state commits. Falls
      // back to frame-stability when no commit signal is available.
      const pre = await a.connection.socket.call('react_commit_ts').catch(() => null);
      const sinceMs = Number((pre?.data as { ts?: number | string })?.ts) || 0;
      const attach = (pre?.data as { attach?: string })?.attach;
      await a.ctx.driver.swipe(
        a.session.udid,
        from.x * w,
        from.y * h,
        to.x * w,
        to.y * h,
        durationMs,
      );
      if (attach && attach !== 'none') {
        await a.connection.socket.call('wait_react_commit', { sinceMs, maxMs: 300 });
      } else {
        await a.connection.socket.call('wait_commit', { maxMs: 250, stableMs: 40 });
      }
      return ok({ swiped: true });
    } catch (e) {
      return classifyError(e);
    }
  }

  /**
   * Fast tap at a normalized [0,1] point: the raw HID tap plus a tight
   * in-process commit-wait, skipping the flow handler's find + settle. The
   * point counterpart to rawSwipe — for an agent that already knows where to
   * tap (or is poking coordinates), with no e2e overhead.
   */
  async rawTap(point: { x: number; y: number }): Promise<EnnioResult<{ tapped: true }>> {
    const a = this.attachment;
    if (!a) return err('invalid', 'not attached to an app — call ennio_launch_app first');
    try {
      const { w, h } = await getScreenSize(a.session.udid);
      await a.ctx.driver.tap(a.session.udid, point.x * w, point.y * h);
      await a.connection.socket.call('wait_commit', { maxMs: 250, stableMs: 40 });
      return ok({ tapped: true });
    } catch (e) {
      return classifyError(e);
    }
  }

  /**
   * Direct in-process tab tap: the dylib's `tap_tab` op resolves a
   * UITabBarItem by name and drives UIKit's own selection — deterministic
   * and idempotent, no gesture machinery. Returns tapped=false when the
   * name doesn't resolve to a tab (callers fall back to a normal tap).
   */
  async tapTab(name: string): Promise<EnnioResult<{ tapped: boolean }>> {
    const a = this.attachment;
    if (!a) return err('invalid', 'not attached to an app — call ennio_launch_app first');
    try {
      const r = await a.connection.socket.call('tap_tab', { name });
      const tapped = !!(r.ok && r.data && (r.data as { tapped?: boolean }).tapped);
      if (tapped) {
        await a.connection.socket.call('wait_commit', { maxMs: 400, stableMs: 60 });
      }
      return ok({ tapped });
    } catch (e) {
      return classifyError(e);
    }
  }

  /**
   * Native alert state. A UIAlertController lives in its own window
   * outside the RN view tree — dump_views and the finder never see it,
   * so callers that enumerate or tap from describe() output are blind
   * to it (and the alert swallows every touch they fire underneath).
   */
  async alertInfo(): Promise<EnnioResult<{ present: boolean; text: string; buttons: string[] }>> {
    const a = this.attachment;
    if (!a) return err('invalid', 'not attached to an app — call ennio_launch_app first');
    try {
      const p = await a.connection.socket.call('alert_present');
      const present = !!(p.ok && p.data && (p.data as { present?: boolean }).present);
      if (!present) return ok({ present: false, text: '', buttons: [] });
      const [t, b] = await Promise.all([
        a.connection.socket.call('alert_text'),
        a.connection.socket.call('alert_buttons'),
      ]);
      return ok({
        present: true,
        text: (t.ok && (t.data as { text?: string })?.text) || '',
        buttons: (b.ok && (b.data as { buttons?: string[] })?.buttons) || [],
      });
    } catch (e) {
      return classifyError(e);
    }
  }

  /** Tap an alert button by its label — routes through UIAlertAction
   *  directly, the only reliable way to press a native alert button. */
  async alertTap(buttonText: string): Promise<EnnioResult<{ tapped: boolean }>> {
    const a = this.attachment;
    if (!a) return err('invalid', 'not attached to an app — call ennio_launch_app first');
    try {
      const r = await a.connection.socket.call('alert_tap', { buttonText });
      const tapped = !!(r.ok && r.data && (r.data as { tapped?: boolean }).tapped);
      if (tapped) {
        await a.connection.socket.call('wait_commit', { maxMs: 400, stableMs: 60 });
      }
      return ok({ tapped });
    } catch (e) {
      return classifyError(e);
    }
  }

  /** Dismiss a present alert (cancel-equivalent action). */
  async alertDismiss(): Promise<EnnioResult<{ dismissed: boolean }>> {
    const a = this.attachment;
    if (!a) return err('invalid', 'not attached to an app — call ennio_launch_app first');
    try {
      const r = await a.connection.socket.call('alert_dismiss');
      const dismissed = !!(r.ok && r.data && (r.data as { dismissed?: boolean }).dismissed);
      if (dismissed) {
        await a.connection.socket.call('wait_commit', { maxMs: 400, stableMs: 60 });
      }
      return ok({ dismissed });
    } catch (e) {
      return classifyError(e);
    }
  }

  /** Scroll until a testID'd element is in view (in-process scroller).
   *  Best-effort: false when there's nothing to scroll or no such id. */
  async scrollTo(testID: string): Promise<boolean> {
    const a = this.attachment;
    if (!a) return false;
    try {
      const r = await a.connection.socket.call('scroll_to', { elementTestID: testID });
      return !!(r.ok && r.data && (r.data as { scrolled?: boolean }).scrolled);
    } catch {
      return false;
    }
  }

  /**
   * Focus a text input and type into it. Focus path: in-process
   * focus_testid when an id is available (deterministic, works for
   * fields below the keyboard), else a tap on the element's center.
   * Typing always goes through insert_text — the same op flows use.
   */
  async typeText(sel: { id?: string; text?: string }, value: string): Promise<boolean> {
    const a = this.attachment;
    if (!a) return false;
    try {
      let focused = false;
      if (sel.id) {
        const f = await a.connection.socket.call('focus_testid', { testID: sel.id });
        focused = !!(f.ok && f.data && (f.data as { ok?: boolean }).ok);
      }
      if (!focused) {
        const found = await this.find(sel.id ? { id: sel.id } : { text: sel.text ?? '' });
        if (!found.ok) return false;
        await this.rawTap(found.data.center);
      }
      // Give the responder a beat to become first responder before typing.
      await a.connection.socket
        .call('first_responder_ready', { maxMs: 1000 })
        .catch(() => undefined);
      const r = await a.connection.socket.call('insert_text', { text: value });
      return !!r.ok;
    } catch {
      return false;
    }
  }

  /** On-screen element inventory (role / testID / text / value). */
  async describe(): Promise<EnnioResult<ScreenDescription>> {
    const a = this.attachment;
    if (!a) return err('invalid', 'not attached to an app — call ennio_launch_app first');
    try {
      const [views, size] = await Promise.all([
        a.connection.socket.call('dump_views'),
        getScreenSize(a.session.udid),
      ]);
      if (!views.ok) return err('infra', views.err ?? 'dump_views failed');
      const lines = Array.isArray(views.data) ? (views.data as string[]) : [];
      return ok(describeViews(lines, size));
    } catch (e) {
      return classifyError(e);
    }
  }

  /**
   * Resolve a single selector to its on-screen rect, normalized to [0,1],
   * plus the tap center. One roundtrip via the in-process finder — the
   * precise-geometry counterpart to describe's inventory. A miss is a
   * not_found, not a failure.
   */
  async find(sel: MaestroSelector): Promise<EnnioResult<FoundElement>> {
    const a = this.attachment;
    if (!a) return err('invalid', 'not attached to an app — call ennio_launch_app first');
    try {
      const [resp, size] = await Promise.all([
        sel.id !== undefined
          ? a.connection.socket.call('find_by_testid', { testID: sel.id })
          : a.connection.socket.call('find_by_text', { text: sel.text ?? '' }),
        getScreenSize(a.session.udid),
      ]);
      if (!resp.ok) {
        return /not found|no match|no element/i.test(resp.err ?? '')
          ? err('not_found', 'no matching element')
          : err('infra', resp.err ?? 'find failed');
      }
      const r = resp.data as { x: number; y: number; w: number; h: number };
      const sw = size.w || 1;
      const sh = size.h || 1;
      const rect = {
        x: +(r.x / sw).toFixed(4),
        y: +(r.y / sh).toFixed(4),
        w: +(r.w / sw).toFixed(4),
        h: +(r.h / sh).toFixed(4),
      };
      return ok({
        rect,
        center: { x: +(rect.x + rect.w / 2).toFixed(4), y: +(rect.y + rect.h / 2).toFixed(4) },
      });
    } catch (e) {
      return classifyError(e);
    }
  }

  /**
   * Toggle UIView/CoreAnimation animations in the target app at runtime.
   * Disabling them snaps transitions to their final frame, so the React
   * commit lands sooner and post-action settle shrinks — a coordinating
   * agent can flip this on for a fast, deterministic run and off when it
   * needs to observe animated UI.
   */
  async setAnimations(enabled: boolean): Promise<EnnioResult<{ enabled: boolean }>> {
    const a = this.attachment;
    if (!a) return err('invalid', 'not attached to an app — call ennio_launch_app first');
    try {
      const r = await a.connection.socket.call('set_no_animations', { enabled: !enabled });
      if (!r.ok) return err('infra', r.err ?? 'set_no_animations failed');
      return ok({ enabled });
    } catch (e) {
      return classifyError(e);
    }
  }

  /**
   * Run a whole Maestro flow against the live attachment and return a
   * structured per-step outcome with failure context. Reuses the exact
   * FlowExecutor an `ennio test` run uses — same registry, settle, and HID
   * actuation — but driven over the already-open MCP connection, so no
   * second attach happens. The agent composes a flow, runs it here, and on
   * failure reads `failure.{step,command,reason,screenshotPath}` to iterate.
   *
   * A failed flow is a normal answer (`ok({ passed: false, … })`), not an
   * error turn — the agent branches on `passed`. Only a parse/attach/socket
   * fault surfaces as an error kind.
   */
  async runFlow(flow: MaestroFlow): Promise<
    EnnioResult<{
      passed: boolean;
      stepsRun: number;
      stepsPassed: number;
      durationMs: number;
      steps: { step: number; ms: number; cmd: string }[];
      failure?: { step: number; command: string; reason: string; screenshotPath?: string };
      /** Values steps recorded via ctx.outputs (e.g. assertScreenMatches
       *  scores), exposed so the agent reads them in the same result. */
      outputs?: Record<string, unknown>;
    }>
  > {
    const a = this.attachment;
    if (!a) return err('invalid', 'not attached to an app — call ennio_launch_app first');
    // The agent already chose the app via ennio_launch_app; default the
    // flow's appId to it so inline flows need no metadata block.
    const f: MaestroFlow = flow.appId ? flow : { ...flow, appId: a.bundleId };
    try {
      const executor = new FlowExecutor({
        session: a.session,
        connection: a.connection,
        platform: this.platform,
        reporter: new SilentReporter(),
        driver: this.platform.createDriver(this.opts.inProcessTap ?? false),
      });
      const r = await executor.run(f);
      return ok({
        passed: r.passed,
        stepsRun: r.stepsRun,
        stepsPassed: r.stepsPassed,
        durationMs: r.durationMs,
        steps: r.stepTimings,
        ...(r.failure && { failure: r.failure }),
        ...(r.outputs && Object.keys(r.outputs).length > 0 && { outputs: r.outputs }),
      });
    } catch (e) {
      return classifyError(e);
    }
  }

  /** Logical screen size in points. */
  async screenSize(): Promise<EnnioResult<{ w: number; h: number }>> {
    const a = this.attachment;
    if (!a) return err('invalid', 'not attached to an app — call ennio_launch_app first');
    try {
      return ok(await getScreenSize(a.session.udid));
    } catch (e) {
      return classifyError(e);
    }
  }

  /** Capture a PNG to `path` via the platform's host-side screenshot. */
  screenshot(path: string): EnnioResult<{ path: string }> {
    const a = this.attachment;
    if (!a) return err('invalid', 'not attached to an app — call ennio_launch_app first');
    try {
      this.platform.system.screenshot(a.session.udid, path);
      return ok({ path });
    } catch (e) {
      return classifyError(e);
    }
  }

  private detach(): void {
    if (this.attachment) {
      this.attachment.connection.close();
      this.attachment = null;
    }
  }

  /**
   * Touch-visualization cleanup (improvise/mcp): the overlay must not outlive
   * the session and keep drawing the user's own taps. Turns it off in
   * the still-running app (awaited, so a process.exit right after can't
   * cut the RPC short) and clears the sticky launchctl env so a manual
   * relaunch doesn't re-arm it. Call before close(); no-op otherwise.
   */
  async disableShowTouches(): Promise<void> {
    const a = this.attachment;
    if (!a || process.env.ENNIO_SHOW_TOUCHES !== '1' || this.platform.name !== 'ios') return;
    await a.connection.socket.call('set_show_touches', { enabled: false }).catch(() => undefined);
    setSimLaunchEnv(a.session.udid, 'ENNIO_SHOW_TOUCHES', false);
  }

  close(): void {
    this.detach();
  }
}
