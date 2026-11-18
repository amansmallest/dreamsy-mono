# Dreamsy engine v2 (DREAMSY.MD §14).
#
#   cmake --preset debug && cmake --build --preset debug && ctest --preset debug
#
# Presets: debug (ASan + UBSan), release, web (Emscripten; needs `source ~/emsdk/emsdk_env.sh`).
cmake_minimum_required(VERSION 3.22)
project(dreamsy_engine LANGUAGES C CXX)

if(APPLE)
  enable_language(OBJC)
endif()

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_C_STANDARD 17)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

option(DREAMSY_SANITIZE "Build everything with AddressSanitizer + UndefinedBehaviorSanitizer" OFF)
option(DREAMSY_BUILD_PLAYER "Build the windowed player (needs a graphics stack)" ON)
option(DREAMSY_BUILD_TESTS "Build the test runner" ON)

set(THIRD_PARTY ${CMAKE_CURRENT_SOURCE_DIR}/../third_party)

# Determinism (§14.4): no fused multiply-add contraction, no fast-math, anywhere.
add_compile_options(-ffp-contract=off -fno-fast-math)

# Luau raises script errors as C++ exceptions (§14.2). On the web they need native wasm exceptions,
# otherwise every Luau error() aborts the module.
if(EMSCRIPTEN)
  add_compile_options(-fwasm-exceptions)
  add_link_options(-fwasm-exceptions)
endif()

if(DREAMSY_SANITIZE)
  add_compile_options(-fsanitize=address,undefined -fno-sanitize-recover=all -fno-omit-frame-pointer)
  add_link_options(-fsanitize=address,undefined)
endif()

# ---------------------------------------------------------------- third-party

# Luau: compiler + VM only. Built with its own flags (it relies on C++ exceptions and RTTI).
set(LUAU_BUILD_CLI OFF CACHE BOOL "" FORCE)
set(LUAU_BUILD_TESTS OFF CACHE BOOL "" FORCE)
add_subdirectory(${THIRD_PARTY}/luau ${CMAKE_BINARY_DIR}/third_party/luau EXCLUDE_FROM_ALL)

# Box2D v3: library only.
set(BOX2D_SAMPLES OFF CACHE BOOL "" FORCE)
set(BOX2D_BENCHMARKS OFF CACHE BOOL "" FORCE)
set(BOX2D_DOCS OFF CACHE BOOL "" FORCE)
set(BOX2D_UNIT_TESTS OFF CACHE BOOL "" FORCE)
add_subdirectory(${THIRD_PARTY}/box2d ${CMAKE_BINARY_DIR}/third_party/box2d EXCLUDE_FROM_ALL)

# yyjson (JSON) and miniz (zip import for tools only): plain C, built here.
add_library(yyjson STATIC ${THIRD_PARTY}/yyjson/yyjson.c)
target_include_directories(yyjson SYSTEM PUBLIC ${THIRD_PARTY}/yyjson)
add_library(miniz STATIC ${THIRD_PARTY}/miniz/miniz.c)
target_include_directories(miniz SYSTEM PUBLIC ${THIRD_PARTY}/miniz)
target_compile_definitions(miniz PUBLIC MINIZ_NO_TIME MINIZ_NO_STDIO)

# ---------------------------------------------------------------- engine code

# Warnings and style flags for code we write (not applied to third-party targets).
# Designated initializers that skip fields are intended (rule structs have defaults), so newer
# clang's -Wmissing-designated-field-initializers is turned off where it exists.
include(CheckCXXCompilerFlag)
check_cxx_compiler_flag(-Wno-missing-designated-field-initializers DREAMSY_HAS_WNO_DESIGNATED)
set(DREAMSY_EXTRA_WARNINGS "")
if(DREAMSY_HAS_WNO_DESIGNATED)
  set(DREAMSY_EXTRA_WARNINGS -Wno-missing-designated-field-initializers)
endif()
function(dreamsy_target_defaults target)
  target_compile_options(${target} PRIVATE
    $<$<COMPILE_LANGUAGE:CXX>:-Wall -Wextra -Wpedantic -Wshadow -Wconversion -Wno-sign-conversion -fno-rtti ${DREAMSY_EXTRA_WARNINGS}>)
  target_include_directories(${target} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src)
endfunction()

add_library(dreamsy_base STATIC
  src/base/arena.cpp
  src/base/log.cpp
  src/base/sha256.cpp)
dreamsy_target_defaults(dreamsy_base)
target_include_directories(dreamsy_base PUBLIC src)

