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

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
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

// Persistent ennioax process per UDID. Spawned once, armed once, fed
// "dump" lines over stdin — amortizes the spawn + AXEnhancedUserInterface
// re-arm + bridge settle that a per-call spawnSync paid every time
// (~870ms → ~310ms/dump measured).
class AxHelperProcess {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<boolean> | null = null;
  private buf = '';
  private waiters: ((line: string) => void)[] = [];
  constructor(
    private readonly udid: string,
    private readonly helper: string,
  ) {}

  private start(): Promise<boolean> {
    if (this.ready) return this.ready;
    this.ready = new Promise<boolean>((resolve) => {
      const proc = spawn(this.helper, [this.udid, '--persistent']);
      this.proc = proc;
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (c: string) => this.onData(c));
      proc.on('error', () => resolve(false));
      proc.on('exit', () => {
        this.proc = null;
        this.ready = null;
      });
      // First line is "ready" (armed) or an {"error":...} JSON.
      this.waiters.push((line) => resolve(line.trim() === 'ready'));
    });
    return this.ready;
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      const w = this.waiters.shift();
      if (w) w(line);
    }
  }

  async dump(): Promise<string | null> {
    const ok = await this.start().catch(() => false);
    const proc = this.proc;
    if (!ok || !proc) return null;
    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 6000);
      this.waiters.push((line) => {
        clearTimeout(timer);
        resolve(line);
      });
      proc.stdin.write('dump\n');
    });
  }

  close(): void {
    if (this.proc) {
      try {
        this.proc.stdin.write('quit\n');
      } catch {
        /* ignore */
      }
      this.proc.kill();
      this.proc = null;
      this.ready = null;
    }
  }
}

const axHelpers = new Map<string, AxHelperProcess>();

/** Tear down every persistent ennioax process (CLI teardown). */
export function shutdownAxHelpers(): void {
  for (const h of axHelpers.values()) h.close();
  axHelpers.clear();
}
// 'exit' covers natural teardown; signal handlers must re-exit
// explicitly (registering one disables Node's default kill).
process.on('exit', () => shutdownAxHelpers());
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    shutdownAxHelpers();
    process.exit(sig === 'SIGINT' ? 130 : 143);
  });
}

/**
 * Pull the cross-process AX tree for the booted device. Returns null
 * when the helper is missing, Simulator.app isn't running, or the
 * process lacks Accessibility trust — all soft failures (the in-app
 * path stays the default; this is an augmentation). Backed by a
 * persistent ennioax process (spawn + arm paid once).
 */
// Cross-process AX going blind is a CAPABILITY loss, not an error — a
// headless sim (no Simulator.app window) or missing Accessibility trust
// degrades silently: system permission dialogs become undismissable and
// flows fail later with a generic "element not found". Say it ONCE, the
// first time the capability is actually consulted and comes back empty,
// so the eventual failure log carries its real cause.
let warnedBlind = false;
function warnBlindOnce(reason: string): void {
  if (warnedBlind) return;
  warnedBlind = true;
  process.stderr.write(
    `[ennio] cross-process AX unavailable (${reason}) — system permission ` +
      `dialogs (Photos, notifications, …) cannot be detected or dismissed. ` +
      `Open a Simulator.app window for this device (open -a Simulator) and ` +
      `ensure the terminal has Accessibility permission, or pre-grant the ` +
      `app's permissions so no dialog appears.\n`,
  );
}

export async function axTree(udid: string): Promise<AxTree | null> {
  const helper = findHelper();
  if (!helper) {
    warnBlindOnce('ennioax helper binary not found');
    return null;
  }
  let h = axHelpers.get(udid);
  if (!h) {
    h = new AxHelperProcess(udid, helper);
    axHelpers.set(udid, h);
  }
  try {
    const out = await h.dump();
    if (!out) return null;
    const data = JSON.parse(out) as AxTree & { error?: string };
    if (data.error) {
      trace(`ax: ${data.error}`);
      warnBlindOnce(data.error);
      return null;
    }
    if (!data.elements?.length) {
      warnBlindOnce('Simulator window not visible or Accessibility trust missing');
      return data;
    }
    return data;
  } catch (e) {
    trace(`ax: ${(e as Error).message}`);
    return null;
  }
}

