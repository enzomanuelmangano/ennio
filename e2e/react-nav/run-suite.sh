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
# Two process models, chosen by platform:
#
#   iOS  → SINGLE DAEMON: one ennio process drives the WHOLE suite. launch.yml's
#          per-flow stopApp + cold deep-link keeps every flow's state isolated
#          regardless, so what the one-process model drops is the pure per-flow
#          overhead — node/CLI cold-start, a redundant shell-level force-stop,
#          the connect probe (~4.5s/flow, ~33% off the suite, measured on iOS
#          18.2). DYLD re-injection is clean across flows in one process
#          (validated 38/38). This is how `maestro test <dir>` and on-device
#          runners drive the suite, and is why they outrun a node-per-flow loop.
#
#   Android → PER FLOW: a fresh CLI process per flow. The ptrace/JVMTI agent
#          re-attach does NOT survive 10+ stopApp+relaunch cycles in one
#          long-lived process (socket drops mid-suite), so Android keeps the
#          proven fresh-process-per-flow model.
#
# STRICT: one attempt per flow, no retry. A flow that needs a second try is a
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

if [ "$ENNIO_PLATFORM" = "android" ]; then
  PLATFORM_FLAG="--android"
  stop_app() { adb -s "$ENNIO_UDID" shell am force-stop "$APP_ID" >/dev/null 2>&1; }
  shot() { adb -s "$ENNIO_UDID" exec-out screencap -p > "$1" 2>/dev/null || true; }
else
  PLATFORM_FLAG="--ios"
  stop_app() { xcrun simctl terminate "$ENNIO_UDID" "$APP_ID" >/dev/null 2>&1; }
  shot() { xcrun simctl io "$ENNIO_UDID" screenshot "$1" >/dev/null 2>&1 || true; }
fi

# The flow list both models walk: every *.yml in the maestro dir, sorted.
# launch.yml lives one level up (example/e2e/) so the glob never picks it up.
# FLOW_FILTER keeps only flows whose basename starts with the prefix.
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

# ── iOS: single daemon, all flows in one process ─────────────────────────────
if [ "$ENNIO_PLATFORM" != "android" ]; then
  echo "=== react-nav suite (ios, single-daemon) ${#FILES[@]} flows $(date +%T) ==="
  # Clean slate so the first flow's launch.yml cold-launch is deterministic
  # (the rest each stopApp themselves inside launch.yml).
  stop_app
  SUITE_T0=$(date +%s)
  # One process; --fail-fast stops at the first failing flow (a single failure
  # fails CI anyway, so don't burn the rest of the wall-clock).
  node "$ENNIO_CLI" test "${FILES[@]}" $PLATFORM_FLAG --fail-fast ${ENNIO_NO_ANIM_FLAG:-} 2>&1 \
    | tee "$LOGD/suite.log"
  RC=${PIPESTATUS[0]}
  SUITE_T1=$(date +%s)
  [ "$RC" -ne 0 ] && shot "$LOGD/suite.fail.png"
  echo ""
  echo "=== SUITE(react-nav/ios): rc=$RC wall=$((SUITE_T1-SUITE_T0))s ==="
  exit $RC
fi

# ── Android: fresh CLI process per flow ──────────────────────────────────────
run_flow() { # $1 = flow file, $2 = LINK, $3 = TEXT, $4 = log path
  LINK="$2" TEXT="$3" $TIMEOUT node "$ENNIO_CLI" test "$1" $PLATFORM_FLAG ${ENNIO_NO_ANIM_FLAG:-} > "$4" 2>&1
}

# Per-flow hard cap, portable: GNU `timeout` on the Linux (Android) runner.
if command -v timeout >/dev/null 2>&1; then TIMEOUT="timeout 180"
elif command -v gtimeout >/dev/null 2>&1; then TIMEOUT="gtimeout 180"
else TIMEOUT=""; fi

PASS=0; FAIL=0; FAILED=""; CONSEC=0
echo "=== react-nav suite (android, per-flow) ${#FILES[@]} flows $(date +%T) ==="
SUITE_T0=$(date +%s)
for fp in "${FILES[@]}"; do
  f=$(basename "$fp" .yml)
  L=$(grep -m1 'LINK:' "$fp" | sed -E "s/.*LINK:[[:space:]]*//;s/[\"']//g;s/[[:space:]]*$//")
  T=$(grep -m1 'TEXT:' "$fp" | sed -E "s/.*TEXT:[[:space:]]*//;s/[\"']//g;s/[[:space:]]*$//")
  stop_app
  # STRICT: one attempt, no retry.
  if run_flow "$fp" "$L" "$T" "$LOGD/$f.log"; then
    echo "PASS  $f  $(grep -o 'total .*' "$LOGD/$f.log" | head -1)"
    PASS=$((PASS+1)); CONSEC=0
  else
    shot "$LOGD/$f.fail.png"
    echo "FAIL  $f"; FAIL=$((FAIL+1)); FAILED="$FAILED $f"; CONSEC=$((CONSEC+1))
    # Fail-fast: 2 consecutive failures = systemic break (app not launching,
    # injection dead) — abort instead of burning the whole suite.
    if [ "$CONSEC" -ge 2 ]; then
      echo "ABORT: $CONSEC consecutive failures — bailing out"
      break
    fi
  fi
done
SUITE_T1=$(date +%s)
echo ""
echo "=== SUITE(react-nav/$ENNIO_PLATFORM): Pass=$PASS Fail=$FAIL wall=$((SUITE_T1-SUITE_T0))s — failed:${FAILED:- none} ==="
[ "$FAIL" -eq 0 ]
