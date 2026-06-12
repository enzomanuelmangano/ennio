/**
 * `ennio mcp` — expose ennio as a Model Context Protocol server over stdio.
 *
 * Any MCP client (Claude Code, Cursor, Cline, a custom agent) can drive a
 * device through the same runtime an `ennio test` run uses: the agent
 * decides actions, ennio finds, settles, and actuates them. Taps and
 * swipes go through the HID driver by default, so ennio is always in the
 * tap path.
 *
 * stdout carries only JSON-RPC — diagnostics go to stderr. The server runs
 * until stdin closes (the client disconnects).
 */

import type { Flags } from '../cli/args';
import { selectPlatform } from '../platform';

import { buildResources } from '../mcp/resources';
import { serveStdio } from '../mcp/serve';
import { McpServer } from '../mcp/server';
import { EnnioMcpSession } from '../mcp/session';
import { buildTools } from '../mcp/tools';
import { ENNIO_CONTRACT_VERSION } from '../mcp/protocol';
import { currentVersion } from '../update-check';

export async function runMcpCommand(_positional: string[], flags: Flags): Promise<number> {
  const platformName =
    flags.android || process.env.ENNIO_PLATFORM === 'android' ? 'android' : 'ios';

  // Touch visualization is ON by default — an agent driving the device
  // through MCP is exactly the case where a human wants to see what it
  // does. Disarmed at session close; --disable-touches opts out.
  process.env.ENNIO_SHOW_TOUCHES = flags.disableTouches ? '0' : '1';

  const session = new EnnioMcpSession({
    platform: selectPlatform(platformName),
    udid: process.env.ENNIO_UDID,
    dylibPath: process.env.ENNIO_DYLIB_PATH || undefined,
    inProcessTap: flags.inProcessTap ?? false,
  });

  const server = new McpServer({
    name: 'ennio',
    version: currentVersion(),
    tools: buildTools(session),
    resources: buildResources(session),
    instructions:
      `ennio MCP ${ENNIO_CONTRACT_VERSION}. Call ennio_status to negotiate capabilities, ` +
      'ennio_launch_app to attach to an app, then ennio_describe to read the screen and ' +
      'ennio_tap / ennio_swipe / ennio_input_text to drive it. Selectors take exactly one ' +
      'of testID, text, or a normalized [0,1] point; coordinates and rects are [0,1] ' +
      'fractions of the screen. Every result is { ok, data } or { ok, error: { kind, message } } — ' +
      'a not_found error is a normal answer, not a failure.',
  });

  process.stderr.write(`ennio mcp ${ENNIO_CONTRACT_VERSION} ready on stdio (${platformName})\n`);

  try {
    await serveStdio(server, process.stdin, process.stdout);
  } finally {
    await session.disableShowTouches();
    session.close();
  }
  return 0;
}
