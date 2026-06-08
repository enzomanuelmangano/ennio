#!/usr/bin/env bash
# Build the Android injection agent:
#   1. javac  EnnioAgent.java            → .class   (framework-only deps)
#   2. d8     .class                     → agent.dex
#   3. embed  agent.dex                  → agent_dex.h  (C byte array)
#   4. ndk    ennio_inject.cpp + header  → libennio.so  (JVMTI agent)
#
# Output: /tmp/ennio-android/{libennio.so, agent.dex}. The CLI pushes
# libennio.so to the device and attaches it with `am attach-agent`.
# Mirrors scripts/build-dylib-local.sh on the iOS side. Set ENNIO_ABI to
# target a specific ABI (arm64-v8a default; x86_64 for KVM emulators).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/Library/Android/sdk}}"

ABI="${ENNIO_ABI:-arm64-v8a}"
API="${ENNIO_MIN_API:-27}"

BT="$(ls "$SDK/build-tools" | sort -V | tail -1)"
PLAT="$(ls "$SDK/platforms" | sort -V | tail -1)"
NDK="$(ls -d "$SDK/ndk/"* | sort -V | tail -1)"
ANDROID_JAR="$SDK/platforms/$PLAT/android.jar"
D8="$SDK/build-tools/$BT/d8"

HOST_TAG="darwin-x86_64"
[ "$(uname)" = "Linux" ] && HOST_TAG="linux-x86_64"
TOOLCHAIN="$NDK/toolchains/llvm/prebuilt/$HOST_TAG"

case "$ABI" in
  arm64-v8a) TRIPLE="aarch64-linux-android" ;;
  armeabi-v7a) TRIPLE="armv7a-linux-androideabi" ;;
  x86_64) TRIPLE="x86_64-linux-android" ;;
  *) echo "unsupported ABI $ABI"; exit 1 ;;
esac
CLANGXX="$TOOLCHAIN/bin/${TRIPLE}${API}-clang++"

OUT="/tmp/ennio-android"
WORK="$OUT/work"
rm -rf "$WORK"; mkdir -p "$WORK/classes" "$OUT"

echo "[1/4] javac (android.jar=$PLAT)"
javac -classpath "$ANDROID_JAR" -d "$WORK/classes" \
  "$ROOT/agent/ennio/inject/EnnioAgent.java"

echo "[2/4] d8 → dex (build-tools $BT, min-api $API)"
# Guard: d8 happily emits a valid-but-empty dex from zero inputs, which would
# embed a broken (agent-less) .so that "builds" yet never binds @ennio. javac
# under `set -e` already aborts on a compile error, but assert the class set is
# non-empty so a moved/renamed source can't slip through as a silent no-op.
CLASS_COUNT=$(find "$WORK/classes" -name '*.class' | wc -l | tr -d ' ')
if [ "$CLASS_COUNT" -eq 0 ]; then
  echo "error: no .class files produced — agent source missing or javac emitted nothing" >&2
  exit 1
fi
"$D8" --min-api "$API" --lib "$ANDROID_JAR" --output "$WORK" \
  $(find "$WORK/classes" -name '*.class')
cp "$WORK/classes.dex" "$OUT/agent.dex"

echo "[3/4] embed dex → agent_dex.h"
node -e '
const fs=require("fs");
const b=fs.readFileSync(process.argv[1]);
let s="// generated — embedded agent dex\n#pragma once\nstatic const unsigned char agent_dex[] = {";
for(let i=0;i<b.length;i++){ if(i%16===0)s+="\n  "; s+="0x"+b[i].toString(16).padStart(2,"0")+","; }
s+="\n};\nstatic const unsigned int agent_dex_len = "+b.length+";\n";
fs.writeFileSync(process.argv[2], s);
' "$OUT/agent.dex" "$ROOT/native/agent_dex.h"

echo "[4/5] ndk compile → libennio.so ($ABI, $TRIPLE$API)"
# Static libc++: the agent is loaded into a process whose linker namespace may
# not expose libc++_shared.so, so a shared-C++ dependency fails at load time —
# bundle it. Only libc/libm/libdl/liblog are guaranteed.
"$CLANGXX" -shared -fPIC -O2 -std=c++17 \
  -static-libstdc++ -fno-exceptions -fno-rtti \
  -I"$ROOT/native" \
  -o "$OUT/libennio.so" \
  "$ROOT/native/ennio_inject.cpp" \
  -llog

echo "[5/5] ndk compile → ennio_ptrace ($ABI)"
# The on-device ptrace injector (runs as root). Loads libennio.so into ANY
# process — including a non-debuggable release build that am attach-agent
# refuses. Static libc++ so it runs standalone from /data/local/tmp.
"$CLANGXX" -O2 -std=c++17 -static-libstdc++ \
  -o "$OUT/ennio_ptrace" \
  "$ROOT/native/ptrace_inject.cpp"

echo ""
echo "Built:"
ls -la "$OUT/libennio.so" "$OUT/ennio_ptrace" "$OUT/agent.dex"
echo "dex bytes: $(wc -c < "$OUT/agent.dex")"
