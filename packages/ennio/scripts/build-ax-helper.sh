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
clang -fobjc-arc -O2 \
  "$ROOT/native-ax/ennioax.m" \
  -F /Library/Developer/PrivateFrameworks -framework CoreSimulator \
  -framework Cocoa -framework ApplicationServices \
  -o "$OUT_DIR/ennioax"
echo "Built → $OUT_DIR/ennioax"
