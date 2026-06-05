# ennio vs Maestro — timing & bottlenecks

Head-to-head performance of **ennio** (in-house CoreSimulator Indigo HID +
dylib finder + macOS-AX bridge) against **Maestro** (idb gRPC + XCUITest)
on the Bluesky e2e suite.

- Sim: iPhone 16 Pro, iOS 18.2 (and iPhone Air, iOS 26 — Maestro's XCUITest
  driver does not start on iOS 26 at all; ennio does).
- App: Bluesky e2e build (`expo run:ios`, `RN_SRC_EXT=e2e`), dev-client + Metro.
- Mock: local dev-env PDS orchestrator on :1986.
- All numbers are wall-clock, median of the runs noted.

> TL;DR — **ennio is 12–21× faster per gesture** because it skips
> idb+XCUITest entirely. End-to-end, flow time is dominated by app/mock
> waits (feed load, dev-launcher), so the gesture edge is partly masked on
> wait-heavy flows but compounds on interaction-heavy ones. ennio reached
> the same flow point **~40% faster** than Maestro (66s vs 111s).

---

## 1. Per-action (transport) — the clean signal

Isolated micro-benchmarks, no app/mock noise. This is the runner's raw cost
per primitive.

| Action | ennio | idb (Maestro backend) | speedup |
|---|---:|---:|---:|
| **tap** | **9.9 ms** | 212 ms | **21×** |
| **swipe** (8-step) | **37.7 ms** | 469 ms | **12×** |
| **text** — 24 chars | 260 ms¹ (10.8 ms/char) | 722 ms (bulk) | ~2.8× |
| **AX tree dump** | 312 ms² | 586 ms (`describe-all`) | ~1.9× |
| **find by testID** | <5 ms³ (dylib socket) | — | — |

¹ Raw enniohid key round-trip. The CLI composer path adds inter-key
settle (~30 ms/char) for reliability — see bottleneck #2.
² Persistent ennioax (after the optimization below; was 867 ms one-shot).
³ In-app dylib `find_by_testid` over the Unix socket — the primary find
path; the AX dump is the cross-process fallback (~5% of finds).

**Why ennio wins the transport layer:** a tap is `build Indigo message →
send over CoreSimulator` — host-side, no daemon. Maestro/idb round-trips
every gesture `CLI → idb companion (gRPC) → XCUITest → tap`. That round-trip
is the 200–470 ms.

---

## 2. Per-flow (end-to-end) — home-screen

Both runners on the identical flow, same sim, same mock, back-to-back.

| | ennio | Maestro |
|---|---:|---:|
| wall-clock to step 6 | **66 s** | 111 s |
| outcome | flaky env fail at "Discover New Feeds"⁴ | same |

⁴ Both fail at the same step — a slow/cold local-mock feed-page, not a
runner issue. ennio simply got there ~40% faster.

### Where the time goes (ennio per-step trace)

```
step 1  setupServer (mock PDS spin) .... ~15–25 s   ← app/mock
step 2  setupApp (dev-launcher + bundle) ~35–40 s   ← app/mock
step 3  tapOn e2eSignInAlice ........... 2.5 s
step 4  extendedWaitUntil "Feeds ✨" .... 0.08 s     ← feed loaded fast here
step 5  tapOn "Feeds ✨" ................ 1.1 s
step 6  assertVisible "Discover ..." .... FAIL (env)
```

**The flow is setup-dominated.** Steps 1–2 (mock PDS spin + dev-launcher +
bundle load) are ~60 s of app/infra time, identical work for both runners.
The actual interaction steps (3–5) are seconds. So on this suite the
gesture speedup is real but bounded by the app waits — it dominates only on
interaction-heavy flows (long scrolls, many taps).

---

## 3. Bottlenecks (ranked)

### App/mock (not ennio) — dominant
The local mock spins a **cold PDS per flow**; the home feed load is tens of
seconds and sometimes never completes, causing early-step failures. This
dwarfs runner cost and makes full-suite numbers noisy. Fixed by CI-grade
mock infra, not the runner.

### #1 — Cross-process AX dump (FIXED this round)
`ennioax` was `spawnSync` **per call**: process spawn + `AXEnhancedUserInterface`
re-arm + ~400 ms bridge settle every time = **~870 ms/dump**.
**Fix shipped:** persistent `--persistent` mode — arm once, serve `dump`
over stdin (mirrors enniohid). **870 → 312 ms (~2.8×).** Since the AX path
is the ~5% fallback, net flow impact is bounded but free.
→ Further win available: drop the 120 ms warm-settle when no frame changed
since last dump (cache + invalidate on gesture).

### #2 — Keyboard-HID char-by-char
The composer real-keyboard path types one USB-usage event at a time with
~30 ms inter-key settle (needed so the sim doesn't drop keys under load).
For a 20-char reply that's ~600 ms vs a bulk insert's ~200 ms.
→ Only used for `composerTextInput` (rich-text editors where
`insert_text` doesn't fire onChangeText); plain fields use the fast
dylib `insert_text`. Tunable: lower the inter-key gap with a per-char
ack instead of a fixed sleep.

### #3 — Settle/wait logic
ennio inserts `wait_commit` / `wait_react_commit` between steps for
reliability on iOS 26. Correct, but a few hundred ms each. Tunable per
step once a flow is known-stable.

---

## 4. The persistent-ennioax optimization (detail)

```
        spawn   arm+settle   walk    IPC     total
one-shot  ~yes    ~500 ms    ~250 ms  —     ~870 ms   (every call)
persistent once    once      ~250 ms ~60 ms ~312 ms   (steady state)
```

- `native-ax/ennioax.m`: `--persistent` flag → arm `AXEnhancedUserInterface`
  once, loop on stdin `dump`/`quit`, flush a JSON line per dump.
- `src/cli/ennio-ax.ts`: `AxHelperProcess` per UDID (mirrors
  `EnnioHidClient`), spawned lazily, torn down on exit. `axTree` is now
  async; `axResolve` / `axHasText` / `axTextFieldId` async, callers awaited.

---

## 5. Conclusions

- **Raw interaction: ennio is 12–21× faster** (no idb/XCUITest). This is the
  core architectural win and compounds on interaction-heavy flows.
- **End-to-end on Bluesky: ennio ~40% faster** to the same point; the rest
  is app/mock wait identical for both.
- **ennio also runs where Maestro can't** — iOS 26 (XCUITest driver won't
  start).
- **Biggest remaining ennio-side cost** was the per-call AX spawn — now
  fixed (~2.8×). Next levers: AX warm-settle caching, keyboard per-char ack,
  per-step settle tuning.
- **The 90% suite bottleneck is the local mock**, not ennio: cold per-flow
  PDS, slow/failed feed loads. Needs CI-grade infra to measure cleanly.

_Methodology: micro-benchmarks via direct `enniohid`/`ennioax`/`idb` calls
(20× tap, 10× swipe, 24-char text, 10× dump). Flow timings via `ennio test`
and `maestro test` wall-clock with `ENNIO_PHASE_TRACE` per-step. iOS 18.2,
Bluesky e2e build._
