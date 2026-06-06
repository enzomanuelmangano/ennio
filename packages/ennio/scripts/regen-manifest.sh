#!/usr/bin/env bash
# Regenerate packages/ennio/prebuilt/manifest.json from the current contents
# of packages/ennio/prebuilt/. CI runs this after building the dylib so the
# published npm tarball ships a fresh manifest. Local devs run it after
# rebuilding to refresh the SHA-256 the CLI verifies before dlopen.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
DIR="$ROOT/prebuilt"

if [[ ! -d "$DIR" ]]; then
    echo "No prebuilt/ directory at $DIR" >&2
    exit 1
fi

sha_for() {
    shasum -a 256 "$1" | awk '{print $1}'
}

SHIM="$DIR/libennio-shim.dylib"
if [[ ! -f "$SHIM" ]]; then
    echo "Missing shim at $SHIM. Run build-shim.sh first." >&2
    exit 2
fi

DYLIB="$DIR/libennio.dylib"
if [[ ! -f "$DYLIB" ]]; then
    echo "Missing dylib at $DYLIB. Run build-dylib.sh first." >&2
    exit 3
fi

HID="$DIR/enniohid"
if [[ ! -f "$HID" ]]; then
    echo "Missing enniohid at $HID. Run build-hid-helper.sh first." >&2
    exit 4
fi

OUT="$DIR/manifest.json"
cat > "$OUT" <<MANIFEST
{
  "\$comment": "CLI verifies SHA-256 before dlopen / helper spawn. Single universal dylib — no per-RN-version slices.",
  "schema": 3,
  "shim": {
    "file": "libennio-shim.dylib",
    "sha256": "$(sha_for "$SHIM")"
  },
  "dylib": {
    "file": "libennio.dylib",
    "sha256": "$(sha_for "$DYLIB")"
  },
  "hid": {
    "file": "enniohid",
    "sha256": "$(sha_for "$HID")"
  }
}
MANIFEST

echo "Wrote $OUT"
cat "$OUT"
