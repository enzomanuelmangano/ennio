#!/usr/bin/env bash
# Build the ennio dylib for the iOS simulator.
#
# The dylib uses -undefined dynamic_lookup so all React Native / Hermes /
# Folly symbols resolve from the host process at load time. A single
# universal binary works across all RN versions (New Architecture, 0.73+).
#
# Usage:
#   build-dylib.sh
#
# Required environment:
#   ENNIO_OBJECTS_DIR  Absolute path to a directory containing freshly-built
#                      EnnioCore object files (e.g. from clang++ compilation
#                      of the ios/ source files). If unset, the script tries
#                      to autodiscover one under ~/Library/Developer/Xcode/DerivedData.
#
# Output: packages/ennio/prebuilt/libennio.dylib
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
OUT_DIR="$ROOT/prebuilt"
OUT="$OUT_DIR/libennio.dylib"

mkdir -p "$OUT_DIR"

# Locate freshly-built EnnioCore .o files. Caller can pin the path via
# ENNIO_OBJECTS_DIR. Without it we pick the most recently modified candidate
# under DerivedData. Fail loudly if nothing matches — the script is not in
# the business of building the pod itself; that's the host app's xcodebuild.
if [[ -n "${ENNIO_OBJECTS_DIR:-}" ]]; then
    OBJ_DIR="$ENNIO_OBJECTS_DIR"
else
    OBJ_DIR="$(find "$HOME/Library/Developer/Xcode/DerivedData" \
        -type d -path '*EnnioCore.build/Objects-normal/arm64' \
        -mindepth 1 -prune 2>/dev/null \
        | xargs -I{} stat -f '%m %N' {} 2>/dev/null \
        | sort -nr | head -n 1 | awk '{print $2}')"
fi

if [[ -z "${OBJ_DIR:-}" || ! -d "$OBJ_DIR" ]]; then
    echo "Cannot find EnnioCore object directory." >&2
    echo "Either set ENNIO_OBJECTS_DIR or build the example/host app first." >&2
    exit 65
fi

OBJ_COUNT="$(ls "$OBJ_DIR"/*.o 2>/dev/null | wc -l | tr -d ' ')"
if [[ "$OBJ_COUNT" -lt 5 ]]; then
    echo "EnnioCore objects dir looks empty ($OBJ_COUNT .o files): $OBJ_DIR" >&2
    exit 66
fi

echo "Linking $OBJ_COUNT objects from $OBJ_DIR"

SDK_PATH="$(xcrun --sdk iphonesimulator --show-sdk-path)"
TARGET="arm64-apple-ios15.1-simulator"

xcrun --sdk iphonesimulator clang++ \
    -dynamiclib \
    -target "$TARGET" \
    -isysroot "$SDK_PATH" \
    -undefined dynamic_lookup \
    -framework Foundation \
    -framework UIKit \
    -o "$OUT" \
    "$OBJ_DIR"/*.o

echo "Built dylib → $OUT"
file "$OUT"
ls -lh "$OUT"
