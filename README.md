# Ennio

> Maestro YAML runner for React Native iOS — fast, because reads bypass the accessibility tree.

Ennio executes [Maestro](https://maestro.mobile.dev) flows against a React Native app on the iOS simulator. Reads (`assertVisible`, `getText`, layout queries) go straight to the Fabric shadow tree through an in-app Nitro module. Writes (`tapOn`, `inputText`, `swipe`, `scroll`, alert handling) go through a bundled XCUITest helper that drives XCUI's HID injection — the only sanctioned API that wakes RN's gesture recognizer reliably on iOS 26 + Fabric.

No `<EnnioProvider>`. No private UIKit. No third-party gesture-tap shell-out.

## Requirements

- React Native 0.81+ with the new architecture (Fabric)
- iOS 17+ simulator (tested on iPhone 17 Pro / iOS 26)
- Xcode 16+
- Bun, Node.js 18+, or compatible runtime
- Expo (the plugin is built for Expo prebuild; bare RN works with manual project edits)

> Android support is out of scope. Ennio is iOS-only by design.

## How it works

```
   ┌──────────────────────────────────┐
   │         ennio CLI (Bun)          │
   │   ┌──────────┐   ┌────────────┐  │
   │   │ EnnioWS  │   │ XCTestTCP  │  │
   │   │ client   │   │ client     │  │
   │   └────┬─────┘   └─────┬──────┘  │
   └────────│───────────────│─────────┘
            │ ws://9876     │ tcp://9877
            ▼               ▼
   ┌────────────────┐  ┌──────────────────────────────┐
   │  Your RN app   │  │ EnnioXCTestRunner.xctest     │
   │  @ennio/core   │  │  (bundled UI-test target)    │
   │  Fabric reads  │  │  XCUI HID writes             │
   └────────────────┘  └──────────────────────────────┘
            │                            │
            ▼                            ▼
       Shadow tree                 Real touches /
                                   keyboard / system
                                   alerts / pasteboard
```

| Concern              | Path                                             |
|----------------------|--------------------------------------------------|
| `assertVisible`      | Fabric shadow tree (in-app Nitro module)         |
| `getText` / layout   | Fabric shadow tree                               |
| Native alert detect  | Fabric runtime helper                            |
| `tapOn`              | XCUI tap on `accessibilityIdentifier` (testID)   |
| `inputText`          | XCUI keyboard injection                          |
| `swipe` / `scroll`   | XCUI gesture                                     |
| `tapOn alert button` | XCUI alert query                                 |

The CLI launches the XCTest helper via `xcodebuild test-without-building`, waits for it to bind TCP `127.0.0.1:9877`, then runs flows. The helper stays hot across all flows in one CLI invocation, so the XCTest cold-start cost is paid once.

## Installation

```bash
bun add @ennio/core
bun add -D @ennio/cli @ennio/xctest-runner @ennio/expo-plugin
```

Add the plugin to your `app.json` / `app.config.ts`:

```json
{
  "expo": {
    "plugins": ["@ennio/expo-plugin"]
  }
}
```

Run prebuild + pod install:

```bash
bun expo prebuild
cd ios && pod install
```

This wires:

- `@ennio/core` into the Podfile so the in-app WebSocket server boots automatically (`+load` constructor).
- `EnnioXCTestRunner` UI-test target into `<YourApp>.xcodeproj` with a shared scheme.

## One-time helper build

Build the XCTest helper bundle so the CLI can launch it later:

```bash
xcodebuild build-for-testing \
  -workspace ios/<YourApp>.xcworkspace \
  -scheme EnnioXCTestRunner \
  -destination "id=$(xcrun simctl list devices booted -j | jq -r '.devices | to_entries[].value[0].udid')"
```

You only need to do this once per machine — and again whenever the helper sources change.

## Writing flows

Plain Maestro YAML. Drop them anywhere; common layout is `e2e/`:

```yaml
# e2e/auth.yaml
appId: com.example.app
name: "Auth"
---
- launchApp:
    clearState: true

- tapOn:
    text: "Home"
- assertVisible:
    id: "home-screen"
    timeout: 5000

- tapOn:
    id: "home-signin-btn"
- tapOn:
    id: "demo-login-btn"

- assertVisible:
    id: "home-screen"
    timeout: 5000
```

Selector forms supported:

- `id: "..."` — RN testID. Resolves via XCUI `accessibilityIdentifier`; falls back to Fabric layout for compound selectors.
- `text: "..."` — XCUI label search across `tabBars.buttons`, `buttons`, `staticTexts`, then any descendant.
- `id: ..., enabled/checked/focused/selected: ...` — Nitro shadow-tree query for state matching, then XCUI tap at the resolved frame.
- Alert buttons match by their title string.

## Running flows

Boot a simulator, launch your app, then:

```bash
# single flow
bun ennio e2e/auth.yaml

# every *.yaml under a directory (subflows/ excluded automatically)
bun ennio e2e/

# pin a specific simulator
ENNIO_UDID=<udid> bun ennio e2e/

# verbose: log every command + its resolution path
bun ennio e2e/ --verbose
```

Sample output:

```
🧪 Ennio

(Connected via WebSocket on port 9876)
(Launching XCTest helper...)
(XCTest helper ready on :9877)

▸ auth.yaml
  [PASS] Auth
  1 passed, 0 failed
────────────────────────────────────────
Total: 1 passed, 0 failed
```

On failure the runner saves a screenshot to `/tmp/ennio-shots/<flow>-fail.png` so you can see the simulator state before the XCTest cleanup tears the app down.

## Supported Maestro commands

Reads (handled by `@ennio/core`):

`assertVisible`, `assertNotVisible`, `assertTrue`, `waitFor`, `extendedWaitUntil`, `waitForAnimationToEnd`.

Writes (handled by the XCTest helper):

`tapOn`, `doubleTapOn`, `longPress`, `inputText`, `clearText`, `eraseText`, `pressKey`, `back`, `hideKeyboard`, `pasteText`, `setClipboard`, `copyTextFrom`, `scroll`, `scrollUntilVisible`, `swipe`.

Lifecycle / device:

`launchApp`, `clearState`, `stopApp`, `openLink`, `setLocation`, `setPermissions`, `addMedia`, `takeScreenshot`, `startRecording`, `stopRecording`.

Control flow:

`runFlow` (file + inline + conditional `when`), `repeat`, `retry`, `evalScript`, `runScript`.

## Environment variables

| Variable             | Purpose                                                   |
|----------------------|-----------------------------------------------------------|
| `ENNIO_UDID`         | Pin to a specific simulator (overrides "first booted")    |
| `ENNIO_BUNDLE_ID`    | App bundle ID handed to the XCTest helper (default `com.ennio.example`) |
| `ENNIO_XCTEST_PORT`  | Helper TCP port (default `9877`)                          |
| `ENNIO_XCWORKSPACE`  | Override `.xcworkspace` autodiscovery                     |

## Troubleshooting

**"Could not connect to the in-app Ennio server on port 9876"**
The user app isn't running. Launch it on the simulator first (`xcrun simctl launch <udid> <bundleId>` or open it from Xcode).

**"Failed to launch XCTest helper"**
Most often the helper bundle isn't built yet. Run the `build-for-testing` step from the install section. If the workspace lives outside `ios/` or `example/ios/`, set `ENNIO_XCWORKSPACE`.

**Tap lands on the wrong element**
First check the screenshot under `/tmp/ennio-shots/`. Common causes: the target is hidden behind the soft keyboard, behind a modal, or behind a tab bar. Wrap the screen with `KeyboardAvoidingView` (or use safe-area insets) so the target is reachable.

**`inputText` produces scrambled output**
Controlled `<TextInput value={state} />` re-renders during fast typing can shuffle characters. Switch the input to `defaultValue={...}` (uncontrolled) and let `onChangeText` push state forward only. The `example/` checkout screen demonstrates the pattern.

**Simulator shuts down between CLI invocations**
The helper is launched via `xcodebuild test-without-building`, which reaps the sim if it owned the boot. Boot the sim before running ennio (`xcrun simctl boot <udid>` and keep `Simulator.app` open), or run all flows in a single ennio invocation so the helper stays hot.

## Project layout

```
packages/
├── cli/             # @ennio/cli — Bun-runnable runner + WS / TCP clients
├── core/            # @ennio/core — Nitro module, WS server, Fabric reads
├── expo-plugin/     # @ennio/expo-plugin — prebuild wiring for Podfile + scheme
└── xctest-runner/   # @ennio/xctest-runner — Swift sources for the UI-test helper
example/             # demo app + maestro-e2e/ flows
```

## License

MIT
