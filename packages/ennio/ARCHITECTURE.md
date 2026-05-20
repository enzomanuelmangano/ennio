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

A11y-only. Two tiers (cache + walk). No JSI, no fiber tree, no RN private
surface.

| Tier      | Mechanism                                                       | Cost    | Catches                                                                             |
| --------- | --------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------- |
| Cache     | `NSMutableDictionary<NSString*, UIView*>` mapping testID → view | ~0.1ms  | Any testID seen recently; invalidated on `clear_state` and when target view is gone |
| A11y walk | Recursive UIView traversal matching `accessibilityIdentifier`   | ~5-10ms | Everything else with proper testID propagation                                      |

**testID propagation requirement.** RN's stock components propagate `testID`
→ `accessibilityIdentifier` automatically. Custom wrappers (RNGH BaseButton,
pressto without patch, zeego DropdownMenu, react-native-ios-context-menu)
may drop the propagation. Users wrap these once via the `ennio-a11y` helper
package or babel plugin. Same requirement Maestro / XCUITest / argent / etc.
have — propagation discipline is industry standard.

This trade — fiber-walk-free in exchange for a one-time user-land setup —
buys: zero JSI capture, zero RCTHost swizzle, zero React internal patches,
zero per-React-major risk. Engine is framework-agnostic (also works on
SwiftUI / native UIKit / NativeScript apps that propagate
`accessibilityIdentifier`).

## Sync (settle)

Pure UIKit-based. No React commit hook in 0.1.

| Op            | Mechanism                                                                                 | Cost          |
| ------------- | ----------------------------------------------------------------------------------------- | ------------- |
| `wait_idle`   | `CFRunLoopObserver` for `kCFRunLoopBeforeWaiting` + no in-flight UIView animations        | ~50ms detect  |
| `wait_commit` | `CADisplayLink` frame-hash: sample visible UIView frames+alpha+labels, settle when stable | ~100ms detect |

This is the "framework-agnostic" path argent uses for non-RN apps. Loses
the ~5ms wake-on-commit advantage that an RN DevTools hook would give,
but in exchange:

- No JSI runtime capture
- No `RCTHost.start` swizzle
- No React internals patched
- No per-React-major maintenance

Speed loss per `waitFor`: ~80ms vs commit-hook path. Over a 30-step flow
with 5 waits: ~400ms. Real but small.

If future need arises, an optional React commit hook can be added in
0.2+ as an opt-in fast path (the dylib detects RN, captures runtime,
installs hook → wakes on commit). Same socket op (`wait_commit`),
different backing. Architecture supports it; we just don't ship with it.

## Bootstrap

```
+load (ObjC class)
  └─ EnnioControlSocket::start()    // socket listener thread
  └─ register UIApplicationDidFinishLaunchingNotification
  └─ distribution gate (refuse AppStore/Enterprise builds)

UIApplicationDidFinishLaunchingNotification
  └─ find key UIWindow
  └─ start CFRunLoopObserver for wait_idle
  └─ start CADisplayLink for wait_commit frame-hash
  └─ mark socket "ready" → start dispatching commands
```

No swizzle. No JSI capture. No RN detection. Bootstrap is pure UIKit/
CoreFoundation. Works identically on RN apps and any iOS Debug app
with proper accessibility propagation.

## Wire protocol (CLI ↔ dylib)

Line-delimited JSON over Unix domain socket. Path:
`<app sandbox>/Library/.ennio.sock` (resolved via `simctl get_app_container`).

Request shape:

```json
{ "id": 42, "op": "find_by_testid", "args": { "testID": "cart-button" } }
```

Response shape:

```json
{ "id": 42, "ok": true, "data": { "x": 140.0, "y": 220.0, "w": 80.0, "h": 40.0 } }
```

Or error:

```json
{ "id": 42, "ok": false, "err": "testID not found: cart-button" }
```

### Operations (Phase 1)

