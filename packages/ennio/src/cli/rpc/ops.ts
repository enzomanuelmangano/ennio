// The op catalog — the single source of truth for the Unix-socket
// protocol's request/response shapes. Each entry maps an op name to its
// `args` and `result` types. `TypedRpcClient.call<K>(op, args)` reads
// both off this map, so a wrong arg field or a misread result field is
// a compile error instead of a silent `as {...}` cast at the call site.
//
// Shapes were reconciled from the CLI call sites AND the native handler
// JSON builders (ios/handlers/*.mm). When the two disagreed, the
// native emitter won (it's the wire reality).

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Result carried by every wait_* op via the native EnnioElapsedJson helper. */
export interface WaitResult {
  ok: boolean;
  elapsedMs: number;
}

export interface RpcOps {
  // ---- discovery / geometry -------------------------------------------
  find_by_testid: { args: { testID: string }; result: Rect };
  find_by_testid_nth: { args: { testID: string; index: number }; result: Rect };
  find_by_text: { args: { text: string; relaxed?: boolean }; result: Rect };
  find_ax_by_text: { args: { text: string }; result: Rect };
  find_child_by_testid: { args: { childTestID: string; parentTestID: string }; result: Rect };
  find_tap_target_by_testid: {
    args: { testID: string };
    result: Rect & { kind: 'self' | 'descendant' };
  };
  wait_find_by_testid: { args: { testID: string; maxMs?: number }; result: Rect };
  wait_find_by_text: { args: { text: string; maxMs?: number }; result: Rect };
  get_text: { args: { testID?: string; text?: string }; result: { text: string } };

  // ---- visibility / exposure ------------------------------------------
  visible: { args: { testID: string }; result: { visible: boolean } };
  is_exposed: {
    args: { testID?: string; text?: string };
    result: { found: boolean; exposed: boolean; childHijack: boolean };
  };
  first_responder_ready: { args: { maxMs: number }; result: { ready: boolean } };
  is_text_input_at: {
    args: { nx: number; ny: number };
    result: { isTextInput: boolean; hit: boolean };
  };

  // ---- settle / timing ------------------------------------------------
  frame_hash: { args: Record<string, never>; result: { hash: string } };
  animations_active: { args: Record<string, never>; result: { active: boolean } };
  // react_commit_ts / wait_react_commit / wait_react_quiet keep their op
  // names for wire compatibility but are now backed by the UNIVERSAL
  // EnnioSettle commit signal (per-vsync frame-hash + runloop observer),
  // not a renderer-specific React hook. `attach` is "universal" on
  // current dylibs; legacy renderer names are tolerated from older ones.
  react_commit_ts: {
    args: Record<string, never>;
    result: { ts: number | string; attach: 'universal' | 'paper' | 'fabric' | 'both' | 'none' };
  };
  wait_commit: { args: { maxMs: number; stableMs: number }; result: WaitResult };
  wait_react_commit: { args: { sinceMs: number; maxMs: number }; result: WaitResult };
  wait_hash_change: { args: { sinceHash: string; maxMs: number }; result: WaitResult };
  wait_presentation_idle: { args: { maxMs: number }; result: WaitResult };
  wait_scroll_idle: { args: { maxMs: number }; result: WaitResult };

  // ---- interaction ----------------------------------------------------
  activate_testid: { args: { testID: string }; result: { ok: boolean } };
  activate_by_text: { args: { text: string }; result: { ok: boolean } };
  focus_testid: { args: { testID: string }; result: { ok: boolean } };
  insert_text: { args: { text: string }; result: { ok: boolean } };
  hardware_key: { args: { keyCode: number }; result: { ok: boolean } };
  hide_keyboard: { args: Record<string, never>; result: { hidden: boolean } };
  scroll_to: {
    args: { elementTestID: string; scrollViewTestID?: string };
    result: { scrolled: boolean };
  };
  tap_tab: { args: { name: string }; result: { tapped: boolean } };
  back: { args: Record<string, never>; result: { popped: boolean } };
  /** Deliver a deep link in-process (posts RN's RCTOpenURLNotification). */
  open_url: { args: { url: string }; result: { ok: boolean } };
  /** In-process scroll/page primitive: setContentOffset for a scroll view at
   *  the start point (one page for a paging view), else declines (ok:false). */
  swipe_points: {
    args: { x1: number; y1: number; x2: number; y2: number; durationMs: number };
    result: { ok: boolean };
  };

  // ---- alerts ---------------------------------------------------------
  alert_present: { args: Record<string, never>; result: { present: boolean } };
  alert_text: { args: Record<string, never>; result: { text: string } };
  alert_buttons: { args: Record<string, never>; result: { buttons: string[] } };
  alert_tap: { args: { buttonText: string }; result: { tapped: boolean } };
  alert_dismiss: { args: Record<string, never>; result: { dismissed: boolean } };

  // ---- scroll-view state ----------------------------------------------
  is_refreshing: { args: { x: number; y: number }; result: { refreshing: boolean } };

  // ---- diagnostics / lifecycle ----------------------------------------
  ping: {
    args: Record<string, never>;
    result: { pong?: boolean; bootstrap?: 'ready' | 'pending' };
  };
  window_size: { args: Record<string, never>; result: { w: number; h: number } };
  // clear_overlays: wipe ennio's transient on-screen instrumentation
  // (show-touches indicators + the "E2E" debug banner) from the running
  // app without disturbing app state. Backs `ennio clean` and improvise's
  // best-effort teardown on abnormal exit. Always returns cleared:true.
  clear_overlays: { args: Record<string, never>; result: { cleared: boolean } };
  top_vc_chain: { args: Record<string, never>; result: { chain: string[] } };
  finder_probe: { args: { testID: string }; result: { index: boolean; uiview: boolean } };
  dump_views: { args: Record<string, never>; result: string[] };
  ax_tree_snapshot: { args: Record<string, never>; result: { tree: string } };
}

export type OpName = keyof RpcOps;
export type OpArgs<K extends OpName> = RpcOps[K]['args'];
export type OpResult<K extends OpName> = RpcOps[K]['result'];
