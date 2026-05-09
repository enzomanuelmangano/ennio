# Ennio

Maestro-compatible E2E test runner for React Native iOS. Reads ride the
Fabric shadow tree directly. Writes invoke the React `onPress` closure
synchronously through a native JSI fiber-walk, with `idb` HID injection
as fallback for keyboard input and swipes.

```
ennio e2e/01-auth-flow.yaml      # one flow
ennio e2e/                       # every *.yaml in the directory
```

## Architecture

```
┌─ host machine ────────────────────────────────────┐
│  ennio CLI (Bun)                                  │
│    EnnioClient ──ws 127.0.0.1:9876──► same host   │
│    idb subprocess (HID input)                     │
└────────────────────────────┬──────────────────────┘
                             │
┌────────────────────────────▼──────────────────────┐
│  iOS sim — your app process                       │
│    WebSocket server thread (C++)                  │
│       │                                           │
│       │ commands route through HybridEnnio        │
│       │                                           │
│       ├─ READS                                    │
│       │   • Fabric ShadowTreeTraverser            │
│       │   • UIKit window-frame queries            │
│       │   • UIAlertController introspection       │
│       │                                           │
│       └─ WRITES                                   │
│           • invokeOnPress  → JSI-thread fiber     │
│             walk → React onPress() (sync)         │
│           • tapTabByName   → UITabBarController   │
│             delegate + selectedIndex              │
│           • backGesture    → UINavigationController│
│             popViewController                     │
│           • tapAlertButton → UIAlertController    │
│             action invocation                     │
│           • idb HID        → typeText / swipe /   │
│             non-tab text taps                     │
└───────────────────────────────────────────────────┘
```

### Bootstrap (zero-import)

`@ennio/core` boots itself entirely from native. The user's app does
**not** import the package anywhere. Sequence at launch:

1. `+load` constructor in `EnnioAutoInit.mm` swizzles `RCTHost.start`.
2. After original `start` returns, the swizzle reads RCTHost's
   `_instance` ivar (RCTInstance), captures it, hands a JS-thread
   executor (wrapping `callFunctionOnBufferedRuntimeExecutor:`) to
   `HybridEnnio::setJSThreadExecutor`.
3. Schedules `HybridEnnio::nativeBootstrap(rt, 9876)` on the JS thread.
4. Inside the JS-thread block: capture `jsi::Runtime*`, evaluate the
   React fiber walker into `globalThis.__ennio_invokeOnPress`, construct
   a singleton `HybridEnnio` (no Nitro JS wrapper — direct C++), start
   the WebSocket server.

The user installs the package via `npm install`; autolinking adds the
pod, and the swizzle does the rest. **No `import '@ennio/core'`.**

### Direct onPress dispatch

For any `tapOn { id: ... }`:

```
CLI ──ws──► WebSocketServer (C++)
              │
              │ invokeOnPress(testID, 1500ms timeout)
              │
              │ JSThreadExecutor → callFunctionOnBufferedRuntimeExecutor:
              │   ↓
              │ JS thread: walk __REACT_DEVTOOLS_GLOBAL_HOOK__ fiber
              │   tree, match memoizedProps.testID === testID,
              │   invoke memoizedProps.onPress sync
              │   ↓ cv.notify_one
              │
              │ wait_for(1500ms) → return success
            CLI ◄── response
```

Bypasses the iOS gesture pipeline entirely. Works for `Pressable`,
`TouchableOpacity`, RNGH `BaseButton`, pressto's `PressableScale`, and
expo-router `<Link asChild>`. Falls back to `idb` HID tap when the fiber
has no `onPress` (TextInput) or no fiber match.

### Performance

| operation | Maestro / XCUI | Ennio |
|-----------|----------------|-------|
| `assertVisible: id` | 200–400 ms | 5–10 ms |
| `tapOn: id` | 200–400 ms | 5–15 ms |
| `tapOn: text` (tab) | 200–400 ms | 5–15 ms |
| `inputText` per char | ~50 ms | ~30 ms (idb HID) |
| 30-step flow | 60–90 s | 5–15 s |
| suite cold start | 10–15 s xcodebuild | 0 — already running |

## Requirements

