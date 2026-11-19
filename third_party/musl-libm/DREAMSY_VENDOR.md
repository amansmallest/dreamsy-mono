# Vendored musl libm (subset)

Upstream: musl 1.2.5 release tarball (sha256 a9a118bbe84d8764da0ea0d28b3ab3fae8477fc7e4085d90102b8596fc7c75e4), MIT (COPYRIGHT)
Copied subset: double-precision sin cos tan asin acos atan atan2 exp exp2 log log10 log2 pow sinh cosh tanh expm1 log1p and helpers (src/math), src/internal/libm.h, arch/generic/fp_arch.h.
Unmodified. Same musl version Emscripten 4.0.11 ships, so engine-web (Luau in WASM) and the C++ engine compute bit-identical math.
Built by engine/CMakeLists.txt (dreamsy_dmath) with -U__FP_FAST_FMA so ARM64 takes the same non-FMA paths as x86-64 and WASM (DREAMSY.MD §14.4).
