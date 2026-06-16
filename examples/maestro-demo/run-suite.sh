#!/usr/bin/env bash
# Maestro-demo conformance runner.
#
# Runs every flow under maestro-e2e/ and ASSERTS its declared outcome:
#   - flows named fail_* or tagged `failing` MUST fail
#   - every other flow MUST pass
# A mismatch (passing flow fails, or failing flow passes) is a regression
# and exits non-zero — this is the outcome discipline borrowed from
# Maestro's own e2e suite, where every flow carries a passing|failing label.
#
# Known divergences (flows whose declared outcome ennio does not yet honour)
# are listed in KNOWN_XPASS / KNOWN_XFAIL: they're reported but don't fail
# the run, so the baseline stays green while the underlying bug is tracked.
#
# Usage:  run-suite.sh <ios|android> [flow-glob]
# Env:    ENNIO_UDID (ios udid / android serial). ENNIO_DYLIB_PATH optional.

set -uo pipefail

PLATFORM="${1:-ios}"
GLOB="${2:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
CLI="$REPO/packages/ennio/dist/cli.js"
FLOW_DIR="$HERE/maestro-e2e"
APP_ID="com.ennio.maestrodemo"
LOG_DIR="/tmp/mdemo-suite-log"
mkdir -p "$LOG_DIR"; rm -f "$LOG_DIR"/*.log

UDID="${ENNIO_UDID:?ENNIO_UDID required (ios udid or android serial)}"
PLATFORM_FLAG=""
[[ "$PLATFORM" == "android" ]] && PLATFORM_FLAG="--android"

# Flows whose declared `failing` outcome ennio currently does NOT honour.
# Reported as KNOWN-XPASS, not a hard failure. Remove an entry once fixed.
#   fail_launchApp: launchApp reuses the running instrumented app and
#   ignores a bundle-id mismatch, so launching a bogus appId "succeeds".
KNOWN_XPASS=("fail_launchApp.yaml")

terminate_app() {
  if [[ "$PLATFORM" == "android" ]]; then
    adb -s "$UDID" shell am force-stop "$APP_ID" >/dev/null 2>&1 || true
  else
    xcrun simctl terminate "$UDID" "$APP_ID" >/dev/null 2>&1 || true
  fi
}

in_list() { local n="$1"; shift; for x in "$@"; do [[ "$x" == "$n" ]] && return 0; done; return 1; }

expect_fail() {
  local file="$1" name="$2"
  [[ "$name" == fail_* ]] && return 0
  # `failing` tag under a tags: block
  grep -qE '^\s*-\s*failing\s*$' "$file" && return 0
  return 1
}

regressions=0; ok=0; xpass=0
results=()
start=$(date +%s)

# Collect the flow list up-front so the per-flow CLI run can't disturb the
# loop's iteration (stdin draining / process-substitution teardown).
files=()
while IFS= read -r -d '' f; do files+=("$f"); done \
  < <(find "$FLOW_DIR" -name '*.yaml' -type f -print0 | sort -z)

for file in "${files[@]}"; do
  name="$(basename "$file")"
  rel="${file#"$FLOW_DIR"/}"
  case "$name" in config.yaml) continue;; esac
  [[ "$file" == *"/subflows/"* ]] && continue
  [[ "$file" == *"/scripts/"* ]] && continue
  [[ -n "$GLOB" && "$name" != $GLOB ]] && continue

  if expect_fail "$file" "$name"; then want="FAIL"; else want="PASS"; fi

  terminate_app
  log="$LOG_DIR/${name}.log"
  # </dev/null: keep the CLI from draining the while-loop's stdin (the
  # Android backend reads stdin and would otherwise swallow the flow list).
  if ENNIO_UDID="$UDID" node "$CLI" test $PLATFORM_FLAG "$file" >"$log" 2>&1 </dev/null; then
    got="PASS"
  else
    got="FAIL"
  fi

  if [[ "$got" == "$want" ]]; then
    echo "  ✓ $rel  ($want)"
    ok=$((ok + 1)); results+=("OK|$rel")
  elif in_list "$name" "${KNOWN_XPASS[@]}"; then
    echo "  ~ $rel  KNOWN-XPASS (declared $want, got $got — tracked divergence)"
    xpass=$((xpass + 1)); results+=("XPASS|$rel")
  else
    echo "  ✗ $rel  REGRESSION (declared $want, got $got)  see $log"
    regressions=$((regressions + 1)); results+=("REGRESSION|$rel")
  fi
done

dur=$(($(date +%s) - start))
echo
echo "========================================"
echo "platform: $PLATFORM   wall-time: ${dur}s"
echo "  outcome-matched: $ok"
echo "  known-xpass:     $xpass"
echo "  regressions:     $regressions"
if [[ $regressions -gt 0 ]]; then
  echo
  echo "REGRESSIONS:"
  printf '%s\n' "${results[@]}" | awk -F'|' '$1=="REGRESSION"{print "  "$2}'
  exit 1
fi
echo "OK — every flow matched its declared outcome."
