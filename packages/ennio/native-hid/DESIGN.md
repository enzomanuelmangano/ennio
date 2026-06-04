# In-house HID — replacing idb_companion

## STATUS — WORKING. Host-side Indigo helper drives 03-cart end to end.

`native-hid/helper/enniohid` (Swift) posts real touches into the
simulator via CoreSimulator Indigo — the exact mechanism idb uses,
owned by us: no idb_companion daemon, no fb-idb, no grpc. 03-cart runs
49/49 entirely on in-house HID, 3× consecutive green (~24s),
deterministic; 19 in-house actuations per flow. Opt-in via
`ENNIO_INHOUSE_HID=1` (default still idb while it proves across the
full suite).

How it works:
- Resolve the booted `SimDevice` via CoreSimulator (SimServiceContext →
  defaultDeviceSet → device by UDID, ObjC runtime).
- `SimDeviceLegacyHIDClient(device:)` (ObjC `initWithDevice:error:`).
- Build a digitizer touch `IndigoMessage` with the **vendored MIT**
  builder (`indigo_touch.h`, from FBSimulatorControl) on top of
  SimulatorKit's exported `IndigoHIDMessageForMouseNSEvent`. Wire size
  0x140 (320), 2-payload digitizer form.
- Send via `sendWithMessage:freeWhenDone:completionQueue:completion:`
  (the @objc-bridged name of the Swift send — same call idb makes; the
  simple `send(message:)` variant does not flush).
- Persistent process: spawned once per UDID, fed `down/move/up`
  newline commands over stdin (normalized [0,1] coords), one `ok` per
  command. EnnioHidClient (CLI) composes taps/swipes and is a drop-in
  for IdbGrpcClient behind `hid.ts`.

Notes / follow-ups:
- `swiftcall.c` (x20 swiftself trampoline) is retained but unused now
  that the @objc send selector works; keep as a reference.
- Next: ship `enniohid` as a prebuilt universal slice + SHA manifest
  (reuse the dylib infra), run the full 41-flow suite on in-house HID,
  then flip the default and strip the grpc deps + proto.

---

## (Earlier) in-process path proven dead; pivot to host-side Indigo

Two approaches were considered. **Findings, so the next iteration
doesn't repeat the dead end:**

**Approach B (in-process IOHIDEvent, the elegant one) — DOES NOT WORK
on the modern simulator.** Built `EnnioHIDInjector` in the dylib:
`IOHIDEventCreateDigitizerEvent` + finger child + `_enqueueHIDEvent:` /
`_handleHIDEvent:`. Tried every variant — senderID magic constant,
`IsDisplayIntegrated`, explicit Range/Touch fields on parent, parent
coords, Position in all masks, both delivery selectors. A swizzle on
`-[UIApplication sendEvent:]` proves the verdict: **zero** touch events
reach UIKit. The simulator's UIApplication _accepts_ the enqueue (the
selector exists and returns) but never dispatches it — sim touch input
is gated to the host Indigo→backboard channel; in-process injection is
ignored regardless of event shape. Kept behind `ENNIO_INHOUSE_HID=1`
for the record (ops `hid_down/move/up`, `hid_probe`, `hid_listen`),
NOT the default.

**Approach A (host-side CoreSimulator Indigo) — the viable path.** This
is idb's actual mechanism, proven to work on the sim. The in-house
version reimplements just that send, dropping the idb_companion daemon

- fb-idb + grpc. Seam (symbol-confirmed): SimulatorKit
  `SimDeviceLegacyHIDClient.init(device:)` / `.send(message:)` +
  `IndigoHIDMessageFor*` C builders, `SimDevice` from CoreSimulator. The
  open work: `.send(message:)` is Swift-ABI (no ObjC selector) so the
  helper is a Swift binary, and the Indigo digitizer message layout
  (R1) still needs a compile→boot→run→observe loop. This is a host
  helper binary (a real build), not a dylib op — see the revised
  architecture below.

---

## Why

idb is ennio's last heavy external dependency. Today the CLI needs:

- `brew install facebook/fb/idb-companion` (install-time)
- `pip3 install fb-idb` (install-time)
- `@grpc/grpc-js` + `@grpc/proto-loader` + `proto/idb.proto` (runtime)
- a running `idb_companion` daemon per simulator

…to do **exactly one thing in the hot path**: post a real `IOHIDEvent`
(touch Down/Move/Up, swipe, key) into the simulator at the
CoreSimulator level. Everything else (launch, install, terminate,
data wipe) already goes through `xcrun simctl` — zero idb.

So "replace idb" = own that one capability. The README's core claim
("the gesture goes through the same path a finger would") must be
preserved: real HID, not the in-process activation chain (that's what
fast mode already does, with its verify+fallback safety net).

## The seam (resolved, not hypothetical)

idb hand-rolls the Indigo mach message via the low-level
`SimDeviceLegacyClient`. We don't have to — **`SimulatorKit.framework`
exposes a higher, more version-stable Swift API** that does the same
send. Confirmed by symbol inspection of
`$(xcode-select -p)/Library/PrivateFrameworks/SimulatorKit.framework`:

