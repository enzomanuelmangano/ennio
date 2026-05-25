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

No config plugin, no `expo prebuild`, no pod install. Ennio ships
per-RN-version prebuilt dylibs in the npm tarball; the CLI injects
the matching slice at simulator launch time.

## Requirements

- React Native ≥ 0.83 (New Architecture, Fabric)
- iOS 17+ simulator
- Xcode 16+, Node 18+
- Facebook's `idb` toolchain:

  ```bash
  brew install facebook/fb/idb-companion
  pip3 install fb-idb
  ```

## How it works

The CLI sets `DYLD_INSERT_LIBRARIES` on the simulator's launchctl env
to a tiny RN-agnostic shim (`libennio-shim.dylib`, ~50 KB). The shim
loads into every process on the sim but only activates when:

1. `RCTInstance` class is present (skips non-RN apps + system daemons)
2. Bundle id matches `ENNIO_TARGET_BUNDLE_ID` (skips other RN apps)
3. No App Store receipt (prevents accidental device injection)

When all three pass, the shim `dlopen`s the per-RN-version slice
(`libennio-rn<X.Y.Z>-sim.dylib`, ~530 KB). The slice's `+load`
bootstraps a Unix socket server, swizzles `setAccessibilityIdentifier:`
for O(1) testID lookup, and installs React commit observers for
frame-level settle detection.

The CLI verifies each dylib's SHA-256 against `prebuilt/manifest.json`
before injection; a mismatch refuses to proceed.

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
