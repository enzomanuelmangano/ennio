# Ennio

> [!WARNING]
> **Experimental.** Ennio is at an early experimental stage. APIs,
> package names, internals, and behavior may change without notice.
> iOS only. Expect rough edges; do not rely on it for production-
> critical test suites yet.

Maestro-compatible E2E test runner for React Native iOS. The CLI drives
the in-app runtime through Metro's Hermes Inspector (CDP). Two-phase
model for every interaction:

1. **JSI discovery** — a `prepareTap` JSI host function walks the Fabric
   shadow tree, finds the element by `testID`, runs an auto-scroll +
   on-screen + hit-test check, and returns its window-coord center in
   one CDP round trip.
2. **idb HID actuation** — a real `UITouch` is delivered at those
   coords via `idb_companion` (CoreSimulator's IOHID layer). The
   gesture goes through the same path a finger would — exercising
   `UIControl`, RNGH state machines, `PressableScale` animations, and
   any other recognizer the app is using.

No XCTest helper, no `xcodebuild` cold-start, no UITouch synthesis that
half-fires recognizers. JSI handles the read side too: shadow-tree
existence, visibility, text, layout, alert introspection.

```
npx ennio test e2e/01-auth-flow.yaml      # one flow
npx ennio test e2e/                       # every *.yaml in the directory
```

https://github.com/user-attachments/assets/97a32505-e4d2-4661-8ed6-7915c0ced1f8

## Getting started

Requires an Expo app on RN ≥ 0.81 (New Architecture, Fabric), iOS 17+
simulator, Xcode 16+, Node 18+, and Facebook's `idb` toolchain (both
the gRPC `idb_companion` server and the Python client used by Ennio's
HID daemon):

```bash
brew install facebook/fb/idb-companion
pip3 install fb-idb
```

**1. Install**

```bash
bun add @reactiive/ennio react-native-nitro-modules
bun add -d @reactiive/ennio-expo-plugin
```

(Or use the equivalent `npm install` / `yarn add` — `ennio-expo-plugin`
is a build-time config plugin, so it belongs in `devDependencies`.)

**2. Register the plugin** — add `"@reactiive/ennio-expo-plugin"` to `app.json`:

```json
{
  "plugins": ["expo-router", "@reactiive/ennio-expo-plugin"]
}
```

**3. Prebuild + run**

```bash
npx expo prebuild --clean
npx expo run:ios
```

The plugin tags the pod as `:configurations => ['Debug']`, so Ennio
is compiled + linked **only** for Debug builds. Release archives carry
zero Ennio code, symbols, or `+load` hooks — automatic, no env var
to remember. Inside a Debug build, autolinking adds the pod and a
`+load` swizzle installs the `__ennioDispatch` JSI host function plus
a React `onCommitFiberRoot` hook (so native can detect commit settle)
before the first frame. Keep Metro running — the CLI reaches the app
through Metro's Hermes Inspector.

(Optional: a red diagonal **E2E** ribbon paints top-right of every
screen if you set `showRibbon: true` in the plugin options — useful
for QA artifact identification or demo videos. Off by default.)

**4. Write a Maestro YAML flow** (`e2e/login.yaml`):

```yaml
appId: com.your.app
---
- launchApp:
    clearState: true
- tapOn:
    id: 'email-input'
- inputText: 'user@example.com'
- tapOn: 'Continue'
- assertVisible:
    id: 'home-screen'
```

**5. Run it**

```bash
npx ennio test e2e/login.yaml
```

That's it. See [Build gating](#build-gating) for plugin options and
how Ennio stays out of Release builds.

## Architecture