```
SimulatorKit.SimDeviceLegacyHIDClient
  .init(device: SimDevice) throws
  .send(message: UnsafeMutablePointer<IndigoHIDMessageStruct>,
        freeWhenDone: Bool, completionQueue:, completion:)

// C message builders (SimulatorKit exports):
IndigoHIDMessageForButton
IndigoHIDMessageForPointerEventFromHIDEventRef   // IOHIDEventRef → Indigo
IndigoHIDMessageForKeyboardNSEvent
IndigoHIDMessageForScrollEvent
... (digitizer/touch: hand-built struct, or via IOHIDEvent → Pointer builder)
```

`SimDevice` comes from CoreSimulator:
`SimServiceContext.sharedServiceContextForDeveloperDir(...)` →
`defaultDeviceSetWithError` → device whose `.UDID` matches `ENNIO_UDID`.

This is strictly **less** reverse-engineering than idb does: idb owns
the full Indigo struct + mach port dance; we call SimulatorKit's own
`send`, and either reuse a `IndigoHIDMessageFor*` builder or port
idb's published `IndigoHID.h` digitizer layout (one struct, stable for
years).

## Architecture — `enniohid` host helper

A tiny **prebuilt universal Mach-O binary** shipped in the npm tarball
next to `libennio.dylib`, reusing the infrastructure we already have:
prebuilt slice + SHA-256 manifest verification + Unix-socket envelope.

```
+-- host (macOS) ----------------------------------------+
|  ennio CLI (Node)                                      |
|     │ spawn once, persistent                           |
|     ▼ newline-JSON over stdin / unix socket            |
|  enniohid  (Swift, links SimulatorKit + CoreSimulator) |
|     SimDeviceLegacyHIDClient.send(IndigoHIDMessage)    |
+------------------------------│-------------------------+
                               ▼ real IOHIDEvent
                       iOS Simulator (CoreSim HID)
```

- **Persistent process** (spawned once per run) → no per-tap process
  startup. Matches today's ~5ms/tap gRPC stream, kills the ~400ms
  Python-CLI tax that motivated the gRPC client in the first place.
- **Protocol**: same `{id, op, args}\n → {id, ok, ...}\n` envelope the
  dylib control socket already speaks. Ops: `touch_down`, `touch_move`,
  `touch_up`, `key`, `ping`. Swipe/longPress are composed CLI-side
  from down/move/up (the CLI already builds gesture-custom event
  sequences — only the actuation primitive changes).
- **Coordinates**: window-space pixels → Indigo's normalized main-screen
  space (the conversion idb's `FBSimulatorIndigoHID` does; screen dims
  already cached in `hid.ts getScreenSize`).

## Why this is the smart shape

1. **One-file CLI swap.** The Phase-1 driver refactor already isolated
   actuation: `HidDriver` composes `hid.ts` primitives, which today
   call `idb-grpc`. Point those primitives at an `EnnioHidClient`
   (same `tap/swipe/doubleTap` interface as `IdbGrpcClient`) and
   nothing above `hid.ts` changes. `FastDriver` keeps using it as the
   fallback. No handler, no settle, no driver-interface change.
2. **Reuses shipped-binary infra.** `scripts/build-*.sh`,
   `regen-manifest.sh`, `prebuilt/manifest.json`, SHA gate, cleanup —
   all already exist for the dylib. `enniohid` is one more slice.
3. **Deletes the most install-friction deps.** No brew, no pip, no
   daemon. `npx ennio` works on a machine with only Xcode.
4. **Higher fidelity than in-process, same as idb.** SimDeviceLegacy
   HIDClient.send posts the identical Indigo event idb posts.

## Risks (ranked)

- **R1 — Indigo digitizer struct layout.** The one piece needing care.
  Mitigation: prefer `IndigoHIDMessageForPointerEventFromHIDEventRef`
  (build an `IOHIDEventRef` digitizer event with public IOKit, let
  SimulatorKit pack it) before hand-rolling. Fallback: idb's
  `IndigoHID.h` (published, stable). De-risk via the spike below.
- **R2 — private framework drift across Xcode.** SimulatorKit's Swift
  ABI is more stable than idb's hand-built mach message, but still
  private. Mitigation: version-probe at startup, fall back to idb if
  present and the symbols are missing (keep idb path as optional
  legacy for one release).
- **R3 — codesigning / hardened runtime** loading a private framework
  from a helper. Mitigation: same as Xcode's own `simctl` — runs
  under the developer dir; ad-hoc sign the helper.
- **R4 — multitouch / pinch.** Out of scope v1 (single-finger covers
  every current flow + swipe). Indigo supports it; add later.

## Spike (de-risk R1 before building the helper)

`native-hid/spike/` — a standalone Swift binary that:

1. Resolves the booted `SimDevice` via CoreSimulator.
2. `SimDeviceLegacyHIDClient(device:)`.
3. Posts a single Down+Up at a hard-coded point.
4. **Success criterion**: the touch fires through the REAL responder
   chain — verify by tapping a normal Pressable (not a test shim) in
   the example app and seeing onPress run. If a real touch lands, the
   architecture is proven and the helper is mechanical.

## Phase plan

1. **Spike** — prove `SimDeviceLegacyHIDClient.send` lands a real touch.
2. **`enniohid` helper** — persistent process, down/move/up/key ops,
   coordinate conversion, build script + manifest entry.
3. **`EnnioHidClient`** (CLI) — drop-in for `IdbGrpcClient`; `hid.ts`
   primitives switch to it; `--legacy-idb` escape hatch for one
   release.
4. **Strip idb** — remove grpc deps + proto once the helper is proven
   across the full 41-flow suite (HID + fast modes).

```

```
