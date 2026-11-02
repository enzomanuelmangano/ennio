import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { describe, expect, it } from 'vitest';

import { expandFiles } from './test';

const FLOW = 'appId: x\n---\n- launchApp\n';

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ennio-expand-'));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

describe('expandFiles', () => {
  it('without a config: every flow in the tree, never subflows', async () => {
    const dir = tree({ 'a.yaml': FLOW, 'deep/b.yaml': FLOW, 'subflows/s.yaml': FLOW });
    const { files, stopOnFailureGroups } = await expandFiles([dir]);
    expect(files).toEqual([join(dir, 'a.yaml'), join(dir, 'deep/b.yaml')]);
    expect(stopOnFailureGroups).toEqual([]);
  });

  it('with a config: not run as a flow; default flows are the top level', async () => {
    const dir = tree({
      'config.yaml': 'executionOrder: {}\n',
      'a.yaml': FLOW,
      'deep/b.yaml': FLOW,
    });
    const { files } = await expandFiles([dir]);
    expect(files).toEqual([join(dir, 'a.yaml')]);
  });

  it('continueOnFailure: false groups only the ordered flows', async () => {
    const dir = tree({
      'config.yaml':
        'flows:\n  - "*"\nexecutionOrder:\n  continueOnFailure: false\n  flowsOrder:\n    - b\n    - a\n',
      'a.yaml': FLOW,
      'b.yaml': FLOW,
      'c.yaml': FLOW,
    });
    const { files, stopOnFailureGroups } = await expandFiles([dir]);
    const [a, b, c] = ['a.yaml', 'b.yaml', 'c.yaml'].map((f) => join(dir, f));
    expect(files).toEqual([b, a, c]);
    expect(stopOnFailureGroups).toEqual([[b, a]]);
  });
});
