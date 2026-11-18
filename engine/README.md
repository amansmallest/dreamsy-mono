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
./build/debug/dreamsy-tool check ../games/examples/feature-demo   # type-check scripts (format/dreamsy.d.luau)
./build/debug/dreamsy-player                           # window (Metal): renderer test scene from feature-demo
./build/debug/dreamsy-player --view iso                # side | topdown | oblique | iso; keys 1-4 / Tab; --smooth; --frames N
```

Other presets: `release`, `headless` (no window; for Linux CI), `web`, and `ios-sim`, `ios-device`,
`android-arm64` (see [Phones](#phones)).

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

## Phones

The player runs natively on phones (DREAMSY.MD §14.7, groundwork for E9): Metal on iOS, GLES3 on
Android, both through sokol_app. Today it shows the E0 spinning square. Scripts run the same as
everywhere else; Luau is always the interpreter (Luau.CodeGen is never linked), which is what iOS
requires anyway. Platform files live in `platform/ios/` (Info.plist template, `ios.cmake`) and
`platform/android/` (Gradle project).

### iOS Simulator

Needs Xcode with an iOS Simulator runtime (tested: Xcode 15.4, iOS 17.5 simulator, Apple silicon).

```sh
cmake --preset ios-sim && cmake --build --preset ios-sim     # build/ios-sim/Dreamsy.app (arm64)
xcrun simctl boot "iPhone 15"                                 # or open -a Simulator
xcrun simctl install booted build/ios-sim/Dreamsy.app
xcrun simctl launch --console-pty booted com.dreamsy.player   # log goes to this terminal
xcrun simctl io booted screenshot /tmp/dreamsy-ios.png
ctest --preset ios-sim                                        # dreamsy-tests inside the booted simulator
xcrun simctl spawn booted "$PWD/build/ios-sim/dreamsy-tool" run "$PWD/tests/scripts/basics"
xcrun simctl shutdown booted
```

`dreamsy-tests` and `dreamsy-tool` are plain command-line binaries; `simctl spawn` runs them in the
simulator, where they can read the Mac's files (use absolute paths). Simulator builds need no signing.

### Your own iPhone (free Apple ID)

The `ios-device` preset generates an Xcode project; Xcode signs it.

1. Xcode > Settings > Accounts: add your Apple ID. It gets a free "Personal Team".
2. On the phone (iOS 16+): connect by cable, tap "Trust", then turn on Settings > Privacy & Security >
   Developer Mode and restart.
3. Pick a bundle ID nobody else has used (free teams cannot use `com.dreamsy.player`), and generate:
   ```sh
   cmake --preset ios-device -DDREAMSY_IOS_BUNDLE_ID=com.yourname.dreamsy -DDREAMSY_IOS_TEAM_ID=YOURTEAMID
   open build/ios-device/dreamsy_engine.xcodeproj
   ```
   The team ID is shown in Xcode > Settings > Accounts (or leave it out and pick the team in Xcode under
   the `dreamsy-player` target > Signing & Capabilities; re-running CMake resets that choice).
4. In Xcode pick the `dreamsy-player` scheme and your phone, press Run.
5. First launch only: on the phone, Settings > General > VPN & Device Management > trust your developer
   profile, then open Dreamsy.

Without the Xcode UI:

```sh
cmake --build --preset ios-device -- -allowProvisioningUpdates
xcrun devicectl list devices
xcrun devicectl device install app --device <id> build/ios-device/Release-iphoneos/Dreamsy.app
xcrun devicectl device process launch --device <id> com.yourname.dreamsy
```

Limits of a free Apple ID: the app stops launching after 7 days (run again from Xcode), at most 3 apps
per device. Xcode only deploys to iOS versions it knows: Xcode 15.4 goes up to iOS 17.x, so a phone on a
newer iOS needs a newer Xcode. To check the device build compiles without signing:
`cmake --build --preset ios-device -- CODE_SIGNING_ALLOWED=NO`.

### Android

Not built yet on this machine (no SDK/NDK). What to install:

- Android Studio (it brings the SDK, a JDK 17+ and Gradle support), or the command-line tools.
- SDK Manager: Android SDK Platform 35, Build-Tools 35, **NDK 27.2.12479018** (r27c), **CMake 3.22.1**.
- Python 3 on `PATH` (the engine build runs code generators) and Gradle 8.9+ if building from a shell.

Build the APK (NativeActivity, arm64-v8a, minSdk 26) with Gradle:

```sh
cd platform/android
gradle wrapper --gradle-version 8.10.2      # once; or just open this folder in Android Studio
./gradlew assembleDebug                      # app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.dreamsy.player/android.app.NativeActivity
adb logcat -s SOKOL                          # sokol logs to logcat (tag SOKOL)
```

Gradle runs `engine/CMakeLists.txt` with `-DDREAMSY_BUILD_TESTS=OFF` and builds only `dreamsy-player`, which on
Android is `libdreamsy-player.so` (sokol_app supplies `ANativeActivity_onCreate`; there is no Java code).
For a plain CMake build of the libraries, tool and tests (e.g. to `adb push` and run them under
`/data/local/tmp`):

```sh
export ANDROID_NDK_HOME=~/Library/Android/sdk/ndk/27.2.12479018
cmake --preset android-arm64 && cmake --build --preset android-arm64
```

The engine's own logging (`base/log.cpp`) writes to stderr, which Android drops; it needs a logcat sink before E9.

## Layout

| Path | What |
|---|---|
| `src/base/` | `Result`/`Status` errors, `Pool`/`Id` handles, `Arena`, `Rng` (bit-identical to the TS engine), `Hasher`, logging, checks |
| `src/pkg/` | packages: `Files` (packs, dirs), `pack.cpp` (.dpk), `catalog` (embedded `format/catalog.json` + kit list), `manifest` (TOML), `formats` (tilesets, levels, anims, sfx, music, SVG), `validate` (`load_package()`), `zip_import` (tools only) |
| `src/script/` | Luau host (§14.13): `vm` (sandbox, memory cap, CPU budget, tracebacks), `host` (scripts, require, kits, scheduler, host ops), prelude + kits embedded from engine-web at build time |
| `src/check/` | `dreamsy-tool check`: Luau analyzer over a package's scripts against `format/dreamsy.d.luau` (tools only) |
| `src/render/` | renderer (E4). CPU side, no GPU (`dreamsy_render`): `draw_list.h` (what E3 fills each frame), `sort` (depth order per view mode, shadows), `view` (letterbox, projection, camera, pixel snap), `image` (PNG/JPG stb_image, SVG nanosvg), `atlas` (stb_rect_pack pages), `textures` (package images on first use), `font` (bundled fonts, stb_truetype, layout), `geometry` (batched quads), `style` (manifest render settings). GPU side (`dreamsy_render_gpu`): `renderer` (sokol_gfx, hand-written Metal + GLSL ES 3.0 shaders) |
| `src/dmath/` | deterministic math: musl libm linked into every executable (see its README) |
| `src/platform/` | sokol implementation unit; web link settings |
| `platform/ios/` | iOS app bundle: `Info.plist.in`, `ios.cmake` (bundle ID, signing settings) |
| `platform/android/` | Android Gradle project: NativeActivity manifest loading `libdreamsy-player.so` |
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
