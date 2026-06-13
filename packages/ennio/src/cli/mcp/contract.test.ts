// Interface-quality conformance — the executable proof of the public MCP
// contract. Each `describe` block maps to one of the seven non-negotiable
// bars; the assertions are the evidence those bars hold for the real tool
// surface (buildTools/buildResources), not a mock.

import { describe, expect, it } from 'vitest';

import { ENNIO_CONTRACT_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from './protocol';
import { err, isErrorResult, ok } from './result';
import { buildResources } from './resources';
import { SELECTOR_SCHEMA } from './selectors';
import { EnnioMcpSession } from './session';
import { buildTools } from './tools';
import type { ToolDef } from './server';

// A session can be constructed offline (no device); the read handlers and
// every tool definition are available without attaching.
const session = new EnnioMcpSession();
const tools = buildTools(session);
const byName = (n: string): ToolDef => {
  const t = tools.find((x) => x.name === n);
  if (!t) throw new Error(`missing tool ${n}`);
  return t;
};

const SELECTOR_TOOLS = [
  'ennio_tap',
  'ennio_double_tap',
  'ennio_long_press',
  'ennio_find',
  'ennio_assert_visible',
  'ennio_wait_for',
];
const READ_TOOLS = [
  'ennio_status',
  'ennio_describe',
  'ennio_find',
  'ennio_screenshot',
  'ennio_assert_visible',
  'ennio_wait_for',
];
const MUTATING_TOOLS = [
  'ennio_launch_app',
  'ennio_stop_app',
  'ennio_tap',
  'ennio_double_tap',
  'ennio_long_press',
  'ennio_input_text',
  'ennio_erase_text',
  'ennio_swipe',
  'ennio_scroll',
  'ennio_set_animations',
  'ennio_back',
  'ennio_handle_alert',
  'ennio_tap_tab',
  'ennio_scroll_until_visible',
];

describe('bar 1 — self-describing tools', () => {
  it('every tool is namespaced ennio_<verb>, uniquely', () => {
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length); // no collisions
    for (const n of names) expect(n).toMatch(/^ennio_[a-z][a-z_]*$/);
  });

  it('every tool has a routable description and an object input schema', () => {
    for (const t of tools) {
      expect(t.description.length, t.name).toBeGreaterThan(30);
      expect((t.inputSchema as { type?: string }).type, t.name).toBe('object');
    }
  });

  it('every tool that requires arguments carries an inline example', () => {
    for (const t of tools) {
      const required = (t.inputSchema as { required?: string[] }).required ?? [];
      if (required.length > 0) {
        expect(t.description, `${t.name} should show an example`).toMatch(/\{.*\}/);
      }
    }
  });
});

describe('bar 2 — structured results, always', () => {
  it('ok/err produce the stable envelope shape', () => {
    expect(ok({ a: 1 })).toEqual({ ok: true, data: { a: 1 } });
    expect(err('timeout', 'x')).toEqual({ ok: false, error: { kind: 'timeout', message: 'x' } });
  });

  it('not_found is a normal answer, not an error turn', () => {
    expect(isErrorResult(err('not_found', 'gone'))).toBe(false);
    for (const k of ['timeout', 'invalid', 'infra'] as const) {
      expect(isErrorResult(err(k, 'x'))).toBe(true);
    }
  });
});

describe('bar 3 — one coordinate + selector model', () => {
  it('all selector tools share the single SELECTOR_SCHEMA', () => {
    for (const n of SELECTOR_TOOLS) {
      const props = (byName(n).inputSchema as { properties?: { selector?: unknown } }).properties;
      expect(props?.selector, n).toBe(SELECTOR_SCHEMA);
    }
  });

  it('the selector model is exactly { testID | text | point }, point normalized [0,1]', () => {
    const props = SELECTOR_SCHEMA.properties;
    expect(Object.keys(props).sort()).toEqual(['point', 'testID', 'text']);
    expect(props.point.properties.x).toMatchObject({ minimum: 0, maximum: 1 });
    expect(props.point.properties.y).toMatchObject({ minimum: 0, maximum: 1 });
  });
});

describe('bar 4 — transparent app view', () => {
  it('ennio_describe is a first-class read', () => {
    expect(byName('ennio_describe').readOnly).toBe(true);
  });
  it('ennio_find exposes precise geometry for a selector', () => {
    expect(byName('ennio_find').readOnly).toBe(true);
  });
});

