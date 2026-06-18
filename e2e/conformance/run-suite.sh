#!/bin/bash
# Maestro conformance suite through ennio.
#
# Drives the per-row fixtures under examples/showcase/maestro-e2e/conformance/ that pin
# ennio's command/selector/modifier behavior to documented Maestro semantics.
# Each fixture is a self-contained flow that PASSES when ennio behaves correctly
# (the expectation is encoded inside the flow via assertVisible/assertNotVisible),
# so "fixture passed" == "row conforms".
#
# The matrix (e2e/conformance/matrix.json) drives which rows are device-backed and
# what their CURRENT expected outcome is:
#   status=pass       -> MUST pass now (a regression fails the suite)
#   status=divergent  -> known gap; allowed to fail until its targetPhase lands (xfail)
#   status=fragile    -> heuristic that can misfire; xfail until removed
#   status=todo       -> fixture may not exist yet; skipped if absent
# As each phase lands it flips rows to `pass`, turning xfail into a hard gate.
#
# Required env:
#   ENNIO_CLI        path to ennio dist/cli.js
#   ENNIO_UDID       simulator UDID / emulator serial
#   ENNIO_PLATFORM   ios | android
#   ENNIO_PROFILE    maestro | resilient   (run the suite under BOTH in CI)
# iOS also needs ENNIO_DYLIB_PATH; Android also needs ENNIO_ANDROID_AGENT.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
MATRIX="$HERE/matrix.json"
FIXDIR="$REPO/examples/showcase/maestro-e2e/conformance"
LOGD=${SUITE_LOG_DIR:-/tmp/ennio-conformance-logs}
rm -rf "$LOGD"; mkdir -p "$LOGD"

if [ "$ENNIO_PLATFORM" = "android" ]; then
  PLATFORM_FLAG="--android"
  shot() { adb -s "$ENNIO_UDID" exec-out screencap -p > "$1" 2>/dev/null || true; }
else
  PLATFORM_FLAG="--ios"
  shot() { xcrun simctl io "$ENNIO_UDID" screenshot "$1" >/dev/null 2>&1 || true; }
fi

# Emit "fixture<TAB>status" for every device-backed row, resolving the fixture
# path relative to the repo root. Node is already an ennio dependency.
rows() {
  # A row may carry `statusByProfile: { maestro, resilient }` for behavior that
  # is correct under one profile but an accepted gap under the other (e.g.
  # whole-string anchoring passes under maestro, stays divergent under
  # resilient). Resolve to the active profile, falling back to `status`.
  ENNIO_PROFILE="${ENNIO_PROFILE:-maestro}" node -e '
    const m = require(process.argv[1]);
    const prof = process.env.ENNIO_PROFILE || "maestro";
    for (const r of m.rows) {
      if (!r.deviceBacked) continue;
      if (!r.fixture || !r.fixture.endsWith(".yaml")) continue;
      const st = (r.statusByProfile && r.statusByProfile[prof]) || r.status;
      process.stdout.write(r.id + "\t" + r.fixture + "\t" + st + "\n");
    }
  ' "$MATRIX"
}

PROFILE=${ENNIO_PROFILE:-maestro}
PASS=0; XFAIL=0; XPASS=0; FAIL=0; SKIP=0; FAILED=""
echo "=== conformance suite ($ENNIO_PLATFORM / profile=$PROFILE) $(date +%T) ==="
T0=$(date +%s)
while IFS=$'\t' read -r id fixture status; do
  fp="$REPO/$fixture"
  if [ ! -f "$fp" ]; then echo "SKIP  $id  (no fixture: $fixture)"; SKIP=$((SKIP+1)); continue; fi
  if ENNIO_PROFILE="$PROFILE" timeout 180 node "$ENNIO_CLI" test "$fp" $PLATFORM_FLAG \
        ${ENNIO_NO_ANIM_FLAG:-} > "$LOGD/$id.log" 2>&1; then
    ran="pass"; else ran="fail"; fi

  if [ "$status" = "pass" ]; then
    if [ "$ran" = "pass" ]; then echo "PASS  $id"; PASS=$((PASS+1))
    else shot "$LOGD/$id.fail.png"; echo "FAIL  $id  (expected pass — regression)"; FAIL=$((FAIL+1)); FAILED="$FAILED $id"; fi
  else
    # divergent / fragile / todo: not yet converged — informational only
    if [ "$ran" = "pass" ]; then echo "XPASS $id  ($status — fixture passes; consider flipping to pass)"; XPASS=$((XPASS+1))
    else echo "xfail $id  ($status — known gap, targetPhase pending)"; XFAIL=$((XFAIL+1)); fi
  fi
done < <(rows)
T1=$(date +%s)
echo ""
echo "=== CONFORMANCE($ENNIO_PLATFORM/$PROFILE): Pass=$PASS Fail=$FAIL xfail=$XFAIL xpass=$XPASS skip=$SKIP wall=$((T1-T0))s — failed:${FAILED:- none} ==="
# Only hard regressions (a `pass` row that failed) fail the suite.
[ "$FAIL" -eq 0 ]
