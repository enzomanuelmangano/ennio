# Contributing to Ennio

Thanks for considering a contribution. Ennio is at an **early
experimental stage** — internals, APIs, and package names can change
without notice. That said, the codebase is set up to be readable and
the regression bench gives you a clear go/no-go signal for any change.

## Repo layout

```
packages/
  ennio/              @reactiive/ennio
    cpp/              EnnioControlSocket (Unix-domain socket primitive)
    ios/              ObjC++ dylib source:
      bootstrap/      DYLD constructor + debug banner + RCTHost swizzle
      finders/        UIView walker + testID index + finder manager
      handlers/       Socket RPC handlers (find / interact / system / wait)
      observers/      React commit observer + frame-hash settle ticker
      ops/            UIKit operations (tab switch, alerts, keyboard)
      PrivateAPI/     Synthetic UITouch (fallback path)
    native-shim/      ennio-shim.m — RN-agnostic loader gate
    prebuilt/         Universal dylib + shim + manifest (gitignored,
                      built by CI, ships in npm tarball)
    src/cli/          TypeScript CLI:
      socket-client   Unix-domain socket transport
      hid.ts          HID actuation (in-house enniohid helper)
      ennio-hid.ts    enniohid host-helper client (CoreSimulator Indigo)
      maestro-parser  YAML → AST
      runner/         Executes the AST (commands + lifecycle + tap)
example/              Sample RN app + maestro-e2e/ regression suite
```

A read-only architectural overview lives in the root `README.md`
(sections "Architecture", "How taps work", "Defense in depth").

## Dev setup

1. **Toolchain prereqs** (host machine):
   - macOS, Xcode 16+
   - Node 18+, bun 1.2+ (`packageManager` in root package.json pins
     bun; npm/yarn also work)
   - iOS 17+ simulator
   - No extra toolchain: touches are driven by the in-house `enniohid`
     helper, which links Xcode's own CoreSimulator / SimulatorKit
     frameworks (built via `scripts/build-hid-helper.sh`). No
     Homebrew formula or pip.

2. **Clone + install**:

   ```bash
   git clone https://github.com/enzomanuelmangano/ennio.git
   cd ennio
   bun install
   ```

3. **Build the example app once** (links the local packages into a
   real Debug build):

   ```bash
   cd example
   bunx expo prebuild --clean
   bunx pod-install
   bunx expo run:ios
   ```

4. **Run the regression bench** in another terminal:
   ```bash
   cd example
   bunx ennio test maestro-e2e/
   ```
   Expected: `36 passed, 0 failed`. If this isn't green on `main`
   before your change, file an issue first — that's the bug to fix.

## Making a change

### Type checking + lint

```bash
bun run typecheck   # tsc on the ennio + plugin + example workspaces
bun run lint        # eslint with `--max-warnings=0`
```

Both must pass before opening a PR. CI runs the same checks; failing
locally means failing in CI.

### Regression bench

**Always re-run the bench after a code change**:

```bash
cd example
bunx ennio test maestro-e2e/
```

The bench covers tab nav, modals, sheets, alerts, gestures, scrolls,
forms, navigation patterns, and every grammar variant. If a yaml
fails:

- Screenshot of the failing state lands at `/tmp/ennio-shots/<flow>-fail.png`.
- Run the failing yaml alone for fast iteration:
  ```bash
  bunx ennio test maestro-e2e/<failing>.yaml
  ```
- Add `ENNIO_VERBOSE=1` for runner-side step tracing.
- Add `ENNIO_DEBUG_TAP=1` for prepareTap coord resolution logs.
- Add `ENNIO_PHASE_TRACE=1` for per-gesture HID + phase-timing logs.

### Adding a new Maestro command

1. Extend `MaestroCommand` in `packages/ennio/src/cli/maestro-parser.ts`
   to accept the new key.
2. Add a handler in `MaestroExecutor.executeCommand` in
   `maestro-runner.ts` (the giant switch around line 800).
3. Add a yaml regression in `example/maestro-e2e/` that exercises it.
4. Run the bench. Must stay at 36/36 (or 37/37 if you added a new
   yaml).
5. Update the "Maestro grammar coverage" section of the root README if
   the new command is generally useful (i.e., not a hack for a
   specific app).

### Adding a new selector mode

Selectors travel through the bridge as JSON (`packages/ennio/cpp/SelectorParser.cpp`) and feed `ElementMatcher`
(`packages/ennio/cpp/ElementMatcher.cpp`). To add a new matching mode:

1. Add the field to `Selector` in `src/Ennio.nitro.ts` (which generates
   the Nitro spec) and the C++ `SelectorCriteria` struct.
2. Extend `SelectorParser` to read the field.
3. Extend `ElementMatcher::matches` to apply it.
4. Add yaml regressions in `example/maestro-e2e/11-grammar-selectors.yaml`.

### Native side

The native code compiles inside the consumer app's pod (`EnnioCore`),
**not** in a standalone Xcode project. Iteration loop:

1. Edit `cpp/*` or `ios/*`.
2. From the example app's iOS dir:
   ```bash
   cd example/ios
   pod install
   ```
3. Rebuild via Xcode or `cd example && bunx expo run:ios`.

Pure-CLI changes (TypeScript / Python) don't require an app rebuild —
the CLI launches as a Node process.

## Pull requests

### Branch + commit conventions

- Branch from `main`. Branch names like `feat/<thing>`, `fix/<thing>`,
  `chore/<thing>`, `docs/<thing>`.
- **Conventional commits**: `feat:`, `fix:`, `chore:`, `docs:`,
  `refactor:`, `test:`, `perf:`. Scope optional: `fix(runner): …`,
  `docs(ennio): …`.
- **One logical change per commit.** Multi-purpose commits make
  bisects painful. A PR with 5 small commits beats a PR with 1 big
  commit.
- **Commit messages explain _why_**. The diff shows _what_. Past
  commits in `git log --oneline` set the tone.

### Before opening a PR

- [ ] `bun run typecheck` green
- [ ] `bun run lint` green
- [ ] Regression bench 36/36 (or higher if you added yamls)
- [ ] Native code changes: example app rebuilt + tested in a real
      Debug build, not just relying on cached pods
- [ ] No `console.log` / `printf` debug code left in
- [ ] No new commented-out code

### PR description

Use the template (auto-populated). Include:

- **Why** the change — the bug or limitation
- **What** changed — the technical approach
- **Test plan** — bench output, any specific yamls exercised, anything
  you couldn't test

If the change touches public API (CLI flags, plugin options, yaml
grammar), call it out under "Breaking changes".

## Filing issues

Use the bug or feature templates. For bugs, please include:

- Repro yaml (smallest possible)
- iOS sim model + version (`xcrun simctl list devices booted`)
- RN version, Expo SDK version
- Ennio CLI version (`bunx ennio version`)
- Screenshot from `/tmp/ennio-shots/<flow>-fail.png` if available

## Code of Conduct

By participating in this project you agree to abide by the
[Code of Conduct](CODE_OF_CONDUCT.md). Be nice; assume good intent;
ask questions over assuming malice.

## License

Contributions are licensed under [MIT](LICENSE) — the same as the
rest of the project.
