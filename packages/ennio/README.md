# ennio

> [!WARNING]
> **Experimental.** APIs, package names, internals, and behavior may
> change without notice. iOS only. Expect rough edges; do not rely on
> it for production-critical test suites yet.

Maestro-compatible E2E test runner for React Native iOS.

The CLI injects a prebuilt ObjC dylib into your simulator app via
`DYLD_INSERT_LIBRARIES` and drives it through a Unix socket. Real
CoreSimulator touches are dispatched via `idb` gRPC HID — the gesture
goes through the same path a finger would. No XCTest, no CDP, no
companion driver.

```bash
bun add -D @reactiive/ennio          # or npm install --save-dev

bunx ennio test e2e/01-auth-flow.yaml      # one flow
bunx ennio test e2e/                       # every *.yaml in the directory
```

No config plugin, no `expo prebuild`, no pod install. Ennio ships a
single universal prebuilt dylib in the npm tarball; the CLI injects
it at simulator launch time.

## Requirements

- A React Native iOS app — architecture-agnostic. The dylib has no
  RN-version-specific linkage; both Paper and Fabric (New
  Architecture) commit signals are supported.
- A **dev / debug simulator build** of your app (e.g. `expo run:ios`
  or an Xcode Debug scheme). The dylib refuses to start in App Store
  and Enterprise distribution builds.
- iOS simulator (tested on iOS 17–18; bleeding-edge OS/RN combos may
  hit injection issues — see the issue tracker)
- Xcode 16+, Node 18+
- Facebook's `idb` toolchain — checked at startup and installed with
  your consent if missing. To install manually:

  ```bash
  brew install facebook/fb/idb-companion
  pip3 install fb-idb
  ```

## How it works

The CLI launches your app with `DYLD_INSERT_LIBRARIES` pointing at the
prebuilt `libennio.dylib` (set via `SIMCTL_CHILD_*` on `simctl launch`,
so only the target app inherits it). At `+load` time the dylib gates
itself:

1. The host must be an iOS app bundle (`CFBundlePackageType == APPL`
   with a bundle id) — skips simctl helpers and system daemons.
2. No App Store / Enterprise distribution markers — the dylib refuses
   to wire its socket in production-looking builds, on top of the
   build-time exclusion from Release configurations.

When the gates pass, the dylib bootstraps a Unix socket server,
swizzles `setAccessibilityIdentifier:` for O(1) testID lookup, and
installs a React commit observer for frame-level settle detection —
Fabric mount methods preferred, Paper as fallback. Every swizzle
candidate is signature-checked before attaching (methods with
non-forwardable C++ signatures are skipped); if nothing safe matches,
settle falls back to view-hash polling.

Before injecting, the CLI verifies the prebuilt dylib's SHA-256
against `prebuilt/manifest.json` and refuses on mismatch. Local dev
builds (`/tmp/ennio-build/`) and explicit `ENNIO_DYLIB_PATH` overrides
skip the check.

If an in-app hook ever conflicts with your stack, `--safe-mode` (or
the granular `ENNIO_DISABLE_*` env flags) disables them and falls back
to polling-based settle.

### Discovery

Element discovery uses UIKit accessibility — no fiber walking, no
shadow tree traversal. The swizzled testID index provides O(1) lookup
by `accessibilityIdentifier`. Text-based finds walk the view hierarchy
with on-screen filtering, topmost-VC scoping, and interactive-ancestor
promotion.

### Touch delivery

Touches go through `idb_companion`'s gRPC HID service, which
synthesizes `IOHIDEvent`s at the CoreSimulator level. Same touch
pipeline as a physical finger — UIKit gesture recognizers, React
Native's responder system, and RNGH all see a real touch.

## Supported Maestro commands

`launchApp`, `clearState`, `tapOn`, `longPressOn`, `doubleTapOn`,
`swipe`, `scrollUntilVisible`, `inputText`, `eraseText`, `pressKey`,
`inputRandomText`, `inputRandomNumber`, `assertVisible`,
`assertNotVisible`, `hideKeyboard`, `back`, `takeScreenshot`,
`setClipboard`, `pasteText`, `runFlow`, `runScript`,
`extendedWaitUntil`

## License

MIT

## Trademarks

Maestro is a trademark of mobile.dev. Ennio is an independent
project, not affiliated with mobile.dev. References to "Maestro"
describe only the YAML flow format that Ennio consumes; no Maestro
source code is bundled or redistributed.
