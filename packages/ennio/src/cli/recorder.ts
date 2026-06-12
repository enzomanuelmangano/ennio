// Screen recording for a run — the `--record` flag. Drives
// `simctl io recordVideo` as a child process for the whole run; SIGINT
// is the documented way to stop it, and the file is only finalized
// (moov atom written) after the process exits — hence the awaited stop.
//
// Pairs naturally with --show-touches: the overlay's ripples are part
// of the screen, so the recording shows every tap and swipe the run
// performed.
//
// iOS-only today: Android's `adb shell screenrecord` has a 3-minute
// hard cap and needs an on-device file + pull, so it gets its own
// treatment later rather than a half-working shim.

import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';

export interface ScreenRecording {
  /** Stop recording, wait for the file to be finalized, and return its
   *  path — null when the recorder never started or died early. */
  stop(): Promise<string | null>;
}

export function startScreenRecording(
  platformName: 'ios' | 'android',
  udid: string,
  outPath: string,
): ScreenRecording | null {
  if (platformName !== 'ios') {
    console.error('[record] --record is iOS-only today — skipping (Android needs its own screenrecord plumbing)');
    return null;
  }
  let proc: ChildProcess;
  let failed = false;
  try {
    proc = spawn(
      'xcrun',
      ['simctl', 'io', udid, 'recordVideo', '--codec', 'h264', '--force', outPath],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
  } catch {
    console.error('[record] could not start simctl recordVideo — continuing without recording');
    return null;
  }
  proc.on('error', () => {
    failed = true;
  });
  // An immediate exit (bad udid, no io support) means no recording —
  // distinguish it from the SIGINT-driven exit at stop() time.
  proc.on('exit', (code, signal) => {
    if (signal === null && code !== 0) failed = true;
  });

  return {
    stop: () =>
      new Promise((resolve) => {
        if (failed || proc.exitCode !== null) {
          resolve(failed ? null : outPath);
          return;
        }
        // recordVideo writes the file on SIGINT; cap the wait so a hung
        // recorder can't wedge the CLI exit.
        const cap = setTimeout(() => resolve(outPath), 10_000);
        proc.once('exit', () => {
          clearTimeout(cap);
          resolve(failed ? null : outPath);
        });
        proc.kill('SIGINT');
      }),
  };
}
