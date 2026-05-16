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
npm install @reactiive/ennio @reactiive/ennio-expo-plugin react-native-nitro-modules
npx ennio test e2e/01-auth-flow.yaml      # one flow
npx ennio test e2e/                       # every *.yaml in the directory
```

## Requirements

- Expo app on React Native ≥ 0.81 (New Architecture, Fabric)
- iOS 17+ simulator
- Xcode 16+, Node 18+
- `idb_companion` (`brew install facebook/fb/idb-companion`)

## Setup

The accompanying [`@reactiive/ennio-expo-plugin`](https://www.npmjs.com/package/@reactiive/ennio-expo-plugin)
links the native runtime into **Debug builds only** via CocoaPods
`:configurations`. Add it to `app.json`:

```json
{
  "plugins": ["expo-router", "@reactiive/ennio-expo-plugin"]
}
```

Then rebuild your app (`npx expo prebuild --clean && npx expo run:ios`).

## Docs

Full architecture notes, security model, supported Maestro commands, and
example flows live in the [monorepo README](https://github.com/enzomanuelmangano/ennio#readme).

## License

MIT
