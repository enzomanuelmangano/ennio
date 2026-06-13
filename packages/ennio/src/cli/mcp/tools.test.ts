// Handler behavior for the Wave-1 wrap tools (handle_alert, tap_tab,
// scroll_until_visible). These exercise the REAL buildTools handlers
// against a fake session that records what it was asked to do — so the
// routing, argument validation, and command shaping are pinned, with no
// device attached.

import { describe, expect, it, vi } from 'vitest';

import { ok } from './result';
import type { EnnioResult } from './result';
import type { EnnioMcpSession } from './session';
import { buildTools } from './tools';
import type { ToolDef } from './server';

/** A session stub: every method is a spy returning a canned envelope. */
function fakeSession() {
  return {
    alertInfo: vi.fn(
      async (): Promise<EnnioResult> => ok({ present: false, text: '', buttons: [] }),
    ),
    alertTap: vi.fn(async (): Promise<EnnioResult> => ok({ tapped: true })),
    alertDismiss: vi.fn(async (): Promise<EnnioResult> => ok({ dismissed: true })),
    tapTab: vi.fn(async (): Promise<EnnioResult> => ok({ tapped: false })),
    dispatch: vi.fn(async (): Promise<EnnioResult> => ok({ command: 'scrollUntilVisible' })),
    runFlow: vi.fn(
      // typed param so mock.calls[0][0] is `unknown`, not an empty tuple
      async (_flow: unknown): Promise<EnnioResult> =>
        ok({ passed: true, stepsRun: 2, stepsPassed: 2, durationMs: 1, steps: [] }),
    ),
    matchScreen: vi.fn(
      async (_opts: unknown): Promise<EnnioResult> => ok({ matchRatio: 1, passed: true }),
    ),
  };
}

function toolsFor(stub: ReturnType<typeof fakeSession>): {
  byName: (n: string) => ToolDef;
  stub: ReturnType<typeof fakeSession>;
} {
  const tools = buildTools(stub as unknown as EnnioMcpSession);
  return {
    stub,
    byName: (n) => {
      const t = tools.find((x) => x.name === n);
      if (!t) throw new Error(`missing tool ${n}`);
      return t;
    },
  };
}

describe('ennio_handle_alert', () => {
  it('routes each action to the matching session method', async () => {
    const { byName, stub } = toolsFor(fakeSession());
    const tool = byName('ennio_handle_alert');

    await tool.handler({ action: 'info' });
    expect(stub.alertInfo).toHaveBeenCalledOnce();

    await tool.handler({ action: 'tap', button: 'Allow' });
    expect(stub.alertTap).toHaveBeenCalledWith('Allow');

    await tool.handler({ action: 'dismiss' });
    expect(stub.alertDismiss).toHaveBeenCalledOnce();
  });

  it('rejects action=tap without a button', async () => {
    const { byName, stub } = toolsFor(fakeSession());
    const res = await byName('ennio_handle_alert').handler({ action: 'tap' });
    expect(res).toEqual({ ok: false, error: { kind: 'invalid', message: expect.any(String) } });
    expect(stub.alertTap).not.toHaveBeenCalled();
  });

  it('rejects an unknown action', async () => {
    const { byName } = toolsFor(fakeSession());
    const res = await byName('ennio_handle_alert').handler({ action: 'nope' });
    expect(res).toMatchObject({ ok: false, error: { kind: 'invalid' } });
  });

  it('treats { present: false } as a normal (non-error) answer', async () => {
    const { byName } = toolsFor(fakeSession());
    const res = await byName('ennio_handle_alert').handler({ action: 'info' });
    expect(res).toEqual({ ok: true, data: { present: false, text: '', buttons: [] } });
  });
});

describe('ennio_tap_tab', () => {
  it('passes the tab name through; { tapped: false } stays a clean ok', async () => {
    const { byName, stub } = toolsFor(fakeSession());
    const res = await byName('ennio_tap_tab').handler({ name: 'Profile' });
    expect(stub.tapTab).toHaveBeenCalledWith('Profile');
    expect(res).toEqual({ ok: true, data: { tapped: false } });
  });

  it('rejects an empty name', async () => {
    const { byName, stub } = toolsFor(fakeSession());
    const res = await byName('ennio_tap_tab').handler({ name: '' });
    expect(res).toMatchObject({ ok: false, error: { kind: 'invalid' } });
    expect(stub.tapTab).not.toHaveBeenCalled();
  });
});

