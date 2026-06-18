#!/usr/bin/env bash
# Maestro-demo DIFFERENTIAL runner — ennio vs Maestro, side by side.
#
# The maestro-e2e/ flows are Maestro-syntax YAML, so the SAME suite runs
# through both ennio and real Maestro against the same app on the same
# device. This script runs every flow through BOTH runners, records a video
# of each run, and emits a comparison matrix:
#
#   flow | declared | ennio | maestro | agree?
#
# It is a SUPERSET of run-suite.sh: run-suite.sh asserts ennio's declared
# outcome and is the gating CI signal; this script is the differential
# conformance report (where does Maestro disagree, captured on video). It is
# intentionally NON-GATING by default — Maestro is EXPECTED to diverge on the
# flows tracked in CONFORMANCE.md, so a divergence is data, not a regression.
#
# Retries: each runner gets up to MAX_ATTEMPTS (default 3) tries per flow.
# A flow whose attempt matches its DECLARED outcome stops early; otherwise it
# burns all attempts and the last attempt's outcome is reported. This soaks
# out device flakiness without hiding a real, repeatable divergence.
#
# Recordings: one .mp4 per (flow, runner), covering all of that runner's
# attempts. Android via `adb screenrecord`, iOS via `simctl io recordVideo`
# (uniform per platform, both runners).
#
# Usage:  compare-suite.sh <ios|android> [flow-glob]
# Env:    ENNIO_UDID   ios udid / android serial   (required)
#         MAX_ATTEMPTS retries per runner per flow  (default 3)
#         RUN_ENNIO / RUN_MAESTRO  set to 0 to skip a runner (default 1)
#         OUT_DIR      output root (default /tmp/mdemo-compare)

set -uo pipefail

PLATFORM="${1:-ios}"
GLOB="${2:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
CLI="$REPO/packages/ennio/dist/cli.js"
FLOW_DIR="$HERE/maestro-e2e"
APP_ID="com.ennio.maestrodemo"

UDID="${ENNIO_UDID:?ENNIO_UDID required (ios udid or android serial)}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-3}"
RUN_ENNIO="${RUN_ENNIO:-1}"
RUN_MAESTRO="${RUN_MAESTRO:-1}"
PER_FLOW_TIMEOUT="${ENNIO_FLOW_TIMEOUT:-240}"
OUT_DIR="${OUT_DIR:-/tmp/mdemo-compare}"

PLATFORM_FLAG=""
[[ "$PLATFORM" == "android" ]] && PLATFORM_FLAG="--android"

