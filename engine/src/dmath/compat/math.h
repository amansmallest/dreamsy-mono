/* <math.h> shim for building the vendored musl libm.
 *
 * glibc's <math.h> declares internal names (__sin, __cos, __tan and the long-double variants) with
 * different prototypes than musl's kernel helpers of the same names, which breaks the build on Linux.
 * Rename glibc's declarations out of the way, include the real header, then restore the names for
 * musl's own definitions. Other C libraries (macOS, Emscripten's musl) don't declare these; harmless. */
#ifndef DREAMSY_DMATH_MATH_H
#define DREAMSY_DMATH_MATH_H
#define __sin dreamsy_libc___sin
#define __cos dreamsy_libc___cos
#define __tan dreamsy_libc___tan
#define __sinl dreamsy_libc___sinl
#define __cosl dreamsy_libc___cosl
#define __tanl dreamsy_libc___tanl
#include_next <math.h>
#undef __sin
#undef __cos
#undef __tan
#undef __sinl
#undef __cosl
#undef __tanl
#endif
