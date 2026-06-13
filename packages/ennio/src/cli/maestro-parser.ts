/**
 * Maestro YAML Parser
 *
 * Parses Maestro YAML test files into executable commands.
 * Supports all Maestro selectors and commands with full parity.
 */

import { loadAll as parseYamlAll } from 'js-yaml';
import { readFileSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';

// ============================================
// Types
// ============================================

export interface MaestroSelector {
  id?: string;
  text?: string;
  /**
   * Maestro alias for text — accessibility label match. We treat it as
   * text-equivalent when forwarding to the writer/reader.
   */
  label?: string;
  /**
   * Maestro point selector. Accepts "X%,Y%" string or {x,y} as percentage
   * (0..100) or pixels. We carry the raw string here and resolve to
   * normalised screen coords inside the runner.
   */
  point?: string | { x: number | string; y: number | string };
  index?: number;
  enabled?: boolean;
  checked?: boolean;
  focused?: boolean;
  selected?: boolean;
  below?: MaestroSelector;
  above?: MaestroSelector;
  leftOf?: MaestroSelector;
  rightOf?: MaestroSelector;
  containsChild?: MaestroSelector;
  childOf?: MaestroSelector;
  containsDescendants?: MaestroSelector[];
  width?: number;
  height?: number;
  tolerance?: number;
  traits?: string[];
  /** Maestro: failure of this step does not fail the flow. */
  optional?: boolean;
  /** Maestro: skip the tap when the screen didn't change. ennio taps
   *  are idempotent via the driver, so this is accepted as a no-op. */
  retryTapIfNoChange?: boolean;
  /** Maestro: per-step settle budget hint. Accepted; ennio's settle is
   *  signal-driven, so this only caps, never extends. */
  waitToSettleTimeoutMs?: number;
}

export interface MaestroCondition {
  visible?: MaestroSelector;
  notVisible?: MaestroSelector;
}

export type MaestroCommand =
  | { tapOn: MaestroSelector | string }
  | { doubleTapOn: MaestroSelector | string }
  | { assertVisible: MaestroSelector & { timeout?: number; anyOf?: MaestroSelector[] } }
  | { assertNotVisible: MaestroSelector & { timeout?: number } }
  | { inputText: string }
  | { clearText: MaestroSelector | string }
  | { eraseText: number | { characters?: number } }
  | { scroll: { direction: 'UP' | 'DOWN' | 'LEFT' | 'RIGHT'; amount?: number } }
  | {
      scrollUntilVisible:
        | MaestroSelector
        | { element: MaestroSelector; direction?: string; timeout?: number };
    }
  | {
      swipe: {
        direction?: string;
        start?: string | { x: number; y: number };
        end?: string | { x: number; y: number };
        from?: MaestroSelector | string;
        duration?: number;
      };
    }
  | { longPress: MaestroSelector | string }
  | { longPressOn: MaestroSelector | string }
  | { back: true }
  | { runFlow: RunFlowCommand }
  | { waitFor: MaestroSelector & { timeout?: number } }
  | { assertAnyVisible: { anyOf: MaestroSelector[] } }
  | { launchApp: true | { clearState?: boolean; appId?: string } }
  | { clearState: true | { appId?: string } }
  | { stopApp: true | { appId?: string } }
  | { killApp: true | { appId?: string } }
  | { dismissAlert: true | Record<string, never> }
  | { clearKeychain: true | Record<string, never> }
  | { openLink: string | { link: string } }
  | { takeScreenshot: string | { path: string } }
  | { hideKeyboard: true }
  | { repeat: { times: number; commands: MaestroCommand[] } }
  | { retry: { maxRetries?: number; commands: MaestroCommand[] } }
  | { assertTrue: string }
  | { evalScript: string }
  | { runScript: { file: string; env?: Record<string, string> } }
  | { setLocation: { latitude: number; longitude: number } | string }
  | { setPermissions: Record<string, 'allow' | 'deny' | 'unset'> }
  | { setAirplaneMode: 'enabled' | 'disabled' | true | false }
  | { toggleAirplaneMode: true | Record<string, never> }
  | { travel: { points: ({ latitude: number; longitude: number } | string)[]; speed?: number } }
  | { startRecording: string | { path: string } }
  | { stopRecording: true }
  | { addMedia: string[] | { files: string[] } }
  | { waitForAnimationToEnd: true | { timeout?: number } }
  | {
      extendedWaitUntil: {
        visible?: MaestroSelector;
        notVisible?: MaestroSelector;
        timeout?: number;
      };
    }
  | { inputRandomEmail: true | Record<string, never> }
  | { inputRandomNumber: true | { length?: number } }
  | { inputRandomText: true | { length?: number } }
  | { inputRandomPersonName: true | Record<string, never> }
  | {
      // ennio extension: deterministic visual conformance. Compare the live
      // screen against a reference PNG (Figma export / mock / prior baseline);
      // fail when the match ratio is below `threshold`. `mask` ignores dynamic
      // regions (testID or normalized rect). Not a Maestro command.
      assertScreenMatches: {
        reference: string;
        threshold?: number;
        mask?: (string | { x: number; y: number; w: number; h: number })[];
        output?: string;
        overlay?: string;
        regions?: string;
        outputVar?: string;
      };
    }
  | {
      // Structural conformance: compare the live element tree against a
      // reference manifest (element set + positions). Fails on blocker/major
      // findings. Not a Maestro command.
      assertScreenConformance: {
        manifest: string;
        failOn?: 'blocker' | 'major' | 'minor';
        outputVar?: string;
      };
    };

export interface RunFlowCommand {
  file?: string;
  when?: MaestroCondition;
  commands?: MaestroCommand[];
}

export interface EnnioFlowConfig {
  /** When true, animations are restored for this flow even when the
   *  runner is started with --no-animations. Useful for flows that
   *  assert mid-animation state or test animation behaviour. */
  animations?: boolean;
}

export interface MaestroFlow {
  appId?: string;
  name?: string;
  tags?: string[];
  /**
   * Maestro top-level `env:` block — string values become available
   * inside YAML as `${KEY}` substitutions and are passed to runScript
   * commands as their default env.
   */
  env?: Record<string, string>;
  /**
   * Maestro lifecycle hooks. Run once per flow, before/after the main
   * command list. Failures inside `onFlowStart` abort the flow;
   * `onFlowComplete` runs in a finally — its failures are logged but
   * don't change the flow's pass/fail.
   */
  onFlowStart?: MaestroCommand[];
  onFlowComplete?: MaestroCommand[];
  commands: MaestroCommand[];
  filePath: string;
  /** ennio-specific metadata block. Ignored by Maestro. */
  ennio?: EnnioFlowConfig;
}

// ============================================
// Parser
// ============================================

/**
 * Substitute `${NAME}` env placeholders, Maestro-style: real Maestro
 * takes them from `-e NAME=value` / the shell; ennio reads
 * process.env. Resolution is parse-time and conservative — a name
 * with no env value is left untouched, so runtime interpolations
 * (`${output.x}`) and flow-local `env:` blocks keep working.
 */
const ENV_PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
function substituteEnv(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(ENV_PLACEHOLDER, (match, name: string) => {
      // Maestro resolves ${VAR} against the CLI-provided env; dynamic
      // lookup is intentional (the var name comes from the flow).
      // eslint-disable-next-line expo/no-dynamic-env-var
      const v = process.env[name];
      return v !== undefined ? v : match;
    });
  }
  if (Array.isArray(value)) return value.map(substituteEnv);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = substituteEnv(v);
    return out;
  }
  return value;
}

