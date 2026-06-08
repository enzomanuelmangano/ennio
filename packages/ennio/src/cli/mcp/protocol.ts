// MCP wire protocol — JSON-RPC 2.0 over newline-delimited stdio.
//
// We speak MCP directly (no SDK) for three reasons that match the house
// style: zero runtime deps (the package ships only glob + js-yaml), full
// control over the contract we publish, and a transport small enough to
// conformance-test by hand. The stdio framing is one JSON object per line,
// UTF-8, no embedded newlines — exactly the MCP stdio transport spec.

/**
 * MCP protocol revisions this server understands. We answer `initialize`
 * with the client's requested version when it's one of these, else with
 * our preferred (first) entry — the standard negotiation handshake.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const PREFERRED_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

/**
 * The ennio MCP *contract* version — semver, independent of the MCP
 * protocol revision and of the npm package version. Bumped when the tool
 * surface or result shape changes. Reported by `ennio_status` so an agent
 * can reason about capabilities without sniffing tool names.
 */
export const ENNIO_CONTRACT_VERSION = '1.0.0';

export const JSONRPC_VERSION = '2.0';

// JSON-RPC 2.0 error codes (the standard set; -32000..-32099 are free for
// server use, which we don't currently need).
export const RpcError = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: typeof JSONRPC_VERSION;
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: typeof JSONRPC_VERSION;
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: typeof JSONRPC_VERSION;
  id: JsonRpcId;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

/** A request with no `id` is a notification — it gets no response. */
export function isNotification(msg: JsonRpcRequest): boolean {
  return msg.id === undefined;
}

export function success(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

export function failure(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcFailure {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    error: { code, message, ...(data !== undefined && { data }) },
  };
}
