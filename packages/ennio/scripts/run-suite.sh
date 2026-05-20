#!/usr/bin/env bash
# Run every Maestro YAML in example/maestro-e2e/ and tally pass/fail.
#
# Skips the meta-aggregator (00-full-suite.yaml) and any file that's
# explicitly a subflow (leading underscore or under subflows/).
#
# Usage:  scripts/run-suite.sh [optional pattern]
# Env:    ENNIO_UDID, ENNIO_DYLIB_PATH (required)

set -uo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
CLI="$REPO/packages/ennio/dist/cli.js"
FLOW_DIR="$REPO/example/maestro-e2e"
LOG_DIR="/tmp/ennio-suite-log"
mkdir -p "$LOG_DIR"
rm -f "$LOG_DIR"/*.log

UDID="${ENNIO_UDID:?ENNIO_UDID required}"
DYLIB="${ENNIO_DYLIB_PATH:?ENNIO_DYLIB_PATH required}"

pattern="${1:-*.yaml}"

pass=0
fail=0
err=0
results=()

while IFS= read -r -d '' file; do
    name=$(basename "$file")
    # Skip aggregators + subflows.
    if [[ "$name" == 00-* ]]; then continue; fi
    if [[ "$name" == _* ]]; then continue; fi
    if [[ "$file" == *"/subflows/"* ]]; then continue; fi

    echo "▸ $name"
    log="$LOG_DIR/$name.log"
    # Fresh start between flows: terminate the app + drop the socket
    # file. The CLI's auto-launch path re-runs the app with DYLD inject.
    # Without this, flows that use `launchApp` (no clearState) inherit
    # whatever screen the previous flow left, and tap targets that are
    # only present in the initial state (tab bar items) go missing.
    xcrun simctl terminate "$UDID" com.ennio.example >/dev/null 2>&1 || true
    rm -f /tmp/ennio-control.sock
    if ENNIO_UDID="$UDID" ENNIO_DYLIB_PATH="$DYLIB" \
        node "$CLI" test "$file" >"$log" 2>&1; then
        echo "  [PASS]"
        pass=$((pass + 1))
        results+=("PASS|$name")
    else
        # Distinguish step failure from infra error
        if grep -q "\[FAIL\]" "$log"; then
            echo "  [FAIL] $(grep -E '\[FAIL\] step' "$log" | head -1 | sed 's/^[[:space:]]*//')"
            fail=$((fail + 1))
            results+=("FAIL|$name")
        else
            echo "  [ERROR] (see $log)"
            err=$((err + 1))
            results+=("ERROR|$name")
        fi
    fi
done < <(find "$FLOW_DIR" -maxdepth 1 -name "$pattern" -type f -print0 | sort -z)

echo
echo "========================================"
total=$((pass + fail + err))
echo "Total: $total"
echo "  pass:  $pass"
echo "  fail:  $fail"
echo "  error: $err"
if [[ $total -gt 0 ]]; then
    pct=$((pass * 100 / total))
    echo "  pass rate: ${pct}%"
fi
echo
echo "Per-file results:"
for r in "${results[@]}"; do
    echo "  $r"
done
