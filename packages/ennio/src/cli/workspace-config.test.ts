import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { describe, expect, it } from 'vitest';

import { orderFlows, readWorkspaceConfig } from './workspace-config';

function workspace(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ennio-ws-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

describe('readWorkspaceConfig', () => {
  it('reads flows, flowsOrder and continueOnFailure', () => {
    const dir = workspace({
      'config.yaml':
        'flows:\n  - flows/*.yaml\nexecutionOrder:\n  continueOnFailure: false\n  flowsOrder:\n    - Home\n',
    });
    expect(readWorkspaceConfig(dir)).toEqual({
      path: join(dir, 'config.yaml'),
      flows: ['flows/*.yaml'],
      flowsOrder: ['Home'],
      continueOnFailure: false,
    });
  });

  it('is undefined without a config file', () => {
    expect(readWorkspaceConfig(workspace({}))).toBeUndefined();
  });
});

describe('orderFlows', () => {
  const dir = workspace({
    'a.yaml': 'appId: x\nname: Sign in\n---\n- launchApp\n',
    'b.yaml': 'appId: x\n---\n- launchApp\n',
    'c.yaml': 'appId: x\nname: Home\n---\n- launchApp\n',
  });
  const [a, b, c] = ['a.yaml', 'b.yaml', 'c.yaml'].map((f) => join(dir, f));

  it('runs ordered flows first (by name: or file name), then the rest sorted', () => {
    expect(orderFlows([c, b, a], ['Home', 'Sign in'])).toEqual([c, a, b]);
    expect(orderFlows([c, b, a], ['b'])).toEqual([b, a, c]);
  });

  it('sorts when there is no order', () => {
    expect(orderFlows([c, a, b], undefined)).toEqual([a, b, c]);
  });

  it('fails on a name that matches no flow', () => {
    expect(() => orderFlows([a, b], ['Nope'])).toThrow(/no flow named "Nope"/);
  });
});