| Op                         | Args                                | Returns                                            |
| -------------------------- | ----------------------------------- | -------------------------------------------------- |
| `ping`                     | —                                   | `{pong:true,bootstrap:"ready"}`                    |
| `find_by_testid`           | `testID`                            | `{x,y,w,h,reactTag?,via:"cache"\|"fiber"\|"a11y"}` |
| `find_by_selector`         | Maestro selector JSON               | `{matches:[{x,y,w,h,testID?,text?}]}`              |
| `frame`                    | `testID` or `reactTag`              | `{x,y,w,h}`                                        |
| `visible`                  | `testID`                            | `{visible:bool}`                                   |
| `wait_commit`              | `maxMs`                             | `{commit:bool,elapsedMs}`                          |
| `wait_idle`                | `maxMs`                             | `{idle:bool,elapsedMs}`                            |
| `tap_tab`                  | `name`                              | `{tapped:bool}` (UITabBarController delegate)      |
| `is_alert_present`         | —                                   | `{present:bool}`                                   |
| `alert_text`               | —                                   | `{text}`                                           |
| `alert_buttons`            | —                                   | `{buttons:[...]}`                                  |
| `alert_tap`                | `buttonText`                        | `{tapped:bool}`                                    |
| `alert_dismiss`            | —                                   | `{dismissed:bool}`                                 |
| `scroll`                   | `testID`, `direction`, `distance`   | `{scrolled:bool}`                                  |
| `scroll_to`                | `scrollViewTestID`, `elementTestID` | `{scrolled:bool}`                                  |
| `back`                     | —                                   | `{popped:bool}`                                    |
| `hide_keyboard`            | —                                   | `{hidden:bool}`                                    |
| `hardware_key`             | `keyCode`                           | `{ok:bool}`                                        |
| `clipboard_copy`           | `text`                              | `{copied:bool}`                                    |
| `clipboard_paste`          | `testID`                            | `{pasted:bool}`                                    |
| `swipe_points`             | `x1,y1,x2,y2,durationMs`            | `{ok:bool}`                                        |
| `clear_state`              | —                                   | `{cleared:bool}`                                   |
| `is_menu_trigger_ancestor` | `testID`                            | `{is:bool}`                                        |

CLI tap flow: `find_by_testid` → coords → CLI sends to idb (Phase 1) →
`wait_commit` for settle.

## What's dropped vs current ennio

| Dropped                                                              | Why                                                                                              |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `cpp/HybridEnnio.{cpp,hpp}`                                          | Fabric C++ surface; per-RN-minor coupling                                                        |
| `cpp/ShadowTreeTraverser.{cpp,hpp}`                                  | Fabric C++ headers                                                                               |
| `cpp/Protocol.{cpp,hpp}`                                             | Was the `__ennioDispatch` request/response envelope; replaced by socket JSON                     |
| `cpp/TestIDRegistry.{cpp,hpp}`                                       | Fabric ShadowNode registry walk; replaced by JS-side fiber observer + native NSMutableDictionary |
| `cpp/IdleMonitor.hpp`                                                | Fabric commit waiter; replaced by JS commit hook + condvar                                       |
| `nitrogen/`, `src/Ennio.nitro.ts`, `react-native-nitro-modules` peer | Nitro JSI bindings — not needed when transport is socket                                         |
| `src/cli/hid-daemon.py`                                              | Python gRPC daemon — Node speaks gRPC directly                                                   |
| `RCTHost.start` swizzle (`ios/EnnioAutoInit.mm`)                     | Not needed — a11y-only discovery + UIKit settle has no JSI requirement                           |
| `instance:didInitializeRuntime:` swizzle (WIP)                       | Same — no JSI capture needed                                                                     |
| Hermes Inspector / CDP hot path                                      | Socket replaces; CDP optionally retained as fallback for `runScript`/`evalScript`                |
| `prebuilt/libennio-rn0.83.6-sim.dylib` (per-RN slice)                | One universal dylib                                                                              |

