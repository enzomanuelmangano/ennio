# In-house HID

How ennio delivers real touches into the simulator — entirely with
Xcode's own frameworks, no external toolchain.

## What it does

`native-hid/helper/enniohid` (Swift) posts real touches into the
simulator via CoreSimulator Indigo. The full 41-flow example suite runs
on it; 03-cart is 49/49, deterministic (~24s).

How it works:

- Resolve the booted `SimDevice` via CoreSimulator (SimServiceContext →
  defaultDeviceSet → device by UDID, ObjC runtime).
- `SimDeviceLegacyHIDClient(device:)` (ObjC `initWithDevice:error:`).
- Build a digitizer touch `IndigoMessage` with the **vendored MIT**
  struct + builder (`indigo_touch.h`, from Meta's FBSimulatorControl)
  on top of SimulatorKit's exported `IndigoHIDMessageForMouseNSEvent`.
  Wire size 0x140 (320), 2-payload digitizer form.
- Send via `sendWithMessage:freeWhenDone:completionQueue:completion:`
  (the @objc-bridged name of the Swift send; the simple `send(message:)`
  variant does not flush).
- Persistent process: spawned once per UDID, fed `down/move/up` newline
  commands over stdin (normalized [0,1] coords), one `ok` per command.
  `EnnioHidClient` (CLI) composes taps/swipes behind `hid.ts`.

## Why host-side, not in-process

An earlier attempt synthesized an `IOHIDEvent` digitizer event inside
the injected dylib and posted it to `UIApplication`
(`_enqueueHIDEvent:` / `_handleHIDEvent:`). It does **not** work on the
modern simulator: every variant was tried (senderID, IsDisplay
Integrated, explicit Range/Touch fields, parent coords, Position masks,
both delivery selectors), and a swizzle on `-[UIApplication sendEvent:]`
proved it — **zero** touch events reach UIKit. The simulator accepts the
enqueue and silently drops it; sim touch input is gated to the host
Indigo→backboard channel. So real touches must originate host-side, via
CoreSimulator.

## Why this shape is stable

- **Vendored, not reverse-engineered.** The Indigo digitizer struct +
  touch builder are MIT source from FBSimulatorControl (battle-tested
  across Xcode versions). We own ~1 header instead of guessing the
  layout.
- **One-file CLI swap.** The driver refactor isolated actuation behind
  `hid.ts`; `EnnioHidClient` is a drop-in. No handler/settle/driver
  change.
- **No external runtime.** `npx ennio` works with only Xcode + Node —
  no daemon, Homebrew formula, or pip.

## Risks / follow-ups

- **R1 — private framework coupling.** CoreSimulator/SimulatorKit are
  private Xcode frameworks. Mitigation: version-probe the symbols at
  startup and surface a clear error if a future Xcode renames them.
- **R2 — helper rpath portability.** The prebuilt binary's `-rpath`
  points at the build machine's developer dir. For shipping, resolve
  the frameworks at runtime relative to `DEVELOPER_DIR` (or re-link in
  a postinstall) rather than baking the path.
- **R3 — coordinates.** Normalized [0,1], top-left origin (scale-
  independent). Validated across the suite on iPhone-class screens.

## Files

- `helper/enniohid.swift` — device resolve + persistent command loop.
- `helper/indigo_touch.h` — vendored MIT Indigo struct + touch builder.
- `helper/swiftcall.c` — x20 swiftself trampoline (reference; the @objc
  send path is used in practice).
- `scripts/build-hid-helper.sh` — links CoreSimulator + SimulatorKit.
