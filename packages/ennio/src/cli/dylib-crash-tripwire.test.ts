// Tripwire for the crash class removed in #76.
//
// The dylib used to swizzle a Fabric mount method (RCTMountingManager
// performTransaction: et al.) to get an RN commit signal. Those methods
// take C++ arguments (e.g. MountingCoordinator::Shared const&); forwarding
// them through an objc IMP is undefined behaviour and CRASHED third-party
// Fabric components on creation — Skia <Canvas>, Expo liquid-glass,
// VisionCamera — and SIGSEGV'd on RN 0.85. #76 deleted it and replaced the
// signal with the renderer-agnostic EnnioSettle (CFRunLoop + frame-hash).
//
// This crash can only come back if someone re-introduces method swizzling
// targeting an RN/Fabric mount method. That's the invariant this test
// guards: NO IMP replacement may co-occur with a Fabric/RN-mount symbol in
// the same translation unit. The three legitimate swizzles that remain
// (CALayer addAnimation:, UIApplication sendEvent:, UIView
// setAccessibilityIdentifier:) target plain objc UIKit methods with no C++
// args and reference none of these tokens, so they pass.
//
// If this test fails, you are about to reintroduce the #76 crash. Don't
// swizzle Fabric mount methods — observe EnnioSettle instead.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const IOS_ROOT = join(__dirname, '..', '..', 'ios');

// objc runtime primitives that replace a method's implementation.
const IMP_REPLACEMENT = /\b(method_setImplementation|method_exchangeImplementations)\b/;

// RN/Fabric mount-path symbols. Swizzling anything that touches these is the
// exact UB that crashed Skia / liquid-glass / VisionCamera.
const FABRIC_MOUNT = [
  'RCTMountingManager',
  'RCTSurfacePresenter',
  'RCTScheduler',
  'performTransaction',
  'scheduleTransaction',
  '_performMountInstructions',
  'performMountInstructions',
];

// Exact symbols from the deleted swizzle machinery — re-adding any of these
// verbatim is an unambiguous regression.
const DELETED_SWIZZLE_SYMBOLS = ['attachFabricSwizzle', 'swizzledMountImp', 'wrapperForEncoding'];

/** Strip // line comments and block comments so tokens that only appear in
 *  prose (e.g. a comment mentioning RCTMountingManager) never trip the
 *  guard. Crude but sufficient — re-introducing the swizzle means real code,
 *  not a comment. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments
    .replace(/\/\/[^\n]*/g, ' '); // line comments
}

function listSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listSources(full));
    } else if (/\.(mm|m|h|cpp|hpp)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe('dylib crash tripwire (#76 — no Fabric mount swizzle)', () => {
  const files = listSources(IOS_ROOT);

  it('finds iOS sources to scan', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('never swizzles a Fabric/RN mount method (the #76 crash class)', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const code = stripComments(readFileSync(file, 'utf8'));
      if (!IMP_REPLACEMENT.test(code)) continue;
      const mountHit = FABRIC_MOUNT.find((t) => code.includes(t));
      if (mountHit) {
        offenders.push(`${file}: IMP replacement co-occurs with "${mountHit}"`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('does not reintroduce the deleted swizzle machinery', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const code = stripComments(readFileSync(file, 'utf8'));
      const hit = DELETED_SWIZZLE_SYMBOLS.find((s) => code.includes(s));
      if (hit) offenders.push(`${file}: reintroduced "${hit}"`);
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
