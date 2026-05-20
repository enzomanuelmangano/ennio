# Ennio architecture (v2)

> Status: in-progress rewrite on `feat/arch-v2`. This document describes the
> target architecture. The codebase is being migrated to match it.

## Goals

1. Survive every React Native release. No per-RN-minor compile, no Fabric
   C++ headers, no nitrogen codegen.
2. Stay 100% Maestro YAML compatible. Same flow files run in Maestro,
   `maestro-runner`, and `ennio`. No vendor grammar extensions.
3. Solo-maintainable. ~5-10 hr/month load. No private RN/React ABI hot
   paths that move every quarter.
4. Faster than Maestro on iOS sim Debug. ~5-10× per-tap latency, ~3-5×
   suite time. In-process discovery + own touch dispatch.
5. Ship Phase 1 with `idb` retained; replace `idb` with own
   `SimulatorKit` IOHID helper in Phase 2.

## Non-goals

- Android (deferred; the JS-side fiber walk + Maestro YAML reusable when
  Android port begins).
- Real iOS device (Apple blocks `DYLD_INSERT_LIBRARIES` + IOHID injection
  outside the XCUITest harness).
- Release builds (Pod plugin gates ennio out of Release via
  `:configurations => ['Debug']` + runtime distribution gate).
- `runScript` / `evalScript` Maestro grammar at full speed. Optional CDP
  fallback or unsupported in 0.1.

## The four pieces

```
┌─ User's Mac ─────────────────────────────────────────────────┐
│                                                              │
│   1. ennio CLI (Node, ~3000 LOC TS, bundled to dist/cli.js)  │
│       parses Maestro YAML                                    │
│       picks UDID (sim) + bundle id                           │
│       opens Unix socket to in-app dylib                      │
│       spawns idb HID daemon (Phase 1) / hid-helper (Phase 2) │
│       orchestrates: send command → recv result → next step   │
│                                                              │
│   2. idb (Phase 1) / ennio-hid-helper (Phase 2)              │
│       Phase 1: idb_companion (existing) via gRPC from Node   │
│       Phase 2: own ObjC binary, ~200 LOC, SimulatorKit       │
│       single job: inject IOHID events into the sim           │
│                                                              │
└──────────────────────────────────────────────────────────────┘
                                          │ IOHID + Unix socket
                                          ▼
┌─ iOS Simulator ──────────────────────────────────────────────┐
│                                                              │
│   User's app (Xcode Debug build)                             │
│                                                              │
│   3. libennio.dylib (in-process, ~1700 LOC ObjC)             │
│       +load: install socket listener thread                  │
│       UIApplicationDidFinishLaunchingNotification: bootstrap │
│       Discovery: cache → fiber walk via JSI → a11y fallback  │
│       Settle: React commit hook (RN) / CFRunLoop (non-RN)    │
│       UIKit ops: tabs / alerts / scroll / back / keyboard    │
│       Selector matcher: reuse C++ via ObjC++ glue            │
│                                                              │
│   4. Captured Hermes runtime                                 │
│       Not a new piece — Hermes is already in the app.        │
│       Dylib captures jsi::Runtime& once via RCTHost.start    │
│       swizzle + RCTInstance.callFunctionOnBufferedRuntime-   │
│       Executor. From that pointer, dylib evals the fiber-    │
│       walk JS helper directly (no CDP, no Inspector).        │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

## Discovery

Three tiers, in order:

| Tier | Mechanism | Cost | When it catches |
|------|-----------|------|-----------------|
| Cache | `NSMutableDictionary<NSString*, NSNumber*>` mapping testID → reactTag | ~0.1ms + ~0.5ms RCTUIManager lookup | Any testID seen since the last React commit |
| Fiber walk | JSI eval of `__ennio_findFiberByTestID(testID)`, returns `stateNode.tag` | ~10-30ms cold | testIDs that React renders (most user-land cases, including RNGH wrappers that drop a11y) |
| A11y walk | Recursive UIView traversal matching `accessibilityIdentifier` | ~5-10ms | Non-React-rendered UIViews (alert buttons, system controls, share sheets) |

**Cache invalidation**: cleared on `clear_state` and on `RCTHost.start`
(reload). Populated opportunistically by `__ennio_fiberObserver` on every
React commit — see "Sync" below.

## Sync (settle)

Pure UIKit-only sync would mean polling. RN-aware sync hooks React's
public DevTools protocol for instant wake.

### Phase 1 (L1): commit fire

JS-side patch on `__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot`. Every
commit fires a JSI host fn → native condition variable signaled →
`wait_commit` socket op returns within ~5ms of the commit.

If non-RN app or React DevTools hook unavailable: fall back to
`CADisplayLink` frame-hash heuristic. ~100ms detection. Same socket op,
different backing.

### Phase 2 (L2/L3, deferred): fiber diff events

Per-commit fiber diff. Native receives events stream
`{type:'mount'|'update'|'unmount', testID, tag}`. Enables surgical
`waitFor` (wakes only when the target fiber mounts), and `assertVisible`
that survives mid-commit reads.

L2/L3 are optional power-ups. Ship L1 in 0.1.

## Bootstrap

```
+load (ObjC class)
  └─ EnnioControlSocket::start()    // socket listener thread
  └─ register UIApplicationDidFinishLaunchingNotification
  └─ distribution gate (refuse AppStore/Enterprise)

