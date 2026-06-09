// stdio transport for the MCP server: read newline-delimited JSON-RPC from
// an input stream, write newline-delimited responses to an output stream.
// One JSON object per line, UTF-8, no embedded newlines — the MCP stdio
// spec. Kept separate from McpServer so the protocol logic stays
// transport-free and testable.

import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import { failure, RpcError } from './protocol';
import type { JsonRpcRequest } from './protocol';
import type { McpServer } from './server';

/**
 * Pump messages from `input` through `server`, writing replies to
 * `output`. Resolves when `input` closes (the client disconnected). A
 * line that won't parse gets a JSON-RPC ParseError reply rather than
 * crashing the loop.
 */
export function serveStdio(server: McpServer, input: Readable, output: Writable): Promise<void> {
  const write = (obj: unknown) => output.write(JSON.stringify(obj) + '\n');
  const rl = createInterface({ input, crlfDelay: Infinity });

  // Serialize handling so responses are emitted in request order even
  // when a handler awaits device I/O.
  let chain: Promise<void> = Promise.resolve();

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    chain = chain.then(async () => {
      let msg: JsonRpcRequest;
      try {
        msg = JSON.parse(trimmed) as JsonRpcRequest;
      } catch {
        write(failure(null, RpcError.ParseError, 'invalid JSON'));
        return;
      }
      const response = await server.handle(msg);
      if (response) write(response);
    });
  });

  return new Promise((resolve) => {
    rl.on('close', () => {
      void chain.then(resolve);
    });
  });
}
