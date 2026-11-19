# Vendored tomlplusplus

Upstream: marzer/tomlplusplus master @ `c38c9b922a68fc9772b25d7f606133d3ec4decfd` (MIT)
Copied subset: toml.hpp (single header), LICENSE, README.md
Unmodified. Used by `engine/` (DREAMSY.MD §14).

Why master and not v3.4.0: v3.4.0 hits an internal assertion (undefined behavior in release builds)
on a table header split across lines (`[` + newline + key), found by engine/fuzz. Fixed upstream.
