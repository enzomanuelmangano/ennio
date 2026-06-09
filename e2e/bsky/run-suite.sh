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
cd "$BLUESKY_DIR"
LOGD=${SUITE_LOG_DIR:-/tmp/bsky-e2e-logs}
rm -rf "$LOGD"; mkdir -p "$LOGD"
PASS=0; FAIL=0; FAILED=""; RETRIED=""
echo "=== bsky suite (fast profile, retry-once) $(date +%T) ==="
SUITE_T0=$(date +%s)
for f in __e2e__/flows/*.yml; do
  b=$(basename "$f" .yml); case "$b" in _*) continue;; esac
  # onboarding picks a photo via a blind point-tap (50%,22%) whose target
  # position depends on the animated picker-sheet timeline — animations
  # must stay on for that flow.
  ANIM_FLAG="--disable-animations"; [ "$b" = "onboarding" ] && ANIM_FLAG=""
  if ENNIO_PHASE_TRACE=1 node "$ENNIO_CLI" test "$f" --verbose $ANIM_FLAG \
       > "$LOGD/$b.log" 2>&1; then
    echo "PASS  $b  $(grep -o 'total .*' "$LOGD/$b.log" | head -1)"
    PASS=$((PASS+1))
  else
    if ENNIO_PHASE_TRACE=1 node "$ENNIO_CLI" test "$f" --verbose $ANIM_FLAG \
         > "$LOGD/$b.retry.log" 2>&1; then
      echo "PASS  $b (retry)"; PASS=$((PASS+1)); RETRIED="$RETRIED $b"
    else
      echo "FAIL  $b"; FAIL=$((FAIL+1)); FAILED="$FAILED $b"
    fi
  fi
done
SUITE_T1=$(date +%s)
echo ""
echo "=== SUITE(bsky): Pass=$PASS Fail=$FAIL wall=$((SUITE_T1-SUITE_T0))s — retried:${RETRIED:- none} failed:${FAILED:- none} ==="
[ "$FAIL" -eq 0 ]
