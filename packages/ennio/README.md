# ennio

> [!WARNING]
> **Experimental.** APIs, package names, internals, and behavior may
> change without notice. iOS is the primary target; **Android is
> newer** (opt-in via `--android`) — its full example suite runs green
> and stable on CI, but it has seen less real-world use. Expect rough
> edges; do not rely on it for production-critical test suites yet.

Maestro-compatible E2E test runner for React Native iOS.

The CLI injects a prebuilt ObjC dylib into your simulator app via
`DYLD_INSERT_LIBRARIES` and drives it through a Unix socket. Real
CoreSimulator touches are dispatched by an in-house host helper that
posts Indigo HID events straight to the simulator — the gesture goes
through the same path a finger would. No XCTest, no CDP, no companion
driver.

```bash
npm install -g @reactiive/ennio      # or bun add -g @reactiive/ennio

ennio test e2e/01-auth-flow.yaml      # one flow
ennio test e2e/                       # every *.yaml in the directory
```

No config plugin, no `expo prebuild`, no pod install — and nothing to
add to your app's dependencies. Ennio is a standalone CLI: install it
globally, point it at any simulator app. It ships a single universal
prebuilt dylib in the npm tarball; the CLI injects it at simulator
launch time.

## Requirements

- A React Native iOS app — architecture-agnostic. The dylib has no
  RN-version-specific linkage; both Paper and Fabric (New
  Architecture) commit signals are supported.
- A **dev / debug simulator build** of your app (e.g. `expo run:ios`
  or an Xcode Debug scheme). The dylib refuses to start in App Store
  and Enterprise distribution builds.
- iOS simulator (tested on iOS 17–18; bleeding-edge OS/RN combos may
  hit injection issues — see the issue tracker)
- Xcode 16+, Node 18+ — and nothing else. Touches use Xcode's own
  CoreSimulator / SimulatorKit frameworks; no Homebrew, no pip, no
  idb.

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

Touches go through an in-house host helper (`enniohid`) that posts
Indigo HID events via CoreSimulator / SimulatorKit, which
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

## MCP server

`ennio mcp` exposes the runner as a [Model Context Protocol](https://modelcontextprotocol.io)
server over stdio, so an AI agent can drive a device directly: read the
screen, decide, act — using the same find → settle → actuate pipeline an
`ennio test` run uses. Taps and swipes go through the HID driver, so ennio
is always the tap path, never a passthrough.

The interface is tool-agnostic by design. It works identically with any MCP
client — Claude Code, Cursor, Cline, or a hand-rolled one — with no
client-specific coupling. Add it to a client's MCP config:

```jsonc
{
  "mcpServers": {
    "ennio": { "command": "ennio", "args": ["mcp"] },
  },
}
```

**Tools** (`ennio_<verb>`, self-describing via JSON Schema):

- Reads (pure): `ennio_status`, `ennio_describe`, `ennio_screenshot`,
  `ennio_assert_visible`, `ennio_wait_for`
- Actions (HID): `ennio_launch_app`, `ennio_stop_app`, `ennio_tap`,
  `ennio_double_tap`, `ennio_long_press`, `ennio_input_text`,
  `ennio_erase_text`, `ennio_swipe`, `ennio_scroll`, `ennio_back`

**Resources:** `ennio://screen/hierarchy`, `ennio://screen/screenshot`,
`ennio://session`.

**Contract.** The tool surface is a versioned public API. Guarantees:

1. **Self-describing** — every `ennio_<verb>` tool ships a routable description,
   a full JSON Schema, and an inline example for any tool that takes arguments.
   No external docs needed to pick the right tool.
2. **Structured results, always** — one envelope: `{ ok: true, data }` or
   `{ ok: false, error: { kind, message } }`, `kind ∈
not_found | timeout | invalid | infra`. Never raw stdout, never a thrown
   exception. `not_found` is a normal answer the agent branches on, not a failure.
3. **One selector + coordinate model** — selectors take exactly one of `testID`,
   `text`, or a normalized `point`; all coordinates/rects are `[0,1]` screen
   fractions; times are ms. Same vocabulary across every tool.
4. **Transparent app view** — `ennio_describe` returns the real element
   inventory (role / testID / text / value); `ennio_find` resolves any selector
   to a normalized rect + tap center. No hidden heuristics.
5. **Capability negotiation** — `ennio_status` reports `protocolVersion`,
   `contractVersion`, `platform`, `dylibLoaded`, and `capabilities`
   (`attach`, `actuation`, `crossProcessAx`) so an agent adapts instead of
   guessing.
6. **Side-effect-honest** — read tools are flagged `readOnly`; mutating tools
   are not. No surprising global state between calls.
7. **Versioned** — `contractVersion` is semver (`1.0.0`); breaking changes bump
   it. `protocolVersion` reports the MCP revision in use.

These bars are enforced by an executable conformance suite
(`src/cli/mcp/contract.test.ts`) — that file is the authoritative spec.

The interface is tool-agnostic: Argent is just the first consumer. ennio
declares how it touches the app (`attach: dyld-inject`, `actuation: hid`) so a
coordinating agent can sequence other controllers around a single actuator.

## License

MIT

## Trademarks

Maestro is a trademark of mobile.dev. Ennio is an independent
project, not affiliated with mobile.dev. References to "Maestro"
describe only the YAML flow format that Ennio consumes; no Maestro
source code is bundled or redistributed.
