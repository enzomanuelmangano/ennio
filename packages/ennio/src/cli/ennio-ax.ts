// Cross-process accessibility — the missing half of discovery.
//
// The in-app dylib sees only its own process. System UI (permission
// sheets, the Photos picker, SpringBoard confirmations) lives elsewhere
// and is invisible to it. The `ennioax` host helper reads the booted
// device's iOS accessibility tree out of Simulator.app's macOS AX tree
// (see native-ax/ennioax.m) and returns elements with normalized [0,1]
// frames — the same space the in-house HID taps in.
//
// Used for: (1) auto-dismissing system sheets that float over the app
// and swallow touches, (2) asserting visibility of cross-process UI the
// in-app finder cannot reach.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { getActuator, getScreenSize, trace } from './hid';

export interface AxElement {
  role: string;
  label: string;
  id: string; // iOS testID, bridged from macOS AXIdentifier
  value: string;
  nx: number;
  ny: number;
  nw: number;
  nh: number;
  cx: number; // normalized center
  cy: number;
}
export interface AxTree {
  screen: { x: number; y: number; w: number; h: number };
  elements: AxElement[];
}

function findHelper(): string | null {
  const candidates = [
    process.env.ENNIO_AX_HELPER,
    '/tmp/ennio-build/ennioax',
    join(dirname(__dirname), 'prebuilt', 'ennioax'),
    join(dirname(__dirname), '..', 'prebuilt', 'ennioax'),
  ].filter(Boolean) as string[];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

/**
 * Pull the cross-process AX tree for the booted device. Returns null
 * when the helper is missing, Simulator.app isn't running, or the
 * process lacks Accessibility trust — all soft failures (the in-app
 * path stays the default; this is an augmentation).
 */
export function axTree(udid: string): AxTree | null {
  const helper = findHelper();
  if (!helper) return null;
  try {
    const r = spawnSync(helper, [udid], { encoding: 'utf8', timeout: 6000 });
    if (r.status !== 0 || !r.stdout) {
      trace(`ax: helper exit=${r.status} ${(r.stdout || '').slice(0, 80)}`);
      return null;
    }
    const data = JSON.parse(r.stdout) as AxTree & { error?: string };
    if (data.error) {
      trace(`ax: ${data.error}`);
      return null;
    }
    return data;
  } catch (e) {
    trace(`ax: ${(e as Error).message}`);
    return null;
  }
}

/** True if any cross-process element's label/value contains `text`. */
export function axHasText(udid: string, text: string): boolean {
  const tree = axTree(udid);
  if (!tree) return false;
  const needle = text.toLowerCase();
  return tree.elements.some(
    (e) => e.label.toLowerCase().includes(needle) || e.value.toLowerCase().includes(needle),
  );
}

/** Resolve a Maestro selector against the cross-process tree. */
export function axResolve(udid: string, sel: { id?: string; text?: string }): AxElement | null {
  const tree = axTree(udid);
  if (!tree) return null;
  if (sel.id) {
    const byId = tree.elements.find((e) => e.id === sel.id);
    if (byId) return byId;
  }
  if (sel.text) {
    // Exact label match. A loose `includes` is unsafe (this runs as a
    // fallback on every not-found tap; a wrong cross-process tap derails
    // the flow), so require an exact label AND an interactive element.
    const needle = sel.text.toLowerCase();
    // Highest confidence: a testID'd element carrying this exact label —
    // e.g. a pager tab rendered as an AXGeneric container (not a
    // Button), where the in-app finder returns only the inner Text
    // label's rect and a tap there misses the Pressable's onPress.
    const idd = tree.elements.find((e) => e.id && e.label.toLowerCase() === needle);
    if (idd) return idd;
    const btn = tree.elements.find(
      (e) => e.role.includes('Button') && e.label.toLowerCase() === needle,
    );
    if (btn) return btn;
  }
  return null;
}

/**
 * Tap a target that lives in cross-process UI the in-app finder can't
 * reach — a native bottom-sheet (BottomSheet.SheetViewController),
 * popover, or system layer. Matches by testID (bridged AXIdentifier) or
 * visible label, then taps its center via the in-house HID. Returns true
 * if it tapped.
 */
export async function axTapTarget(
  udid: string,
  sel: { id?: string; text?: string },
): Promise<boolean> {
  const el = axResolve(udid, sel);
  if (!el) return false;
  const { w, h } = await getScreenSize(udid);
  trace(`ax: cross-process tap "${el.id || el.label}" @ (${el.cx.toFixed(3)},${el.cy.toFixed(3)})`);
  await getActuator(udid).tap(el.cx * w, el.cy * h);
  return true;
}

// System-sheet buttons we treat as "proceed", most-specific first. A
// blocking permission/confirmation sheet is cleared by tapping the
// permissive option so the flow continues (matches what a user grants
// in an e2e run). English + Italian — sim locale varies.
const PROCEED_LABELS = [
  'Allow Full Access',
  'Consenti accesso completo',
  'Allow While Using App',
  'Allow Once',
  'Allow',
  'Consenti',
  'Open',
  'Apri',
  'OK',
  'Continue',
  'Continua',
];
// A sheet is only "system" if it pairs a proceed option with one of
// these — guards against tapping an app button that happens to say OK.
const SYSTEM_MARKERS = [
  "Don't Allow",
  'Non consentire',
  'Keep Add Only',
  'Limit Access',
  'Ask App Not to Track',
  'Select More Photos',
  'requesting',
  'would like',
  'access to',
];

/**
 * Detect a cross-process system sheet floating over the app and clear it
 * by tapping its permissive button via the in-house HID. Returns true
 * when something was tapped. No-op (false) when the AX helper is
 * unavailable or no recognizable sheet is present.
 */
export async function dismissSystemSheet(udid: string): Promise<boolean> {
  const tree = axTree(udid);
  if (!tree || !tree.elements.length) return false;
  const labels = tree.elements.map((e) => e.label);
  const looksSystem = SYSTEM_MARKERS.some((m) =>
    labels.some((l) => l.toLowerCase().includes(m.toLowerCase())),
  );
  if (!looksSystem) return false;

  for (const want of PROCEED_LABELS) {
    const btn = tree.elements.find(
      (e) =>
        (e.role === 'AXButton' || e.role.includes('Button')) &&
        e.label.toLowerCase() === want.toLowerCase(),
    );
    if (!btn) continue;
    const { w, h } = await getScreenSize(udid);
    const actuator = getActuator(udid);
    trace(
      `ax: dismiss system sheet via "${btn.label}" @ (${btn.cx.toFixed(3)},${btn.cy.toFixed(3)})`,
    );
    await actuator.tap(btn.cx * w, btn.cy * h);
    return true;
  }
  return false;
}
