# Ennio

> [!WARNING]
> **Experimental.** APIs, package names, internals, and behavior may
> change without notice. iOS is the primary target and further along;
> **Android is earlier-stage** (opt-in via `--android`). Expect rough
> edges on both; do not rely on it for production-critical test suites yet.

Maestro-compatible E2E test runner for React Native iOS. The CLI
injects a prebuilt ObjC dylib into your simulator app via
`DYLD_INSERT_LIBRARIES` and drives it through a Unix socket. Real
CoreSimulator touches are dispatched by an in-house host helper that
posts Indigo HID events straight to the simulator — the gesture goes
through the same path a finger would.

No XCTest, no CDP, no Metro required, no companion driver.

```bash
npx ennio test e2e/01-auth-flow.yaml      # one flow
npx ennio test e2e/                       # every *.yaml in the directory
```

https://github.com/user-attachments/assets/8734572f-f90c-4658-9cba-98642d0da2d5

## Getting started

Requires a React Native app (New Architecture, Fabric), iOS 17+
simulator, Xcode 16+, and Node 18+. No extra toolchain — touches are
driven by an in-house helper that links Xcode's own CoreSimulator /
SimulatorKit frameworks. No Homebrew formula, no pip.

### Install

```bash
bun add -D @reactiive/ennio          # or npm install --save-dev
```

No config plugin, no `npx expo prebuild`, no pod install, no rebuild.
Ennio ships a universal prebuilt dylib in the npm tarball; the CLI
injects it at simulator launch time. Works across all New Architecture
RN versions.

**Write a Maestro YAML flow** (`e2e/login.yaml`):

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

**Run it:**

```bash
npx ennio test e2e/login.yaml
```

The CLI:

1. Picks the dylib from `node_modules/@reactiive/ennio/prebuilt/`.
2. Verifies its SHA-256 against `prebuilt/manifest.json` (refuses on
   mismatch — see [Security](#security)).
3. Sets `DYLD_INSERT_LIBRARIES` and `ENNIO_TARGET_BUNDLE_ID` on the
   simulator's launchctl env.
4. Launches your app via `simctl`.
5. The shim dylib gates on bundle-id + RN-app presence and dlopens
   the real dylib only inside your targeted app.
6. The dylib bootstraps a Unix socket server, the CLI connects and
   drives the test flow.
7. Clears the launchctl env on exit so the simulator is left clean.

## How it works

### Discovery

Element discovery uses UIKit accessibility — no fiber walking, no
shadow tree traversal. A swizzled `setAccessibilityIdentifier:` hook
provides O(1) testID lookup. Text-based finds walk the view hierarchy
with on-screen filtering, topmost-VC scoping, and interactive-ancestor
promotion.

### Touch delivery

Touches go through an in-house host helper (`enniohid`) that posts
Indigo HID events to the simulator via CoreSimulator / SimulatorKit
(`SimDeviceLegacyHIDClient`), built with a vendored (MIT, from Meta's
FBSimulatorControl) Indigo message struct + builder. Same touch
pipeline as a physical finger — UIKit gesture recognizers, React
Native's responder system, and RNGH all see a real touch. No external
daemon.

Three special cases bypass HID — tab-bar taps, native-alert button
taps, and the iOS back gesture — because driving those through UIKit
selectors is more deterministic than a gesture.

### Settle detection

The dylib observes React commits via swizzled mount methods and tracks
view-tree stability via a CADisplayLink frame-hash ticker. The CLI
uses these signals (`wait_commit`, `wait_react_commit`) to know when
a tap's side effects have settled before proceeding to the next step.

## Architecture

```
+-- host machine -------------------------------------------+
|  ennio CLI (Node)                                         |
|    Unix socket client                                     |
|    enniohid helper -- CoreSimulator Indigo HID ---------+ |
+-------------------------------|-------------------------|-+
                                |                         |
                   +-- iOS Simulator --+ <----------------+
                   |                   |
                   |  CoreSim IOHID    |
                   |  (real UITouch)   |
                   |       |           |
                   |       v           |
                   |  Your RN App      |
                   |    +----------+   |
                   |    | ennio    |   |
                   |    | dylib    |   |
                   |    |          |   |
                   |    | Unix     |   |
                   |    | socket   |<--+-- CLI commands
                   |    | server   |   |
                   |    |          |   |
                   |    | a11y     |   |
                   |    | finders  |   |
                   |    |          |   |
                   |    | React    |   |
                   |    | observer |   |
                   |    +----------+   |
                   +-------------------+
```

Two channels:

- **Unix socket — discovery, reads, coordination.** The CLI sends
  JSON-envelope commands (`find_by_testid`, `visible`, `wait_commit`,
  `insert_text`, etc.) over a Unix domain socket to the in-process
  dylib. Responses are synchronous per-request.
- **enniohid host helper — touch actuation.** Every tap, long-press,
  and swipe delivers a real Indigo HID event through CoreSimulator's
  HID layer. One persistent helper process per run, fed `down/move/up`
  over stdin; calls cost ~5 ms. (Typing goes over the Unix socket via
  the dylib's `insert_text`.)

## Security

Runtime injection runs ennio's code in your app's process. The model
that keeps it safe:

1. **Sim-only.** Real-device codesigning blocks DYLD injection.
   Production builds never run ennio.
2. **Three-layer shim gate.** The shim dylib set on the sim's
   `DYLD_INSERT_LIBRARIES` only dlopens the real dylib when:
   (a) `RCTInstance` class is present, (b) bundle id matches
   `ENNIO_TARGET_BUNDLE_ID`, and (c) no App Store receipt is present.
   Other apps on the same simulator are unaffected.
3. **SHA-256 manifest.** The CLI verifies each dylib's hash against
   `prebuilt/manifest.json` before arming injection. A mismatch
   refuses to proceed.
4. **Clean-up on exit.** The CLI clears the simulator's launchctl env
   on `process.on('exit')`, `SIGINT`, `SIGTERM`, and
   `uncaughtException`. A crash mid-test never leaves stale injection.

## CLI

```bash
ennio test <flow.yaml>            # one flow
ennio test e2e/                   # every *.yaml under the directory
ennio test --verbose e2e/         # log every step + timing
```

### Flags

| Flag                   | Default        | What it does                                                                                                                                                                                                                     |
| ---------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--verbose`, `-v`      | on             | Per-step inline output + timing.                                                                                                                                                                                                 |
| `--quiet`, `-q`        | off            | Suppress per-step output.                                                                                                                                                                                                        |
| `--reporter=<kind>`    | `pretty`       | `pretty` or `json`.                                                                                                                                                                                                              |
| `--lenient`            | off            | Skip unknown commands with a warning instead of failing.                                                                                                                                                                         |
| `--android` / `--ios`  | iOS            | Backend. `--android` drives an emulator/device over adb.                                                                                                                                                                         |
| `--disable-reuse-app`  | reuse **on**   | Force a full relaunch on `clearState`. By default ennio reuses the running app (soft-reset: data wipe + JS reload) between flows — much faster across a suite.                                                                   |
| `--disable-animations` | off            | Suppress app animations (transitions snap to the final frame). Faster, but alters animated UI.                                                                                                                                   |
| `--in-process-tap`     | off (real HID) | **iOS only.** Actuate taps via in-process activation (with a per-gesture real-HID fallback) instead of real HID touches. Faster on some apps, but skips the real gesture path — the default real-HID actuation is more faithful. |
| `--safe-mode`          | off            | Disable all in-app hooks (swizzles/observers). Slower settle, but survives injection conflicts.                                                                                                                                  |

> Discovery and settle are always **in-process** (the injected dylib reads the
> view tree / React commits / a11y) — `--in-process-tap` only changes how
> _taps_ are actuated.

`ENNIO_UDID=<udid>` pins to a specific simulator when multiple are
booted. Equivalent env vars exist for several flags
(`ENNIO_NO_ANIMATIONS`, `ENNIO_REUSE_APP=0`, `ENNIO_SAFE_MODE`) for CI use.

### Test independence

Each flow that begins with `launchApp { clearState: true }` is fully
independent: Ennio terminates the app, wipes its data directories,
then re-launches. The Unix socket reconnects automatically once the
fresh app process starts.

## Maestro flow support

The runner targets [Maestro YAML](https://maestro.mobile.dev/). Covered:

- `tapOn`, `doubleTapOn`, `longPressOn`
- `inputText`, `eraseText`, `pressKey`, `inputRandomText`,
  `inputRandomNumber`
- `assertVisible`, `assertNotVisible`, `extendedWaitUntil`
- `scrollUntilVisible`, `swipe`, `back`, `hideKeyboard`
- `runFlow` (subflows), `runScript`
- `setClipboard`, `pasteText`, `takeScreenshot`
- `launchApp: { clearState: true }`
- bare-string `tapOn: "Some Text"` (text match)
- `tapOn: { id: "..." }` (testID match)

## Limitations

- **iOS** is the primary target — the most coverage so far (still experimental).
- **Android** is **earlier-stage** — opt-in via `--android` (or
  `ENNIO_PLATFORM=android`). In-process agent injection (JVMTI attach / ptrace);
  less exercised than the iOS path.

## License

MIT.

## Trademarks

Maestro is a trademark of mobile.dev. Ennio is an independent
project, not affiliated with mobile.dev. References to "Maestro"
describe only the YAML flow format that Ennio consumes; no Maestro
source code is bundled or redistributed.
