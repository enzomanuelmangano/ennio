# Ennio

Maestro-compatible E2E test runner for React Native. 

```bash
ennio test e2e/01-auth-flow.yaml      # one flow
ennio test e2e/                       # every *.yaml in the directory
```

### Why? 

E2E tests are the most reliable way to ensure your product is stable. As the time it takes to build software keeps shrinking, verification is becoming the bottleneck.

The vision behind this package is to:
- speed up verification as much as possible.
- give your agent the fastest possible eyes and hands
- provide a consistent way to [design loops instead of prompts](https://x.com/steipete/status/2063697162748260627?s=20).

### Install

```bash
npm install -g @reactiive/ennio      # or bun add -g @reactiive/ennio
```

No config plugin, no `npx expo prebuild`, no pod install, no rebuild —
and nothing to add to your app's dependencies. Ennio is a standalone
CLI: install it globally, point it at any simulator app. It ships a
universal prebuilt dylib in the npm tarball and injects it at
simulator launch time. Works across RN versions and both
architectures.

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
ennio test e2e/login.yaml
```

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

https://github.com/user-attachments/assets/8734572f-f90c-4658-9cba-98642d0da2d5

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
ennio improvise [bundleId]        # play the app without a score — autonomous crash hunt, exit 0/1
ennio hierarchy                   # dump the in-app shadow tree as JSON
ennio screenshot [path]           # grab the simulator screen
ennio doctor                      # diagnose Node, Xcode, enniohid, dylib + app socket
ennio doctor --smoke <bundleId>   # end-to-end self-test: inject, read, actuate
ennio mcp                         # serve ennio over MCP (stdio) for an AI agent
```

### Flags

| Flag                   | Default        | What it does                                                                                                                                                                                                                                                  |
| ---------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--verbose`, `-v`      | on             | Per-step inline output + timing.                                                                                                                                                                                                                              |
| `--quiet`, `-q`        | off            | Suppress per-step output.                                                                                                                                                                                                                                     |
| `--reporter=<kind>`    | `pretty`       | `pretty` or `json`.                                                                                                                                                                                                                                           |
| `--lenient`            | off            | Skip unknown commands with a warning instead of failing.                                                                                                                                                                                                      |
| `--android` / `--ios`  | iOS            | Backend. `--android` drives an emulator/device over adb.                                                                                                                                                                                                      |
| `--disable-reuse-app`  | reuse **on**   | Force a full relaunch on `clearState`. By default ennio reuses the running app (soft-reset: data wipe + JS reload) between flows — much faster across a suite.                                                                                                |
| `--disable-animations` | off            | Suppress app animations (transitions snap to the final frame). Faster, but alters animated UI.                                                                                                                                                                |
| `--in-process-tap`     | off (real HID) | **iOS only.** Actuate taps via in-process activation (with a per-gesture real-HID fallback) instead of real HID touches. Faster on some apps, but skips the real gesture path — the default real-HID actuation is more faithful.                              |
| `--safe-mode`          | off            | Disable all in-app hooks (swizzles/observers). Slower settle, but survives injection conflicts.                                                                                                                                                               |
| `--disable-touches`    | touches shown  | Touch visualization is **on by default**: every tap/swipe/drag ennio performs is drawn on the device (iOS: in-app ripple overlay; Android: the OS _show touches_ setting) and disarmed when the session ends. Disable for pixel-exact screenshot comparisons. |
| `--record`             | off            | Record the whole run to an `.mp4` (`simctl recordVideo`, iOS only). Saved into `--output` or the cwd; the path is printed at the end.                                                                                                                         |

### `ennio improvise`

Drives the app without a script to find crashes — the exit code is the
product (`0` survived, `1` crashed, with the `.ips` report path and a
seed to replay the exact walk). It's not a random tapper: it signs each
screen to know where it's been, skips elements on screens occluded
behind a modal or push, fills text inputs with format-plausible values
before pressing the primary action, follows flow CTAs
(next/submit/checkout) to completion, scrolls to reveal below-the-fold
content, and drags sliders. Warm-starts on the current screen by
default.

Crawl-specific flags — `--duration`, `--seed`, `--deny`, `--max-depth`,
`--max-nodes`, `--output`, `--relaunch` — are documented in full in the
package README.

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

## MCP server

`ennio mcp` exposes the runner as a
[Model Context Protocol](https://modelcontextprotocol.io) server over
stdio, so an AI agent can drive a device directly — read the screen,
decide, act — using the same find → settle → actuate pipeline an
`ennio test` run uses. Taps and swipes go through the HID driver, so
ennio is always the tap path, never a passthrough.

Tool-agnostic by design: works identically with any MCP client
(Claude Code, Cursor, Cline, or a hand-rolled one). Add it to a
client's MCP config:

```jsonc
{
  "mcpServers": {
    "ennio": { "command": "ennio", "args": ["mcp"] },
  },
}
```

The tool surface (`ennio_<verb>`) is a versioned public contract —
structured `{ ok, data | error }` results, one selector model
(`testID` | `text` | normalized `point`), capability negotiation via
`ennio_status` — enforced by an executable conformance suite. Full
tool list and contract details in
[`packages/ennio/README.md`](packages/ennio/README.md#mcp-server).

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

- **iOS** is the primary target — the most coverage so far.
- **Android** is **newer** — opt-in via `--android` (or
  `ENNIO_PLATFORM=android`). In-process agent injection (JVMTI attach /
  ptrace — works on non-debuggable release builds). The full example
  suite (40 flows) runs green and stable on CI, but the path has seen
  less real-world use than iOS.

## Sponsor

If ennio saves your team time — faster E2E runs, no XCTest tax —
consider leaving a star or
[sponsoring the project](https://github.com/sponsors/enzomanuelmangano).

## License

MIT.

## Trademarks

Maestro is a trademark of mobile.dev. Ennio is an independent
project, not affiliated with mobile.dev. References to "Maestro"
describe only the YAML flow format that Ennio consumes; no Maestro
source code is bundled or redistributed.