```
┌─ host machine ─────────────────────────────────────────┐
│  ennio CLI (Node)                                      │
│    CDP client ──ws localhost:8081/inspector──┐         │
│                                              │         │
│    idb HID daemon (Python, Unix socket)──┐   │         │
│      └─ gRPC ─► idb_companion ──HID──┐   │   │         │
└──────────────────────────────────────┼───┼───┼─────────┘
                                       │   │   │
                              ┌────────┘   │   │
                              │            │   │
                              ▼            │   │
                  ┌─ CoreSim IOHID ──┐     │   │
                  │ real UITouch     │     │   │
                  │ injected into…   │     │   │
                  └────────┬─────────┘     │   │
                           │      ┌────────┘   │
                           │      ▼            │
                           │  Metro (host) ◄───┘
                           │   Hermes Inspector proxy
                           │            │ (CDP / WebSocket)
                           │            ▼
                           ▼  ┌─────────────────────────────┐
                              │ iOS sim / device — app      │
                              │  Hermes runtime             │
                              │   globalThis.__ennioDispatch│
                              │   (JSI host fn installed    │
                              │    at +load swizzle time)   │
                              │            │                │
                              │            ▼                │
                              │  HybridEnnio (C++)          │
                              │   • Fabric ShadowTreeTraverser │
                              │   • UIKit frame queries     │
                              │   • UIAlertController intro │
                              │   • prepareTap (find+coord) │
                              │                             │
                              │  Special UIKit selectors:   │
                              │   • UITabBarController      │
                              │     delegate + selectedIdx  │
                              │   • UIAlertController       │
                              │     action invocation       │
                              │   • UINavigationController  │
                              │     popViewController       │
                              └─────────────────────────────┘
```

Two channels, separate jobs:

- **CDP via Hermes Inspector — discovery & reads.** The CLI sends
  `Runtime.evaluate` calls that invoke
  `__ennioDispatch(type, payloadJson, token)` on `globalThis`.
  Dispatch is non-blocking: the host function queues the work on a
  background worker and returns a token immediately so the JS thread
  is never held. The CLI polls the result via a follow-up
  `Runtime.evaluate` against a result slot. The worker schedules the
  actual work (shadow-tree walk, hit-test, frame computation) back
  onto the JS thread when it's ready. This is how every
  `assertVisible`, `getText`, `prepareTap`, and layout query flows.
- **idb HID — actuation.** Every tap, long-press, swipe, and
  `typeText` delivers a real `UITouch` / key event through
  CoreSimulator's IOHID layer. A persistent Python daemon keeps one
  gRPC channel warm to `idb_companion`; calls cost ~5 ms instead of
  the ~250 ms per-spawn `idb ui tap` baseline. Falls back to
  spawning `idb` directly if the daemon dies. Three special cases
  bypass HID entirely — tab-bar taps, native-alert button taps, and
  the iOS back gesture — because driving those through UIKit
  selectors (`UITabBarController` delegate, `UIAlertController`
  action invocation, `UINavigationController popViewController`) is
  more deterministic than a gesture.

## How taps work

https://github.com/user-attachments/assets/42c38084-551f-41c0-90c3-02e62c13e617

One CDP round trip for discovery, one HID delivery for the touch. Why
not invoke `onPress` directly via JSI (the old design)? Two reasons:

- **RNGH state machines.** Components wrapped in
  `react-native-gesture-handler` (the default for most modern RN
  apps — `Pressable` with `pressRetentionOffset`, `PressableScale`,
  `BaseButton`) don't expose a plain `onPress` on the matched fiber.
  The gesture handler owns the press state and only fires through a
  real touch sequence.
- **Layout-bug masking.** Calling `onPress` directly worked even when
  the view was off-screen, behind a modal, or covered by an overlay.
  That let flows pass which a real user could never have completed —
  silently. Maestro / XCUI both refuse off-screen taps; matching that
  behavior catches real layout regressions.

JSI is still the fast path for discovery (one round trip beats N) and
for everything read-only. Actuation lives on idb.

`typeText`, `pressKey`, and `swipe` go straight to idb too — no
`prepareTap` step needed.

## CLI

```bash
ennio test <flow.yaml>            # one flow
ennio test e2e/                   # every *.yaml under the directory, in order
ennio test --verbose e2e/         # log every step + RPC
ennio test --trace e2e/           # per-step state snapshot
```

`ENNIO_UDID=<udid>` pins to a specific simulator when multiple are
booted. `ENNIO_DEBUG_IDB=1` logs every HID call.

