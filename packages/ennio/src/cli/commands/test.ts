/**
 * `ennio test <flow.yaml | dir | glob>` — run one or more Maestro YAML
 * flows.
 *
 * Thin wrapper around EnnioRunner. All orchestration, lifecycle, and
 * reporting lives in core/. This file only handles arg expansion and
 * the process exit code.
 */

import { existsSync, statSync } from 'fs';
import { basename, join, resolve } from 'path';

import { glob } from 'glob';

import type { Flags } from '../cli/args';
import { EnnioRunner } from '../core';
import { selectPlatform } from '../platform';

function isMaestroFile(filePath: string): boolean {
  return filePath.endsWith('.yaml') || filePath.endsWith('.yml');
}

function isSubflowFile(filePath: string): boolean {
  return basename(filePath).startsWith('_');
}

async function expandFiles(patterns: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const pattern of patterns) {
    const resolved = resolve(pattern);
    if (existsSync(resolved) && statSync(resolved).isDirectory()) {
      const yamlMatches = await glob(join(pattern, '**/*.{yaml,yml}'));
      files.push(
        ...yamlMatches
          .filter((f) => isMaestroFile(f) && !f.includes('/subflows/') && !isSubflowFile(f))
          .map((f) => resolve(f)),
      );
    } else {
      const matches = await glob(pattern);
      files.push(
        ...matches
          .filter((f) => isMaestroFile(f) && !f.includes('/subflows/'))
          .map((f) => resolve(f)),
      );
    }
  }
  return files;
}

export async function runTestCommand(positional: string[], flags: Flags): Promise<number> {
  if (positional.length === 0) {
    console.error('Usage: ennio test <flow.yaml | dir | glob> [options]');
    console.error('');
    console.error('Options:');
    console.error('  --verbose, -v         Per-step inline output (on by default)');
    console.error('  --quiet, -q           Suppress per-step inline output');
    console.error('  --lenient             Skip unknown commands with a warning');
    console.error('  --reporter=<kind>     pretty (default) | json');
    console.error('  --safe-mode           Disable all in-app hooks (swizzles/observers).');
    console.error('                        Slower settle, but survives injection conflicts.');
    console.error('  --in-process-tap      Actuate taps via in-process activation (dylib),');
    console.error('                        per-gesture fallback to real HID. iOS-only; opt-in.');
    console.error('                        Default actuation is real HID (full gesture path).');
    console.error('  --disable-animations  Suppress app animations (transitions snap to');
    console.error('                        final frame) — faster, but alters animated UI');
    console.error('  --disable-reuse-app   Force a full relaunch on clearState. App reuse');
    console.error('                        (soft-reset: data wipe + JS reload) is ON by default.');
    console.error('  --show-touches        Draw every tap/swipe on screen (iOS: in-app ripple');
    console.error('                        overlay; Android: the OS setting, restored on exit).');
    console.error('');
    console.error('Auto-detection:');
    console.error('  - booted iOS simulator (or auto-boots one)');
    console.error('  - libennio.dylib from /tmp/ennio-build/ or <pkg>/prebuilt/');
    console.error('Overrides: ENNIO_UDID, ENNIO_DYLIB_PATH');
    return 1;
  }

  const files = await expandFiles(positional);
  if (files.length === 0) {
    console.error('No Maestro YAML files found');
    return 1;
  }

  // --disable-animations propagates to the app via launchctl env at every
  // launch site (set there from this process env). Set it here so all
  // three launch paths see a single source of truth.
  if (flags.noAnimations) process.env.ENNIO_NO_ANIMATIONS = '1';
  // --show-touches rides the same channel (iOS: in-app overlay reads the
  // env at launch; Android: the platform flips the OS setting on connect).
  if (flags.showTouches) process.env.ENNIO_SHOW_TOUCHES = '1';
  // App reuse is ON by default: clearState soft-resets (data wipe + JS reload)
  // instead of relaunching when the app is already running (read in the
  // launchApp handler via this env). --disable-reuse-app forces full relaunch.
  process.env.ENNIO_REUSE_APP = flags.disableReuseApp ? '0' : '1';

  const reporterKind = (flags.reporter as 'pretty' | 'json' | undefined) ?? 'pretty';
  // Verbose is the default — per-step inline output is the whole point
  // of a pretty run. --quiet/-q opts out. An explicit --verbose still
  // means something: it wins over --quiet when both are passed.
  const verbose = flags.verbose ? true : !flags.quiet;
  // Backend: --android targets an emulator/device over adb; default iOS.
  // ENNIO_PLATFORM=android is an env-level equivalent for CI.
  const platformName =
    flags.android || process.env.ENNIO_PLATFORM === 'android' ? 'android' : 'ios';
  const runner = new EnnioRunner({
    udid: process.env.ENNIO_UDID,
    dylibPath: process.env.ENNIO_DYLIB_PATH || undefined,
    reporterKind,
    verbose,
    lenient: flags.lenient ?? false,
    safeMode: flags.safeMode ?? false,
    inProcessTap: flags.inProcessTap ?? false,
    platform: selectPlatform(platformName),
  });

  try {
    const result = await runner.run(files);
    return result.passed ? 0 : 1;
  } catch (err) {
    console.error(`✗ ERROR  ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
