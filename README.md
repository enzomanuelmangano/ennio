# Ennio

Maestro-compatible E2E test runner for React Native iOS, built on top of
the Fabric shadow tree. Every action and assertion goes through the user
app over a single WebSocket — no XCTest, no `xcodebuild test`, no HID
injection, no cold-start tax.

```
ennio e2e/01-auth-flow.yaml
ennio e2e/                # runs every *.yaml under the directory
```

## Architecture

```
ennio CLI (Bun/Node)
    │  ws :9876
    ▼
@ennio/core (in-app Nitro module)
    │
    ├─ READS  → Fabric shadow tree (testID + props + layout)
    └─ WRITES → UIControl.sendActions / accessibilityActivate /
                synthesised UITouch / UIScrollView APIs
```

Reads traverse the React-side shadow tree directly. Writes pick the
fastest in-process activation path on the matched UIView and only fall
to a synthesised `UITouch` event as a last resort.

## Why Nitro-only

Maestro / Detox / Appium drive the simulator from outside the app
through `xcodebuild test` + XCUI HID injection. That round-trip costs
~250 ms per action and adds a 10–15 s cold-start to every suite.

Ennio runs in-process. Typical numbers:

| operation | Maestro / XCUI | Ennio (Nitro) |
|---|---|---|
| `assertVisible: id` | 200–400 ms | 5–10 ms |
| `tapOn: id` | 200–400 ms | 5–15 ms |
| `tapOn: text` | 200–400 ms | 5–15 ms |
| 30-step flow | 60–90 s | 5–15 s |

## Requirements

- React Native ≥ 0.74 with the New Architecture (Fabric)
- iOS 17+ simulator (tested on iPhone 17 Pro / iOS 26)
- Xcode 16+
- Bun or Node.js 18+
- Expo prebuild (bare RN works with manual Podfile edits)

iOS only. Android is out of scope.

## Setup

Install the runtime + plugin in the user app:

```bash
bun add @ennio/core @ennio/expo-plugin
```

`app.json` / `app.config.ts`:

```json
{ "plugins": ["@ennio/expo-plugin"] }
```

Boot the in-app WebSocket server by importing the module once at the top
of your root layout:

```tsx
import '@ennio/core';
```

Prebuild + run iOS:

```bash
bunx expo prebuild --platform ios --clean
bunx expo run:ios
```

The pod is conditionally included; set `ENNIO_ENABLED=0` at prebuild
time to ship without it.

Install the CLI:

```bash
bun add -g @ennio/cli
```

## CLI

```bash
ennio <flow.yaml>          # single flow
ennio e2e/                 # every *.yaml under directory
ennio --port=9876          # change WebSocket port
ennio --verbose            # log every Nitro RPC
```

The user app must be running on the simulator before you invoke ennio —
the CLI connects to the in-app WebSocket server, it does not launch the
app on its own (use `xcrun simctl launch` or run from Xcode).

`ENNIO_UDID` pins to a specific simulator when multiple are booted.

## Maestro flow support

The runner targets [Maestro YAML](https://maestro.mobile.dev/). Supported
commands cover the typical mobile flow:

- `tapOn`, `doubleTapOn`, `longPress`
- `inputText`, `clearText`, `eraseText`, `pressKey`
- `assertVisible`, `assertNotVisible`, `waitFor`
- `scroll`, `scrollUntilVisible`, `swipe`, `back`, `hideKeyboard`
- `runFlow` (subflows + `when` conditionals)
- `runScript`, `evalScript`, top-level `env:` block, `${VAR}` interpolation
- `tapOn: { point: "X%,Y%" }`
- `tapOn: { label: "..." }` (alias for `text:`)
- bare-string shorthand `tapOn: "Some Text"` → text match
- `launchApp: { clearState: true }` (terminates app, wipes Library /
  Documents / tmp on the simulator data container, restarts)
- `repeat`, `retry`
- alerts: `tapAlertButton`, `dismissAlert`, `assertVisible: text:` on
  alert title or button

## Repo layout

```
packages/
  core/         @ennio/core       — in-app Nitro module (C++/Obj-C)
  cli/          @ennio/cli        — `ennio` binary, Maestro YAML runner
  expo-plugin/  @ennio/expo-plugin — Podfile patch + plugin entry
example/        Sample RN app + e2e/ flows used as the canonical
                end-to-end test bed for the runner.
```

## Limitations

- iOS-simulator only.
- Activations beyond Pressable / UIControl / accessibilityActivate (e.g.
  complex RNGH gestures, swipe-to-reorder) fall back to a synthesised
  `UITouch` and may not reach handlers that filter synthetic events.
  Add an explicit testID on the wrapper to give the runner a stable
  target.
