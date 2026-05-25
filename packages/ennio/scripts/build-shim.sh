#!/usr/bin/env bash
# Build the ennio shim dylib.
#
# The shim is RN-agnostic and safe to set as DYLD_INSERT_LIBRARIES globally on
# the simulator. Its only job is to detect whether the host process is a
# React Native app (RCTInstance class present) and, if so, dlopen the matching
# real ennio dylib. In any other process it no-ops, so we don't crash
# launchctl, system daemons, or any other simulator-side helper.
#
# Output: packages/ennio/prebuilt/libennio-shim.dylib
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
OUT_DIR="$ROOT/prebuilt"
SRC="$ROOT/native-shim/ennio-shim.m"
OUT="$OUT_DIR/libennio-shim.dylib"

mkdir -p "$OUT_DIR"

SDK_PATH="$(xcrun --sdk iphonesimulator --show-sdk-path)"
TARGET="arm64-apple-ios15.1-simulator"

xcrun --sdk iphonesimulator clang \
    -dynamiclib \
    -target "$TARGET" \
    -isysroot "$SDK_PATH" \
    -framework Foundation \
    -o "$OUT" \
    "$SRC"

echo "Built shim → $OUT"
file "$OUT"