## What's kept

| Kept                               | Why                                                                               |
| ---------------------------------- | --------------------------------------------------------------------------------- |
| `cpp/SelectorParser.{cpp,hpp}`     | Maestro selector AST parsing; pure data, no RN deps                               |
| `cpp/ElementMatcher.{cpp,hpp}`     | Selector predicate evaluation; pure data                                          |
| `cpp/EnnioControlSocket.{cpp,h}`   | Unix-domain socket listener; expanded for new protocol                            |
| `ios/EnnioRuntimeHelper.{h,mm}`    | UIKit selectors (tabs/alerts/scroll/back/keyboard); ported to new socket dispatch |
| `ios/EnnioDebugBanner.{h,mm}`      | Optional E2E ribbon                                                               |
| Distribution gate logic            | Runtime backstop; moved to new bootstrap file                                     |
| Maestro YAML parser + runner       | Largely unchanged; transport refactored to socket-first                           |
| `@reactiive/ennio-expo-plugin`     | Pod link gate via `:configurations`; unchanged                                    |
| DYLD injection path (zero-install) | Real differentiator; unchanged                                                    |
| `prebuilt/libennio-shim.dylib`     | RN-agnostic shim gate; unchanged but now loads universal slice                    |

## What's added

| Added                                 | Purpose                                                                                                                                                        |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ios/EnnioBootstrap.mm`               | New `+load` + UIApplicationDidFinishLaunchingNotification bootstrap. Replaces `EnnioAutoInit.mm`.                                                              |
| `ios/EnnioFinder.{h,mm}`              | A11y/UIView walk + cache management.                                                                                                                           |
| `ios/EnnioFiberWalker.mm`             | ObjC++ glue: JSI eval of `__ennio_findFiberByTestID`.                                                                                                          |
| `ios/EnnioCommitHook.mm`              | ObjC++ glue: installs `__ennio_native_onCommit` JSI host fn, signals condvar.                                                                                  |
| `ios/EnnioSettle.mm`                  | `wait_commit`/`wait_idle` handlers, condition variable, CFRunLoop / CADisplayLink fallback.                                                                    |
| `ios/SelectorRunner.mm`               | ObjC++ glue between C++ SelectorParser/ElementMatcher and ObjC UIView walk.                                                                                    |
| `js-helpers/ennio-fiber.js`           | JS snippet evaluated in Hermes via JSI; defines `__ennio_findFiberByTestID`, `__ennio_fiberObserver`, commit-hook patch. Compiled into dylib as static string. |
| `src/cli/socket-client.ts` (expanded) | Primary transport. Per-op typed wrappers.                                                                                                                      |

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

| Surface                                                 | Owner                     | Stability                                 |
| ------------------------------------------------------- | ------------------------- | ----------------------------------------- |
| UIView / UIAccessibility / UIKit selectors              | Apple                     | ~decade                                   |
| `+load` / `UIApplicationDidFinishLaunchingNotification` | Apple                     | decade                                    |
| Unix domain socket                                      | POSIX                     | forever                                   |
| `jsi::Runtime` public API                               | React Native              | stable since RN 0.60                      |
| `__REACT_DEVTOOLS_GLOBAL_HOOK__`                        | React                     | DevTools public protocol; per React major |
| `RCTUIManager viewForReactTag:`                         | React Native              | stable since RN 0.40                      |
| `RCTHost.start` swizzle                                 | React Native private ObjC | stable ~3 years                           |
| `RCTInstance.callFunctionOnBufferedRuntimeExecutor:`    | React Native private ObjC | stable                                    |
| `SimulatorKit` IOHID (Phase 2)                          | Apple private             | sim-stable ~8 years                       |
| `idb_companion` (Phase 1)                               | Facebook (archived)       | breaks on new iOS, drops out at Phase 2   |

Maintenance: ~5-10 hr/month after 0.1 ships.
