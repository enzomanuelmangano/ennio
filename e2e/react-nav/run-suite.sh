#!/bin/bash
# react-navigation example e2e suite through ennio.
#
# Drives the upstream react-navigation playground's 38-flow maestro suite
# (example/e2e/maestro/*.yml) against a PREBUILT release fixture — the same
# binary on every run, downloaded from the e2e-fixtures release, never built
# in CI. The flows live in the cloned react-navigation repo (pinned commit);
# each carries a deep-link target in its `LINK:`/`TEXT:` runFlow env that
# launch.yml turns into an `openLink ${APP_SCHEME}${LINK}` + wait-for `${TEXT}`.
#
# A fresh CLI process per flow (the app is force-stopped between flows so each
# starts from the deep-link cold path, matching how the suite runs locally).
# STRICT: one attempt per flow, no retry — a flow that needs a second try is a
# real flake to fix at the source.
#
# Required env:
#   ENNIO_CLI        path to ennio dist/cli.js
#   ENNIO_UDID       simulator UDID / emulator serial
#   ENNIO_PLATFORM   ios | android
#   RNNAV_DIR        react-navigation checkout (pinned, with example/e2e)
#   APP_ID           org.reactnavigation.playground
#   APP_SCHEME       rne://
# iOS also needs ENNIO_DYLIB_PATH; Android also needs ENNIO_ANDROID_AGENT.
set -u

FLOWS_DIR="$RNNAV_DIR/example/e2e/maestro"
LOGD=${SUITE_LOG_DIR:-/tmp/rnnav-e2e-logs}
rm -rf "$LOGD"; mkdir -p "$LOGD"

# Per-flow hard cap, portable: GNU `timeout` ships on the Linux (Android)
# runner; macOS (iOS runner) has it only as `gtimeout` with coreutils, and may
# have neither — fall back to running unguarded (each ennio step is already
# bounded by its own wait budget, and the CI job has a timeout-minutes cap).
if command -v timeout >/dev/null 2>&1; then TIMEOUT="timeout 180"
elif command -v gtimeout >/dev/null 2>&1; then TIMEOUT="gtimeout 180"
else TIMEOUT=""; fi

if [ "$ENNIO_PLATFORM" = "android" ]; then
  PLATFORM_FLAG="--android"
  stop_app() { adb -s "$ENNIO_UDID" shell am force-stop "$APP_ID" >/dev/null 2>&1; }
  shot() { adb -s "$ENNIO_UDID" exec-out screencap -p > "$1" 2>/dev/null || true; }
else
  PLATFORM_FLAG="--ios"
  stop_app() { xcrun simctl terminate "$ENNIO_UDID" "$APP_ID" >/dev/null 2>&1; }
  shot() { xcrun simctl io "$ENNIO_UDID" screenshot "$1" >/dev/null 2>&1 || true; }
fi

run_flow() { # $1 = flow file, $2 = LINK, $3 = TEXT, $4 = log path
  LINK="$2" TEXT="$3" $TIMEOUT node "$ENNIO_CLI" test "$1" $PLATFORM_FLAG ${ENNIO_NO_ANIM_FLAG:-} > "$4" 2>&1
}

PASS=0; FAIL=0; FAILED=""
echo "=== react-nav suite ($ENNIO_PLATFORM) $(date +%T) ==="
SUITE_T0=$(date +%s)
for fp in "$FLOWS_DIR"/*.yml; do
  f=$(basename "$fp" .yml)
  # Optional prefix filter (FLOW_FILTER=stack) for iterating on a subset.
  if [ -n "${FLOW_FILTER:-}" ]; then case "$f" in ${FLOW_FILTER}*) ;; *) continue;; esac; fi
  L=$(grep -m1 'LINK:' "$fp" | sed -E "s/.*LINK:[[:space:]]*//;s/[\"']//g;s/[[:space:]]*$//")
  T=$(grep -m1 'TEXT:' "$fp" | sed -E "s/.*TEXT:[[:space:]]*//;s/[\"']//g;s/[[:space:]]*$//")
  stop_app
  # STRICT: one attempt, no retry. A flow that needs a second try is a real
  # flake to fix at the source, not to paper over — the suite fails outright.
  if run_flow "$fp" "$L" "$T" "$LOGD/$f.log"; then
    echo "PASS  $f  $(grep -o 'total .*' "$LOGD/$f.log" | head -1)"
    PASS=$((PASS+1))
  else
    shot "$LOGD/$f.fail.png"
    echo "FAIL  $f"; FAIL=$((FAIL+1)); FAILED="$FAILED $f"
  fi
done
SUITE_T1=$(date +%s)
echo ""
echo "=== SUITE(react-nav/$ENNIO_PLATFORM): Pass=$PASS Fail=$FAIL wall=$((SUITE_T1-SUITE_T0))s — failed:${FAILED:- none} ==="
[ "$FAIL" -eq 0 ]
