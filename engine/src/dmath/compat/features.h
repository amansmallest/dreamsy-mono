/* <features.h> shim for the vendored musl libm. musl's data headers include it only for the
 * `hidden` attribute (defined on the command line by engine/CMakeLists.txt). Platforms with a real
 * <features.h> (glibc) still get theirs: its own headers depend on it. */
#ifndef DREAMSY_DMATH_FEATURES_H
#define DREAMSY_DMATH_FEATURES_H
#if defined(__has_include_next)
#if __has_include_next(<features.h>)
#include_next <features.h>
#endif
#endif
#endif
