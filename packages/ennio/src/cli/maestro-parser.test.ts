import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  normalizeSelector,
  parseMaestroFile,
  expandFlow,
  resolveSubflowPath,
  isRegexText,
  textMatchMode,
  extractModifiers,
} from './maestro-parser';
import type { MaestroCommand } from './maestro-parser';

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
      const p = write('cmdvar.yaml', ['appId: com.x', '---', '- openLink: ${LINK}', ''].join('\n'));
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

// ---------------------------------------------------------------------------
// Conformance spec: text matcher mode.
//
// Pins the CURRENT behavior of `isRegexText` — the metacharacter sniff that
// decides whether a text selector is a literal substring or a regex. This is a
// fragile heuristic (it cannot tell "the user meant a pattern" from "the user
// typed a $"). Phase 1 deletes it in favor of an explicit `matchMode` computed
// once at parse time. These tests document what IS so the replacement is a
// deliberate, visible change, and they enumerate the cases the new matchMode
// must get right.
//
// Maps to matrix.json rows: selector.text.* (see docs/maestro-parity.md).
// ---------------------------------------------------------------------------
describe('isRegexText (current matcher sniff — Phase 1 replaces with matchMode)', () => {
  it('treats plain text as a literal (not regex)', () => {
    // matrix: selector.text.literal-plain — status pass
    expect(isRegexText('Sign In')).toBe(false);
    expect(isRegexText('Home')).toBe(false);
    expect(isRegexText('3')).toBe(false);
  });

  it('treats an explicit .* anchor as a regex', () => {
    // matrix: selector.text.regex-explicit — status pass
    expect(isRegexText('.*Settings.*')).toBe(true);
    expect(isRegexText('Settings.*')).toBe(true);
    expect(isRegexText('.*Settings')).toBe(true);
  });

  it('treats a genuine pattern with character classes/quantifiers as a regex', () => {
    // matrix: selector.text.regex-explicit — status pass
    expect(isRegexText('users[,]? or feeds')).toBe(true);
    expect(isRegexText('item-(1|2|3)')).toBe(true);
  });

  // The unfixable cases: literal content that happens to contain a
  // metacharacter is mis-detected as a pattern. Documented here as the SNIFF's
  // failure mode — the new matchMode (Phase 1) must let these be matched
  // literally via an explicit `literal:` escape hatch.
  // matrix: selector.text.literal-with-metachars — status fragile
  it('MISFIRES: a literal price string with $ ( ) is wrongly flagged regex', () => {
    expect(isRegexText('Price: $5 (USD)')).toBe(true); // <- bug: should be literal
  });

  it('MISFIRES: a literal label with parentheses is wrongly flagged regex', () => {
    expect(isRegexText('Change position (left)')).toBe(true); // <- bug: should be literal
  });

  it('MISFIRES: a literal label with a trailing question mark is wrongly flagged regex', () => {
    expect(isRegexText('Delete account?')).toBe(true); // <- bug: should be literal
  });
});

// ---------------------------------------------------------------------------
// textMatchMode: the single resolver the finder/visibility layers use. Phase 1
// routes every text match through this so the mode is decided ONCE, and adds
// explicit `regex:`/`literal:` escape hatches over the legacy sniff.
//
// Maps to matrix.json rows: selector.text.* and the Phase-1 escape hatch.
// ---------------------------------------------------------------------------
describe('textMatchMode', () => {
  it('honors an explicit literal escape hatch even for metachar content', () => {
    // The misfire cases above become correct once the author opts in.
    expect(textMatchMode({ text: 'Price: $5 (USD)', literal: true })).toBe('literal');
    expect(textMatchMode({ text: 'Change position (left)', literal: true })).toBe('literal');
  });

  it('honors an explicit regex escape hatch for plain text', () => {
    expect(textMatchMode({ text: 'Settings', regex: true })).toBe('regex');
  });

  it('literal wins when both flags are set (conservative tie-break)', () => {
    expect(textMatchMode({ text: 'x', regex: true, literal: true })).toBe('literal');
  });

  it('transitional default is byte-identical to the legacy sniff', () => {
    // No explicit flag => same decision the scattered isRegexText() calls made,
    // so existing flows are unaffected until Phase 2 flips the profile default.
    for (const t of ['Sign In', 'Home', '3', '.*Settings.*', 'users[,]? or feeds', 'Price: $5']) {
      const expected = isRegexText(t) ? 'regex' : 'literal';
      expect(textMatchMode({ text: t })).toBe(expected);
    }
  });

  it('defaults to literal for an empty/absent text', () => {
    expect(textMatchMode({})).toBe('literal');
    expect(textMatchMode({ text: '' })).toBe('literal');
  });

  it('honors the profile defaultMode when no explicit flag is set', () => {
    expect(textMatchMode({ text: 'Done' }, 'regex')).toBe('regex');
    expect(textMatchMode({ text: 'users[,]? or feeds' }, 'literal')).toBe('literal');
    // explicit flags still beat the profile default
    expect(textMatchMode({ text: 'Done', literal: true }, 'regex')).toBe('literal');
  });
});

// ---------------------------------------------------------------------------
// extractModifiers: splits Maestro per-command modifiers (optional/label/when)
// from the bare command. Maps to matrix.json rows: modifier.* (Phase 3).
// ---------------------------------------------------------------------------
describe('extractModifiers', () => {
  it('splits sibling optional/label/when off the bare command', () => {
    const cmd = {
      tapOn: 'Submit',
      optional: true,
      label: 'tap submit',
      when: { visible: { id: 'form' } },
    } as unknown as MaestroCommand;
    const { command, modifiers } = extractModifiers(cmd);
    expect(command).toEqual({ tapOn: 'Submit' });
    expect(modifiers).toEqual({
      optional: true,
      label: 'tap submit',
      when: { visible: { id: 'form' } },
    });
  });

  it('returns empty modifiers for a command with none', () => {
    const { command, modifiers } = extractModifiers({ tapOn: 'X' } as MaestroCommand);
    expect(command).toEqual({ tapOn: 'X' });
    expect(modifiers).toEqual({});
  });

  it('leaves a bare-string command untouched', () => {
    const { command, modifiers } = extractModifiers('back' as unknown as MaestroCommand);
    expect(command).toBe('back');
    expect(modifiers).toEqual({});
  });

  it('does NOT extract a selector-level optional nested inside the verb', () => {
    // `tapOn: { id, optional }` keeps optional on the selector (handled by the
    // tap handler), not as a command-level modifier.
    const cmd = { tapOn: { id: 'X', optional: true } } as unknown as MaestroCommand;
    const { command, modifiers } = extractModifiers(cmd);
    expect(command).toEqual({ tapOn: { id: 'X', optional: true } });
    expect(modifiers).toEqual({});
  });
});