- React Native ≥ 0.81 with New Architecture (Fabric, bridgeless).
- iOS 17+ simulator (tested on iPhone 17 Pro / iOS 26).
- Xcode 16+.
- Bun or Node 18+.
- `idb_companion`: `brew install facebook/fb/idb-companion` (used for
  typeText, swipes, and non-tab text taps).
- Expo (bare RN works with manual Podfile linking).

iOS only.

## Setup

```bash
# Runtime + plugin
npm install @ennio/core @ennio/expo-plugin react-native-nitro-modules

# CLI
npm install -D @ennio/cli
```

`app.json`:

```json
{
  "plugins": [
    "expo-router",
    "@ennio/expo-plugin"
  ]
}
```

> **Default = OFF.** Having `@ennio/core` and `@ennio/expo-plugin` in
> your dependencies is **safe to ship to production**. The native
> runtime only links in when `ENNIO_ENABLED=1` is set at prebuild
> time. Without it the plugin no-ops and the resulting build is
> byte-equivalent to one that never installed the packages.
>
> When Ennio is active in a build, a red diagonal **E2E** ribbon
> appears in the top-right corner of every screen — a visible
> reminder that the build carries the remote-control surface and is
> not for production distribution. If a build with Ennio enabled is
> archived for App Store or Enterprise distribution, the runtime
> refuses to start: no server, no fiber walker, no ribbon.

Enable for E2E:

```bash
ENNIO_ENABLED=1 bunx expo prebuild --clean
ENNIO_ENABLED=1 cd ios && pod install && cd ..
ENNIO_ENABLED=1 bunx expo run:ios
```

Disable for production / App Store. Either unset the env var entirely
or set it explicitly to `0` — both excluded equally:

```bash
# Recommended: be explicit
ENNIO_ENABLED=0 bunx expo prebuild --clean
ENNIO_ENABLED=0 bunx expo run:ios --configuration Release

# Equivalent: leave it unset
bunx expo prebuild --clean
bunx expo run:ios --configuration Release
```

When excluded, the build is byte-identical to one with
`@ennio/expo-plugin` removed from `app.json` — zero symbols, zero
linked code, zero port listener.

You never import `@ennio/core` anywhere. When enabled, autolinking
includes the pod and a `+load` swizzle bootstraps the WebSocket server
+ JSI fiber walker before your app's first frame.

Run a flow:

```bash
ennio e2e/01-auth-flow.yaml
```

## Build gating (`@ennio/expo-plugin`)

The plugin's only job: keep Ennio out of any build that doesn't
explicitly opt in. Default behavior:

| `ENNIO_ENABLED` value | Plugin action |
|-----------------------|---------------|
| `1` (iOS) / `true` (Android) | Adds `pod 'EnnioCore'` / Gradle dep — full runtime included |
| `0`, `false`, unset, or anything else | Plugin no-ops — build contains **zero** Ennio code, symbols, or port listener (byte-equivalent to omitting the plugin entirely) |

EAS:

```json
{
  "build": {
    "development": { "env": { "ENNIO_ENABLED": "1" } },
    "preview":     { "env": { "ENNIO_ENABLED": "1" } },
    "production":  { /* unset → off */ }
  }
}
```

CI sanity check (run on every release artifact before signing):

```bash
nm -gU YourApp.app/YourApp 2>/dev/null | grep -E "EnnioCore|__ennio_invokeOnPress" \
  && { echo "FAIL: Ennio symbols found in release build"; exit 1; } \
  || echo "OK: no Ennio symbols"
```

## CLI

```bash
ennio <flow.yaml>            # one flow
ennio e2e/                   # every *.yaml under the directory, in order
ennio --port=9876            # override WebSocket port
ennio --verbose              # log every step + RPC
ennio --trace                # per-step state snapshot
```

`ENNIO_UDID=<udid>` pins to a specific simulator when multiple are
booted.

The app must already be running on the simulator. Ennio connects to its
in-process WebSocket server — it doesn't launch the app itself. Use
`xcrun simctl launch` or run from Xcode.

### Test independence

Each flow that begins with `launchApp { clearState: true }` is fully
independent: Ennio terminates the app, wipes its `Library/`,
`Documents/`, and `tmp/` directories, resets privacy permissions, then
re-launches. The native WebSocket server reconnects automatically.