/**
 * Parse a Maestro YAML file
 */
export function parseMaestroFile(filePath: string): MaestroFlow {
  const absolutePath = resolve(filePath);
  const content = readFileSync(absolutePath, 'utf-8');
  return parseMaestroString(content, absolutePath);
}

/**
 * Parse Maestro YAML from a string — the file-less entry point used by the
 * MCP `ennio_run_flow` tool, where an agent supplies a flow inline.
 * `parseMaestroFile` is a thin reader over this. `filePath` is recorded on
 * the flow for error messages and `runFlow` subflow resolution; it defaults
 * to a synthetic path in the cwd for inline flows.
 */
export function parseMaestroString(
  content: string,
  filePath: string = resolve('mcp-inline.yaml'),
): MaestroFlow {
  // Maestro YAML uses --- to separate metadata from commands
  const documents = (parseYamlAll(content) as unknown[]).map(substituteEnv);

  let metadata: Record<string, unknown> = {};
  let commands: MaestroCommand[] = [];

  if (documents.length === 1) {
    // Single document - could be just commands or metadata + commands
    const doc = documents[0];
    if (Array.isArray(doc)) {
      commands = doc as MaestroCommand[];
    } else if (doc && typeof doc === 'object') {
      metadata = doc as Record<string, unknown>;
    }
  } else if (documents.length >= 2) {
    // First document is metadata, second is commands
    metadata = (documents[0] as Record<string, unknown>) || {};
    commands = (documents[1] as MaestroCommand[]) || [];
  }

  return {
    appId: metadata.appId as string | undefined,
    name: metadata.name as string | undefined,
    tags: metadata.tags as string[] | undefined,
    env: metadata.env as Record<string, string> | undefined,
    onFlowStart: metadata.onFlowStart as MaestroCommand[] | undefined,
    onFlowComplete: metadata.onFlowComplete as MaestroCommand[] | undefined,
    commands,
    filePath,
    ennio: metadata.ennio as EnnioFlowConfig | undefined,
  };
}

