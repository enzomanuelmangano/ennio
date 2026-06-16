# maestro-demo — ennio ↔ Maestro conformance

The maestro-demo app + `maestro-e2e/` suite mirror Maestro's own
`e2e/demo_app` self-test: one screen per interaction archetype, one flow
per command, plus `fail_*` negatives and `issues/` repros — every flow
tagged `passing` or `failing` so the outcome is asserted (see
`run-suite.sh`).

Because the flows are Maestro-syntax YAML, the **same suite runs through
both ennio and real Maestro**, which turns the suite into a differential
conformance harness. This file records that comparison.

## How to reproduce

```bash
# ennio (asserts declared outcomes)
ENNIO_UDID=<udid|serial> ./run-suite.sh ios     # or: android

# Maestro (same flows, same app, same device)
maestro --device <udid> test maestro-e2e/<flow>.yaml
```

App: `com.ennio.maestrodemo`. Device for the run below: iPhone 16 Pro,
iOS 18.2, Release build.

## Result — command grid

ennio passes every `passing` flow on **both** iOS and Android (35
outcome-matched + 1 known divergence). Running the identical flows through
Maestro diverges on 9 of them:

| flow                                                                                                                                                                                                            | ennio |    Maestro     | why they differ                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---: | :------------: | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| assertVisible, assertNotVisible, assertTrue, inputText, eraseText, pressKey, hideKeyboard, longPressOn, copyTextFrom, openLink, repeat, retry, runScript, evalScript, takeScreenshot, tapOn, scrollUntilVisible |  ✅   |       ✅       | agree                                                                                                                                                     |
| **scroll**                                                                                                                                                                                                      |  ✅   | ⛔ parse error | `scroll: {direction: DOWN}` — `direction` is an ennio extension; Maestro's `scroll` takes no args                                                         |
| **swipe**                                                                                                                                                                                                       |  ✅   |       ❌       | `tapOn {id: Container 2}` — ennio matches an accessibility **label** as `id`; Maestro's `id` is strictly `accessibilityIdentifier` → not found            |
| **assertVisible-relative**                                                                                                                                                                                      |  ✅   |       ❌       | `containsChild` over nested testIDs — ennio's RN-native finder sees the nesting; Maestro's XCTest a11y tree does not                                      |
| **paging**                                                                                                                                                                                                      |  ✅   |       ❌       | `assertVisible {id: page-indicator, text: 'Page 1 of 4'}` — ennio's combined id+text selector is looser than Maestro's                                    |
| **back**                                                                                                                                                                                                        |  ✅   |       ❌       | ennio's in-process nav-pop returns to `home-screen`; Maestro's hardware back doesn't pop the expo-router stack the same way                               |
| **launchApp**                                                                                                                                                                                                   |  ✅   |       ❌       | persist-then-relaunch: ennio's app-**reuse** keeps the Input screen mounted so `potato` is still visible; Maestro cold-relaunches to Home, where it isn't |
| **extendedWaitUntil**, **waitForAnimationToEnd**                                                                                                                                                                |  ✅   |       ❌       | the countdown hits `0.0s` momentarily; ennio's polling catches it, Maestro's single-shot assert after the wait misses it                                  |

`fail_*` negatives fail in both. `fail_launchApp` passes in ennio (it
reuses the running app and ignores the bogus appId) and fails in Maestro —
tracked as a known ennio divergence.

## What the divergences mean

The flows were authored and validated against ennio, so ennio is green by
construction. The value is in _where Maestro disagrees_ — four distinct
classes, not one:

1. **Grammar is a superset.** `scroll: direction`, `assertVisible: timeout`
   are ennio extensions Maestro can't parse. Convenient, but flows using
   them aren't portable to Maestro.
2. **Selectors are more lenient.** ennio matches an `accessibilityLabel`
   as `id`, and its combined id+text / `containsChild` selectors resolve
   where Maestro's stricter ones don't — partly grammar, partly because
   ennio reads the React Native element tree in-process while Maestro
   reads the iOS XCTest accessibility tree (different sources, different
   nesting/labels).
3. **Statefulness differs.** ennio's app-reuse optimization keeps the
   previous screen mounted across a no-clearState `launchApp`; Maestro
   cold-relaunches. ennio's behavior is faster but can mask a real
   relaunch (the `launchApp` persistence flow passes for the _wrong_
   reason — the screen was never torn down).
4. **Polling tolerance differs.** ennio waits on transient states
   (`extendedWaitUntil`, animation end) that Maestro's single-shot asserts
   miss — a robustness win for ennio, but it means the two tools can
   report different outcomes for timing-sensitive UI.

Items 1–2 are conformance gaps worth closing if Maestro-portability is a
goal; item 3 is a correctness risk in ennio's reuse path (see the
`fail_launchApp` divergence in `run-suite.sh`); item 4 is a genuine ennio
strength.
