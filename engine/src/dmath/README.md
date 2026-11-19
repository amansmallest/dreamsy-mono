# Deterministic math

`third_party/musl-libm` (musl 1.2.5) is compiled into every engine executable as the object library
`dreamsy_dmath`, defining the standard names (`sin`, `cos`, `pow`, `exp`, `log`, ...). Because the objects are
linked straight into each executable, these definitions win over the platform's libm for all engine code,
including Luau's VM (`math.sin`, the `^` operator) — so scripts compute bit-identical results on macOS, Linux,
iOS, Android and the web, and identical to engine-web (Emscripten ships the same musl). docs/engine.md §14.4.

Build flags: `-U__FP_FAST_FMA` (ARM64 would otherwise take FMA paths in pow/log that x86-64 and WASM don't),
`-ffp-contract=off -fno-fast-math` (global), `-fno-builtin` (the compiler must call these, not fold them).
`compat/endian.h` exists because macOS has no `<endian.h>`. Golden values: `tests/dmath_test.cpp`.