UIApplicationDidFinishLaunchingNotification
  └─ find key UIWindow
  └─ NSClassFromString(@"RCTHost") → RN detected
  └─ if RN:
      └─ swizzle RCTHost.start
      └─ swizzled start runs:
          └─ call original
          └─ object_getIvar(host, "_instance") → RCTInstance
          └─ [instance callFunctionOnBufferedRuntimeExecutor:^(rt) {
                EnnioRuntimeHolder.runtime = &rt;
                rt.evaluateJavaScript(kFiberWalkScript)   // install helper
                rt.evaluateJavaScript(kCommitHookScript)  // install observer
              }]
  └─ mark socket "ready" → start dispatching commands
```

## Wire protocol (CLI ↔ dylib)

Line-delimited JSON over Unix domain socket. Path:
`<app sandbox>/Library/.ennio.sock` (resolved via `simctl get_app_container`).

Request shape:
```json
{"id":42,"op":"find_by_testid","args":{"testID":"cart-button"}}
```

Response shape:
```json
{"id":42,"ok":true,"data":{"x":140.0,"y":220.0,"w":80.0,"h":40.0}}
```

Or error:
```json
{"id":42,"ok":false,"err":"testID not found: cart-button"}
```

### Operations (Phase 1)

| Op | Args | Returns |
|----|------|---------|
| `ping` | — | `{pong:true,bootstrap:"ready"}` |
| `find_by_testid` | `testID` | `{x,y,w,h,reactTag?,via:"cache"\|"fiber"\|"a11y"}` |
| `find_by_selector` | Maestro selector JSON | `{matches:[{x,y,w,h,testID?,text?}]}` |
| `frame` | `testID` or `reactTag` | `{x,y,w,h}` |
| `visible` | `testID` | `{visible:bool}` |
| `wait_commit` | `maxMs` | `{commit:bool,elapsedMs}` |
| `wait_idle` | `maxMs` | `{idle:bool,elapsedMs}` |
| `tap_tab` | `name` | `{tapped:bool}` (UITabBarController delegate) |
| `is_alert_present` | — | `{present:bool}` |
| `alert_text` | — | `{text}` |
| `alert_buttons` | — | `{buttons:[...]}` |
| `alert_tap` | `buttonText` | `{tapped:bool}` |
| `alert_dismiss` | — | `{dismissed:bool}` |
| `scroll` | `testID`, `direction`, `distance` | `{scrolled:bool}` |
| `scroll_to` | `scrollViewTestID`, `elementTestID` | `{scrolled:bool}` |
| `back` | — | `{popped:bool}` |
| `hide_keyboard` | — | `{hidden:bool}` |
| `hardware_key` | `keyCode` | `{ok:bool}` |
| `clipboard_copy` | `text` | `{copied:bool}` |
| `clipboard_paste` | `testID` | `{pasted:bool}` |
| `swipe_points` | `x1,y1,x2,y2,durationMs` | `{ok:bool}` |
| `clear_state` | — | `{cleared:bool}` |
| `is_menu_trigger_ancestor` | `testID` | `{is:bool}` |

CLI tap flow: `find_by_testid` → coords → CLI sends to idb (Phase 1) →
`wait_commit` for settle.

## What's dropped vs current ennio

| Dropped | Why |
|---------|-----|
| `cpp/HybridEnnio.{cpp,hpp}` | Fabric C++ surface; per-RN-minor coupling |
| `cpp/ShadowTreeTraverser.{cpp,hpp}` | Fabric C++ headers |
| `cpp/Protocol.{cpp,hpp}` | Was the `__ennioDispatch` request/response envelope; replaced by socket JSON |
| `cpp/TestIDRegistry.{cpp,hpp}` | Fabric ShadowNode registry walk; replaced by JS-side fiber observer + native NSMutableDictionary |
| `cpp/IdleMonitor.hpp` | Fabric commit waiter; replaced by JS commit hook + condvar |
| `nitrogen/`, `src/Ennio.nitro.ts`, `react-native-nitro-modules` peer | Nitro JSI bindings — not needed when transport is socket |
| `src/cli/hid-daemon.py` | Python gRPC daemon — Node speaks gRPC directly |
| `instance:didInitializeRuntime:` swizzle (WIP from `feat/ennio-reset-hook`) | Socket survives reload; re-capture jsi::Runtime via re-fired RCTHost.start |
| Hermes Inspector / CDP hot path | Socket replaces; CDP optionally retained as fallback for `runScript`/`evalScript` |
| `prebuilt/libennio-rn0.83.6-sim.dylib` (per-RN slice) | One universal dylib |

## What's kept

| Kept | Why |
|------|-----|
| `cpp/SelectorParser.{cpp,hpp}` | Maestro selector AST parsing; pure data, no RN deps |
| `cpp/ElementMatcher.{cpp,hpp}` | Selector predicate evaluation; pure data |
| `cpp/EnnioControlSocket.{cpp,h}` | Unix-domain socket listener; expanded for new protocol |
| `ios/EnnioRuntimeHelper.{h,mm}` | UIKit selectors (tabs/alerts/scroll/back/keyboard); ported to new socket dispatch |
| `ios/EnnioDebugBanner.{h,mm}` | Optional E2E ribbon |
| Distribution gate logic | Runtime backstop; moved to new bootstrap file |
| Maestro YAML parser + runner | Largely unchanged; transport refactored to socket-first |
| `@reactiive/ennio-expo-plugin` | Pod link gate via `:configurations`; unchanged |
| DYLD injection path (zero-install) | Real differentiator; unchanged |
| `prebuilt/libennio-shim.dylib` | RN-agnostic shim gate; unchanged but now loads universal slice |

## What's added

| Added | Purpose |
|-------|---------|
| `ios/EnnioBootstrap.mm` | New `+load` + UIApplicationDidFinishLaunchingNotification bootstrap. Replaces `EnnioAutoInit.mm`. |
| `ios/EnnioRuntimeHolder.{h,mm}` | Stores captured `jsi::Runtime*` for later eval. |
| `ios/EnnioFinder.{h,mm}` | A11y/UIView walk + cache management. |
| `ios/EnnioFiberWalker.mm` | ObjC++ glue: JSI eval of `__ennio_findFiberByTestID`. |
| `ios/EnnioCommitHook.mm` | ObjC++ glue: installs `__ennio_native_onCommit` JSI host fn, signals condvar. |
| `ios/EnnioSettle.mm` | `wait_commit`/`wait_idle` handlers, condition variable, CFRunLoop / CADisplayLink fallback. |
| `ios/SelectorRunner.mm` | ObjC++ glue between C++ SelectorParser/ElementMatcher and ObjC UIView walk. |
| `js-helpers/ennio-fiber.js` | JS snippet evaluated in Hermes via JSI; defines `__ennio_findFiberByTestID`, `__ennio_fiberObserver`, commit-hook patch. Compiled into dylib as static string. |
| `src/cli/socket-client.ts` (expanded) | Primary transport. Per-op typed wrappers. |

## Phase plan

**Phase 1 (0.1) — architecture switch with idb retained**
- All of the above, except own IOHID helper.
- idb gRPC kept for HID, but Python daemon replaced with Node-side gRPC client (`@grpc/grpc-js`).
- Ship: ~8 weeks of solo work.

**Phase 2 (0.2) — replace idb**
- Build `ennio-hid-helper` Mac binary linking `SimulatorKit.framework` + `CoreSimulator.framework`.
- ~200 LOC ObjC.
- Drop `idb_companion` brew dep, `fb-idb` pip dep, Python runtime.
- Ship: ~3-4 weeks after 0.1.

**Phase 3 (0.3+, deferred) — L2/L3 fiber events**
- Fiber-diff observer per commit.
- Targeted per-testID waiters for surgical `waitFor`.
- ~2-3 weeks.

## Stability assessment

Surfaces touched:

| Surface | Owner | Stability |
|---------|-------|-----------|
| UIView / UIAccessibility / UIKit selectors | Apple | ~decade |
| `+load` / `UIApplicationDidFinishLaunchingNotification` | Apple | decade |
| Unix domain socket | POSIX | forever |
| `jsi::Runtime` public API | React Native | stable since RN 0.60 |
| `__REACT_DEVTOOLS_GLOBAL_HOOK__` | React | DevTools public protocol; per React major |
| `RCTUIManager viewForReactTag:` | React Native | stable since RN 0.40 |
| `RCTHost.start` swizzle | React Native private ObjC | stable ~3 years |
| `RCTInstance.callFunctionOnBufferedRuntimeExecutor:` | React Native private ObjC | stable |
| `SimulatorKit` IOHID (Phase 2) | Apple private | sim-stable ~8 years |
| `idb_companion` (Phase 1) | Facebook (archived) | breaks on new iOS, drops out at Phase 2 |

Maintenance: ~5-10 hr/month after 0.1 ships.
