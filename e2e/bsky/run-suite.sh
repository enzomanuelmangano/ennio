#!/bin/bash
# Bluesky e2e suite through ennio — fast profile.
#
# Per-flow CLI process (a fresh app process per flow measured FASTER than
# in-place soft reset for the bsky Release bundle: 7.0s relaunch vs 9.7s
# clear_state+reload_rn), animations suppressed (--disable-animations,
# dylib time-compresses to 1000x so UIKit transition delegates still fire),
# retry-once to absorb transient mock-PDS propagation lag.
#
# Required env:
#   ENNIO_UDID        simulator UDID
#   ENNIO_DYLIB_PATH  path to libennio.dylib
#   BLUESKY_DIR       bluesky checkout (patched, with __e2e__/flows)
#   ENNIO_CLI         path to ennio dist/cli.js
set -u

# ennio's own e2e run under the resilient profile (15 s waits + legacy text
# sniff) for the slow iOS-26 simulator. Conformance runs under both profiles.
export ENNIO_PROFILE="${ENNIO_PROFILE:-resilient}"
cd "$BLUESKY_DIR"
LOGD=${SUITE_LOG_DIR:-/tmp/bsky-e2e-logs}
rm -rf "$LOGD"; mkdir -p "$LOGD"
PASS=0; FAIL=0; FAILED=""; CONSEC=0
echo "=== bsky suite (fast profile, STRICT no-retry) $(date +%T) ==="
SUITE_T0=$(date +%s)
for f in __e2e__/flows/*.yml; do
  b=$(basename "$f" .yml); case "$b" in _*) continue;; esac
  # Optional prefix filter (FLOW_FILTER=composer) — iterate on a single
  # failing flow without paying for the whole suite.
  if [ -n "${FLOW_FILTER:-}" ]; then case "$b" in ${FLOW_FILTER}*) ;; *) continue;; esac; fi
  # Space-separated exact flow names to skip (SKIP_FLOWS="composer ..."),
  # each printed loudly so an exclusion can never hide.
  skip=0
  for s in ${SKIP_FLOWS:-}; do [ "$b" = "$s" ] && skip=1; done
  if [ "$skip" = "1" ]; then echo "SKIP  $b (SKIP_FLOWS)"; continue; fi
  # onboarding picks a photo via a blind point-tap (50%,22%) whose target
  # position depends on the animated picker-sheet timeline — animations
  # must stay on for that flow.
  ANIM_FLAG="--disable-animations"; [ "$b" = "onboarding" ] && ANIM_FLAG=""
  # STRICT: one attempt, no retry. A flow that needs a second try is a real
  # flake to fix at the source — the suite fails outright.
  if ENNIO_PHASE_TRACE=1 node "$ENNIO_CLI" test "$f" --verbose $ANIM_FLAG \
       > "$LOGD/$b.log" 2>&1; then
    echo "PASS  $b  $(grep -o 'total .*' "$LOGD/$b.log" | head -1)"
    PASS=$((PASS+1)); CONSEC=0
  else
    # Screen state at failure — element-not-found failures don't produce an
    # in-app screenshot, and the screen is the fastest way to tell "app
    # wedged" from "wrong element" on a slow runner.
    xcrun simctl io "$ENNIO_UDID" screenshot "$LOGD/$b.fail.png" || true
    echo "FAIL  $b"; FAIL=$((FAIL+1)); FAILED="$FAILED $b"; CONSEC=$((CONSEC+1))
    # Fail-fast: 2 consecutive failures = systemic break, abort the suite.
    if [ "$CONSEC" -ge 2 ]; then
      echo "ABORT: $CONSEC consecutive failures — bailing out"
      break
    fi
  fi
done
SUITE_T1=$(date +%s)
echo ""
echo "=== SUITE(bsky): Pass=$PASS Fail=$FAIL wall=$((SUITE_T1-SUITE_T0))s — failed:${FAILED:- none} ==="
[ "$FAIL" -eq 0 ]
