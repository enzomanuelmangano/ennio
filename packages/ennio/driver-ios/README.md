# ennio-driver (iOS)

XCTest companion runner that handles taps ennio's in-process dylib can't
land on its own (RN-Navigation header back-arrows, etc).

## Why it exists

iOS gesture-recognisers can be configured to ignore synthesized HID
touches (`UIPanGestureRecognizer.requiresExclusiveTouchType`, custom
`delaysTouchesBegan` chains, RNGH-wrapped Pressables that gate on the
event source). Argent's `gesture-tap` and our own dylib's HID
injection both produce synthetic touches. For ~5 % of buttons, the
host gesture-recogniser drops them.

`XCUIElement.tap()` calls `_XCT_postAXNotification` (private) which
makes accessibilityd send the click as a system AX event, NOT a
synthesized touch. Host gesture-recognisers see an AX-originated
activation and fire onPress unconditionally.

We can't call that path from in-process — it's gated behind XCTest's
entitlements. So this driver runs as a separate XCTest target and
exposes a thin HTTP API for ennio's CLI to call.

## What it does

1. `RunLoop.main.run()` parks the XCTest function indefinitely.
2. Inside that test, a minimal HTTP server listens on `127.0.0.1:9088`.
3. ennio's CLI POSTs `/tap_label` or `/tap_identifier` requests with
   the host app's bundle id; the driver does `XCUIApplication(...)
   .descendants(matching:.any).matching(...).firstMatch.tap()` and
   returns ok.

## Build

(TODO — needs xcodeproj target setup; spawned via
`xcodebuild test-without-building` at session start.)
