# Wikipedia e2e flows

Maestro's official sample flows (the Wikipedia iOS app), adapted for the
current Wikipedia build, run through ennio. These exercise ennio against a
real-world third-party app — UIKit navigation, onboarding pager swipes,
conditional `runFlow`, `runScript` + `${output.*}` interpolation, search
field focus + typing — none of it instrumented for us.

## App binary

The Wikipedia simulator app ships inside Maestro's samples bundle (not
committed here — 117 MB):

```bash
curl -L -o /tmp/samples.zip https://storage.googleapis.com/mobile.dev/samples/samples.zip
unzip -j /tmp/samples.zip wikipedia.zip -d /tmp
unzip -q /tmp/wikipedia.zip -d /tmp/wikiapp
xcrun simctl install booted /tmp/wikiapp/Wikipedia.app
```

CI verifies the inner `wikipedia.zip` against a pinned SHA-256 before
installing (see `.github/workflows/ci-wikipedia.yml`). If upstream rotates
the bundle, re-pin: download, `shasum -a 256 wikipedia.zip`, update the
`WIKIPEDIA_ZIP_SHA256` constant in the workflow, and re-validate the flows
locally first.

## Run

```bash
ENNIO_UDID=<udid> ENNIO_DYLIB_PATH=/tmp/ennio-build/libennio.dylib \
  node dist/cli.js test e2e-wikipedia/ios-smoke.yaml
ENNIO_UDID=<udid> ENNIO_DYLIB_PATH=/tmp/ennio-build/libennio.dylib \
  node dist/cli.js test e2e-wikipedia/ios-advanced.yaml
```

`ios-advanced.yaml` is Maestro's `ios-advanced-flow.yaml` with stale UI
labels updated for current Wikipedia HEAD (promo modals that postdate the
sample, Search moved into a tab). Every command kind is from the original.
