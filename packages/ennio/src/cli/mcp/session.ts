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
import { axTreeSnapshot, getScreenSize } from '../hid';
import type { MaestroCommand } from '../maestro-parser';
import type { Platform } from '../platform';
import { selectPlatform } from '../platform';
import type { DeviceSession } from '../platform/types';
import type { RunContext } from '../runner/context';

import { describeTree } from './describe';
import type { ScreenDescription } from './describe';
import { classifyError, err, ok } from './result';
import type { EnnioResult } from './result';

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

  /** Interactable element tree, rects normalized to [0,1]. */
  async describe(): Promise<EnnioResult<ScreenDescription>> {
    const a = this.attachment;
    if (!a) return err('invalid', 'not attached to an app — call ennio_launch_app first');
    try {
      const [raw, size] = await Promise.all([
        axTreeSnapshot(a.session.udid),
        getScreenSize(a.session.udid),
      ]);
      return ok(describeTree(raw, size));
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
