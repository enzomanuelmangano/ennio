# Conformance fixtures

One flow per `matrix.json` row that pins a single Maestro command / selector /
modifier behavior. Each flow is **self-asserting**: it PASSES iff ennio behaves
per the matrix row, so the runner (`e2e/conformance/run-suite.sh`) only needs to
check exit status.

These target the example app (`com.ennio.example`) Gauntlet → `g-playground`
screen, whose stable testIDs (`counter-display`, `counter-inc-btn`, `toggle-1..5`,
`search-input`, `fruit-cherry`, `fruit-banana`, …) are also exercised by
`../11-grammar-selectors.yaml`.

Convention:

- A fixture for a `status: pass` row must pass today (regression gate).
- A fixture for a `divergent` / `fragile` row encodes the **target** Maestro
  behavior; it xfails until its `targetPhase` lands, then the row flips to `pass`.

Run: `ENNIO_CLI=… ENNIO_UDID=… ENNIO_PLATFORM=ios ENNIO_PROFILE=maestro \
  bash e2e/conformance/run-suite.sh`
