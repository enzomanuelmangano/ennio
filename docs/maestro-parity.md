# Maestro parity & divergence ledger

ennio reimplements Maestro's YAML command language. This document is the
**contract**: for every command, selector, and modifier, it records what Maestro
documents, what ennio currently does, and — where they differ — whether the
difference is an intentional choice or a bug to fix.

The machine-readable form lives in [`e2e/conformance/matrix.json`](../e2e/conformance/matrix.json).
Device-free rows are asserted by `packages/ennio/src/cli/maestro-parser.test.ts`;
device-backed rows by [`e2e/conformance/run-suite.sh`](../e2e/conformance/run-suite.sh),
run under both tuning profiles × both platforms.

> Status vocabulary: **pass** = matches Maestro · **divergent** = differs (see note)
> · **fragile** = works by a heuristic that can misfire · **todo** = not yet pinned.

## How to use this

- Adding/altering a command or selector? Add or flip its matrix row first, then make
  the code match. CI fails if a `pass` row regresses.
- Found ennio behaving differently from Maestro? It's either a `divergent` row with a
  documented reason, or a bug — there is no third option. Add the row.

## Tuning profiles

ennio ships two profiles (see `packages/ennio/src/cli/settle/profile.ts`, Phase 2):

| Profile | Intent | `assertVisible` default wait | Post-tap settle |
| --- | --- | --- | --- |
| `maestro` (default) | Faithful Maestro drop-in | 7000 ms | Maestro-equivalent |
| `resilient` (opt-in) | Empirically tuned for slow iOS-26 sim / CI | 15000 ms | 800 ms |

Select with `--profile <name>` or `ENNIO_PROFILE=<name>`. ennio's own e2e suites
(react-nav, bsky) run under `resilient`; the conformance suite runs under both.

## Selector semantics (Phase 1)

The largest divergence. Maestro's `text` and `id` are **whole-string regex by
default**. ennio today does literal case-insensitive substring `contains` with a
regex *fallback*, gated by `isRegexText()` — a sniff that inspects the string for
metacharacters. The sniff is unfixable in principle: `"Price: $5"`,
`"users[,]? or feeds"`, and `"Item (new)"` all carry metacharacters as literal
content, and no heuristic distinguishes "the user meant a pattern" from "the user
typed a dollar sign".

**Destination:** explicit `matchMode` (`literal` | `regex`) computed once at parse
time, carried on the selector and typed onto the wire. `regex: true` / `literal:
true` are explicit escape hatches; otherwise the profile default decides
(regex-by-default under `maestro`). The `isRegexText()` sniff is deleted.

## Divergence ledger

Intentional, documented differences from Maestro. Anything not listed here that
differs is a bug. (Filled in as phases land — Phase 5 finalizes.)

| Row | Difference | Why it's intentional |
| --- | --- | --- |
| `wait.assertVisible.default-timeout` | `resilient` profile waits 15 s vs Maestro 7 s | RN bundle execute + UIKit layout + RNGH gesture acceptance on the iOS-26 simulator takes 4–7 s; the `maestro` profile still ships 7 s for parity. |
| `selector.text.regex-by-default-anchor` | `resilient` profile keeps substring matching during migration | Deprecation window so existing ennio flows that rely on substring don't break overnight; the `maestro` profile anchors per spec. |

_(More rows added as Phases 1–6 land; each `divergent` matrix row that survives gets
an entry here with its justification.)_

## Command coverage

Tracked per-row in `matrix.json`. Summary of known gaps at Phase 0:

- **Per-command modifiers** (`optional` / `label` / `when`) are only partially
  general — `optional` is ad-hoc in the tap handler, `when` only on `runFlow`. Phase 3.
- **`repeat.while`** is missing (`repeat` supports `times` only). Phase 3.
- **`when` conditions** lack `platform:` and `true:` (JS expression). Phase 3.
- **`id` regex**: ennio matches `id` exactly; Maestro treats it as regex. Phase 1.
