// Capability registry — the single, documented, overridable home for the
// platform facts ennio keys resilience behavior off.
//
// These were previously scattered inline as `cls.includes('PHPicker')` style
// allowlists across tap / lifecycle / input, with comments tying them to
// specific test fixtures (Bluesky's composer, an avatar cropper). That made the
// resilience invisible to anyone with a different app and overfit to those
// fixtures. Centralizing them here:
//   • removes the fixture-specific overfitting,
//   • documents WHAT each entry is and WHY ennio treats it specially,
//   • lets a new app extend the sets via env without touching code.
//
// SIGNAL vs REGISTRY. Where a capability can be detected at runtime from a
// signal, the signal is primary and this registry is the fallback. The entries
// below are the cases that genuinely CANNOT be signal-detected from inside the
// app process:
//   • Cross-process presenters (PHPicker, share/document pickers) run in another
//     XPC process — the in-app dylib is structurally blind to them, so they can
//     only be recognized by the class name surfaced in the VC chain.
//   • A rich-text field that swallows insertText's onChangeText looks identical
//     to a working field from outside (the text DOES appear) — "onChangeText
//     didn't fire" is not observable, so the field must be named.
// These are PLATFORM facts (Apple system classes) or a small per-app list, not
// behavior we can infer — exactly what a registry is for.
//
// Overrides (each a JSON array, or a comma list, in the env var):
//   ENNIO_CAP_CROSS_PROCESS_CLASSES   ENNIO_CAP_ASYNC_PAYLOAD_CLASSES
//   ENNIO_CAP_RICH_TEXT_FIELDS        ENNIO_CAP_SUBMIT_DISMISS_PATTERN (regex src)

function envList(name: string, fallback: string[]): string[] {
  // eslint-disable-next-line expo/no-dynamic-env-var
  const raw = process.env[name];
  if (!raw) return fallback;
  const trimmed = raw.trim();
  try {
    if (trimmed.startsWith('[')) {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) return arr.map(String);
    }
  } catch {
    /* fall through to comma-split */
  }
  return trimmed
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Apple system view-controller classes that present cross-process (in a
 * separate XPC process). animations_active and the React commit observer are
 * blind to them, so lifecycle/settle waits poll the VC chain for these names to
 * know a system sheet is still up. Matched as substrings of the VC class name.
 */
export const CROSS_PROCESS_PRESENTER_CLASSES = envList('ENNIO_CAP_CROSS_PROCESS_CLASSES', [
  'PHPicker',
  'PhotoPicker',
  'PHImagePicker',
  'UIActivityViewController',
  'UIDocumentPickerViewController',
]);

/**
 * Hosts whose payload arrives asynchronously AFTER the controller dismisses and
 * which repaint continuously while up (so a tap's frame-hash flaps without the
 * tap having "landed"). A tap into one of these needs extra retaps gated on
 * exposure rather than hash-change, plus a post-dismissal commit wait so the
 * next step doesn't read state before the payload lands. Matched as substrings.
 */
export const ASYNC_PAYLOAD_HOST_CLASSES = envList('ENNIO_CAP_ASYNC_PAYLOAD_CLASSES', [
  'CropViewController',
  'Mantis',
  'PHPicker',
  'PhotoPicker',
]);

/**
 * testIDs of rich-text inputs whose controlled value is driven by an
 * onChangeText handler that UIKeyInput.insertText does NOT trigger — they must
 * be typed via real keyboard HID events or their state (e.g. a submit button's
 * enabled flag) never updates. Cannot be signal-detected (see file header).
 */
export const RICH_TEXT_FIELD_TESTIDS = envList('ENNIO_CAP_RICH_TEXT_FIELDS', ['composerTextInput']);

/**
 * testID pattern for buttons that commit async server state and then dismiss
 * their presenting sheet (a publish/submit/send affordance). Used only by the
 * opt-in submit-dismiss settle (ENNIO_SUBMIT_DISMISS_MAX_MS).
 */
export const SUBMIT_DISMISS_TESTID_PATTERN = new RegExp(
  process.env.ENNIO_CAP_SUBMIT_DISMISS_PATTERN ?? 'publish|submit|send',
  'i',
);

const includesAny = (cls: string, list: string[]): boolean => list.some((c) => cls.includes(c));

/** Is `cls` an Apple cross-process presenter (system sheet in another process)? */
export const isCrossProcessPresenter = (cls: string): boolean =>
  includesAny(cls, CROSS_PROCESS_PRESENTER_CLASSES);

/** Is `cls` an async-payload / continuously-repainting host (cropper, picker)? */
export const isAsyncPayloadHost = (cls: string): boolean =>
  includesAny(cls, ASYNC_PAYLOAD_HOST_CLASSES);

/** Does a VC chain contain any async-payload host? */
export const chainHasAsyncPayloadHost = (chain: string[]): boolean => chain.some(isAsyncPayloadHost);

/** Does a VC chain contain any cross-process presenter? */
export const chainHasCrossProcessPresenter = (chain: string[]): boolean =>
  chain.some(isCrossProcessPresenter);

/** Is `testID` a rich-text field that needs HID typing (no onChangeText on insert)? */
export const isRichTextField = (testID: string | null | undefined): boolean =>
  testID != null && RICH_TEXT_FIELD_TESTIDS.includes(testID);