/**
 * Normalize a selector - handle string shorthand.
 * Maestro shorthand `tapOn: "Some String"` is a TEXT match (not id), so
 * the bare string becomes `{ text: str }`. The runner falls back to id
 * lookup if the text match fails.
 *
 * `label:` is a Maestro alias for `text:` (accessibility label) — fold it
 * into `text` so downstream selectors are simpler.
 */
export function normalizeSelector(selector: MaestroSelector | string): MaestroSelector {
  if (typeof selector === 'string') {
    return { text: selector };
  }
  if (selector.label && !selector.text) {
    const { label, ...rest } = selector;
    return { ...rest, text: label };
  }
  return selector;
}

/**
 * A Maestro text selector is a regex (not a literal substring) when it carries
 * regex metacharacters or explicit `.*` anchors — e.g. "users[,]? or feeds".
 * Used both to tag the native iOS selector and to flag Android find_* calls so
 * the in-app agent applies Pattern matching instead of a literal contains.
 */
export function isRegexText(text: string): boolean {
  return text.startsWith('.*') || text.endsWith('.*') || /[[\]{}()|\\^$+?]/.test(text);
}

/**
 * Convert Maestro selector to Ennio selector format
 */
export function toEnnioSelector(selector: MaestroSelector): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  if (selector.id !== undefined) result.id = selector.id;

  // Handle text selector - Maestro semantics: text matches as substring (or regex if it
  // contains regex metacharacters / explicit .* anchors). Plain text falls back to
  // 'contains' so e.g. text: "Wireless" matches "Wireless Headphones".
  // Use TextMatcher shape so client.selectorToJson serializes flat form expected by
  // the native SelectorParser ({ text, textMatchMode }).
  if (selector.text !== undefined) {
    if (isRegexText(selector.text)) {
      result.text = { pattern: selector.text, mode: 'regex' };
    } else {
      result.text = { pattern: selector.text, mode: 'contains' };
    }
  }

  if (selector.index !== undefined) result.index = selector.index;
  if (selector.enabled !== undefined) result.enabled = selector.enabled;
  if (selector.checked !== undefined) result.checked = selector.checked;
  if (selector.focused !== undefined) result.focused = selector.focused;
  if (selector.selected !== undefined) result.selected = selector.selected;

  // Spatial selectors (recursive)
  if (selector.below) result.below = toEnnioSelector(selector.below);
  if (selector.above) result.above = toEnnioSelector(selector.above);
  if (selector.leftOf) result.leftOf = toEnnioSelector(selector.leftOf);
  if (selector.rightOf) result.rightOf = toEnnioSelector(selector.rightOf);

  // Hierarchical selectors
  if (selector.containsChild) result.containsChild = toEnnioSelector(selector.containsChild);
  if (selector.childOf) result.childOf = toEnnioSelector(selector.childOf);
  if (selector.containsDescendants) {
    result.containsDescendants = selector.containsDescendants.map(toEnnioSelector);
  }

  // Dimension selectors
  if (selector.width !== undefined) result.width = selector.width;
  if (selector.height !== undefined) result.height = selector.height;
  if (selector.tolerance !== undefined) result.tolerance = selector.tolerance;

  // Trait selectors
  if (selector.traits) result.traits = selector.traits;

  return result;
}

/**
 * Resolve a subflow file path relative to the current flow
 */
export function resolveSubflowPath(currentFlowPath: string, subflowPath: string): string {
  const dir = dirname(currentFlowPath);
  return resolve(dir, subflowPath);
}

/**
 * Get all commands from a flow, including expanded subflows
 */
export function expandFlow(
  flow: MaestroFlow,
  expandedPaths = new Set<string>(),
): { commands: MaestroCommand[]; subflows: MaestroFlow[] } {
  // Prevent infinite recursion
  if (expandedPaths.has(flow.filePath)) {
    return { commands: [], subflows: [] };
  }
  expandedPaths.add(flow.filePath);

  const subflows: MaestroFlow[] = [];

  // Process commands and load any referenced subflows
  for (const cmd of flow.commands) {
    if ('runFlow' in cmd && cmd.runFlow.file) {
      const subflowPath = resolveSubflowPath(flow.filePath, cmd.runFlow.file);
      if (existsSync(subflowPath)) {
        const subflow = parseMaestroFile(subflowPath);
        subflows.push(subflow);
        // Recursively expand subflows
        const expanded = expandFlow(subflow, expandedPaths);
        subflows.push(...expanded.subflows);
      }
    }
  }

  return { commands: flow.commands, subflows };
}
