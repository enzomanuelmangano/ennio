// Platform — the device-backend abstraction. Sits alongside GestureDriver
// (which abstracts the gesture MECHANISM) and abstracts everything else
// that differs between an iOS simulator and an Android emulator:
//
//   - device selection (simctl UDID vs adb serial)
//   - control-socket transport (Unix path vs adb-forwarded TCP)
//   - app lifecycle (simctl launch/terminate/clearState vs adb am/pm)
//   - deep links, first-paint waits
//
// Everything ABOVE this line — flow execution, command handlers, settle
// policies, finders, the wire protocol — is platform-agnostic and shared.
// The runner picks a Platform once (commands/test.ts) and threads it
// through RunContext; handlers call ctx.platform.* instead of importing
// simctl helpers directly.

import type { GestureDriver } from '../driver';
import type { EnnioConnection } from '../core/ennio-connection';
import type { AxElement } from '../ennio-ax';
import type { RunContext } from '../runner/context';

/**
 * Cross-process accessibility bridge — locating and acting on UI the
 * in-app agent can't see from inside the process. On iOS this reads the
 * Simulator's macOS AX tree (native sheets, system permission dialogs)
 * and taps via the host HID helper. On Android the in-app agent already
 * traverses everything (native menus, dialogs render in the same view
 * tree), so this is a null object: nothing extra to find, nothing extra
 * to dismiss.
 */
export interface AxBridge {
  resolve(udid: string, sel: { id?: string; text?: string }): Promise<AxElement | null>;
  tapTarget(udid: string, sel: { id?: string; text?: string }): Promise<boolean>;
  dismissSystemSheet(udid: string): Promise<boolean>;
  /** testID of the currently-focused text field, cross-process. */
  textFieldId(udid: string): Promise<string | null>;
  /** Focus the frontmost text field via the cross-process AX tree. */
  focusTextField(udid: string): Promise<boolean>;
}

/**
 * Host-side system actions that don't go through the in-app agent —
 * screenshots, OS keychain/keystore, the system clipboard. iOS drives
 * these with simctl; Android with adb.
 */
export interface SystemBridge {
  screenshot(udid: string, path: string): void;
  clearKeychain(udid: string): void;
  setClipboard(udid: string, text: string): void;
  getClipboard(udid: string): string;
  /** Inject a real OS BACK. Optional: only Android needs it (to pop a
   *  poppable native-stack screen owned by the predictive-back dispatcher,
   *  which no in-process call can trigger). iOS pops via the nav controller
   *  in-process and leaves this undefined. */
  hardwareBack?(udid: string): void;
}

/** The minimal device identity the flow executor needs. SimulatorSession
 *  already satisfies this; Android produces a plain object. */
export interface DeviceSession {
  udid: string;
  bundleId: string;
  dylibPath: string | null;
}

export interface ConnectOptions {
  udid?: string;
  bundleId: string;
  dylibPath?: string | null;
  safeMode?: boolean;
}

export interface OpenConnection {
  session: DeviceSession;
  connection: EnnioConnection;
}

export interface Platform {
  readonly name: 'ios' | 'android';

  /** Cross-process accessibility bridge (see AxBridge). */
  readonly ax: AxBridge;

  /** Host-side system actions (screenshot / keychain / clipboard). */
  readonly system: SystemBridge;

  /** Build the gesture driver for this run. iOS returns HID/Fast; Android
   *  returns the in-process MotionEvent driver. */
  createDriver(fast: boolean): GestureDriver;

  /**
   * Resolve the device, ensure the app is running with the agent
   * attached, and open a ready control connection. Launches the app if
   * it isn't already up. Throws with an actionable message on failure.
   */
  connect(opts: ConnectOptions): Promise<OpenConnection>;

  /** clearState + relaunch + reconnect. Mutates ctx.client to the new
   *  socket. (YAML: `launchApp: { clearState: true }`, `clearState`.) */
  clearStateAndRelaunch(ctx: RunContext, launchArgs?: string[]): Promise<void>;

  /** Reuse-app fast path for `launchApp: { clearState: true }` when the app
   *  is already running and there are no launch arguments: wipe data WITHOUT
   *  a full relaunch where the backend can. iOS soft-resets in place (sandbox
   *  wipe + JS reload). Android has no in-process JS reload on a release
   *  bundle, so it just relaunches — the relaunch IS its reset. Keeping this
   *  on the platform (not an `isAndroid()` branch in the handler) is what
   *  stops the iOS-only soft-reset from running simctl against an emulator. */
  softReset(ctx: RunContext): Promise<void>;

  /** Relaunch after an explicit stopApp/killApp. Mutates ctx.client.
   *  (YAML: `launchApp` following a `stopApp`.) */
  relaunchAndReconnect(ctx: RunContext, launchArgs?: string[]): Promise<void>;

  /** Terminate the app without wiping data. (YAML: `stopApp`/`killApp`.) */
  terminate(udid: string, bundleId: string): void;

  /** Open a deep link / universal link. (YAML: `openLink`.) */
  openUrl(ctx: RunContext, url: string): Promise<void>;
}
