#!/usr/bin/env bash
# Direct compile of every ennio source file into a sim dylib. Used for
# fast local iteration when we don't want to re-scaffold an Expo app to
# rebuild the EnnioCore pod. Output: /tmp/ennio-build/libennio.dylib
# (the dev-mode lookup path the CLI checks first).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

OUT_DIR=/tmp/ennio-build
OUT="$OUT_DIR/libennio.dylib"
mkdir -p "$OUT_DIR"

SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
TARGET="arm64-apple-ios15.1-simulator"

SRCS=()
SRCS+=("$ROOT/cpp/EnnioControlSocket.cpp")
while IFS= read -r f; do SRCS+=("$f"); done < <(find "$ROOT/ios" -name '*.mm')

echo "Compiling ${#SRCS[@]} sources → $OUT"

xcrun --sdk iphonesimulator clang++ \
    -dynamiclib \
    -target "$TARGET" \
    -isysroot "$SDK" \
    -std=c++17 \
    -fobjc-arc \
    -fno-objc-arc-exceptions \
    -O2 \
    -I"$ROOT/cpp" \
    -I"$ROOT/ios" \
    -framework Foundation \
    -framework UIKit \
    -framework QuartzCore \
    -framework CoreGraphics \
    -undefined dynamic_lookup \
    -install_name "$OUT" \
    -o "$OUT" \
    "${SRCS[@]}"

echo "Built → $OUT"
ls -lh "$OUT"
