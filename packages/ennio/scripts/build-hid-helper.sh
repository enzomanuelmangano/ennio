#!/usr/bin/env bash
# Build the enniohid host helper — the in-house HID sender that posts
# real touches into the simulator via CoreSimulator Indigo (SimulatorKit
# SimDeviceLegacyHIDClient + the vendored MIT Indigo builder). Replaces
# the host CoreSimulator touch path. Output: /tmp/ennio-build/enniohid
# (the dev-mode path EnnioHidClient checks first).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SRC="$ROOT/native-hid/helper"
OUT_DIR=/tmp/ennio-build
mkdir -p "$OUT_DIR"

DEV="$(xcode-select -p)"
CS_DIR="/Library/Developer/PrivateFrameworks"
SK_DIR="$DEV/Library/PrivateFrameworks"
# Xcode 27 moved SimulatorKit to Contents/SharedFrameworks.
[ -d "$SK_DIR/SimulatorKit.framework" ] || SK_DIR="$(dirname "$DEV")/SharedFrameworks"

echo "Compiling enniohid → $OUT_DIR/enniohid"
# Deployment target pinned (see build-ax-helper.sh): the helper must run on
# hosts older than the build machine.
clang -arch arm64 -mmacosx-version-min=13.0 -c "$SRC/swiftcall.c" -o "$OUT_DIR/swiftcall.o"
xcrun swiftc -O -target arm64-apple-macos13.0 \
  "$SRC/enniohid.swift" "$OUT_DIR/swiftcall.o" \
  -import-objc-header "$SRC/indigo_touch.h" \
  -F "$CS_DIR" -F "$SK_DIR" \
  -framework CoreSimulator -framework SimulatorKit \
  -Xlinker -rpath -Xlinker "$CS_DIR" \
  -Xlinker -rpath -Xlinker "$SK_DIR" \
  -o "$OUT_DIR/enniohid"

echo "Built → $OUT_DIR/enniohid"
ls -lh "$OUT_DIR/enniohid"
