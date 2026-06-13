// The ennio MCP tool catalog. Every tool is self-describing: a precise
// description with an inline example, a JSON Schema for its arguments, and
// a read-only flag so an agent knows which calls mutate the device. Tools
// are tool-agnostic by construction — they wrap the same runtime any
// `ennio test` run uses and return the same structured envelope, so any
// MCP client (Claude, Cursor, Cline, a hand-rolled one) drives them
// identically.
//
// Naming: `ennio_<verb>`. Reads (status/describe/screenshot/assert/wait)
// are pure; everything else actuates through the HID driver — ennio is the
// tap path, never a passthrough.

import type { MaestroCommand, MaestroSelector } from '../maestro-parser';
import { parseMaestroFile, parseMaestroString } from '../maestro-parser';
import { currentVersion } from '../update-check';
import type { MaskInput } from '../visual/capture';

import { ENNIO_CONTRACT_VERSION, PREFERRED_PROTOCOL_VERSION } from './protocol';
import { err, ok } from './result';
import type { EnnioResult } from './result';
import { SELECTOR_SCHEMA, toMaestroSelector } from './selectors';
import type { McpSelector } from './selectors';
import type { EnnioMcpSession } from './session';
import type { ToolDef } from './server';

const NO_ARGS = { type: 'object', properties: {}, additionalProperties: false } as const;

// Center-screen segments for a cardinal swipe, normalized [0,1]. A short
// drag across the middle of the screen — clear of the edges (and any
// pull-to-refresh zone at the very top) so the gesture reads as a pan.
const DIRECTION_SEGMENTS: Record<
  string,
  { from: { x: number; y: number }; to: { x: number; y: number } }
> = {
  UP: { from: { x: 0.5, y: 0.62 }, to: { x: 0.5, y: 0.38 } },
  DOWN: { from: { x: 0.5, y: 0.38 }, to: { x: 0.5, y: 0.62 } },
  LEFT: { from: { x: 0.62, y: 0.5 }, to: { x: 0.38, y: 0.5 } },
  RIGHT: { from: { x: 0.38, y: 0.5 }, to: { x: 0.62, y: 0.5 } },
};

/** Read + validate the `selector` arg, then dispatch a selector command. */
async function dispatchSelector(
  session: EnnioMcpSession,
  args: Record<string, unknown>,
  build: (sel: MaestroSelector) => MaestroCommand,
): Promise<EnnioResult> {
  const sel = toMaestroSelector(args.selector as McpSelector | undefined);
  if (!sel.ok) return sel;
  return session.dispatch(build(sel.data));
}

