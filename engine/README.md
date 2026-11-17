# Dreamsy engine v2 (C++)

The native 2D/2.5D engine: one C++20 core for web (WebAssembly), iOS, Android and headless game
servers. Design and roadmap: `DREAMSY.MD` §14. New to C++? Start with `docs/CPP-FOR-TS-DEVS.md`.

Status: **slices E0 (scaffold) and E1 (packages) done.** It builds on every target, loads and validates
every game in `games/` (same verdicts as the TypeScript validator), and reads/writes Dreamsy packs
(`.dpk`, DREAMSY.MD §3.6). It does not run games yet (E2 Luau, E3 world/physics); `engine-web/` is still
the shipping engine.

## Build

Needs CMake ≥ 3.22, Ninja, and a C++20 compiler (Apple clang 15+ or clang/gcc on Linux).

```sh
cd engine
cmake --preset debug && cmake --build --preset debug   # debug + AddressSanitizer/UBSan
ctest --preset debug                                   # run the tests
./build/debug/dreamsy-tool smoke                       # Luau + Box2D check
./build/debug/dreamsy-tool validate ../games/examples/feature-demo
./build/debug/dreamsy-tool pack ../games/examples/feature-demo /tmp/fd.dpk   # also converts .zip builds
./build/debug/dreamsy-tool info /tmp/fd.dpk            # summary + content hash
./build/debug/dreamsy-player                           # window (Metal on macOS)
```

Other presets: `release`, `headless` (no window; for Linux CI), `web`.

Web (needs Emscripten; the repo uses 4.0.11 in `~/emsdk`):

```sh
source ~/emsdk/emsdk_env.sh
cmake --preset web && cmake --build --preset web
ctest --preset web                                     # tests run under Node
# build/web/dreamsy-player.html: serve the folder with any static server to view it
```

## Layout

| Path | What |
|---|---|
| `src/base/` | `Result`/`Status` errors, `Pool`/`Id` handles, `Arena`, `Rng` (bit-identical to the TS engine), `Hasher`, logging, checks |
| `src/pkg/` | packages: `Files` (packs, dirs), `pack.cpp` (.dpk), `catalog` (embedded `format/catalog.json` + kit list), `manifest` (TOML), `formats` (tilesets, levels, anims, sfx, music, SVG), `validate` (`load_package()`), `zip_import` (tools only) |
| `src/platform/` | sokol implementation unit; web link settings |
| `src/dev/` | E0 smoke checks (Luau, Box2D); replaced by `src/script` (E2) and `src/physics` (E3) |
| `apps/tool/` | `dreamsy-tool`, the headless CLI |
| `apps/player/` | `dreamsy-player`, the windowed engine |
| `tests/` | doctest unit tests, one binary: `dreamsy-tests` |
| `tests/conformance/` | `conformance.py`: C++ vs `format/src/validate.ts` on every game plus ~80 generated broken packages |
| `fuzz/` | fuzz targets (pack, package, zip import); `-replay` builds run in ctest, libFuzzer builds in CI |

Third-party code lives in `../third_party/` (vendored, unmodified; each folder has `DREAMSY_VENDOR.md`).

## Rules

- No `throw`/`try` in engine code; errors are `Result`/`Status` (§14.2).
- No raw `new`/`delete`; reference long-lived objects by `Id<T>`, never by pointer across frames.
- Simulation code never reads the clock or OS randomness; use `Rng` and the tick counter (§14.4).
- Builds use `-ffp-contract=off -fno-fast-math` everywhere. The physics golden-hash test fails if
  determinism breaks on any platform.

## Checks beyond unit tests

```sh
python3 tests/conformance/conformance.py              # needs `pnpm install` in format/
python3 fuzz/make_corpus.py /tmp/corpus build/debug/dreamsy-tool
DREAMSY_FUZZ_SAVE=/tmp/last.bin ./build/debug/fuzz-package-replay --mutate 1000 /tmp/corpus/package
```

After a fuzz crash, `/tmp/last.bin` holds the input that caused it.
