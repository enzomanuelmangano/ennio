import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { verifyDylibIntegrity } from './sim';

describe('verifyDylibIntegrity', () => {
  let dir: string;
  let dylib: string;
  const contents = Buffer.from('fake dylib bytes');
  const goodSha = createHash('sha256').update(contents).digest('hex');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ennio-sha-'));
    dylib = join(dir, 'libennio.dylib');
    writeFileSync(dylib, contents);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const writeManifest = (sha256: string) =>
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({ schema: 2, dylib: { file: 'libennio.dylib', sha256 } }),
    );

  it('passes when the hash matches the manifest', () => {
    writeManifest(goodSha);
    expect(() => verifyDylibIntegrity(dylib)).not.toThrow();
  });

  it('throws on hash mismatch', () => {
    writeManifest('0'.repeat(64));
    expect(() => verifyDylibIntegrity(dylib)).toThrow(/SHA-256 mismatch/);
  });

  it('is a no-op when no manifest sits next to the dylib', () => {
    expect(() => verifyDylibIntegrity(dylib)).not.toThrow();
  });

  it('is a no-op on unreadable manifest (our packaging bug, not the user)', () => {
    writeFileSync(join(dir, 'manifest.json'), '{not json');
    expect(() => verifyDylibIntegrity(dylib)).not.toThrow();
  });

  it('is a no-op when the manifest has no dylib hash', () => {
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ schema: 2 }));
    expect(() => verifyDylibIntegrity(dylib)).not.toThrow();
  });

  it('verifies the real prebuilt dylib against the shipped manifest', () => {
    // Guards against the manifest going stale when prebuilt/ is updated
    // without scripts/regen-manifest.sh (this exact drift happened).
    const prebuilt = join(__dirname, '..', '..', 'prebuilt', 'libennio.dylib');
    expect(() => verifyDylibIntegrity(prebuilt)).not.toThrow();
  });
});
