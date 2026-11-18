# Dreamsy engine v2 (C++)

The native 2D/2.5D engine: one C++20 core for web (WebAssembly), iOS, Android and headless game
servers. Design and roadmap: `DREAMSY.MD` §14. New to C++? Start with `docs/CPP-FOR-TS-DEVS.md`.

Status: **E0 (scaffold), E1 (packages) done; E2 (scripting) mostly done; E4 (renderer) foundation in progress.** It loads and validates every
game in `games/` (same verdicts as the TypeScript validator), reads/writes Dreamsy packs (`.dpk`, §3.6), and
runs game scripts natively with output identical to engine-web, minus entities (E3 world/physics, next).
`engine-web/` is still the shipping engine.

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
./build/debug/dreamsy-tool run tests/scripts/basics    # run scripts headless (logs, errors, save)
./build/debug/dreamsy-player                           # window (Metal): renderer test scene from feature-demo
./build/debug/dreamsy-player --view iso                # side | topdown | oblique | iso; keys 1-4 / Tab; --smooth; --frames N
```

Other presets: `release`, `headless` (no window; for Linux CI), `web`.

Web (needs Emscripten; the repo uses 4.0.11 in `~/emsdk`):

```sh
source ~/emsdk/emsdk_env.sh
cmake --preset web && cmake --build --preset web
ctest --preset web                                     # tests run under Node
# build/web/dreamsy-player.html: serve the folder with any static server to view it
# (dreamsy-player.html#iso picks the view mode, #iso-smooth forces smooth mode)
NODE_PATH=../engine-web/node_modules node tools/web_screenshot.cjs /tmp/dreamsy-e4 540x960
#   headless Chromium screenshots of every view mode (Playwright page.route, no server)
```

## Layout

| Path | What |
|---|---|
| `src/base/` | `Result`/`Status` errors, `Pool`/`Id` handles, `Arena`, `Rng` (bit-identical to the TS engine), `Hasher`, logging, checks |
| `src/pkg/` | packages: `Files` (packs, dirs), `pack.cpp` (.dpk), `catalog` (embedded `format/catalog.json` + kit list), `manifest` (TOML), `formats` (tilesets, levels, anims, sfx, music, SVG), `validate` (`load_package()`), `zip_import` (tools only) |
| `src/script/` | Luau host (§14.13): `vm` (sandbox, memory cap, CPU budget, tracebacks), `host` (scripts, require, kits, scheduler, host ops), prelude + kits embedded from engine-web at build time |
| `src/render/` | renderer (E4). CPU side, no GPU (`dreamsy_render`): `draw_list.h` (what E3 fills each frame), `sort` (depth order per view mode, shadows), `view` (letterbox, projection, camera, pixel snap), `image` (PNG/JPG stb_image, SVG nanosvg), `atlas` (stb_rect_pack pages), `textures` (package images on first use), `font` (bundled fonts, stb_truetype, layout), `geometry` (batched quads), `style` (manifest render settings). GPU side (`dreamsy_render_gpu`): `renderer` (sokol_gfx, hand-written Metal + GLSL ES 3.0 shaders) |
| `src/dmath/` | deterministic math: musl libm linked into every executable (see its README) |
| `src/platform/` | sokol implementation unit; web link settings |
| `src/dev/` | E0 smoke checks (Luau, Box2D); replaced by `src/script` (E2) and `src/physics` (E3) |
| `apps/tool/` | `dreamsy-tool`, the headless CLI |
| `apps/player/` | `dreamsy-player`, the windowed engine; `demo_scene` draws a test scene from a package's assets until E3/E6 |
| `tools/` | `web_screenshot.cjs` (screenshots of the web player) |
| `tests/` | doctest unit tests, one binary: `dreamsy-tests` |
| `tests/conformance/` | `conformance.py`: C++ vs `format/src/validate.ts` on every game plus ~80 generated broken packages; `run_compare.py`: C++ vs engine-web running `tests/scripts/*` (logs, errors, audio, save, time must be identical) |
| `tests/scripts/` | script-only test games (basics, modules, data/save, errors/budget, scenes/room/store/audio, math) |
| `fuzz/` | fuzz targets (pack, package, zip import); `-replay` builds run in ctest, libFuzzer builds in CI |

Third-party code lives in `../third_party/` (vendored, unmodified; each folder has `DREAMSY_VENDOR.md`).

## Renderer notes (E4)

- Draw order per view mode (DREAMSY.MD §14.5): layer, then `z_index` (a sub-layer, as in Godot), then
  side: submission order; topdown: y; oblique: y, z; iso: x+y, z; ties by submission order. Tiles and
  ground rects draw under upright items of the same layer/z_index, shadows between.
- One draw call per atlas page: images, glyphs, alpha and additive blending share batches
  (premultiplied colors; additive = alpha 0).
- Pixel-art styles (`pixel`) draw the world into a reference-size target and scale it up with nearest
  filtering; the UI is drawn on top at full resolution. Other styles draw directly (linear filtering).
- Not supported yet: WebP images (clear error, drawn as a solid rect; no package uses WebP), SVG `<text>`
  (nanosvg; two kit icons use it), characters outside Latin-1 (fonts are subset; fallback is later),
  MSDF text (outlines are 8 offset copies), tilemap elevation (E7), lighting, particles, render targets
  and post effects.

## Rules

- No `throw`/`try` in engine code; errors are `Result`/`Status` (§14.2).
- No raw `new`/`delete`; reference long-lived objects by `Id<T>`, never by pointer across frames.
- Simulation code never reads the clock or OS randomness; use `Rng` and the tick counter (§14.4).
- Builds use `-ffp-contract=off -fno-fast-math` everywhere. The physics golden-hash test fails if
  determinism breaks on any platform.

## Checks beyond unit tests

```sh
python3 tests/conformance/conformance.py              # needs `pnpm install` (format/, engine-web/)
python3 tests/conformance/run_compare.py
python3 fuzz/make_corpus.py /tmp/corpus build/debug/dreamsy-tool
DREAMSY_FUZZ_SAVE=/tmp/last.bin ./build/debug/fuzz-package-replay --mutate 1000 /tmp/corpus/package
```

After a fuzz crash, `/tmp/last.bin` holds the input that caused it.