describe('ennio_scroll_until_visible', () => {
  it('builds a scrollUntilVisible command with element + direction + timeout', async () => {
    const { byName, stub } = toolsFor(fakeSession());
    await byName('ennio_scroll_until_visible').handler({
      selector: { text: 'Log out' },
      direction: 'DOWN',
      timeoutMs: 5000,
    });
    expect(stub.dispatch).toHaveBeenCalledWith({
      scrollUntilVisible: { element: { text: 'Log out' }, direction: 'DOWN', timeout: 5000 },
    });
  });

  it('omits direction/timeout when not given', async () => {
    const { byName, stub } = toolsFor(fakeSession());
    await byName('ennio_scroll_until_visible').handler({ selector: { testID: 'logout-btn' } });
    expect(stub.dispatch).toHaveBeenCalledWith({
      scrollUntilVisible: { element: { id: 'logout-btn' } },
    });
  });

  it('rejects a point selector (you scroll to a testID/text, not a point)', async () => {
    const { byName, stub } = toolsFor(fakeSession());
    const res = await byName('ennio_scroll_until_visible').handler({
      selector: { point: { x: 0.5, y: 0.5 } },
    });
    expect(res).toMatchObject({ ok: false, error: { kind: 'invalid' } });
    expect(stub.dispatch).not.toHaveBeenCalled();
  });
});

describe('ennio_run_flow', () => {
  it('parses inline YAML and runs it; passes the parsed flow to the session', async () => {
    const { byName, stub } = toolsFor(fakeSession());
    const res = await byName('ennio_run_flow').handler({
      yaml: '- tapOn: Login\n- assertVisible: Home',
    });
    expect(stub.runFlow).toHaveBeenCalledOnce();
    const flow = stub.runFlow.mock.calls[0][0] as { commands: unknown[] };
    expect(flow.commands).toHaveLength(2);
    expect(res).toMatchObject({ ok: true, data: { passed: true } });
  });

  it('rejects when both yaml and path are given', async () => {
    const { byName, stub } = toolsFor(fakeSession());
    const res = await byName('ennio_run_flow').handler({ yaml: '- back', path: '/tmp/f.yaml' });
    expect(res).toMatchObject({ ok: false, error: { kind: 'invalid' } });
    expect(stub.runFlow).not.toHaveBeenCalled();
  });

  it('rejects when neither yaml nor path is given', async () => {
    const { byName } = toolsFor(fakeSession());
    const res = await byName('ennio_run_flow').handler({});
    expect(res).toMatchObject({ ok: false, error: { kind: 'invalid' } });
  });

  it('reports a parse failure as invalid, not infra', async () => {
    const { byName, stub } = toolsFor(fakeSession());
    const res = await byName('ennio_run_flow').handler({ yaml: '- tapOn: [unterminated' });
    expect(res).toMatchObject({ ok: false, error: { kind: 'invalid' } });
    expect(stub.runFlow).not.toHaveBeenCalled();
  });
});

describe('ennio_match_screen', () => {
  it('passes reference + options through to the session', async () => {
    const { byName, stub } = toolsFor(fakeSession());
    const res = await byName('ennio_match_screen').handler({
      reference: '/tmp/ref.png',
      threshold: 0.95,
      mask: ['clock', { x: 0, y: 0, w: 1, h: 0.05 }],
      output: '/tmp/diff.png',
    });
    expect(stub.matchScreen).toHaveBeenCalledWith({
      reference: '/tmp/ref.png',
      threshold: 0.95,
      mask: ['clock', { x: 0, y: 0, w: 1, h: 0.05 }],
      output: '/tmp/diff.png',
    });
    expect(res).toMatchObject({ ok: true, data: { passed: true } });
  });

  it('requires a reference path', async () => {
    const { byName, stub } = toolsFor(fakeSession());
    const res = await byName('ennio_match_screen').handler({});
    expect(res).toMatchObject({ ok: false, error: { kind: 'invalid' } });
    expect(stub.matchScreen).not.toHaveBeenCalled();
  });

  it('is a read-only tool', () => {
    const { byName } = toolsFor(fakeSession());
    expect(byName('ennio_match_screen').readOnly).toBe(true);
  });
});
