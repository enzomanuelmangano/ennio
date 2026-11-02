#!/usr/bin/env bash
# Build the ennioax host helper — reads the booted simulator's iOS
# accessibility tree out of Simulator.app's macOS AX tree (cross-process:
# system sheets, pickers, SpringBoard alerts the in-app dylib can't see).
# Output: /tmp/ennio-build/ennioax
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
OUT_DIR=/tmp/ennio-build
mkdir -p "$OUT_DIR"
echo "Compiling ennioax → $OUT_DIR/ennioax"
# Pin the deployment target: without it clang uses the build machine's OS,
# and a helper built on a newer macOS refuses to run on older hosts (CI
# runners) — the cross-process AX paths then go silently blind.
clang -fobjc-arc -O2 -mmacosx-version-min=13.0 \
  "$ROOT/native-ax/ennioax.m" \
  -F /Library/Developer/PrivateFrameworks -framework CoreSimulator \
  -framework Cocoa -framework ApplicationServices \
  -o "$OUT_DIR/ennioax"
echo "Built → $OUT_DIR/ennioax"