describe('bar 5 — capability negotiation', () => {
  it('ennio_status reports protocol, contract, platform, and capabilities', () => {
    const res = byName('ennio_status').handler({});
    expect('ok' in res && res.ok).toBe(true);
    const data = (res as { data: Record<string, unknown> }).data;
    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain(data.protocolVersion);
    expect(data.contractVersion).toBe(ENNIO_CONTRACT_VERSION);
    expect(data.platform).toMatch(/ios|android/);
    expect(data.capabilities).toMatchObject({
      attach: expect.any(String),
      actuation: expect.any(String),
      crossProcessAx: expect.any(Boolean),
    });
  });
});

describe('bar 6 — deterministic + side-effect-honest', () => {
  it('read tools are flagged readOnly', () => {
    for (const n of READ_TOOLS) expect(byName(n).readOnly, n).toBe(true);
  });
  it('mutating tools are flagged not readOnly', () => {
    for (const n of MUTATING_TOOLS) expect(byName(n).readOnly, n).toBe(false);
  });
});

describe('bar 7 — versioned contract', () => {
  it('the contract version is semver', () => {
    expect(ENNIO_CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
  it('ennio_status surfaces both the contract and protocol versions', () => {
    const data = (byName('ennio_status').handler({}) as { data: Record<string, unknown> }).data;
    expect(data.contractVersion).toBe(ENNIO_CONTRACT_VERSION);
    expect(typeof data.protocolVersion).toBe('string');
  });
});

describe('bar 8 — the tool surface is snapshot-guarded', () => {
  // The honesty guard for the versioned contract. `ENNIO_CONTRACT_VERSION`
  // is hand-maintained, so nothing structural stops the catalog from
  // changing under a stale version. This snapshot pins the public surface
  // (every tool's name, side-effect flag, and argument keys). When it
  // fails you have changed the contract — update BOTH this map AND
  // `ENNIO_CONTRACT_VERSION` (minor = tool added, major = tool changed or
  // removed) in the same change, on purpose.
  it('matches the committed catalog', () => {
    const surface = Object.fromEntries(
      tools.map((t) => [
        t.name,
        {
          readOnly: t.readOnly,
          args: Object.keys(
            (t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
          ).sort(),
        },
      ]),
    );
    expect(surface).toEqual({
      ennio_status: { readOnly: true, args: [] },
      ennio_describe: { readOnly: true, args: [] },
      ennio_find: { readOnly: true, args: ['selector'] },
      ennio_screenshot: { readOnly: true, args: ['path'] },
      ennio_launch_app: { readOnly: false, args: ['bundleId', 'clearState'] },
      ennio_stop_app: { readOnly: false, args: [] },
      ennio_tap: { readOnly: false, args: ['selector'] },
      ennio_double_tap: { readOnly: false, args: ['selector'] },
      ennio_long_press: { readOnly: false, args: ['selector'] },
      ennio_input_text: { readOnly: false, args: ['text'] },
      ennio_erase_text: { readOnly: false, args: ['count'] },
      ennio_swipe: { readOnly: false, args: ['direction', 'durationMs', 'from', 'to'] },
      ennio_scroll: { readOnly: false, args: ['direction'] },
      ennio_set_animations: { readOnly: false, args: ['enabled'] },
      ennio_back: { readOnly: false, args: [] },
      ennio_assert_visible: { readOnly: true, args: ['selector', 'timeoutMs'] },
      ennio_wait_for: { readOnly: true, args: ['selector', 'timeoutMs'] },
      ennio_handle_alert: { readOnly: false, args: ['action', 'button'] },
      ennio_tap_tab: { readOnly: false, args: ['name'] },
      ennio_scroll_until_visible: {
        readOnly: false,
        args: ['direction', 'selector', 'timeoutMs'],
      },
    });
  });
});

describe('MCP surface — resources', () => {
  it('exposes the live read-only resources', () => {
    const uris = buildResources(session)
      .map((r) => r.uri)
      .sort();
    expect(uris).toEqual([
      'ennio://screen/hierarchy',
      'ennio://screen/screenshot',
      'ennio://session',
    ]);
    for (const r of buildResources(session)) {
      expect(r.name.length).toBeGreaterThan(0);
      expect(r.description.length).toBeGreaterThan(0);
      expect(r.mimeType).toMatch(/json|png/);
    }
  });
});
