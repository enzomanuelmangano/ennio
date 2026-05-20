# ennio

> [!WARNING]
> **Experimental.** APIs, package names, internals, and behavior may
> change without notice. iOS only. Expect rough edges; do not rely on
> it for production-critical test suites yet.

Maestro-compatible E2E test runner for React Native iOS.

The CLI drives the in-app runtime through Metro's Hermes Inspector (CDP)
and actuates real CoreSimulator touches via a persistent `idb` HID
daemon. No XCTest helper, no `xcodebuild` cold-start, no synthetic
UITouch that half-fires recognizers — the gesture goes through the same
path a finger would.

```bash
bun add -D @reactiive/ennio          # or npm install --save-dev

bunx ennio test e2e/01-auth-flow.yaml      # one flow
bunx ennio test e2e/                       # every *.yaml in the directory
```

That's it. No config plugin to add, no `expo prebuild`, no pod
install. Ennio ships per-RN-version prebuilt dylibs in the npm
tarball; the CLI `DYLD_INSERT_LIBRARIES`-injects the matching slice
into your existing Debug build at simulator launch time.

Verify install integrity with `npm audit signatures` (CI publishes
with Sigstore provenance).

## Requirements

- Expo app on React Native ≥ 0.81 (New Architecture, Fabric)
- iOS 17+ simulator
- Xcode 16+, Node 18+
- Facebook's `idb` toolchain — gRPC server + Python client (the
  HID daemon imports the `idb` python package):

  ```bash
  brew install facebook/fb/idb-companion
  pip3 install fb-idb
  ```

## How injection works

The CLI sets `DYLD_INSERT_LIBRARIES` on the simulator's launchctl env
to a tiny RN-agnostic shim (`libennio-shim.dylib`, ~30 KB). The shim
loads into every process on the sim but gates on three checks:

1. **`RCTInstance` class present** — catches non-RN apps + system daemons.
2. **Bundle id matches `ENNIO_TARGET_BUNDLE_ID`** — catches stale env
   leaking into a different RN app on the same sim.
3. **No App Store receipt** — catches accidental real-device install.

When all three pass, the shim `dlopen`s the per-RN-version slice
(`libennio-rn<X.Y.Z>-sim.dylib`, ~3 MB). The slice's `+load` swizzles
`RCTHost.start`, captures the live `jsi::Runtime`, and installs the
`__ennioDispatch` JSI host function the CLI drives via Hermes
Inspector CDP. Identical surface + performance to the pod-based
install — different load mechanism.

The CLI verifies each dylib's SHA-256 against `prebuilt/manifest.json`
before arming the env; a mismatch refuses injection.

## Alternative: pod-based install

If you'd rather link Ennio statically into your Debug build:

```bash
bun add @reactiive/ennio react-native-nitro-modules
bun add -d @reactiive/ennio-expo-plugin
```

Add the plugin to `app.json`:

```json
{
  "plugins": ["expo-router", "@reactiive/ennio-expo-plugin"]
}
```

Rebuild (`npx expo prebuild --clean && npx expo run:ios`). The plugin
tags the pod as `:configurations => ['Debug']` so Release binaries are
unaffected.

To make sure the CLI doesn't double-up runtime injection on top of
the pod-linked symbols:

```bash
ENNIO_DISABLE_DYLIB=1 npx ennio test e2e/
```

## Docs

Full architecture notes, security model, supported Maestro commands, and
example flows live in the [monorepo README](https://github.com/enzomanuelmangano/ennio#readme).

## License

MIT

## Trademarks

Maestro is a trademark of mobile.dev. Ennio is an independent
project, not affiliated with mobile.dev. References to "Maestro"
describe only the YAML flow format that Ennio consumes; no Maestro
source code is bundled or redistributed.
