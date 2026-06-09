// The MCP server: routes JSON-RPC messages to tools and resources, and
// frames the structured result envelope into MCP's content shape. Pure
// dispatch — no transport here (see serve.ts), so the whole protocol is
// testable by feeding messages to `handle()` and asserting the response.

import {
  failure,
  isNotification,
  PREFERRED_PROTOCOL_VERSION,
  RpcError,
  success,
  SUPPORTED_PROTOCOL_VERSIONS,
} from './protocol';
import type { JsonRpcRequest, JsonRpcResponse } from './protocol';
import { err, isErrorResult } from './result';
import type { EnnioResult } from './result';

// Hard ceiling on any single tool call. A dead socket, a missing element
// on the wrong screen, or a stuck animation must never hang the agent —
// past this the call returns a structured `timeout` and the agent adapts.
const TOOL_TIMEOUT_MS = Number(process.env.ENNIO_MCP_TOOL_TIMEOUT_MS) || 30_000;

function withDeadline(p: Promise<EnnioResult> | EnnioResult, name: string): Promise<EnnioResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: EnnioResult) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(r);
      }
    };
    const timer = setTimeout(
      () => done(err('timeout', `tool ${name} exceeded ${TOOL_TIMEOUT_MS}ms`)),
      TOOL_TIMEOUT_MS,
    );
    Promise.resolve(p).then(done, (e: unknown) =>
      done(err('infra', e instanceof Error ? e.message : String(e))),
    );
  });
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** True for tools that only read device/app state (no actuation). */
  readOnly: boolean;
  handler(args: Record<string, unknown>): Promise<EnnioResult> | EnnioResult;
}

export interface ResourceContent {
  text?: string;
  blob?: string; // base64
  mimeType?: string;
}

export interface ResourceDef {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  read(): Promise<ResourceContent> | ResourceContent;
}

export interface McpServerOptions {
  name: string;
  version: string;
  tools: ToolDef[];
  resources: ResourceDef[];
  instructions?: string;
}

export class McpServer {
  constructor(private readonly opts: McpServerOptions) {}

  /**
   * Handle one parsed JSON-RPC message. Returns the response, or null for
   * notifications (which the spec says get no reply). Never throws — a
   * handler fault becomes a JSON-RPC InternalError so the stream survives.
   */
  async handle(msg: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const id = msg.id ?? null;
    try {
      switch (msg.method) {
        case 'initialize':
          return success(id, this.initialize(msg.params));
        case 'notifications/initialized':
        case 'notifications/cancelled':
          return null; // notification, no response
        case 'ping':
          return success(id, {});
        case 'tools/list':
          return success(id, { tools: this.listTools() });
        case 'tools/call':
          return success(id, await this.callTool(msg.params));
        case 'resources/list':
          return success(id, { resources: this.listResources() });
        case 'resources/read':
          return success(id, await this.readResource(msg.params));
        default:
          if (isNotification(msg)) return null;
          return failure(id, RpcError.MethodNotFound, `unknown method: ${msg.method}`);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // Argument-shape problems are the caller's; everything else is ours.
      const code = /missing|invalid|unknown tool|unknown resource/i.test(message)
        ? RpcError.InvalidParams
        : RpcError.InternalError;
      return failure(id, code, message);
    }
  }

  private initialize(params: unknown): Record<string, unknown> {
    const requested = (params as { protocolVersion?: string } | undefined)?.protocolVersion;
    const protocolVersion =
      requested && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
        ? requested
        : PREFERRED_PROTOCOL_VERSION;
    return {
      protocolVersion,
      capabilities: {
        tools: { listChanged: false },
        resources: { listChanged: false },
      },
      serverInfo: { name: this.opts.name, version: this.opts.version },
      ...(this.opts.instructions && { instructions: this.opts.instructions }),
    };
  }

  private listTools(): unknown[] {
    return this.opts.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: { readOnlyHint: t.readOnly },
    }));
  }

  private async callTool(params: unknown): Promise<Record<string, unknown>> {
    const { name, arguments: args } = (params ?? {}) as {
      name?: string;
      arguments?: Record<string, unknown>;
    };
    if (!name) throw new Error('invalid params: tools/call requires a tool name');
    const tool = this.opts.tools.find((t) => t.name === name);
    if (!tool) throw new Error(`unknown tool: ${name}`);
    // Every tool is bounded: a handler that hangs becomes a structured
    // timeout, never a stuck agent.
    const result = await withDeadline(tool.handler(args ?? {}), name);
    // The envelope is the source of truth. We mirror it as text (so plain
    // MCP clients without structuredContent support still see everything)
    // and as structuredContent (for clients that parse it directly).
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      structuredContent: result,
      isError: isErrorResult(result),
    };
  }

  private listResources(): unknown[] {
    return this.opts.resources.map((r) => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType,
    }));
  }

  private async readResource(params: unknown): Promise<Record<string, unknown>> {
    const uri = (params as { uri?: string } | undefined)?.uri;
    if (!uri) throw new Error('invalid params: resources/read requires a uri');
    const resource = this.opts.resources.find((r) => r.uri === uri);
    if (!resource) throw new Error(`unknown resource: ${uri}`);
    const content = await resource.read();
    return {
      contents: [
        {
          uri,
          mimeType: content.mimeType ?? resource.mimeType,
          ...(content.text !== undefined && { text: content.text }),
          ...(content.blob !== undefined && { blob: content.blob }),
        },
      ],
    };
  }
}