For `ennio e2e/`, flows run sequentially, each carrying its own
`clearState`, so cross-flow leakage is impossible if the YAML opts in.
If a flow omits `launchApp`, it inherits the previous flow's state by
design (used for split flows that share auth setup).

To rule out flake from sim quirks rather than test-content issues:

```bash
# Same flow back-to-back
for i in 1 2 3; do ennio e2e/03-cart-management.yaml; done

# Verify a single flow in isolation
ennio --verbose e2e/03-cart-management.yaml | tail -50
```

## Maestro flow support

The runner targets [Maestro YAML](https://maestro.mobile.dev/). Covered:

- `tapOn`, `doubleTapOn`, `longPress`
- `inputText`, `clearText`, `eraseText`, `pressKey`
- `assertVisible`, `assertNotVisible`, `waitFor`, `assertAnyVisible`
- `scroll`, `scrollUntilVisible`, `swipe`, `back`, `hideKeyboard`
- `runFlow` (subflows + `when` conditionals + inline `commands`)
- `runScript`, `evalScript`, top-level `env:`, `${VAR}` interpolation
- `tapOn: { point: "X%,Y%" }`
- `tapOn: { label: "..." }` (alias for `text:`)
- bare-string `tapOn: "Some Text"` → text match
- `launchApp: { clearState: true }` (terminate, wipe app data, relaunch)
- `repeat`, `retry`
- Native alerts: `tapAlertButton`, `dismissAlert`, plus
  `assertVisible: text:` matches alert titles + button labels

## Repo layout

```
packages/
  core/         @ennio/core       — in-app native module
                                    (C++/ObjC++ + Nitro spec)
  cli/          @ennio/cli        — `ennio` binary, YAML runner
  expo-plugin/  @ennio/expo-plugin — Podfile gate (ENNIO_ENABLED)
example/        Sample app + e2e/ flows (10 example flows, the
                runner's regression suite).
```

## Security

> **TL;DR — installed ≠ enabled.** Keeping `@ennio/core` and
> `@ennio/expo-plugin` in your dependencies and plugins list is **safe
> for App Store / production builds**. They are inert by default. The
> remote-control surface only ships when you explicitly set
> `ENNIO_ENABLED=1` at prebuild time. Production builds without that
> env var are byte-equivalent to a build that never had the package.

### Defense layers

Ennio applies four independent gates. A misconfiguration of any single
layer still leaves the others in place.

| Layer | Stage | Mechanism |
|-------|-------|-----------|
| 1 | Plugin (build time) | `@ennio/expo-plugin` writes the pod / Gradle dep **only** if `ENNIO_ENABLED=1`. Without the env var the binary contains zero Ennio symbols. |
| 2 | Runtime (app launch) | `EnnioAutoInit` parses `appStoreReceiptURL` + `embedded.mobileprovision` and refuses to start the server, fiber walker, or ribbon on App Store / Enterprise distribution — even if the build-time gate slipped. |
| 3 | Network (server bind) | WebSocket server binds to `127.0.0.1` only. Off-host LAN traffic is refused at `bind()`. |
| 4 | Visual | When all three above are bypassed and Ennio is in fact running, the red diagonal **E2E** ribbon paints in the top-right corner of every screen — visible on every screenshot, App Store reviewer included. |

Allowed channels (layer 2): Development, Ad-Hoc, TestFlight (sandbox
receipt). Refused: App Store production receipt, Enterprise
provisioning profile (`ProvisionsAllDevices=true`), and App Store
distribution profiles installed by sideload (no receipt + no
`ProvisionedDevices`).

### Installed vs enabled

| Action | Effect on production build |
|--------|----------------------------|
| `npm install @ennio/core @ennio/expo-plugin` | None. Adds JS deps, zero native code shipped. |
| `"plugins": ["@ennio/expo-plugin"]` in `app.json` | None. Plugin self-checks env at prebuild and no-ops if `ENNIO_ENABLED ≠ 1`. |
| `expo prebuild` (no env) | None. No `pod 'EnnioCore'` written, no Gradle dep, no symbols. |
| `ENNIO_ENABLED=1 expo prebuild` | **Ennio active**. Pod linked, WebSocket server binds on launch, `E2E` ribbon shown top-right of every screen. |

When the ribbon appears, Ennio is active. When the ribbon is absent,
Ennio is dormant — even if the package is installed, listed in plugins,
and shipped to TestFlight / App Store.

### What "active" means

When Ennio is active (`ENNIO_ENABLED=1` was set at prebuild **and** the
build is not App Store / Enterprise distribution), a native WebSocket
server bound to `127.0.0.1:9876` listens for JSON commands. Only
same-host processes can connect — off-host LAN traffic is refused at
the bind. A same-host process can:

- Read the entire React tree — every visible label, every TextInput
  value, every navigation state.
- Read modal alert titles + button labels.
- Trigger any `onPress` in the live fiber tree by `testID`. Includes
  `place-order-btn`, `confirm-transfer`, `delete-account`,
  `submit-payment`, etc. Bypasses iOS gesture pipeline → no biometric
  prompts → no UI confirmation.
- Force tab switches, pop nav stacks, dismiss alerts, scroll content.

Same threat model as Reactotron, Flipper, and React DevTools: an
unauthenticated control surface scoped to the local host. Different in
that Ennio writes can fire `onPress` synchronously without going
through the iOS gesture pipeline — biometrics and confirmation alerts
do not gate the call.

### Default = OFF

The plugin only activates when you explicitly set `ENNIO_ENABLED=1`
(iOS) / `ENNIO_ENABLED=true` (Android) at prebuild / build time. Any
other value, **including unset**, makes the plugin a no-op:

- No `pod 'EnnioCore'` line written to the Podfile.
- No Gradle dependency added.
- Zero Ennio symbols in the linked binary.
- Zero port listener at runtime.

This is the primary mitigation. Forgetting to disable Ennio = a build
without Ennio. Forgetting to enable Ennio = a build that fails its E2E
suite locally before anything ships.

### EAS / CI configuration

Production profile **must** either omit `ENNIO_ENABLED` entirely or set
it to `0`. Both produce a byte-identical Ennio-free build — neither one
matches the `=1` opt-in trigger:

```json
{
  "build": {
    "development": { "env": { "ENNIO_ENABLED": "1" } },
    "preview":     { "env": { "ENNIO_ENABLED": "1" } },
    "production":  { "env": { "ENNIO_ENABLED": "0" } }
  }
}
```

Setting it to `0` explicitly is recommended over unset — makes the
intent visible in the build profile and fails loudly if anyone copies
the value-not-the-key.

### Pre-ship CI guard

Add this to your release pipeline. It exits non-zero if any Ennio
symbol leaked into the binary:

```bash
nm -gU build/Build/Products/Release-iphoneos/YourApp.app/YourApp \
  2>/dev/null \
  | grep -E "_OBJC_CLASS_\$_EnnioAutoInit|EnnioCore|__ennio_invokeOnPress" \
  && { echo "FAIL: Ennio symbols in release build"; exit 1; } \
  || echo "OK: no Ennio in release"
```

### Recommendations beyond the env gate

- **Treat the gate as a hard rule.** The plugin defaults to off; any CI
  workflow that sets `ENNIO_ENABLED=1` on a production target is a
  policy violation, not a feature.
- **Treat any prod build with Ennio active as an incident.** If
  `[Ennio] WebSocket server listening` ever shows up in Console.app on
  a build that wasn't supposed to carry Ennio, pull the build, audit
  who could have reached affected devices, and rotate any credentials
  that could have been in scope (anything visible in TextInput state
  qualifies).
- **Consider a bake-time token (not shipped).** Defense in depth
  against the exotic case of a same-host malicious app on a developer
  device: embed a per-build secret read by both the WS server and the
  CLI; reject unauthenticated frames. Out of scope today — the four
  shipped layers cover the realistic attack surface.

## Limitations

- iOS-simulator focus. Real-device works but requires `idb_companion`
  on the device and codesign-friendly build settings.
- TextInput focus uses idb HID tap (forwardRef breaks fiber.stateNode
  focus paths). Each typeText preamble dismisses the keyboard before
  re-tapping the field to avoid keyboard-occlusion focus drops.
- Custom touchables must surface an `onPress` prop on the testID-bearing
  fiber to use the fast path. Anything else falls to idb HID.

## License

MIT.
