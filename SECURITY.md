# Security Policy

## Supported Versions

Ennio is at an early experimental stage. Only the latest published
version on npm (`@reactiive/ennio`) receives security fixes. Older
versions are not patched — upgrade to the latest release.

## Reporting a Vulnerability

**Please do not open public GitHub issues for security problems.**

Email **hello@reactiive.io** with:

- A short description of the issue.
- Steps to reproduce (minimal repro preferred).
- The version of `@reactiive/ennio` (and `@reactiive/ennio-expo-plugin`
  if relevant) where you observed it.
- Any known mitigations or workarounds.

You should receive an initial acknowledgment within 7 days. If you
do not, please re-send — mail can get lost.

## Scope

Ennio is a **Debug-build-only** test runtime. It is gated by
CocoaPods `:configurations => ['Debug']` so it does not ship in
Release archives. Reports are most useful when they relate to:

- Release builds shipping any Ennio symbols (`__ennioDispatch`,
  `EnnioAutoInit`, etc.) when the plugin defaults are used. This
  should be impossible by design; a counter-example is a critical bug.
- The CLI executing untrusted YAML / `runScript` content in a way that
  escapes the intended sandbox.
- The Hermes Inspector channel or HID daemon being reachable from
  outside `localhost`.
- Supply-chain risk: a published `@reactiive/*` tarball containing
  files that are not in the repo, or post-install scripts touching
  anything outside the package directory.

Out of scope:

- Anything that requires the attacker to already have the Debug build
  installed on the device, plus Metro running, plus physical
  simulator access. That is the standard threat model — Ennio
  intentionally trades isolation for fidelity in Debug.
- Vulnerabilities in `idb_companion`, `fb-idb`, Hermes, Metro, React
  Native, or Expo themselves — report those upstream.

## Disclosure

Once a fix is available, we will:

1. Publish a patched version to npm.
2. Open a public advisory on the repository describing the issue and
   the fix.
3. Credit the reporter (unless they ask to stay anonymous).
