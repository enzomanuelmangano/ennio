# Motion match — a deterministic reward for animation

> Design doc. The static visual reward (`assertScreenMatches` / `ennio_match_screen`)
> is shipped. This describes the next axis: a deterministic reward for **motion**,
> so an agent loop can converge an animation against a reference video — not just
> a static screen against a reference image.

## Thesis

A loop converges whatever its reward can measure.

- **Static layout** → pixel match (built). Compare a screenshot to a reference image; the diff heatmap is the gradient an agent edits against.
- **Motion** → **trajectory match** (this doc). Per-frame pixel diff cannot reward motion: two animations that reach the same end state via slightly different easing mismatch on _every_ intermediate frame (temporal drift). Instead, extract each element's **curve** — position(t), scale(t), opacity(t) — from both sides, align them in time, and reward the curve distance. That gives a real gradient:
  _"your overshoot peaks at 1.15 @ t=0.30, the reference peaks at 1.08 @ t=0.45 → lower stiffness, raise damping."_

So motion is **reward-bound, not craft-bound**: the missing piece is a trajectory reward, which is buildable and deterministic.

## The asymmetry that makes it tractable (ennio's edge)

General video-to-video motion matching is hard because you must _infer_ motion from pixels on both sides. ennio only has to infer it on **one** side:

| side                        | how trajectories are obtained                                                                                                                                                                                                                            |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **reproduction** (your app) | **zero CV** — ennio reads exact element rect / opacity / transform every frame via the in-process dylib. Perfect ground truth.                                                                                                                           |
| **reference** (the video)   | **CV, once, offline** — track the original's elements into a trajectory JSON. ennio _consumes_ that JSON the same way it consumes a reference PNG: source-agnostic (a CV script, a VLM, or hand annotation produces it). ennio never does CV at runtime. |

Half the problem is _measured_, not _inferred_. That is what makes the loop converge instead of hallucinate.

## Pipeline

```
reference video ──(offline CV / VLM, once)──▶ reference trajectory spec (JSON: per-element curves)
                                                          │
your app ── ennio drives the interaction ── dylib element_states @~60Hz ──▶ reproduction curves
                                                          ▼
                 visual/trajectory.ts:  segment → time-align (DTW) → per-channel distance → spring-fit
                                                          │
            { motionRatio, perElement: { scale: { rmse, fittedTarget: { stiffness, damping } } } }
                                                          ▼
        agent edits the Reanimated config toward fittedTarget → re-drive → re-measure → converge
```

## Components to build

1. **`element_states` socket op (dylib, native).** One call snapshots all tracked elements' `{ rect, opacity, transform }`. The CLI polls it at ~60 Hz across a transition (or the dylib pushes a timestamped log). This is the reproduction-side trajectory extractor — no CV. _The one piece that needs the native build + a dylib regen + manifest update._
2. **Reference trajectory format.** `{ elements: { <label>: { t[], x[], y[], scale[], opacity[] } } }`. A source-agnostic input, like the reference image. How it's produced (CV script / VLM keyframes / manual) is out of scope for ennio.
3. **`visual/trajectory.ts` (pure, host-side).** The algorithmic core, fully unit-testable without a device:
   - **resample / normalize** both curves to a common timeline (0→1).
   - **DTW** time-alignment + per-channel normalized RMSE → `motionRatio`.
   - **damped-spring fit** (grid / Levenberg–Marquardt over stiffness / damping / mass) → the **fitted target params**. This is the multiplier: report _"reference spring ≈ { stiffness: 180, damping: 20 }"_ so the agent sets two numbers instead of blind-searching a curve.
4. **`assertMotionMatches` command + `ennio_match_motion` tool.** Drive the interaction, capture the reproduction trajectory, DTW against the reference spec, return `motionRatio` + per-channel deltas + fitted targets. Same envelope / `outputs` plumbing as the static reward.
5. **Segmentation helper.** Scene-change detection (frame-hash energy spikes) splits a video into **states** (→ static pixel reward) + **transitions** (→ motion reward). On the reproduction side ennio already knows the boundaries via `animations_active` / `frame_hash`.

## Why it dodges the pixel ceiling

The static pixel reward caps below 1.0 against a _recording_ (mockup frame, compression, font rendering). Trajectory and structural rewards compare **motion + structure, not raw pixels**, so they are **robust to those artifacts** — the wall that limits the static loop's last mile does not apply here.

## Honest hard parts (cost / asymptote, not walls)

- **Reference CV extraction** through blur / overlap is the real engineering. Keep it offline + source-agnostic so ennio stays pure.
- **Correspondence** (which reference blob ↔ which testID) is light, semi-manual: the agent labels "the pill that expands" ↔ a testID.
- **Spring-model assumption.** If the original used a custom Skia timeline, the fit is approximate — still a strong target.
- **Cycle speed.** Each iteration = build + drive + extract + DTW (tens of seconds); a full multi-second sequence is many iterations. It converges; it is not free.
- **Skia shader exactness** (the very last fidelity %) stays craft; a smarter appearance metric (glow falloff / color histogram per region) helps but does not fully close it.

## Staged plan (each stage ships value)

- **Stage 1 — static states.** Pixel match + diff-region crops (shipped). Reproduce keyframes, verifiably. **Available now.**
- **Stage 2 — motion reward.** `element_states` op + reproduction trajectory + `visual/trajectory.ts` (DTW + spring-fit) + `assertMotionMatches`. Motion converges against a hand/CV-authored reference spec. **The unlock. The pure-JS core (DTW + spring-fit) has no native dependency and lands first; `element_states` is the native follow-up.**
- **Stage 3 — full auto.** Automate reference extraction (CV / VLM) + segmentation → "point at a video, the loop reproduces it." Asymptotic Skia-fidelity polish remains craft.

## Status

- Stage 1: shipped (`visual/compare.ts`, `visual/regions.ts`, the three surfaces).
- Stage 2 core (`visual/trajectory.ts`): implemented pure + unit-tested (no device).
- Stage 2 native (`element_states`) + `assertMotionMatches` wiring: pending the dylib build.
- Stage 3: not started.
