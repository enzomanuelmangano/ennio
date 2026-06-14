// Result decoders — one per op, keyed by op name. The TypedRpcClient
// runs the matching decoder on every response `data` before handing it
// back, so call sites receive a validated, typed value (no `as {...}`).
//
// Hand-rolled (not zod): the package ships only 4 runtime deps and the
// hot path issues thousands of find_by_testid calls per suite. These
// decoders are a few field checks each — zero deps, negligible cost.

import type { OpName, OpResult, Rect } from './ops';

export type Decoded<T> = { ok: true; value: T } | { ok: false; why: string };

const okD = <T>(value: T): Decoded<T> => ({ ok: true, value });
const failD = (why: string): Decoded<never> => ({ ok: false, why });

const isObj = (d: unknown): d is Record<string, unknown> =>
  typeof d === 'object' && d !== null && !Array.isArray(d);

type FieldSpec = 'num' | 'str' | 'bool' | 'num?' | 'str?' | 'bool?' | 'str[]' | 'numOrStr';

function checkField(value: unknown, spec: FieldSpec): boolean {
  const optional = spec.endsWith('?');
  if (optional && (value === undefined || value === null)) return true;
  switch (spec) {
    case 'num':
    case 'num?':
      return typeof value === 'number' && !Number.isNaN(value);
    case 'str':
    case 'str?':
      return typeof value === 'string';
    case 'bool':
    case 'bool?':
      return typeof value === 'boolean';
    case 'numOrStr':
      return typeof value === 'number' || typeof value === 'string';
    case 'str[]':
      return Array.isArray(value) && value.every((v) => typeof v === 'string');
  }
}

/** Decoder for a flat object result. Validates each listed field; extra fields pass through. */
function shape<T>(spec: Record<string, FieldSpec>): (d: unknown) => Decoded<T> {
  return (d: unknown): Decoded<T> => {
    if (!isObj(d)) return failD('expected object');
    for (const [field, fieldSpec] of Object.entries(spec)) {
      if (!checkField(d[field], fieldSpec)) {
        return failD(`field "${field}" failed ${fieldSpec} (got ${typeof d[field]})`);
      }
    }
    return okD(d as T);
  };
}

const decRect = shape<Rect>({ x: 'num', y: 'num', w: 'num', h: 'num' });
const strArray = (d: unknown): Decoded<string[]> =>
  Array.isArray(d) && d.every((v) => typeof v === 'string')
    ? okD(d as string[])
    : failD('expected string[]');

export type OpDecoders = { [K in OpName]: (d: unknown) => Decoded<OpResult<K>> };

export const decoders: OpDecoders = {
  // discovery / geometry
  find_by_testid: decRect,
  find_by_testid_nth: decRect,
  find_by_text: decRect,
  find_ax_by_text: decRect,
  find_child_by_testid: decRect,
  find_tap_target_by_testid: shape({ x: 'num', y: 'num', w: 'num', h: 'num', kind: 'str?' }),
  wait_find_by_testid: decRect,
  wait_find_by_text: decRect,
  get_text: shape({ text: 'str' }),
  // visibility / exposure
  visible: shape({ visible: 'bool' }),
  is_exposed: shape({ found: 'bool', exposed: 'bool', childHijack: 'bool?' }),
  first_responder_ready: shape({ ready: 'bool' }),
  is_text_input_at: shape({ isTextInput: 'bool', hit: 'bool' }),
  // settle / timing
  frame_hash: shape({ hash: 'str' }),
  animations_active: shape({ active: 'bool' }),
  react_commit_ts: shape({ ts: 'numOrStr', attach: 'str' }),
  wait_commit: shape({ ok: 'bool', elapsedMs: 'num?' }),
  wait_react_commit: shape({ ok: 'bool', elapsedMs: 'num?' }),
  wait_hash_change: shape({ ok: 'bool', elapsedMs: 'num?' }),
  wait_presentation_idle: shape({ ok: 'bool', elapsedMs: 'num?' }),
  // interaction
  activate_testid: shape({ ok: 'bool' }),
  activate_by_text: shape({ ok: 'bool' }),
  focus_testid: shape({ ok: 'bool' }),
  insert_text: shape({ ok: 'bool' }),
  hardware_key: shape({ ok: 'bool' }),
  hide_keyboard: shape({ hidden: 'bool' }),
  scroll_to: shape({ scrolled: 'bool' }),
  tap_tab: shape({ tapped: 'bool' }),
  back: shape({ popped: 'bool' }),
  open_url: shape({ ok: 'bool' }),
  // alerts
  alert_present: shape({ present: 'bool' }),
  alert_text: shape({ text: 'str' }),
  alert_buttons: shape({ buttons: 'str[]' }),
  alert_tap: shape({ tapped: 'bool' }),
  alert_dismiss: shape({ dismissed: 'bool' }),
  // scroll-view state
  is_refreshing: shape({ refreshing: 'bool' }),
  // diagnostics / lifecycle
  ping: shape({ pong: 'bool?', bootstrap: 'str?' }),
  window_size: shape({ w: 'num', h: 'num' }),
  clear_overlays: shape({ cleared: 'bool' }),
  top_vc_chain: shape({ chain: 'str[]' }),
  finder_probe: shape({ index: 'bool', uiview: 'bool' }),
  dump_views: strArray,
  ax_tree_snapshot: shape({ tree: 'str' }),
};
