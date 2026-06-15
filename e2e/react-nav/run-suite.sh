#!/bin/bash
# react-navigation example e2e suite through ennio.
#
# Drives the upstream react-navigation playground's maestro suite
# (example/e2e/maestro/*.yml) against a PREBUILT release fixture — the same
# binary on every run, downloaded from the e2e-fixtures release, never built
# in CI. The flows live in the cloned react-navigation repo (pinned commit);
# each `runFlow`s the shared launch.yml, which `stopApp`s then deep-links via
# `openLink ${APP_SCHEME}${LINK}` and waits for `${TEXT}` — LINK/TEXT come
# from each flow's own `runFlow.env` block (per-flow scoped, not process env).
#
# SINGLE-DAEMON model: ONE ennio process drives the WHOLE suite, not a fresh
# node per flow. launch.yml's per-flow stopApp + cold deep-link keeps every
# flow's state isolated regardless, so what the one-process model drops is the
# pure per-flow overhead — node/CLI cold-start, the redundant shell-level
# force-stop, the connect probe (~4.5s/flow measured on iOS 18.2). This is how
# `maestro test <dir>` and on-device runners drive the same suite, and is why
# they outrun a node-per-flow loop.
#
# STRICT: --fail-fast — one attempt per flow, abort on the first failure. A
# flow that needs a second try is a real flake to fix at the source.
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

if [ "$ENNIO_PLATFORM" = "android" ]; then
  PLATFORM_FLAG="--android"
  stop_app() { adb -s "$ENNIO_UDID" shell am force-stop "$APP_ID" >/dev/null 2>&1; }
  shot() { adb -s "$ENNIO_UDID" exec-out screencap -p > "$1" 2>/dev/null || true; }
else
  PLATFORM_FLAG="--ios"
  stop_app() { xcrun simctl terminate "$ENNIO_UDID" "$APP_ID" >/dev/null 2>&1; }
  shot() { xcrun simctl io "$ENNIO_UDID" screenshot "$1" >/dev/null 2>&1 || true; }
fi

# The flow list the one daemon runs: every *.yml in the maestro dir, in sorted
# order. launch.yml lives one level up (example/e2e/) so the glob never picks
# it up. FLOW_FILTER keeps only flows whose basename starts with the prefix
# (iterate on a subset without paying for the whole suite).
FILES=()
for fp in "$FLOWS_DIR"/*.yml; do
  f=$(basename "$fp" .yml)
  if [ -n "${FLOW_FILTER:-}" ]; then case "$f" in ${FLOW_FILTER}*) ;; *) continue;; esac; fi
  FILES+=("$fp")
done
if [ "${#FILES[@]}" -eq 0 ]; then
  echo "=== react-nav suite ($ENNIO_PLATFORM): no flows matched FLOW_FILTER='${FLOW_FILTER:-}' ==="
  exit 1
fi

echo "=== react-nav suite ($ENNIO_PLATFORM, single-daemon) ${#FILES[@]} flows $(date +%T) ==="
# Clean slate so the first flow's launch.yml cold-launch is deterministic
# (the remaining flows each stopApp themselves inside launch.yml).
stop_app
SUITE_T0=$(date +%s)
# One process, all flows. The runner reports per-flow pass/fail + a suite
# summary; --fail-fast stops at the first failing flow (a single failure fails
# CI anyway, so don't burn the rest of the wall-clock).
node "$ENNIO_CLI" test "${FILES[@]}" $PLATFORM_FLAG --fail-fast ${ENNIO_NO_ANIM_FLAG:-} 2>&1 | tee "$LOGD/suite.log"
RC=${PIPESTATUS[0]}
SUITE_T1=$(date +%s)
# On failure, grab the screen — element-not-found failures produce no in-app
# shot and the screen is the fastest "app wedged vs wrong element" signal.
[ "$RC" -ne 0 ] && shot "$LOGD/suite.fail.png"
echo ""
echo "=== SUITE(react-nav/$ENNIO_PLATFORM): rc=$RC wall=$((SUITE_T1-SUITE_T0))s ==="
exit $RC