/**
 * Tap the frontmost text field via cross-process AX to move keyboard
 * focus into it. Used when insert_text reports no first responder — a
 * composer/sheet whose input didn't auto-focus, where the in-app
 * recovery (re-tapping the button that OPENED the sheet) would toggle it
 * shut. Returns true if a field was tapped.
 */
export async function axFocusTextField(udid: string): Promise<boolean> {
  const tree = await axTree(udid);
  if (!tree) return false;
  // Large text inputs on screen (rich-text composer = AXTextArea/View,
  // plain field = AXTextField). Only act when there is EXACTLY ONE — an
  // unambiguous composer. A multi-field form (e.g. edit-profile's Display
  // name + Description) is ambiguous: tapping the wrong field routes the
  // input to the wrong place, so defer to the in-app focus path there.
  const fields = tree.elements.filter(
    (e) =>
      (e.role.includes('TextArea') ||
        e.role.includes('TextField') ||
        e.role.includes('TextView')) &&
      e.nw > 0.2, // a real input, not a tiny search/proxy box
  );
  if (fields.length !== 1) return false;
  const field = fields[0];
  const { w, h } = await getScreenSize(udid);
  trace(
    `ax: focus text field "${field.label || field.id}" @ (${field.cx.toFixed(3)},${field.cy.toFixed(3)})`,
  );
  await getActuator(udid).tap(field.cx * w, field.cy * h);
  return true;
}

/**
 * testID of the single on-screen text input, if it has one (Bluesky's
 * composer field is `composerTextInput`). Lets the caller focus it via
 * the IN-APP finder — an accurate, current rect — instead of the
 * cross-process AX position, which is stale while a sheet animates in.
 * Returns null when there isn't exactly one identified input.
 */
export async function axTextFieldId(udid: string): Promise<string | null> {
  const tree = await axTree(udid);
  if (!tree) return null;
  const fields = tree.elements.filter(
    (e) =>
      (e.role.includes('TextArea') ||
        e.role.includes('TextField') ||
        e.role.includes('TextView')) &&
      e.nw > 0.2 &&
      e.id,
  );
  return fields.length === 1 ? fields[0].id : null;
}

/** True if any cross-process element's label/value contains `text`. */
export async function axHasText(udid: string, text: string): Promise<boolean> {
  const tree = await axTree(udid);
  if (!tree) return false;
  const needle = text.toLowerCase();
  return tree.elements.some(
    (e) => e.label.toLowerCase().includes(needle) || e.value.toLowerCase().includes(needle),
  );
}

/** Resolve a Maestro selector against the cross-process tree. */
export async function axResolve(
  udid: string,
  sel: { id?: string; text?: string },
): Promise<AxElement | null> {
  const tree = await axTree(udid);
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
    // Interactive element with this exact label. Includes AXGeneric /
    // AXLink — native bottom-sheet menu rows (Bluesky's "Mute accounts"
    // / "Block accounts") render as AXGeneric with no testID, so a
    // Button-only match would miss them and the in-app tap mislands on an
    // adjacent row. Exclude AXStaticText so a bare label never matches.
    const interactive = tree.elements.filter(
      (e) =>
        !e.role.includes('StaticText') &&
        (e.role.includes('Button') ||
          e.role.includes('Generic') ||
          e.role.includes('Link') ||
          e.role.includes('Cell') ||
          e.role.includes('MenuItem')) &&
        e.label.toLowerCase() === needle,
    );
    // Only when unambiguous (exactly one match) — two rows sharing a
    // label would make the pick arbitrary.
    if (interactive.length === 1) return interactive[0];
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
  pollMs = 3000,
): Promise<boolean> {
  // Poll: a native overlay (image cropper, share sheet) opened by the
  // previous step may still be animating in when this runs — e.g. after
  // a permission sheet was just dismissed. Retry the AX read briefly so
  // it's caught once present, instead of giving up on a single miss.
  const deadline = Date.now() + pollMs;
  for (;;) {
    const el = await axResolve(udid, sel);
    if (el) {
      const { w, h } = await getScreenSize(udid);
      trace(
        `ax: cross-process tap "${el.id || el.label}" @ (${el.cx.toFixed(3)},${el.cy.toFixed(3)})`,
      );
      await getActuator(udid).tap(el.cx * w, el.cy * h);
      return true;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 300));
  }
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
  const tree = await axTree(udid);
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
