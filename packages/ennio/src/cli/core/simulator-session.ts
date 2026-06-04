// Simulator + app lifecycle. Wraps simctl invocations and the
// launchctl-env propagation needed to feed ENNIO_SOCKET_PATH into the
// dylib at +load time.
//
// One session per (UDID, bundleId) pair. Used by EnnioRunner before
// any flow runs (to launch the app + inject the dylib) and by
// FlowExecutor when the YAML calls launchApp / clearState.

import { execFileSync } from 'node:child_process';

import { ensureBootedSim, findDylib, terminateApp } from '../sim';
import { ennioSocketPath } from '../socket-client';

export interface SimulatorSessionOptions {
  udid?: string;
  bundleId: string;
  dylibPath?: string | null;
}

export class SimulatorSession {
  readonly udid: string;
  readonly bundleId: string;
  dylibPath: string | null;

  constructor(opts: SimulatorSessionOptions) {
    const udid = opts.udid ?? ensureBootedSim();
    if (!udid) {
      throw new Error('No iOS simulator available. Install one via Xcode or set ENNIO_UDID.');
    }
    this.udid = udid;
    this.bundleId = opts.bundleId;
    this.dylibPath = opts.dylibPath ?? null;
  }

  /**
   * Auto-locate the dylib if not pinned. Throws with an actionable
   * message if nothing is found.
   */
  resolveDylib(): string {
    if (this.dylibPath) return this.dylibPath;
    const auto = findDylib();
    if (!auto) {
      throw new Error(
        'libennio.dylib not found. Set ENNIO_DYLIB_PATH or run from the package dir.',
      );
    }
    this.dylibPath = auto;
    return auto;
  }

  /**
   * Launch the app with DYLD injection. Sets ENNIO_SOCKET_PATH on the
   * simulator launchctl env first (SIMCTL_CHILD_* only forwards
   * DYLD_* and known prefixes — arbitrary names are silently dropped).
   */
  launch(args: string[] = []): void {
    const dylib = this.resolveDylib();
    execFileSync(
      'xcrun',
      [
        'simctl',
        'spawn',
        this.udid,
        'launchctl',
        'setenv',
        'ENNIO_SOCKET_PATH',
        ennioSocketPath(this.udid),
      ],
      { stdio: 'pipe' },
    );
    execFileSync(
      'xcrun',
      ['simctl', 'launch', '--terminate-running-process', this.udid, this.bundleId, ...args],
      {
        env: { ...process.env, SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: dylib },
        stdio: 'pipe',
      },
    );
  }

  /**
   * Kill the app — swallows ENOENT/already-dead errors. Useful before
   * a fresh launch to avoid `--terminate-running-process` racing with
   * a still-shutting-down PID.
   */
  terminate(): void {
    try {
      terminateApp(this.udid, this.bundleId);
    } catch {
      /* already dead */
    }
  }
}
