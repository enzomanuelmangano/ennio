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
  /**
   * Explicit text match-mode escape hatches (ennio extension, Phase 1).
   * `regex: true` forces the `text` selector to be a pattern; `literal: true`
   * forces a literal substring even when the string carries metacharacters
   * (e.g. "Price: $5 (USD)"). When neither is set the mode is resolved by
   * `textMatchMode()` — see there for the transitional default. Mutually
   * exclusive; `literal` wins if both are set (the more conservative choice).
   */
  regex?: boolean;
  literal?: boolean;
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
  | { inputRandomPersonName: true | Record<string, never> };

export interface RunFlowCommand {
  file?: string;
  when?: MaestroCondition;
  commands?: MaestroCommand[];
  /** Per-call env passed down to the subflow's `${VAR}` interpolation,
   *  overriding the subflow's own `env:` defaults. The react-navigation
   *  e2e suite drives every deep link through `runFlow: { file: launch.yml,
   *  env: { LINK, TEXT } }`, so without this the link resolves to an empty
   *  `${LINK}` and the launch lands on the home screen. */
  env?: Record<string, string>;
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
  // Maestro YAML uses --- to separate metadata from commands. Parse the
  // documents RAW — parse-time env substitution is applied below to only the
  // metadata fields that are consumed before a runtime context exists. Command
  // bodies (and the hook command lists) keep their ${VAR} placeholders so the
  // runtime pass can resolve them with flowEnv / runFlow.env taking precedence
  // over process.env. Substituting them here would let a shell env var silently
  // shadow a per-flow override.
  const documents = parseYamlAll(content) as unknown[];

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
    // appId selects the bundle at run setup, before any command runs — it must
    // be a concrete value, so it resolves against process.env at parse time.
    appId: substituteEnv(metadata.appId) as string | undefined,
    name: metadata.name as string | undefined,
    tags: metadata.tags as string[] | undefined,
    // `env:` defaults may reference the shell env (e.g. BASE: ${HOST}); resolve
    // those here. Per-flow values still win at runtime because the command
    // bodies that read them are interpolated against flowEnv first.
    env: substituteEnv(metadata.env) as Record<string, string> | undefined,
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
 *
 * This is the legacy metacharacter SNIFF. It is fragile by construction: it
 * cannot tell "the user meant a pattern" from "the user typed a $" — see the
 * misfire cases in maestro-parser.test.ts. It is NO LONGER the default: the
 * `maestro` profile matches text as regex-by-default and never calls this. It
 * survives as the implementation of the `sniff` mode, selected only by the
 * `resilient` migration profile so existing ennio flows that relied on
 * auto-regex keep working. Removed once `resilient` is retired.
 */
export function isRegexText(text: string): boolean {
  return text.startsWith('.*') || text.endsWith('.*') || /[[\]{}()|\\^$+?]/.test(text);
}

export type TextMatchMode = 'literal' | 'regex';

/**
 * Resolve how a selector's `text` should be matched, in ONE place, so the
 * finder/visibility layers never re-decide it per call. Precedence:
 *   1. explicit `literal: true`  -> literal   (escape hatch, wins ties)
 *   2. explicit `regex: true`    -> regex     (escape hatch)
 *   3. otherwise                 -> the active profile's `defaultMode`
 *
 * `defaultMode` comes from the run's TuningProfile (`ctx.profile.textMatchDefault`):
 * `regex` (Maestro), `literal`, or `sniff` (resilient migration — the legacy
 * isRegexText heuristic). Defaults to `sniff` when omitted (device-free callers /
 * tests) so the parser-level contract is unchanged. Taken as a plain literal, not
 * the TuningProfile type, to keep the parser below the profile module in the
 * import graph.
 *
 * NOTE: whole-string anchoring under `regex` mode (Maestro anchors the full
 * string) is applied in the native finder and lands in Phase 6; today the
 * `regex` path is a partial match.
 */
export function textMatchMode(
  sel: Pick<MaestroSelector, 'text' | 'regex' | 'literal'>,
  defaultMode: 'sniff' | 'literal' | 'regex' = 'sniff',
): TextMatchMode {
  if (sel.literal) return 'literal';
  if (sel.regex) return 'regex';
  if (defaultMode === 'regex') return 'regex';
  if (defaultMode === 'literal') return 'literal';
  return sel.text && isRegexText(sel.text) ? 'regex' : 'literal';
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
