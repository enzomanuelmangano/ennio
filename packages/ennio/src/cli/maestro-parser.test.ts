import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  normalizeSelector,
  toEnnioSelector,
  parseMaestroFile,
  expandFlow,
  resolveSubflowPath,
} from './maestro-parser';

describe('normalizeSelector', () => {
  it('treats a bare string as a TEXT match (Maestro shorthand)', () => {
    expect(normalizeSelector('Sign In')).toEqual({ text: 'Sign In' });
  });

  it('folds label into text when text is absent', () => {
    expect(normalizeSelector({ label: 'Submit' })).toEqual({ text: 'Submit' });
  });

  it('keeps text and drops label when both present (text wins)', () => {
    const out = normalizeSelector({ text: 'A', label: 'B' });
    expect(out.text).toBe('A');
    // label is not folded when text already exists
    expect(out).toEqual({ text: 'A', label: 'B' });
  });

  it('passes an id selector through unchanged', () => {
    expect(normalizeSelector({ id: 'email-input' })).toEqual({ id: 'email-input' });
  });
});

describe('toEnnioSelector — text match mode', () => {
  it('uses contains mode for plain text', () => {
    expect(toEnnioSelector({ text: 'Wireless' })).toEqual({
      text: { pattern: 'Wireless', mode: 'contains' },
    });
  });

  it('uses regex mode when text contains metacharacters', () => {
    for (const pattern of ['Step [0-9]', 'a|b', 'foo+', '^Start', 'end$', '(grp)']) {
      const out = toEnnioSelector({ text: pattern });
      expect((out.text as { mode: string }).mode).toBe('regex');
    }
  });

  it('uses regex mode for leading/trailing .* anchors', () => {
    expect((toEnnioSelector({ text: '.*Headphones' }).text as { mode: string }).mode).toBe('regex');
    expect((toEnnioSelector({ text: 'Wireless.*' }).text as { mode: string }).mode).toBe('regex');
  });

  it('passes id through', () => {
    expect(toEnnioSelector({ id: 'cart' }).id).toBe('cart');
  });
});

describe('toEnnioSelector — spatial / hierarchical recursion', () => {
  it('recursively converts a rightOf selector', () => {
    const out = toEnnioSelector({ text: 'Step 2', rightOf: { id: 'step-1' } });
    expect(out.rightOf).toEqual({ id: 'step-1' });
    expect((out.text as { mode: string }).mode).toBe('contains');
  });

  it('maps containsDescendants over each child selector', () => {
    const out = toEnnioSelector({ id: 'row', containsDescendants: [{ label: 'X' }, { id: 'y' }] });
    // NB: containsDescendants is NOT normalized — label is not folded here.
    expect(out.containsDescendants).toEqual([{}, { id: 'y' }]);
  });

  it('forwards state + dimension selectors', () => {
    const out = toEnnioSelector({
      id: 'a',
      enabled: true,
      checked: false,
      width: 10,
      tolerance: 2,
    });
    expect(out).toMatchObject({ id: 'a', enabled: true, checked: false, width: 10, tolerance: 2 });
  });
});