REC_DIR="$OUT_DIR/$PLATFORM/recordings"
LOG_DIR="$OUT_DIR/$PLATFORM/logs"
REPORT_MD="$OUT_DIR/$PLATFORM/compare.md"
REPORT_JSON="$OUT_DIR/$PLATFORM/compare.json"
mkdir -p "$REC_DIR" "$LOG_DIR"
rm -f "$LOG_DIR"/* "$REC_DIR"/* "$REPORT_MD" "$REPORT_JSON" 2>/dev/null || true

# ---- declared-outcome detection (mirrors run-suite.sh) ----------------------
expect_fail() {
  local file="$1" name="$2"
  [[ "$name" == fail_* ]] && return 0
  grep -qE '^\s*-\s*failing\s*$' "$file" && return 0
  return 1
}

terminate_app() {
  if [[ "$PLATFORM" == "android" ]]; then
    adb -s "$UDID" shell am force-stop "$APP_ID" >/dev/null 2>&1 || true
  else
    xcrun simctl terminate "$UDID" "$APP_ID" >/dev/null 2>&1 || true
  fi
}

# ---- recording wrappers -----------------------------------------------------
# start_record <out.mp4> -> echoes a token used by stop_record
REC_PID=""
REC_REMOTE=""
start_record() {
  local out="$1"
  if [[ "$PLATFORM" == "android" ]]; then
    REC_REMOTE="/sdcard/mdemo_rec_$$_$RANDOM.mp4"
    # screenrecord exits on SIGINT with a valid container; 200s cap is plenty
    # for <=3 attempts of a <30s flow, and bounds a hung recorder.
    adb -s "$UDID" shell screenrecord --time-limit 200 "$REC_REMOTE" >/dev/null 2>&1 &
    REC_PID=$!
    REC_OUT="$out"
  else
    xcrun simctl io "$UDID" recordVideo --codec=h264 --force "$out" >/dev/null 2>&1 &
    REC_PID=$!
    REC_OUT="$out"
  fi
}
stop_record() {
  [[ -z "$REC_PID" ]] && return 0
  if [[ "$PLATFORM" == "android" ]]; then
    # Stop device-side recorder cleanly so the mp4 trailer is written, then pull.
    adb -s "$UDID" shell pkill -INT screenrecord >/dev/null 2>&1 || true
    wait "$REC_PID" 2>/dev/null || true
    # screenrecord needs a beat to flush the moov atom after SIGINT.
    local d=$((SECONDS + 8))
    while [ "$SECONDS" -lt "$d" ]; do
      adb -s "$UDID" shell 'pgrep screenrecord >/dev/null' 2>/dev/null || break
      sleep 1
    done
    adb -s "$UDID" pull "$REC_REMOTE" "$REC_OUT" >/dev/null 2>&1 || true
    adb -s "$UDID" shell rm -f "$REC_REMOTE" >/dev/null 2>&1 || true
  else
    kill -INT "$REC_PID" 2>/dev/null || true
    wait "$REC_PID" 2>/dev/null || true
  fi
  REC_PID=""; REC_REMOTE=""
}

# ---- one runner attempt (returns PASS/FAIL) ---------------------------------
# run_ennio <flow> <logfile>
run_ennio() {
  local file="$1" log="$2"
  ENNIO_UDID="$UDID" node "$CLI" test $PLATFORM_FLAG "$file" >"$log" 2>&1 </dev/null &
  local pid=$! deadline=$(( $(date +%s) + PER_FLOW_TIMEOUT ))
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
      kill -9 "$pid" 2>/dev/null
      echo "[compare] TIMEOUT after ${PER_FLOW_TIMEOUT}s" >>"$log"
      wait "$pid" 2>/dev/null || true
      return 1
    fi
    sleep 2
  done
  wait "$pid"
}
# run_maestro <flow> <logfile>
#
# Maestro's EXIT CODE and STDOUT are both unreliable for this suite:
#   - Exit code: every flow whose `name:` contains '/' (all commands/*) crashes
#     Maestro's post-run AI-report writer (HtmlAITestSuiteReporter →
#     FileNotFoundException on a path derived from the slashed name) AFTER the
#     flow already passed/failed — a non-zero exit unrelated to the outcome.
#   - Stdout: container steps (nested `runFlow`, conditional `when:`) print
#     "Run flow... RUNNING" and never a clean "... COMPLETED", so scraping
#     stdout false-FAILs a flow that actually passed.
# The authoritative signal is Maestro's own JUnit report (--format JUNIT),
# which records the real per-flow result AND is written before the AI-report
# crash. We parse the testcase status from it.
run_maestro() {
  local file="$1" log="$2"
  local xml="${log%.log}.junit.xml"
  rm -f "$xml"
  maestro --device "$UDID" test --no-ansi --format JUNIT --output "$xml" "$file" \
    >"$log" 2>&1 </dev/null &
  local pid=$! deadline=$(( $(date +%s) + PER_FLOW_TIMEOUT ))
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
      kill -9 "$pid" 2>/dev/null
      echo "[compare] TIMEOUT after ${PER_FLOW_TIMEOUT}s" >>"$log"
      wait "$pid" 2>/dev/null || true
      return 1
    fi
    sleep 2
  done
  wait "$pid" 2>/dev/null || true
  # JUnit testcase carries status="SUCCESS|FAILED|ERROR". A flow that never ran
  # produces no testcase -> treated as FAIL.
  [[ -f "$xml" ]] || return 1
  if grep -qE 'status="(FAILED|ERROR)"' "$xml"; then return 1; fi
  if grep -qE 'status="SUCCESS"' "$xml"; then return 0; fi
  # Fallback: a testsuite with zero failures/errors and >=1 test.
  if grep -qE 'failures="0"[^>]*errors="0"' "$xml" && grep -qE 'tests="[1-9]' "$xml"; then
    return 0
  fi
  return 1
}

# run_with_retries <runner-fn> <flow> <want PASS|FAIL> <logbase> <rec.mp4>
#   echoes "OUTCOME ATTEMPTS"  (OUTCOME = PASS|FAIL)
run_with_retries() {
  local fn="$1" file="$2" want="$3" logbase="$4" rec="$5"
  local got="FAIL" attempt=0
  start_record "$rec"
  while [ "$attempt" -lt "$MAX_ATTEMPTS" ]; do
    attempt=$((attempt + 1))
    terminate_app
    if "$fn" "$file" "${logbase}.attempt${attempt}.log"; then got="PASS"; else got="FAIL"; fi
    [[ "$got" == "$want" ]] && break
  done
  stop_record
  echo "$got $attempt"
}

# ---- main loop --------------------------------------------------------------
files=()
while IFS= read -r -d '' f; do files+=("$f"); done \
  < <(find "$FLOW_DIR" -name '*.yaml' -type f -print0 | sort -z)

echo "# maestro-demo conformance — ennio vs Maestro ($PLATFORM)" >"$REPORT_MD"
echo >>"$REPORT_MD"
echo "Device: \`$UDID\`  ·  app: \`$APP_ID\`  ·  retries: $MAX_ATTEMPTS  ·  recordings: \`$REC_DIR\`" >>"$REPORT_MD"
echo >>"$REPORT_MD"
echo "| flow | declared | ennio | maestro | agree |" >>"$REPORT_MD"
echo "| --- | :---: | :---: | :---: | :---: |" >>"$REPORT_MD"

json_rows=()
agree=0; diverge=0; total=0
start=$(date +%s)

for file in "${files[@]}"; do
  name="$(basename "$file")"
  rel="${file#"$FLOW_DIR"/}"
  case "$name" in config.yaml) continue;; esac
  [[ "$file" == *"/subflows/"* ]] && continue
  [[ "$file" == *"/scripts/"* ]] && continue
  [[ -n "$GLOB" && "$name" != $GLOB ]] && continue

  if expect_fail "$file" "$name"; then want="FAIL"; else want="PASS"; fi
  slug="${rel//\//__}"; slug="${slug%.yaml}"
  total=$((total + 1))

  e_out="-"; e_att="0"; m_out="-"; m_att="0"
  if [[ "$RUN_ENNIO" == "1" ]]; then
    read -r e_out e_att < <(run_with_retries run_ennio "$file" "$want" \
      "$LOG_DIR/${slug}.ennio" "$REC_DIR/${slug}.ennio.mp4")
  fi
  if [[ "$RUN_MAESTRO" == "1" ]]; then
    read -r m_out m_att < <(run_with_retries run_maestro "$file" "$want" \
      "$LOG_DIR/${slug}.maestro" "$REC_DIR/${slug}.maestro.mp4")
  fi

  # "agree" = ennio and maestro produced the same outcome (the differential
  # signal). Only meaningful when both runners ran.
  agreed="n/a"
  if [[ "$RUN_ENNIO" == "1" && "$RUN_MAESTRO" == "1" ]]; then
    if [[ "$e_out" == "$m_out" ]]; then agreed="yes"; agree=$((agree+1)); else agreed="NO"; diverge=$((diverge+1)); fi
  fi

  efmt="$e_out"; [[ "$e_att" -gt 1 ]] && efmt="$e_out (×$e_att)"
  mfmt="$m_out"; [[ "$m_att" -gt 1 ]] && mfmt="$m_out (×$m_att)"
  amark="$agreed"; [[ "$agreed" == "yes" ]] && amark="✅"; [[ "$agreed" == "NO" ]] && amark="⚠️"
  echo "| \`$rel\` | $want | $efmt | $mfmt | $amark |" >>"$REPORT_MD"
  printf '  %-44s declared=%-4s ennio=%-12s maestro=%-12s %s\n' "$rel" "$want" "$efmt" "$mfmt" "$agreed"

  json_rows+=("{\"flow\":\"$rel\",\"declared\":\"$want\",\"ennio\":\"$e_out\",\"ennio_attempts\":$e_att,\"maestro\":\"$m_out\",\"maestro_attempts\":$m_att,\"agree\":\"$agreed\"}")
done

dur=$(($(date +%s) - start))
{
  echo
  echo "**$total flows · ${dur}s · ennio↔maestro agree: $agree · diverge: $diverge**"
  echo
  echo "_Maestro divergences are expected (see CONFORMANCE.md): grammar superset, looser ennio selectors, app-reuse statefulness, polling tolerance. This report is non-gating._"
} >>"$REPORT_MD"

{
  echo "{"
  echo "  \"platform\": \"$PLATFORM\", \"device\": \"$UDID\", \"max_attempts\": $MAX_ATTEMPTS,"
  echo "  \"total\": $total, \"agree\": $agree, \"diverge\": $diverge, \"seconds\": $dur,"
  echo "  \"rows\": ["
  row_first=1
  for r in "${json_rows[@]}"; do
    [[ $row_first -eq 1 ]] && row_first=0 || echo ","
    printf '    %s' "$r"
  done
  echo
  echo "  ]"
  echo "}"
} >"$REPORT_JSON"

echo
echo "========================================"
echo "platform: $PLATFORM   wall-time: ${dur}s   flows: $total"
echo "  ennio↔maestro agree:   $agree"
echo "  ennio↔maestro diverge: $diverge"
echo "report:     $REPORT_MD"
echo "json:       $REPORT_JSON"
echo "recordings: $REC_DIR"