export function buildTools(session: EnnioMcpSession): ToolDef[] {
  return [
    {
      name: 'ennio_status',
      description:
        'Report device, attachment, and capability state. Pure read. Use first to ' +
        'negotiate what this server can do before driving the app. Returns the ennio ' +
        'contract version, the platform, whether an app is attached, and how taps are ' +
        'actuated (hid = real OS-level events).',
      inputSchema: NO_ARGS,
      readOnly: true,
      handler: () =>
        ok({
          // Versioned contract (semver) + the MCP protocol revision in play,
          // so an agent can negotiate before driving.
          protocolVersion: PREFERRED_PROTOCOL_VERSION,
          contractVersion: ENNIO_CONTRACT_VERSION,
          ennioVersion: currentVersion(),
          platform: session.platformName,
          attached: session.attached,
          dylibLoaded: session.attached,
          device: { udid: session.udid, bundleId: session.bundleId },
          capabilities: {
            attach: session.attachMode,
            actuation: session.actuation,
            crossProcessAx: session.crossProcessAx,
          },
        }),
    },
    {
      name: 'ennio_describe',
      description:
        'Return the on-screen element inventory: role, testID, text, and value for ' +
        'every targetable element. Pure read — this is how you see the app, instead ' +
        'of guessing from a screenshot. Pick an element here, then target it with ' +
        'ennio_tap by testID or text. For a precise normalized rect, use ennio_find.',
      inputSchema: NO_ARGS,
      readOnly: true,
      handler: () => session.describe(),
    },
    {
      name: 'ennio_find',
      description:
        'Resolve one element to its normalized [0,1] rect and tap center. Pure read. ' +
        'Use when you need exact coordinates (e.g. to reason spatially or tap a point). ' +
        'A not_found result is a normal answer. Example: ' +
        '{ "selector": { "text": "Following" } }.',
      inputSchema: {
        type: 'object',
        properties: { selector: SELECTOR_SCHEMA },
        required: ['selector'],
      },
      readOnly: true,
      handler: (args) => {
        const sel = toMaestroSelector(args.selector as McpSelector | undefined);
        if (!sel.ok) return sel;
        if (sel.data.point !== undefined) {
          return err('invalid', 'ennio_find takes a testID or text selector, not a point');
        }
        return session.find(sel.data);
      },
    },
    {
      name: 'ennio_screenshot',
      description:
        'Capture a PNG of the current screen to a file. Pure read. ' +
        'Example: { "path": "/tmp/ennio-shot.png" }.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Destination PNG path.' } },
        additionalProperties: false,
      },
      readOnly: true,
      handler: (args) => {
        const path = typeof args.path === 'string' && args.path ? args.path : '/tmp/ennio-shot.png';
        return session.screenshot(path);
      },
    },
    {
      name: 'ennio_launch_app',
      description:
        'Attach to an app, launching it with the ennio agent injected if it is not ' +
        'already running under ennio. This must be called before any actuation. ' +
        'Optionally wipe app state first. Example: ' +
        '{ "bundleId": "com.example.app", "clearState": true }.',
      inputSchema: {
        type: 'object',
        properties: {
          bundleId: { type: 'string', description: 'iOS bundle id / Android package name.' },
          clearState: { type: 'boolean', description: 'Wipe app data before launch.' },
        },
        required: ['bundleId'],
        additionalProperties: false,
      },
      readOnly: false,
      handler: async (args) => {
        const bundleId = args.bundleId;
        if (typeof bundleId !== 'string' || !bundleId) {
          return err('invalid', 'bundleId is required');
        }
        const attached = await session.attach(bundleId);
        if (!attached.ok) return attached;
        if (args.clearState === true) {
          const cleared = await session.dispatch({ clearState: true });
          if (!cleared.ok) return cleared;
        }
        return ok({ bundleId, udid: session.udid, attached: true });
      },
    },
    {
      name: 'ennio_stop_app',
      description: 'Terminate the attached app without wiping its data.',
      inputSchema: NO_ARGS,
      readOnly: false,
      handler: () => session.dispatch({ stopApp: true }),
    },
    {
      name: 'ennio_tap',
      description:
        'Tap an element. Actuated via the HID driver (a real touch). Example: ' +
        '{ "selector": { "testID": "submit-button" } } or ' +
        '{ "selector": { "point": { "x": 0.5, "y": 0.9 } } }.',
      inputSchema: {
        type: 'object',
        properties: { selector: SELECTOR_SCHEMA },
        required: ['selector'],
      },
      readOnly: false,
      handler: (args) => {
        const sel = toMaestroSelector(args.selector as McpSelector | undefined);
        if (!sel.ok) return sel;
        // A point tap needs no find/settle — take the fast HID path. testID
        // and text taps go through the full find pipeline (correct targeting).
        const p = (args.selector as McpSelector)?.point;
        if (p) return session.rawTap(p);
        return session.dispatch({ tapOn: sel.data });
      },
    },
    {
      name: 'ennio_double_tap',
      description: 'Double-tap an element. Example: { "selector": { "text": "Like" } }.',
      inputSchema: {
        type: 'object',
        properties: { selector: SELECTOR_SCHEMA },
        required: ['selector'],
      },
      readOnly: false,
      handler: (args) => dispatchSelector(session, args, (sel) => ({ doubleTapOn: sel })),
    },
    {
      name: 'ennio_long_press',
      description: 'Long-press an element. Example: { "selector": { "testID": "message-row" } }.',
      inputSchema: {
        type: 'object',
        properties: { selector: SELECTOR_SCHEMA },
        required: ['selector'],
      },
      readOnly: false,
      handler: (args) => dispatchSelector(session, args, (sel) => ({ longPressOn: sel })),
    },
    {
      name: 'ennio_input_text',
      description:
        'Type text into the focused field. Tap the field first to focus it. ' +
        'Example: { "text": "hello@example.com" }.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
      readOnly: false,
      handler: (args) => {
        if (typeof args.text !== 'string') return err('invalid', 'text must be a string');
        return session.dispatch({ inputText: args.text });
      },
    },
    {
      name: 'ennio_erase_text',
      description:
        'Erase characters from the focused field. Example: { "count": 5 }. ' +
        'Omit count to clear a typical field length.',
      inputSchema: {
        type: 'object',
        properties: { count: { type: 'integer', minimum: 1 } },
        additionalProperties: false,
      },
      readOnly: false,
      handler: (args) => {
        const count = typeof args.count === 'number' ? args.count : 50;
        return session.dispatch({ eraseText: count });
      },
    },
    {
      name: 'ennio_swipe',
      description:
        'Swipe, either by cardinal direction (from screen center) or between two ' +
        'normalized [0,1] points. This is also the move primitive for grid games. ' +
        'Examples: { "direction": "UP" } or ' +
        '{ "from": { "x": 0.5, "y": 0.7 }, "to": { "x": 0.5, "y": 0.3 }, "durationMs": 200 }.',
      inputSchema: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['UP', 'DOWN', 'LEFT', 'RIGHT'] },
          from: pointSchema(),
          to: pointSchema(),
          durationMs: { type: 'integer', minimum: 1 },
        },
        additionalProperties: false,
      },
      readOnly: false,
      handler: (args) => {
        const duration = typeof args.durationMs === 'number' ? args.durationMs : 120;
        if (typeof args.direction === 'string') {
          const seg = DIRECTION_SEGMENTS[args.direction.toUpperCase()];
          if (!seg) return err('invalid', 'direction must be UP, DOWN, LEFT, or RIGHT');
          return session.rawSwipe(seg.from, seg.to, duration);
        }
        const from = asPoint(args.from);
        const to = asPoint(args.to);
        if (!from || !to) {
          return err(
            'invalid',
            'swipe needs either a direction or both from and to points in [0,1]',
          );
        }
        return session.rawSwipe(from, to, duration);
      },
    },
    {
      name: 'ennio_scroll',
      description:
        'Scroll the view a fixed amount in a direction. Example: { "direction": "DOWN" }.',
      inputSchema: {
        type: 'object',
        properties: { direction: { type: 'string', enum: ['UP', 'DOWN', 'LEFT', 'RIGHT'] } },
        required: ['direction'],
        additionalProperties: false,
      },
      readOnly: false,
      handler: (args) => {
        if (typeof args.direction !== 'string') return err('invalid', 'direction is required');
        return session.dispatch({
          scroll: { direction: args.direction as 'UP' | 'DOWN' | 'LEFT' | 'RIGHT' },
        });
      },
    },
    {
      name: 'ennio_set_animations',
      description:
        'Enable or disable in-app animations at runtime. Disable for fast, ' +
        'deterministic runs (transitions snap to their final frame, so actions ' +
        'settle sooner); enable to observe animated UI. A coordinating agent can ' +
        'toggle this per task. Example: { "enabled": false }.',
      inputSchema: {
        type: 'object',
        properties: { enabled: { type: 'boolean', description: 'true = animations on.' } },
        required: ['enabled'],
        additionalProperties: false,
      },
      readOnly: false,
      handler: (args) => {
        if (typeof args.enabled !== 'boolean') return err('invalid', 'enabled must be a boolean');
        return session.setAnimations(args.enabled);
      },
    },
    {
      name: 'ennio_back',
      description: 'Navigate back (iOS nav pop / Android system back).',
      inputSchema: NO_ARGS,
      readOnly: false,
      handler: () => session.dispatch({ back: true }),
    },
    {
      name: 'ennio_assert_visible',
      description:
        'Check whether an element is visible, waiting up to timeoutMs for it. A ' +
        'not_found result is a normal answer, not a failure. Example: ' +
        '{ "selector": { "text": "Welcome" }, "timeoutMs": 3000 }.',
      inputSchema: {
        type: 'object',
        properties: { selector: SELECTOR_SCHEMA, timeoutMs: { type: 'integer', minimum: 0 } },
        required: ['selector'],
      },
      readOnly: true,
      handler: (args) =>
        dispatchSelector(session, args, (sel) => ({
          assertVisible: {
            ...sel,
            ...(typeof args.timeoutMs === 'number' && { timeout: args.timeoutMs }),
          },
        })),
    },
    {
      name: 'ennio_wait_for',
      description:
        'Wait until an element becomes visible, then settle. Use after an action that ' +
        'triggers a transition. Example: { "selector": { "testID": "home" }, "timeoutMs": 8000 }.',
      inputSchema: {
        type: 'object',
        properties: { selector: SELECTOR_SCHEMA, timeoutMs: { type: 'integer', minimum: 0 } },
        required: ['selector'],
      },
      readOnly: true,
      handler: (args) =>
        dispatchSelector(session, args, (sel) => ({
          waitFor: {
            ...sel,
            ...(typeof args.timeoutMs === 'number' && { timeout: args.timeoutMs }),
          },
        })),
    },
    {
      name: 'ennio_handle_alert',
      description:
        'Read or act on a native alert / permission dialog (UIAlertController). These ' +
        'live outside the RN view tree, so ennio_describe and ennio_tap cannot see or ' +
        'press them. action "info" reads the title + buttons (a pure read — { present: ' +
        'false } when none is up), "tap" presses a button by label, "dismiss" cancels. ' +
        'Example: { "action": "tap", "button": "Allow" }.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['info', 'tap', 'dismiss'] },
          button: {
            type: 'string',
            description: 'Button label to press (required for action=tap).',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      // info is a pure read, but tap/dismiss mutate — the tool as a whole actuates.
      readOnly: false,
      handler: (args) => {
        switch (args.action) {
          case 'info':
            return session.alertInfo();
          case 'dismiss':
            return session.alertDismiss();
          case 'tap':
            if (typeof args.button !== 'string' || !args.button) {
              return err('invalid', 'button is required for action=tap');
            }
            return session.alertTap(args.button);
          default:
            return err('invalid', 'action must be one of: info, tap, dismiss');
        }
      },
    },
    {
      name: 'ennio_tap_tab',
      description:
        'Tap a tab-bar item by its label. Routed through the deterministic tab handler ' +
        '(not a coordinate tap), so persistent tab bars switch reliably. A { tapped: ' +
        'false } result is a clean miss (no such tab), not an error. ' +
        'Example: { "name": "Profile" }.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'The tab item label.' } },
        required: ['name'],
        additionalProperties: false,
      },
      readOnly: false,
      handler: (args) => {
        if (typeof args.name !== 'string' || !args.name) {
          return err('invalid', 'name must be a non-empty string');
        }
        return session.tapTab(args.name);
      },
    },
    {
      name: 'ennio_scroll_until_visible',
      description:
        'Scroll (swipe repeatedly) until an element is visible, then settle. Target by ' +
        'testID or text — not a point. Optional direction (default DOWN) and timeoutMs. ' +
        'Example: { "selector": { "text": "Log out" }, "direction": "DOWN" }.',
      inputSchema: {
        type: 'object',
        properties: {
          selector: SELECTOR_SCHEMA,
          direction: { type: 'string', enum: ['UP', 'DOWN', 'LEFT', 'RIGHT'] },
          timeoutMs: { type: 'integer', minimum: 0 },
        },
        required: ['selector'],
      },
      readOnly: false,
      handler: (args) => {
        const sel = toMaestroSelector(args.selector as McpSelector | undefined);
        if (!sel.ok) return sel;
        if (sel.data.point !== undefined) {
          return err(
            'invalid',
            'ennio_scroll_until_visible takes a testID or text selector, not a point',
          );
        }
        return session.dispatch({
          scrollUntilVisible: {
            element: sel.data,
            ...(typeof args.direction === 'string' && { direction: args.direction }),
            ...(typeof args.timeoutMs === 'number' && { timeout: args.timeoutMs }),
          },
        });
      },
    },
    {
      name: 'ennio_run_flow',
      description:
        'Run a whole Maestro flow (inline YAML or a file path) against the attached app, ' +
        'and return a structured per-step result with failure context — which step ' +
        'failed, why, and a diagnostic screenshot path. Compose a flow, run it, and on ' +
        'failure read the reason to iterate. A failed flow is a normal answer ' +
        '(passed: false), not an error. appId defaults to the attached app. ' +
        'Example: { "yaml": "- tapOn: Login\\n- assertVisible: Home" }.',
      inputSchema: {
        type: 'object',
        properties: {
          yaml: {
            type: 'string',
            description: 'Inline Maestro YAML (a command list, with optional --- metadata).',
          },
          path: {
            type: 'string',
            description: 'Path to a .yaml flow file (alternative to yaml — provide exactly one).',
          },
        },
        additionalProperties: false,
      },
      readOnly: false,
      handler: (args) => {
        const hasYaml = typeof args.yaml === 'string' && args.yaml.length > 0;
        const hasPath = typeof args.path === 'string' && args.path.length > 0;
        if (hasYaml === hasPath) {
          return err('invalid', 'provide exactly one of: yaml, path');
        }
        let flow;
        try {
          flow = hasYaml
            ? parseMaestroString(args.yaml as string)
            : parseMaestroFile(args.path as string);
        } catch (e) {
          return err('invalid', `flow parse failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        return session.runFlow(flow);
      },
    },
    {
      name: 'ennio_match_screen',
      description:
        'Compare the current screen against a reference PNG and return a DETERMINISTIC ' +
        'match score — no model, an anti-aliasing-aware pixel diff. matchRatio is in ' +
        '[0,1]; passed reflects the threshold (default 0.97). A below-threshold result ' +
        'is a normal answer, not an error. mask ignores dynamic regions (element ' +
        'testIDs or normalized [0,1] rects). Optionally writes a diff heatmap PNG that ' +
        'shows where they differ. The reference is just an image — a design export, a ' +
        'mock, or a prior baseline. Example: ' +
        '{ "reference": "/tmp/checkout.png", "threshold": 0.97, "mask": ["clock-label"] }.',
      inputSchema: {
        type: 'object',
        properties: {
          reference: { type: 'string', description: 'Path to the reference PNG.' },
          threshold: {
            type: 'number',
            minimum: 0,
            maximum: 1,
            description: 'Minimum matchRatio to pass. Default 0.97.',
          },
          mask: {
            type: 'array',
            description:
              'Regions to ignore before diffing: element testIDs (strings) or ' +
              'normalized [0,1] rects { x, y, w, h }.',
          },
          output: { type: 'string', description: 'Path to write the diff heatmap PNG.' },
        },
        required: ['reference'],
        additionalProperties: false,
      },
      // Reads the screen + computes a score; no device actuation.
      readOnly: true,
      handler: (args) => {
        if (typeof args.reference !== 'string' || !args.reference) {
          return err('invalid', 'reference (PNG path) is required');
        }
        return session.matchScreen({
          reference: args.reference,
          ...(typeof args.threshold === 'number' && { threshold: args.threshold }),
          ...(Array.isArray(args.mask) && { mask: args.mask as MaskInput[] }),
          ...(typeof args.output === 'string' && { output: args.output }),
        });
      },
    },
  ];
}

function pointSchema() {
  return {
    type: 'object',
    properties: {
      x: { type: 'number', minimum: 0, maximum: 1 },
      y: { type: 'number', minimum: 0, maximum: 1 },
    },
    required: ['x', 'y'],
  } as const;
}

function asPoint(v: unknown): { x: number; y: number } | null {
  if (!v || typeof v !== 'object') return null;
  const p = v as { x?: unknown; y?: unknown };
  if (typeof p.x !== 'number' || typeof p.y !== 'number') return null;
  if (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) return null;
  return { x: p.x, y: p.y };
}
