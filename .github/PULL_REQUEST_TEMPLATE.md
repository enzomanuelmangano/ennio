<!--
Thanks for the PR. Please keep one logical change per PR.
For multi-purpose work, split into multiple PRs — easier to review,
easier to revert.
-->

## Why

<!-- The bug, limitation, or motivation. Link the issue if there is one. -->

Fixes #

## What changed

<!-- The technical approach. One short paragraph or bullets. -->

## Test plan

<!--
How you verified the change. Include regression bench output.
Paste the tail of `bunx ennio test maestro-e2e/` from the example app.
-->

- [ ] `bun run typecheck` green
- [ ] `bun run lint` green
- [ ] Regression bench passes locally (`cd example && bunx ennio test maestro-e2e/`)
- [ ] Native code changes: example app rebuilt with `expo prebuild --clean` + `expo run:ios`, not just cached pods
- [ ] No `console.log` / `printf` debug code left in
- [ ] No commented-out code

## Breaking changes

<!--
Does this change public surface area (CLI flags, plugin options,
Maestro YAML grammar, JS API)? If yes, describe the break + migration.
If no, write "None".
-->

None

## Screenshots / recordings

<!-- Optional. Helpful for ribbon / output-format / docs changes. -->
