// Conformance: a generic MCP client driving the server with no ennio
// knowledge. Exercises the handshake, discovery, the result→content
// mapping (including the not_found-is-not-an-error rule), resources, and
// the JSON-RPC error paths.

import { describe, expect, it } from 'vitest';

import { PREFERRED_PROTOCOL_VERSION, RpcError } from './protocol';
import { err, ok } from './result';
import { McpServer } from './server';
import type { ToolDef, ResourceDef } from './server';

function testServer(): McpServer {
  const tools: ToolDef[] = [
    {
      name: 'read_tool',
      description: 'a read',
      inputSchema: { type: 'object', properties: {} },
      readOnly: true,
      handler: () => ok({ value: 42 }),
    },
    {
      name: 'act_tool',
      description: 'an action',
      inputSchema: { type: 'object', properties: { x: { type: 'number' } } },
      readOnly: false,
      handler: (args) => ok({ echoed: args.x }),
    },
    {
      name: 'missing_tool',
      description: 'returns not_found',
      inputSchema: { type: 'object', properties: {} },
      readOnly: true,
      handler: () => err('not_found', 'no element'),
    },
    {
      name: 'broken_tool',
      description: 'returns infra error',
      inputSchema: { type: 'object', properties: {} },
      readOnly: false,
      handler: () => err('infra', 'socket dead'),
    },
    {
      name: 'throwing_tool',
      description: 'throws',
      inputSchema: { type: 'object', properties: {} },
      readOnly: false,
      handler: () => {
        throw new Error('boom');
      },
    },
  ];
  const resources: ResourceDef[] = [
    {
      uri: 'ennio://session',
      name: 'Session',
      description: 'state',
      mimeType: 'application/json',
      read: () => ({ text: '{"attached":false}' }),
    },
  ];
  return new McpServer({ name: 'ennio', version: '9.9.9', tools, resources });
}

const req = (id: number | string, method: string, params?: unknown) => ({
  jsonrpc: '2.0' as const,
  id,
  method,
  params,
});

describe('initialize', () => {
  it('echoes a supported protocol version and advertises capabilities', async () => {
    const s = testServer();
    const r = await s.handle(req(1, 'initialize', { protocolVersion: '2025-03-26' }));
    expect(r).toMatchObject({
      id: 1,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: 'ennio', version: '9.9.9' },
      },
    });
  });

  it('falls back to the preferred version for an unknown request', async () => {
    const s = testServer();
    const r = await s.handle(req(1, 'initialize', { protocolVersion: '1999-01-01' }));
    expect((r as { result: { protocolVersion: string } }).result.protocolVersion).toBe(
      PREFERRED_PROTOCOL_VERSION,
    );
  });
});

describe('tools/list', () => {
  it('lists every tool with schema and a readOnly annotation', async () => {
    const s = testServer();
    const r = (await s.handle(req(2, 'tools/list'))) as { result: { tools: unknown[] } };
    const tools = r.result.tools as {
      name: string;
      inputSchema: unknown;
      annotations: { readOnlyHint: boolean };
    }[];
    expect(tools.map((t) => t.name)).toContain('read_tool');
    const read = tools.find((t) => t.name === 'read_tool')!;
    expect(read.annotations.readOnlyHint).toBe(true);
    expect(read.inputSchema).toBeTruthy();
    const act = tools.find((t) => t.name === 'act_tool')!;
    expect(act.annotations.readOnlyHint).toBe(false);
  });
});

describe('tools/call', () => {
  const call = (id: number, name: string, args?: unknown) =>
    testServer().handle(req(id, 'tools/call', { name, arguments: args }));

  it('returns the envelope as both text content and structuredContent', async () => {
    const r = (await call(3, 'act_tool', { x: 7 })) as { result: Record<string, unknown> };
    expect(r.result.structuredContent).toEqual({ ok: true, data: { echoed: 7 } });
    expect(r.result.isError).toBe(false);
    const content = r.result.content as { type: string; text: string }[];
    expect(JSON.parse(content[0].text)).toEqual({ ok: true, data: { echoed: 7 } });
  });

  it('does NOT flag not_found as an error turn', async () => {
    const r = (await call(4, 'missing_tool')) as {
      result: { isError: boolean; structuredContent: unknown };
    };
    expect(r.result.isError).toBe(false);
    expect(r.result.structuredContent).toEqual({
      ok: false,
      error: { kind: 'not_found', message: 'no element' },
    });
  });

  it('flags infra failures as an error turn', async () => {
    const r = (await call(5, 'broken_tool')) as { result: { isError: boolean } };
    expect(r.result.isError).toBe(true);
  });

  it('catches a thrown handler as an InternalError response', async () => {
    const r = (await call(6, 'throwing_tool')) as { error?: { code: number; message: string } };
    expect(r.error?.code).toBe(RpcError.InternalError);
    expect(r.error?.message).toBe('boom');
  });

  it('rejects an unknown tool with InvalidParams', async () => {
    const r = (await call(7, 'nope')) as { error?: { code: number } };
    expect(r.error?.code).toBe(RpcError.InvalidParams);
  });
});

describe('resources', () => {
  it('lists and reads a resource', async () => {
    const s = testServer();
    const list = (await s.handle(req(8, 'resources/list'))) as {
      result: { resources: { uri: string }[] };
    };
    expect(list.result.resources[0].uri).toBe('ennio://session');
    const read = (await s.handle(req(9, 'resources/read', { uri: 'ennio://session' }))) as {
      result: { contents: { uri: string; text: string; mimeType: string }[] };
    };
    expect(read.result.contents[0]).toMatchObject({
      uri: 'ennio://session',
      mimeType: 'application/json',
    });
    expect(JSON.parse(read.result.contents[0].text)).toEqual({ attached: false });
  });

  it('rejects an unknown resource uri', async () => {
    const s = testServer();
    const r = (await s.handle(req(10, 'resources/read', { uri: 'ennio://nope' }))) as {
      error?: { code: number };
    };
    expect(r.error?.code).toBe(RpcError.InvalidParams);
  });
});

describe('protocol housekeeping', () => {
  it('answers ping', async () => {
    const s = testServer();
    expect(await s.handle(req(11, 'ping'))).toEqual({ jsonrpc: '2.0', id: 11, result: {} });
  });

  it('returns null (no reply) for notifications', async () => {
    const s = testServer();
    expect(await s.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
  });

  it('returns MethodNotFound for an unknown request method', async () => {
    const s = testServer();
    const r = (await s.handle(req(12, 'bogus/method'))) as { error?: { code: number } };
    expect(r.error?.code).toBe(RpcError.MethodNotFound);
  });
});