The app must already be running on the simulator **with Metro
attached**. The CLI reaches the app through Metro's Hermes Inspector
channel; without Metro there is no transport. Ennio does not launch
the app itself — use `npx expo run:ios` or run from Xcode with Metro
started separately.

### Test independence

Each flow that begins with `launchApp { clearState: true }` is fully
independent: Ennio terminates the app, wipes its `Library/`,
`Documents/`, and `tmp/` directories, resets privacy permissions, then
re-launches. The CDP channel reconnects through Hermes Inspector
automatically once the fresh app process attaches to Metro.

For `ennio test e2e/`, flows run sequentially, each carrying its own
`clearState`, so cross-flow leakage is impossible if the YAML opts in.
A flow that omits `launchApp` inherits the previous flow's state by
design — used for split flows that share auth setup.

```bash
# Same flow back-to-back — rules out sim quirks
for i in 1 2 3; do npx ennio test e2e/03-cart.yaml; done

# Verbose, just the tail
npx ennio test --verbose e2e/03-cart.yaml | tail -50
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
- `launchApp: { clearState: true }`
- `repeat`, `retry`
- Native alerts: `tapAlertButton`, `dismissAlert`. `assertVisible: text:`
  also matches alert titles + button labels.

## Build gating

`@reactiive/ennio-expo-plugin` writes a single `pod 'EnnioCore'` line
into the generated `Podfile`, tagged with `:configurations => ['Debug']`.
CocoaPods compiles + links the pod **only** for the listed Xcode
build configurations:

| Xcode configuration            | Ennio in binary?                               |
| ------------------------------ | ---------------------------------------------- |
| `Debug`                        | Yes                                            |
| `Release`                      | **No** (zero code, zero symbols, zero `+load`) |
| Custom config (e.g. `Staging`) | Only if listed in plugin options               |

No env var. No prebuild discipline. Release archives can't carry
Ennio even if someone tries — CocoaPods literally skips the source.
**Safe to keep `@reactiive/ennio-expo-plugin` in `app.json` for
production-shipping apps.**

Plugin options (all optional):

```json
{
  "plugins": [
    [
      "@reactiive/ennio-expo-plugin",
      {
        "configurations": ["Debug", "Staging"],
        "showRibbon": true,
        "enabled": true
      }
    ]
  ]
}
```

| Option           | Default     | What it does                                                                                                |
| ---------------- | ----------- | ----------------------------------------------------------------------------------------------------------- |
| `configurations` | `["Debug"]` | Xcode build configurations to link EnnioCore into. Extend for custom configs (e.g. `Staging`).              |
| `showRibbon`     | `false`     | Paint the red diagonal **E2E** ribbon on every screen. Useful for QA artifact identification / demo videos. |
| `enabled`        | `true`      | Set to `false` to skip the plugin entirely.                                                                 |

CI sanity check before signing a release artifact (should always
pass):

```bash
nm -gU build/Build/Products/Release-iphoneos/YourApp.app/YourApp \
  2>/dev/null \
  | grep -E "_OBJC_CLASS_\$_EnnioAutoInit|EnnioCore|__ennioDispatch" \
  && { echo "FAIL: Ennio symbols in release build"; exit 1; } \
  || echo "OK: no Ennio in release"
```

## Limitations

- **Android not yet supported.** Some scaffolding exists in the source
  tree (CMake, Gradle, nitrogen Android codegen) but no runtime: no
  `+load`-equivalent bootstrap, no JNI hook, no JS-thread executor.
  The plugin is iOS-only — adding `@reactiive/ennio-expo-plugin` to an
  Android-only build is a no-op.
- **Requires Metro.** With no Metro running, there is no Hermes
  Inspector to connect to. The CLI errors out immediately. Tests can't
  run against a standalone simulator build that has no host attached.
- **Bridgeless / Fabric only.** Old-architecture RN is not supported;
  the shadow-tree traverser and the React-commit hook assume the new
  arch.

## License

MIT.

## Trademarks

Maestro is a trademark of mobile.dev. Ennio is an independent
project, not affiliated with mobile.dev. References to "Maestro"
describe only the YAML flow format that Ennio consumes; no Maestro
source code is bundled or redistributed.