# E0 toolchain checks; replaced by src/script (E2) and src/physics (E3).
add_library(dreamsy_dev STATIC src/dev/smoke.cpp)
dreamsy_target_defaults(dreamsy_dev)
target_link_libraries(dreamsy_dev PUBLIC dreamsy_base Luau.Compiler Luau.VM box2d::box2d)

# Packages (§3): Dreamsy packs, directories, the catalog, the validator.
# format/catalog.json and engine-web/kits/*/kit.json are embedded at build time.
set(DREAMSY_CATALOG ${CMAKE_CURRENT_SOURCE_DIR}/../format/catalog.json)
set(DREAMSY_KITS_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../engine-web/kits)
file(GLOB DREAMSY_KIT_MANIFESTS CONFIGURE_DEPENDS ${DREAMSY_KITS_DIR}/*/kit.json)
set(DREAMSY_EMBEDDED_CPP ${CMAKE_BINARY_DIR}/generated/embedded.cpp)
add_custom_command(
  OUTPUT ${DREAMSY_EMBEDDED_CPP}
  COMMAND ${CMAKE_COMMAND} -DCATALOG=${DREAMSY_CATALOG} -DKITS_DIR=${DREAMSY_KITS_DIR} -DOUT=${DREAMSY_EMBEDDED_CPP}
          -P ${CMAKE_CURRENT_SOURCE_DIR}/cmake/embed_data.cmake
  DEPENDS ${DREAMSY_CATALOG} ${DREAMSY_KIT_MANIFESTS} ${CMAKE_CURRENT_SOURCE_DIR}/cmake/embed_data.cmake
  COMMENT "Embedding catalog.json and kit manifests")

add_library(dreamsy_pkg STATIC
  src/pkg/catalog.cpp
  src/pkg/files.cpp
  src/pkg/formats.cpp
  src/pkg/json.cpp
  src/pkg/manifest.cpp
  src/pkg/pack.cpp
  src/pkg/text.cpp
  src/pkg/validate.cpp
  ${DREAMSY_EMBEDDED_CPP})
dreamsy_target_defaults(dreamsy_pkg)
target_include_directories(dreamsy_pkg SYSTEM PRIVATE ${THIRD_PARTY}/tomlplusplus)
target_link_libraries(dreamsy_pkg PUBLIC dreamsy_base yyjson)

# Deterministic math (§14.4): musl's libm under the standard names, linked straight into every
# executable (dreamsy_link_dmath) so it wins over the platform libm for all engine code, Luau included.
set(DREAMSY_DMATH_DIR ${THIRD_PARTY}/musl-libm)
file(GLOB DREAMSY_DMATH_SOURCES ${DREAMSY_DMATH_DIR}/src/math/*.c)
add_library(dreamsy_dmath OBJECT ${DREAMSY_DMATH_SOURCES})
target_include_directories(dreamsy_dmath PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}/src/dmath/compat ${DREAMSY_DMATH_DIR}/src/internal ${DREAMSY_DMATH_DIR}/arch/generic)
target_compile_definitions(dreamsy_dmath PRIVATE "hidden=__attribute__((__visibility__(\"hidden\")))")
target_compile_options(dreamsy_dmath PRIVATE -U__FP_FAST_FMA -fno-builtin -w)
function(dreamsy_link_dmath target)
  target_sources(${target} PRIVATE $<TARGET_OBJECTS:dreamsy_dmath>)
endfunction()
# Luau must call these functions, not fold or replace them with builtins.
target_compile_options(Luau.VM PRIVATE -fno-builtin)

# Scripting (E2, §14.13). The prelude is extracted from engine-web/core/prelude.ts and the kit
# sources from engine-web/kits at build time (engine-web stays the source of truth until parity).
find_package(Python3 REQUIRED COMPONENTS Interpreter)
set(DREAMSY_PRELUDE_TS ${CMAKE_CURRENT_SOURCE_DIR}/../engine-web/core/prelude.ts)
file(GLOB_RECURSE DREAMSY_KIT_SOURCES CONFIGURE_DEPENDS ${DREAMSY_KITS_DIR}/*.luau)
set(DREAMSY_SCRIPT_DATA_CPP ${CMAKE_BINARY_DIR}/generated/script_data.cpp)
add_custom_command(
  OUTPUT ${DREAMSY_SCRIPT_DATA_CPP}
  COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/cmake/gen_script_data.py ${DREAMSY_PRELUDE_TS} ${DREAMSY_KITS_DIR} ${DREAMSY_SCRIPT_DATA_CPP}
  DEPENDS ${DREAMSY_PRELUDE_TS} ${DREAMSY_KIT_SOURCES} ${CMAKE_CURRENT_SOURCE_DIR}/cmake/gen_script_data.py
  COMMENT "Embedding the Luau prelude and kit sources")
add_library(dreamsy_script_data STATIC ${DREAMSY_SCRIPT_DATA_CPP})
target_include_directories(dreamsy_script_data PRIVATE src)

add_library(dreamsy_script STATIC
  src/script/host.cpp
  src/script/json_value.cpp
  src/script/require_path.cpp
  src/script/theme.cpp
  src/script/vm.cpp)
dreamsy_target_defaults(dreamsy_script)
target_link_libraries(dreamsy_script PUBLIC dreamsy_pkg Luau.Compiler Luau.VM PRIVATE dreamsy_script_data)

# Type checking (tools only): Luau's analyzer + the API definitions (format/dreamsy.d.luau with
# Entity props generated from format/catalog.json).
set(DREAMSY_DEFS ${CMAKE_CURRENT_SOURCE_DIR}/../format/dreamsy.d.luau)
set(DREAMSY_DEFS_CPP ${CMAKE_BINARY_DIR}/generated/defs.cpp)
add_custom_command(
  OUTPUT ${DREAMSY_DEFS_CPP}
  COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/cmake/gen_defs.py ${DREAMSY_DEFS} ${DREAMSY_CATALOG} ${DREAMSY_DEFS_CPP}
  DEPENDS ${DREAMSY_DEFS} ${DREAMSY_CATALOG} ${CMAKE_CURRENT_SOURCE_DIR}/cmake/gen_defs.py
  COMMENT "Building the Luau API definitions")
add_library(dreamsy_check STATIC src/check/check.cpp ${DREAMSY_DEFS_CPP})
target_include_directories(dreamsy_check PRIVATE src)
# Luau.Analysis uses RTTI and exceptions; this tool-only module is the boundary (see check.cpp).
target_compile_options(dreamsy_check PRIVATE -frtti)
target_link_libraries(dreamsy_check PUBLIC dreamsy_pkg PRIVATE dreamsy_script dreamsy_script_data Luau.Analysis)

# Rendering, CPU side (E4): draw list, depth sorting, view math, image decoding, atlas, fonts,
# batching. No GPU, so it builds everywhere (tests, headless tools); the sokol renderer is below.
# stb_image / stb_rect_pack / stb_truetype / nanosvg compile in one C file, warnings off (vendored).
add_library(dreamsy_media_libs STATIC src/render/third_party_impl.c)
target_include_directories(dreamsy_media_libs SYSTEM PUBLIC ${THIRD_PARTY}/stb ${THIRD_PARTY}/nanosvg)
target_compile_options(dreamsy_media_libs PRIVATE -w)

# The bundled theme fonts (third_party/fonts), embedded as byte arrays. Order matters:
# pixel, rounded, bold, serif (render/font.cpp bundled_font).
set(DREAMSY_FONT_FILES
  ${THIRD_PARTY}/fonts/press-start-2p/PressStart2P-Regular.ttf
  ${THIRD_PARTY}/fonts/nunito/Nunito-ExtraBold-Latin1.ttf
  ${THIRD_PARTY}/fonts/inter/Inter-Bold-Latin1.ttf
  ${THIRD_PARTY}/fonts/source-serif-4/SourceSerif4-Bold-Latin1.ttf)
set(DREAMSY_FONTS_CPP ${CMAKE_BINARY_DIR}/generated/fonts.cpp)
string(JOIN "|" DREAMSY_FONT_FILES_ARG ${DREAMSY_FONT_FILES})  # "|": a ";" list would split the argument
add_custom_command(
  OUTPUT ${DREAMSY_FONTS_CPP}
  COMMAND ${CMAKE_COMMAND} "-DFILES=${DREAMSY_FONT_FILES_ARG}" -DNAMESPACE=dreamsy::render::embedded
          -DOUT=${DREAMSY_FONTS_CPP} -P ${CMAKE_CURRENT_SOURCE_DIR}/cmake/embed_files.cmake
  DEPENDS ${DREAMSY_FONT_FILES} ${CMAKE_CURRENT_SOURCE_DIR}/cmake/embed_files.cmake
  COMMENT "Embedding the bundled fonts"
  VERBATIM)

add_library(dreamsy_render STATIC
  src/render/atlas.cpp
  src/render/font.cpp
  src/render/geometry.cpp
  src/render/image.cpp
  src/render/sort.cpp
  src/render/style.cpp
  src/render/textures.cpp
  src/render/view.cpp
  ${DREAMSY_FONTS_CPP})
dreamsy_target_defaults(dreamsy_render)
target_link_libraries(dreamsy_render PUBLIC dreamsy_pkg PRIVATE dreamsy_media_libs)

add_library(dreamsy_zip_import STATIC src/pkg/zip_import.cpp)
dreamsy_target_defaults(dreamsy_zip_import)
target_link_libraries(dreamsy_zip_import PUBLIC dreamsy_pkg PRIVATE miniz)

add_executable(dreamsy-tool apps/tool/main.cpp)
dreamsy_target_defaults(dreamsy-tool)
target_link_libraries(dreamsy-tool PRIVATE dreamsy_dev dreamsy_zip_import dreamsy_script dreamsy_check)
dreamsy_link_dmath(dreamsy-tool)
if(EMSCRIPTEN)
  target_link_options(dreamsy-tool PRIVATE -sENVIRONMENT=node -sALLOW_MEMORY_GROWTH=1 -sNODERAWFS=1)
endif()

# ---------------------------------------------------------------- player (sokol)

if(DREAMSY_BUILD_PLAYER)
  if(APPLE)
    set(SOKOL_IMPL_SRC src/platform/sokol_impl.m)
    set(SOKOL_BACKEND SOKOL_METAL)
  elseif(EMSCRIPTEN)
    set(SOKOL_IMPL_SRC src/platform/sokol_impl.c)
    set(SOKOL_BACKEND SOKOL_GLES3)
  else()
    set(SOKOL_IMPL_SRC src/platform/sokol_impl.c)
    set(SOKOL_BACKEND SOKOL_GLCORE)
  endif()

  add_library(dreamsy_sokol STATIC ${SOKOL_IMPL_SRC})
  target_include_directories(dreamsy_sokol PUBLIC ${THIRD_PARTY}/sokol)
  target_compile_definitions(dreamsy_sokol PUBLIC ${SOKOL_BACKEND})
  if(APPLE)
    target_compile_options(dreamsy_sokol PRIVATE -fobjc-arc)
    target_link_libraries(dreamsy_sokol PUBLIC
      "-framework Cocoa" "-framework QuartzCore" "-framework Metal" "-framework MetalKit")
  elseif(EMSCRIPTEN)
    # em_library_funcs.json works around an Emscripten bug (seen in 4.0.11 and 6.0.13): with
    # -fwasm-exceptions and -O1 or higher, sokol_app's `withStackSave` fails to link with
    # "undefined symbol: emscripten_stack_get_current". Listing the stack helpers explicitly fixes it.
    target_link_options(dreamsy_sokol PUBLIC -sUSE_WEBGL2=1 -sMIN_WEBGL_VERSION=2 -sMAX_WEBGL_VERSION=2
      -sDEFAULT_LIBRARY_FUNCS_TO_INCLUDE=@${CMAKE_CURRENT_SOURCE_DIR}/src/platform/web/em_library_funcs.json)
  else()
    find_package(X11 REQUIRED)
    find_package(OpenGL REQUIRED)
    target_link_libraries(dreamsy_sokol PUBLIC X11::X11 X11::Xi X11::Xcursor OpenGL::GL dl m pthread)
  endif()

  # The GPU renderer (E4): sokol_gfx, hand-written Metal / GLSL ES 3.0 shaders (render/renderer.cpp).
  add_library(dreamsy_render_gpu STATIC src/render/renderer.cpp)
  dreamsy_target_defaults(dreamsy_render_gpu)
  target_link_libraries(dreamsy_render_gpu PUBLIC dreamsy_render dreamsy_sokol)

  # The demo package the player shows until it runs games (E6): native reads it from the repo,
  # the web build embeds it at /pkg.
  set(DREAMSY_DEMO_PACKAGE_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../games/examples/feature-demo)
  add_executable(dreamsy-player apps/player/main.cpp apps/player/demo_scene.cpp)
  dreamsy_target_defaults(dreamsy-player)
  target_link_libraries(dreamsy-player PRIVATE dreamsy_render_gpu)
  dreamsy_link_dmath(dreamsy-player)
  if(EMSCRIPTEN)
    set_target_properties(dreamsy-player PROPERTIES SUFFIX ".html")
    target_link_options(dreamsy-player PRIVATE
      --shell-file ${CMAKE_CURRENT_SOURCE_DIR}/apps/player/shell.html -sALLOW_MEMORY_GROWTH=1
      --embed-file ${DREAMSY_DEMO_PACKAGE_DIR}@/pkg)
    set_property(TARGET dreamsy-player APPEND PROPERTY LINK_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/apps/player/shell.html)
  else()
    target_compile_definitions(dreamsy-player PRIVATE DREAMSY_DEMO_PACKAGE="${DREAMSY_DEMO_PACKAGE_DIR}")
  endif()
endif()

# ---------------------------------------------------------------- tests

if(DREAMSY_BUILD_TESTS)
  enable_testing()
  add_executable(dreamsy-tests tests/main.cpp tests/base_test.cpp tests/smoke_test.cpp tests/pkg_test.cpp tests/pack_test.cpp tests/script_test.cpp tests/dmath_test.cpp tests/render_test.cpp)
  dreamsy_target_defaults(dreamsy-tests)
  # doctest needs RTTI; tests are not engine code.
  target_compile_options(dreamsy-tests PRIVATE $<$<COMPILE_LANGUAGE:CXX>:-frtti>)
  target_include_directories(dreamsy-tests PRIVATE ${THIRD_PARTY}/doctest)
  target_link_libraries(dreamsy-tests PRIVATE dreamsy_dev dreamsy_zip_import dreamsy_script dreamsy_render miniz)
  dreamsy_link_dmath(dreamsy-tests)
  target_compile_definitions(dreamsy-tests PRIVATE DREAMSY_REPO_ROOT="${CMAKE_CURRENT_SOURCE_DIR}/..")
  if(EMSCRIPTEN)
    target_link_options(dreamsy-tests PRIVATE -sENVIRONMENT=node -sALLOW_MEMORY_GROWTH=1 -sNODERAWFS=1)
    add_test(NAME dreamsy-tests COMMAND node $<TARGET_FILE:dreamsy-tests>)
  else()
    add_test(NAME dreamsy-tests COMMAND dreamsy-tests)
  endif()
endif()

# ---------------------------------------------------------------- fuzzing (§14.9)
#
# Each target in fuzz/ builds two ways:
#   fuzz-<name>-replay  runs a corpus (+ random mutations) with any compiler; ctest runs it
#   fuzz-<name>         libFuzzer, coverage-guided (DREAMSY_FUZZ=ON, upstream clang)
option(DREAMSY_FUZZ "Build libFuzzer targets (needs clang with -fsanitize=fuzzer)" OFF)

if(NOT EMSCRIPTEN)
  set(DREAMSY_FUZZ_TARGETS pack package zip_import)
  foreach(name IN LISTS DREAMSY_FUZZ_TARGETS)
    add_executable(fuzz-${name}-replay fuzz/fuzz_${name}.cpp fuzz/replay_main.cpp)
    dreamsy_target_defaults(fuzz-${name}-replay)
    target_link_libraries(fuzz-${name}-replay PRIVATE dreamsy_zip_import)
    dreamsy_link_dmath(fuzz-${name}-replay)
    if(DREAMSY_FUZZ)
      add_executable(fuzz-${name} fuzz/fuzz_${name}.cpp)
      dreamsy_target_defaults(fuzz-${name})
      target_compile_options(fuzz-${name} PRIVATE -fsanitize=fuzzer)
      target_link_options(fuzz-${name} PRIVATE -fsanitize=fuzzer)
      target_link_libraries(fuzz-${name} PRIVATE dreamsy_zip_import)
    endif()
  endforeach()

  find_package(Python3 COMPONENTS Interpreter)
  if(DREAMSY_BUILD_TESTS AND Python3_FOUND)
    set(DREAMSY_CORPUS ${CMAKE_BINARY_DIR}/fuzz-corpus)
    add_test(NAME fuzz-corpus
             COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/fuzz/make_corpus.py ${DREAMSY_CORPUS} $<TARGET_FILE:dreamsy-tool>)
    set_tests_properties(fuzz-corpus PROPERTIES FIXTURES_SETUP fuzz_corpus)
    foreach(name pack package zip_import)
      set(corpus_dir ${name})
      if(name STREQUAL "zip_import")
        set(corpus_dir zip)
      endif()
      add_test(NAME fuzz-${name} COMMAND fuzz-${name}-replay --mutate 100 ${DREAMSY_CORPUS}/${corpus_dir})
      set_tests_properties(fuzz-${name} PROPERTIES FIXTURES_REQUIRED fuzz_corpus)
      # Inputs that once crashed (fuzz/regressions/<target>/): must stay fixed.
      add_test(NAME fuzz-${name}-regressions COMMAND fuzz-${name}-replay ${CMAKE_CURRENT_SOURCE_DIR}/fuzz/regressions/${name})
    endforeach()
  endif()
endif()
