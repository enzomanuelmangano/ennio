#!/usr/bin/env bash
# Build the enniohid host helper — the in-house HID sender that posts
# real touches into the simulator via CoreSimulator Indigo (SimulatorKit
# SimDeviceLegacyHIDClient + the vendored MIT Indigo builder). Replaces
# idb_companion's touch path. Output: /tmp/ennio-build/enniohid
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

echo "Compiling enniohid → $OUT_DIR/enniohid"
clang -arch arm64 -c "$SRC/swiftcall.c" -o "$OUT_DIR/swiftcall.o"
xcrun swiftc -O \
  "$SRC/enniohid.swift" "$OUT_DIR/swiftcall.o" \
  -import-objc-header "$SRC/indigo_touch.h" \
  -F "$CS_DIR" -F "$SK_DIR" \
  -framework CoreSimulator -framework SimulatorKit \
  -Xlinker -rpath -Xlinker "$CS_DIR" \
  -Xlinker -rpath -Xlinker "$SK_DIR" \
  -o "$OUT_DIR/enniohid"

echo "Built → $OUT_DIR/enniohid"
ls -lh "$OUT_DIR/enniohid"