describe('parseMaestroFile', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ennio-parser-test-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(name: string, content: string): string {
    const p = join(dir, name);
    writeFileSync(p, content, 'utf-8');
    return p;
  }

  it('parses the standard metadata + commands two-document shape', () => {
    const p = write(
      'flow.yaml',
      [
        'appId: com.ennio.example',
        'name: My Flow',
        'tags:',
        '  - smoke',
        '---',
        '- tapOn: Home',
        '- assertVisible:',
        '    id: home-screen',
        '',
      ].join('\n'),
    );
    const flow = parseMaestroFile(p);
    expect(flow.appId).toBe('com.ennio.example');
    expect(flow.name).toBe('My Flow');
    expect(flow.tags).toEqual(['smoke']);
    expect(flow.commands).toHaveLength(2);
    expect(flow.commands[0]).toEqual({ tapOn: 'Home' });
    expect(flow.filePath).toBe(p);
  });

  it('parses a single commands-only document (array)', () => {
    const p = write('cmds-only.yaml', ['- tapOn: A', '- back', ''].join('\n'));
    const flow = parseMaestroFile(p);
    expect(flow.appId).toBeUndefined();
    expect(flow.commands).toEqual([{ tapOn: 'A' }, 'back' as never]);
  });

  it('parses a single metadata-only document (no commands)', () => {
    const p = write('meta-only.yaml', 'appId: com.x\n');
    const flow = parseMaestroFile(p);
    expect(flow.appId).toBe('com.x');
    expect(flow.commands).toEqual([]);
  });

  it('captures onFlowStart / onFlowComplete hooks', () => {
    const p = write(
      'hooks.yaml',
      ['appId: com.x', 'onFlowStart:', '  - launchApp', '---', '- tapOn: A', ''].join('\n'),
    );
    const flow = parseMaestroFile(p);
    expect(flow.onFlowStart).toEqual(['launchApp']);
    expect(flow.commands).toEqual([{ tapOn: 'A' }]);
  });

  // The single interpolation boundary: parse-time substitution resolves only
  // metadata that is consumed BEFORE a runtime context exists (appId). Command
  // bodies must keep their ${VAR} placeholders so the runtime pass — where
  // flowEnv / runFlow.env take precedence over process.env — can resolve them.
  // Pre-resolving a command-body var at parse time (the old behaviour) made
  // process.env silently shadow a runFlow.env override.
  describe('interpolation boundary', () => {
    it('resolves ${VAR} in the metadata appId at parse time', () => {
      process.env.ENNIO_TEST_APPID = 'org.example.app';
      const p = write('appid.yaml', ['appId: ${ENNIO_TEST_APPID}', '---', '- back', ''].join('\n'));
      expect(parseMaestroFile(p).appId).toBe('org.example.app');
      delete process.env.ENNIO_TEST_APPID;
    });

    it('does NOT pre-resolve a command-body ${VAR} even when it exists in process.env', () => {
      process.env.LINK = 'from-process';
      const p = write(
        'cmdvar.yaml',
        ['appId: com.x', '---', '- openLink: ${LINK}', ''].join('\n'),
      );
      const flow = parseMaestroFile(p);
      // Placeholder survives parse → runtime flowEnv can still override it.
      expect(flow.commands[0]).toEqual({ openLink: '${LINK}' });
      delete process.env.LINK;
    });

    it('does NOT pre-resolve a ${VAR} inside a selector at parse time', () => {
      process.env.TEXT = 'from-process';
      const p = write(
        'selvar.yaml',
        ['appId: com.x', '---', '- assertVisible:', '    text: ${TEXT}', ''].join('\n'),
      );
      const flow = parseMaestroFile(p);
      expect(flow.commands[0]).toEqual({ assertVisible: { text: '${TEXT}' } });
      delete process.env.TEXT;
    });
  });
});

describe('expandFlow', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ennio-expand-test-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolveSubflowPath resolves relative to the parent flow', () => {
    const got = resolveSubflowPath('/a/b/flow.yaml', 'subflows/x.yaml');
    expect(got).toBe('/a/b/subflows/x.yaml');
  });

  it('loads a referenced subflow and is cycle-safe', () => {
    const sub = join(dir, 'sub.yaml');
    const main = join(dir, 'main.yaml');
    writeFileSync(sub, ['appId: com.x', '---', `- runFlow:`, `    file: main.yaml`, ''].join('\n'));
    writeFileSync(main, ['appId: com.x', '---', `- runFlow:`, `    file: sub.yaml`, ''].join('\n'));
    const flow = parseMaestroFile(main);
    // A → sub → A. The visited-set guard must terminate.
    const { subflows } = expandFlow(flow);
    expect(subflows.length).toBeGreaterThanOrEqual(1);
    expect(subflows.map((s) => s.filePath)).toContain(sub);
  });

  it('ignores a runFlow whose file does not exist', () => {
    const p = join(dir, 'missing.yaml');
    writeFileSync(p, ['appId: com.x', '---', '- runFlow:', '    file: nope.yaml', ''].join('\n'));
    const flow = parseMaestroFile(p);
    expect(() => expandFlow(flow)).not.toThrow();
    expect(expandFlow(flow).subflows).toEqual([]);
  });
});
