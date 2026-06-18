import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { findCrashReport } from './crash-detector';

const HEADER = JSON.stringify({
  app_name: 'Liverum',
  timestamp: '2026-06-04 21:18:02.00 +0100',
  bug_type: '309',
});

function ipsBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    procName: 'Liverum',
    bundleInfo: { CFBundleIdentifier: 'com.liverum.client' },
    exception: { type: 'EXC_BAD_ACCESS', signal: 'SIGSEGV' },
    faultingThread: 1,
    threads: [
      { frames: [] },
      {
        frames: [
          { imageIndex: 1, symbol: 'hermes::Context::Context' },
          { imageIndex: 1, symbol: 'worklets::WorkletHermesRuntime' },
          { imageIndex: 0, imageOffset: 0x1234 },
        ],
      },
    ],
    usedImages: [{ name: 'Liverum' }, { name: 'hermes' }, { name: 'libennio.dylib' }],
    ...overrides,
  });
}

describe('findCrashReport', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ennio-ips-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('parses a matching .ips and extracts exception + frames + ennio flag', () => {
    writeFileSync(join(dir, 'Liverum-2026-06-04-211802.ips'), `${HEADER}\n${ipsBody()}`);
    const r = findCrashReport('com.liverum.client', Date.now() - 60_000, dir);
    expect(r).not.toBeNull();
    expect(r!.exception).toBe('EXC_BAD_ACCESS (SIGSEGV)');
    expect(r!.ennioLoaded).toBe(true);
    expect(r!.faultingFrames[0]).toBe('hermes: hermes::Context::Context');
    expect(r!.faultingFrames[2]).toBe('Liverum: +0x1234');
  });

  it('ignores reports for other bundle ids', () => {
    writeFileSync(
      join(dir, 'Other-2026-06-04-211802.ips'),
      `${HEADER}\n${ipsBody({ bundleInfo: { CFBundleIdentifier: 'com.other.app' }, procName: 'Other' })}`,
    );
    expect(findCrashReport('com.liverum.client', Date.now() - 60_000, dir)).toBeNull();
  });

  it('ignores reports older than sinceMs', () => {
    const p = join(dir, 'Liverum-2026-06-04-211802.ips');
    writeFileSync(p, `${HEADER}\n${ipsBody()}`);
    // File mtime is "now"; asking for crashes after now + slack finds nothing.
    expect(findCrashReport('com.liverum.client', Date.now() + 60_000, dir)).toBeNull();
  });

  it('falls back to procName match when bundleInfo is missing', () => {
    writeFileSync(
      join(dir, 'Liverum-2026-06-04-211802.ips'),
      `${HEADER}\n${ipsBody({ bundleInfo: undefined, procName: 'client' })}`,
    );
    const r = findCrashReport('com.liverum.client', Date.now() - 60_000, dir);
    expect(r).not.toBeNull();
    expect(r!.procName).toBe('client');
  });

  it('survives malformed .ips files', () => {
    writeFileSync(join(dir, 'Broken-2026-06-04-211802.ips'), 'not json at all');
    expect(findCrashReport('com.liverum.client', Date.now() - 60_000, dir)).toBeNull();
  });

  it('flags ennioLoaded=false when the dylib was not in the process', () => {
    writeFileSync(
      join(dir, 'Liverum-2026-06-04-211802.ips'),
      `${HEADER}\n${ipsBody({ usedImages: [{ name: 'Liverum' }] })}`,
    );
    const r = findCrashReport('com.liverum.client', Date.now() - 60_000, dir);
    expect(r!.ennioLoaded).toBe(false);
  });

  // A real stale-dylib crash: SIGABRT whose faulting (JS) thread aborts in
  // the allocator/os_log while Expo registers native modules at startup —
  // libennio loaded but not on a faulting frame.
  function startupAbortBody(): string {
    return JSON.stringify({
      procName: 'MaestroDemo',
      bundleInfo: { CFBundleIdentifier: 'com.ennio.maestrodemo' },
      exception: { type: 'EXC_CRASH', signal: 'SIGABRT' },
      faultingThread: 0,
      threads: [
        {
          frames: [
            { imageIndex: 0, symbol: 'abort' },
            { imageIndex: 0, symbol: 'nanov2_guard_corruption_detected' },
            { imageIndex: 1, symbol: '_os_log_impl' },
            { imageIndex: 2, symbol: 'ModuleRegistry.register(holder:)' },
            { imageIndex: 2, symbol: 'AppContext.registerNativeModules()' },
          ],
        },
      ],
      usedImages: [
        { name: 'libsystem_malloc.dylib' },
        { name: 'libsystem_trace.dylib' },
        { name: 'MaestroDemo' },
        { name: 'libennio.dylib', path: '/private/tmp/x/libennio.dylib' },
      ],
    });
  }

  it('flags startupAbort for a stale-dylib SIGABRT during module registration', () => {
    writeFileSync(
      join(dir, 'MaestroDemo-2026-06-17-000357.ips'),
      `${HEADER}\n${startupAbortBody()}`,
    );
    const r = findCrashReport('com.ennio.maestrodemo', Date.now() - 60_000, dir);
    expect(r).not.toBeNull();
    expect(r!.exception).toBe('EXC_CRASH (SIGABRT)');
    expect(r!.startupAbort).toBe(true);
    expect(r!.ennioLoaded).toBe(true);
    expect(r!.jsFatal).toBe(false);
  });

  it('does not flag startupAbort for an ordinary SIGSEGV', () => {
    writeFileSync(join(dir, 'Liverum-2026-06-04-211802.ips'), `${HEADER}\n${ipsBody()}`);
    const r = findCrashReport('com.liverum.client', Date.now() - 60_000, dir);
    expect(r!.startupAbort).toBe(false);
  });
});
