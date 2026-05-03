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
  | { scrollUntilVisible: MaestroSelector | { element: MaestroSelector; direction?: string; timeout?: number } }
  | { swipe: { direction?: string; start?: string | { x: number; y: number }; end?: string | { x: number; y: number }; duration?: number } }
  | { longPress: MaestroSelector | string }
  | { back: true }
  | { runFlow: RunFlowCommand }
  | { waitFor: MaestroSelector & { timeout?: number } }
  | { assertAnyVisible: { anyOf: MaestroSelector[] } }
  | { launchApp: true | { clearState?: boolean; appId?: string } }
  | { clearState: true | { appId?: string } }
  | { stopApp: true | { appId?: string } }
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
  | { startRecording: string | { path: string } }
  | { stopRecording: true }
  | { addMedia: string[] | { files: string[] } }
  | { waitForAnimationToEnd: true | { timeout?: number } }
  | { extendedWaitUntil: { visible?: MaestroSelector; notVisible?: MaestroSelector; timeout?: number } };

export interface RunFlowCommand {
  file?: string;
  when?: MaestroCondition;
  commands?: MaestroCommand[];
}

export interface MaestroFlow {
  appId?: string;
  name?: string;
  tags?: string[];
  commands: MaestroCommand[];
  filePath: string;
}

// ============================================
// Parser
// ============================================

/**
 * Parse a Maestro YAML file
 */
export function parseMaestroFile(filePath: string): MaestroFlow {
  const absolutePath = resolve(filePath);
  const content = readFileSync(absolutePath, 'utf-8');

  // Maestro YAML uses --- to separate metadata from commands
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
    appId: metadata.appId as string | undefined,
    name: metadata.name as string | undefined,
    tags: metadata.tags as string[] | undefined,
    commands,
    filePath: absolutePath,
  };
}

/**
 * Normalize a selector - handle string shorthand
 */
export function normalizeSelector(selector: MaestroSelector | string): MaestroSelector {
  if (typeof selector === 'string') {
    return { id: selector };
  }
  return selector;
}

/**
 * Convert Maestro selector to Ennio selector format
 */
export function toEnnioSelector(selector: MaestroSelector): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  if (selector.id !== undefined) result.id = selector.id;

  // Handle text selector - Maestro uses regex patterns
  if (selector.text !== undefined) {
    // Check if it's a regex pattern (starts with .* or contains regex chars)
    if (
      selector.text.startsWith('.*') ||
      selector.text.endsWith('.*') ||
      /[\[\]{}()|\\^$+?]/.test(selector.text)
    ) {
      result.text = { pattern: selector.text, mode: 'regex' };
    } else {
      result.text = selector.text;
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
  expandedPaths = new Set<string>()
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
