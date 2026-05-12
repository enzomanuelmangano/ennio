# Ennio

> [!WARNING]
> **Experimental.** Ennio is at an early experimental stage. APIs, package
> names, internals, and behavior may change without notice. iOS only.
> Expect rough edges; do not rely on it for production-critical test
> suites yet.

Maestro-compatible E2E test runner for React Native iOS. Reads ride the
Fabric shadow tree directly. Writes invoke the React `onPress` closure
synchronously through a native JSI fiber-walk, with `idb` HID injection
as fallback for keyboard input and swipes.

```
ennio test e2e/01-auth-flow.yaml      # one flow
ennio test e2e/                       # every *.yaml in the directory
```

## Getting started

Requires an Expo app on RN ≥ 0.81 (New Architecture, Fabric), iOS 17+
simulator, Xcode 16+, Node 18+, and `idb_companion`
(`brew install facebook/fb/idb-companion`).

**1. Install**

```bash
npm install ennio ennio-expo-plugin react-native-nitro-modules
```

**2. Register the plugin** — add `"ennio-expo-plugin"` to `app.json`:

```json
{
  "plugins": ["expo-router", "ennio-expo-plugin"]
}
```

**3. Prebuild + run with Ennio enabled**

```bash
ENNIO_ENABLED=1 npx expo prebuild --clean
ENNIO_ENABLED=1 npx expo run:ios
```

The app autolinks `ennio`, the WebSocket server binds on port `9876`,
and the red **E2E** ribbon appears on every screen. No imports needed
anywhere in your app code.

**4. Write a Maestro YAML flow** (`e2e/login.yaml`):

```yaml
appId: com.your.app
---
- launchApp:
    clearState: true
- tapOn:
    id: "email-input"
- inputText: "user@example.com"
- tapOn: "Continue"
- assertVisible:
    id: "home-screen"
```

**5. Run it**

```bash
npx ennio test e2e/login.yaml
```

