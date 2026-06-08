// MCP resources — addressable, re-readable views of the live session.
// These mirror the read-only tools but fit clients that prefer the
// resource model (subscribe-and-read) over tool calls. No prompts: ennio
// exposes data and actions, not conversation templates.

import { readFileSync } from 'node:fs';

import { ENNIO_CONTRACT_VERSION } from './protocol';
import type { EnnioMcpSession } from './session';
import type { ResourceDef } from './server';

export function buildResources(session: EnnioMcpSession): ResourceDef[] {
  return [
    {
      uri: 'ennio://screen/hierarchy',
      name: 'Screen hierarchy',
      description: 'The current on-screen interactable element tree (same data as ennio_describe).',
      mimeType: 'application/json',
      read: async () => ({ text: JSON.stringify(await session.describe(), null, 2) }),
    },
    {
      uri: 'ennio://screen/screenshot',
      name: 'Screenshot',
      description: 'A PNG capture of the current screen.',
      mimeType: 'image/png',
      read: () => {
        const path = '/tmp/ennio-mcp-shot.png';
        const shot = session.screenshot(path);
        if (!shot.ok) throw new Error(shot.error.message);
        return { blob: readFileSync(path).toString('base64'), mimeType: 'image/png' };
      },
    },
    {
      uri: 'ennio://session',
      name: 'Session',
      description: 'Device, attachment, and capability state (same data as ennio_status).',
      mimeType: 'application/json',
      read: () => ({
        text: JSON.stringify(
          {
            contractVersion: ENNIO_CONTRACT_VERSION,
            platform: session.platformName,
            attached: session.attached,
            device: { udid: session.udid, bundleId: session.bundleId },
            capabilities: {
              attach: session.attachMode,
              actuation: session.actuation,
              crossProcessAx: session.crossProcessAx,
            },
          },
          null,
          2,
        ),
      }),
    },
  ];
}
