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
import { getScreenSize } from '../hid';
import type { MaestroCommand, MaestroSelector } from '../maestro-parser';
import type { Platform } from '../platform';
import { selectPlatform } from '../platform';
import type { DeviceSession } from '../platform/types';
import type { RunContext } from '../runner/context';

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
      return ok({ bundleId, udid: session.udid });
    } catch (e) {
      return classifyError(e);
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

  close(): void {
    this.detach();
  }
}