That's it. For production / disabling the runtime, EAS profiles,
build-symbol auditing, and security details, see the [Setup](#setup)
and [Security](#security) sections below.

## Architecture

```
┌─ host machine ────────────────────────────────────┐
│  ennio CLI (Node)                                 │
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

`ennio` boots itself entirely from native. The user's app does
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
pod, and the swizzle does the rest. **No `import 'ennio'`.**

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

## Requirements

- React Native ≥ 0.81 with New Architecture (Fabric, bridgeless).
- iOS 17+ simulator (tested on iPhone 17 Pro / iOS 26).
- Xcode 16+.
- Node 18+.
- `idb_companion`: `brew install facebook/fb/idb-companion` (used for
  typeText, swipes, and non-tab text taps).
- Expo (bare RN works with manual Podfile linking).

iOS only.

## Setup

```bash
npm install ennio ennio-expo-plugin react-native-nitro-modules
```

`ennio` ships the native runtime and the CLI binary together — `npx ennio` is available immediately.

`app.json`:

```json
{
  "plugins": ["expo-router", "ennio-expo-plugin"]
}
```

> **Default = OFF.** Having `ennio` and `ennio-expo-plugin` in
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
ENNIO_ENABLED=1 npx expo prebuild --clean
ENNIO_ENABLED=1 cd ios && pod install && cd ..
ENNIO_ENABLED=1 npx expo run:ios
```

Disable for production / App Store. Either unset the env var entirely
or set it explicitly to `0` — both excluded equally:

```bash
# Recommended: be explicit
ENNIO_ENABLED=0 npx expo prebuild --clean
ENNIO_ENABLED=0 npx expo run:ios --configuration Release

# Equivalent: leave it unset
npx expo prebuild --clean
npx expo run:ios --configuration Release
```

When excluded, the build is byte-identical to one with
`ennio-expo-plugin` removed from `app.json` — zero symbols, zero
linked code, zero port listener.

You never import `ennio` anywhere. When enabled, autolinking
includes the pod and a `+load` swizzle bootstraps the WebSocket server

- JSI fiber walker before your app's first frame.

Run a flow:

```bash
ennio test e2e/01-auth-flow.yaml
```

## Build gating (`ennio-expo-plugin`)

The plugin's only job: keep Ennio out of any build that doesn't
explicitly opt in. Default behavior:

| `ENNIO_ENABLED` value                 | Plugin action                                                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `1`                                   | Adds `pod 'EnnioCore'` to the iOS Podfile — full runtime included                                                               |
| `0`, `false`, unset, or anything else | Plugin no-ops — build contains **zero** Ennio code, symbols, or port listener (byte-equivalent to omitting the plugin entirely) |

EAS:

```json
{
  "build": {
    "development": { "env": { "ENNIO_ENABLED": "1" } },
    "preview": { "env": { "ENNIO_ENABLED": "1" } },
    "production": {
      /* unset → off */
    }
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
ennio test <flow.yaml>            # one flow
ennio test e2e/                   # every *.yaml under the directory, in order
ennio test --verbose e2e/         # log every step + RPC
ennio test --trace e2e/           # per-step state snapshot
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

For `ennio test e2e/`, flows run sequentially, each carrying its own
`clearState`, so cross-flow leakage is impossible if the YAML opts in.
If a flow omits `launchApp`, it inherits the previous flow's state by
design (used for split flows that share auth setup).

To rule out flake from sim quirks rather than test-content issues:

```bash
# Same flow back-to-back
for i in 1 2 3; do ennio test e2e/03-cart-management.yaml; done

# Verify a single flow in isolation
ennio test --verbose e2e/03-cart-management.yaml | tail -50
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
  ennio/              ennio              — in-app native runtime (C++/ObjC++
                                           + Nitro spec) AND `ennio` CLI binary
                                           (esbuild-bundled, ships in same pkg)
  ennio-expo-plugin/  ennio-expo-plugin  — Podfile gate (ENNIO_ENABLED)
example/              Sample app + maestro-e2e/ flows (regression suite).
```

## Security

> **TL;DR — installed ≠ enabled.** Keeping `ennio` and
> `ennio-expo-plugin` in your dependencies and plugins list is **safe
> for App Store / production builds**. They are inert by default. The
> remote-control surface only ships when you explicitly set
> `ENNIO_ENABLED=1` at prebuild time. Production builds without that
> env var are byte-equivalent to a build that never had the package.

### Defense layers

| Layer | Stage                 | Mechanism                                                                                                                                                                                                                                                                                                          |
| ----- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1     | Plugin (build time)   | `ennio-expo-plugin` adds the iOS pod **only** if `ENNIO_ENABLED=1`. Without the env var the binary contains zero Ennio symbols.                                                                                                                                                                                    |
| 2     | Runtime (app launch)  | If Ennio is somehow linked into an App Store / Enterprise build, `EnnioAutoInit` refuses to start the server, fiber walker, or ribbon (parses `appStoreReceiptURL` + `embedded.mobileprovision`).                                                                                                                  |
| 3     | Network (server bind) | Server binds `INADDR_ANY` so usbmuxd's TCP forward can reach it on physical device. On the iOS Simulator the sandbox confines traffic to the host. **On physical device the port is reachable from the LAN — only run device builds on trusted networks.** Defense for production rests primarily on Layers 1 + 2. |
| 4     | Visual                | When Ennio is active, the red diagonal **E2E** ribbon paints top-right of every screen — visible on every screenshot.                                                                                                                                                                                              |

Layer 1 is the primary defense. Layers 2–4 are runtime backstops if a
build with Ennio enabled accidentally escapes the gate. **Always set
`ENNIO_ENABLED=0` explicitly on production EAS profiles** — makes the
intent visible in the build profile and fails loudly if anyone copies
the value-not-the-key.

```json
{
  "build": {
    "development": { "env": { "ENNIO_ENABLED": "1" } },
    "preview": { "env": { "ENNIO_ENABLED": "1" } },
    "production": { "env": { "ENNIO_ENABLED": "0" } }
  }
}
```

### Pre-ship CI guard

Add this to your release pipeline. Exits non-zero if any Ennio symbol
leaked into the binary:

```bash
nm -gU build/Build/Products/Release-iphoneos/YourApp.app/YourApp \
  2>/dev/null \
  | grep -E "_OBJC_CLASS_\$_EnnioAutoInit|EnnioCore|__ennio_invokeOnPress" \
  && { echo "FAIL: Ennio symbols in release build"; exit 1; } \
  || echo "OK: no Ennio in release"
```

## Limitations

- **Android not yet supported.** Some scaffolding is present in the source
  tree (CMake, Gradle, nitrogen Android codegen) but no runtime: no
  `+load`-equivalent bootstrap, no JNI hook, no JS-thread executor.
  Setting `ENNIO_ENABLED=true` for Android builds currently has no effect
  — do not rely on it.

## License

MIT.
