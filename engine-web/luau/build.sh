#!/usr/bin/env bash
# Builds Luau 0.747 (third_party/luau, unmodified) + our bridge to WASM.
# Output (vendored, committed): luau/dist/luau.mjs + luau/dist/luau.wasm
# Requires Emscripten 4.0.11: source ~/emsdk/emsdk_env.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
LUAU="$HERE/../../third_party/luau"
OUT="$HERE/dist"
OBJ="${TMPDIR:-/tmp}/dreamsy-luau-obj"
mkdir -p "$OUT" "$OBJ"
if ! command -v em++ >/dev/null; then EMSDK_QUIET=1 source "$HOME/emsdk/emsdk_env.sh" >/dev/null; fi

CXXFLAGS=(-O2 -std=c++17 -fwasm-exceptions -DNDEBUG
  -I"$LUAU/Common/include" -I"$LUAU/Ast/include" -I"$LUAU/Bytecode/include" -I"$LUAU/Bytecode/src" -I"$LUAU/Compiler/include" -I"$LUAU/VM/include" -I"$LUAU/VM/src")

SRCS=("$LUAU"/Common/src/*.cpp "$LUAU"/VM/src/*.cpp "$LUAU"/Ast/src/*.cpp "$LUAU"/Bytecode/src/*.cpp "$LUAU"/Compiler/src/*.cpp "$HERE/src/bridge.cpp")
OBJS=()
pids=()
for src in "${SRCS[@]}"; do
  name="$(basename "$(dirname "$(dirname "$src")")")_$(basename "$src" .cpp).o"
  obj="$OBJ/$name"
  OBJS+=("$obj")
  if [[ ! -f "$obj" || "$src" -nt "$obj" ]]; then
    em++ "${CXXFLAGS[@]}" -c "$src" -o "$obj" &
    pids+=($!)
    if (( ${#pids[@]} >= 8 )); then wait "${pids[0]}" || { echo "compile failed" >&2; exit 1; }; pids=("${pids[@]:1}"); fi
  fi
done
for p in "${pids[@]}"; do wait "$p" || { echo "compile failed" >&2; exit 1; }; done

em++ "${OBJS[@]}" -O2 -fwasm-exceptions \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createLuau \
  -sENVIRONMENT=web,node -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=16MB -sSTACK_SIZE=1MB \
  -sFILESYSTEM=0 -sINCOMING_MODULE_JS_API=wasmBinary,locateFile,print,printErr \
  -sEXPORTED_FUNCTIONS=_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAP32,HEAPU32,UTF8ToString \
  -o "$OUT/luau.mjs"
ls -la "$OUT"
