// Stability: a tool that hangs must never hang the agent — it becomes a
// structured `timeout` after the deadline. Set a short ceiling before the
// module loads (the bound is read once at import).

import { describe, expect, it } from 'vitest';

import type { ToolDef } from './server';

// Bound is read once at import — set it before the module loads.
process.env.ENNIO_MCP_TOOL_TIMEOUT_MS = '80';
const { McpServer } = await import('./server');
const { ok } = await import('./result');

function server(): InstanceType<typeof McpServer> {
  const tools: ToolDef[] = [
    {
      name: 'ennio_hang',
      description: 'never resolves',
      inputSchema: { type: 'object', properties: {} },
      readOnly: true,
      handler: () => new Promise(() => {}), // never settles
    },
    {
      name: 'ennio_quick',
      description: 'resolves immediately',
      inputSchema: { type: 'object', properties: {} },
      readOnly: true,
      handler: () => ok({ fine: true }),
    },
  ];
  return new McpServer({ name: 'ennio', version: '0', tools, resources: [] });
}

describe('tool deadline', () => {
  it('turns a hanging tool into a structured timeout', async () => {
    const r = (await server().handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'ennio_hang', arguments: {} },
    })) as {
      result: { isError: boolean; structuredContent: { ok: boolean; error?: { kind: string } } };
    };
    expect(r.result.isError).toBe(true);
    expect(r.result.structuredContent.error?.kind).toBe('timeout');
  });

  it('does not penalize a fast tool', async () => {
    const r = (await server().handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'ennio_quick', arguments: {} },
    })) as { result: { isError: boolean } };
    expect(r.result.isError).toBe(false);
  });
});
