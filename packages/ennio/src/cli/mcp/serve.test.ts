// Transport conformance: newline-delimited framing, parse-error replies,
// notification silence, and in-order responses driven through real
// streams (the same path the stdio client uses).

import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { ok } from './result';
import { serveStdio } from './serve';
import { McpServer } from './server';
import type { ToolDef } from './server';

function server(): McpServer {
  const tools: ToolDef[] = [
    {
      name: 'echo',
      description: 'echo',
      inputSchema: { type: 'object', properties: { v: {} } },
      readOnly: true,
      handler: (args) => ok({ v: args.v }),
    },
  ];
  return new McpServer({ name: 'ennio', version: '0', tools, resources: [] });
}

/** Feed `lines` into the server and collect the response lines. */
async function exchange(lines: string[]): Promise<string[]> {
  const input = new PassThrough();
  const output = new PassThrough();
  const out: string[] = [];
  output.on('data', (chunk: Buffer) => {
    for (const l of chunk.toString('utf-8').split('\n')) if (l.trim()) out.push(l);
  });
  const done = serveStdio(server(), input, output);
  for (const l of lines) input.write(l + '\n');
  input.end();
  await done;
  return out;
}

describe('serveStdio', () => {
  it('frames each response as one JSON line', async () => {
    const out = await exchange([JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })]);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0])).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
  });

  it('replies to a malformed line with a ParseError and keeps going', async () => {
    const out = await exchange([
      '{ not json',
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
    ]);
    expect(JSON.parse(out[0]).error.code).toBe(-32700);
    expect(JSON.parse(out[1])).toMatchObject({ id: 2, result: {} });
  });

  it('emits no reply for a notification', async () => {
    const out = await exchange([
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    ]);
    expect(out).toHaveLength(0);
  });

  it('preserves request order', async () => {
    const out = await exchange([
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'a',
        method: 'tools/call',
        params: { name: 'echo', arguments: { v: 1 } },
      }),
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'b',
        method: 'tools/call',
        params: { name: 'echo', arguments: { v: 2 } },
      }),
    ]);
    expect(JSON.parse(out[0]).id).toBe('a');
    expect(JSON.parse(out[1]).id).toBe('b');
  });
});
