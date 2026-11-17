/* Minimal <endian.h> for building the vendored musl libm on platforms without one (macOS).
 * Every Dreamsy target is little-endian (arm64, x86-64, wasm32). */
#ifndef DREAMSY_DMATH_ENDIAN_H
#define DREAMSY_DMATH_ENDIAN_H
#define __LITTLE_ENDIAN 1234
#define __BIG_ENDIAN 4321
#define __BYTE_ORDER __LITTLE_ENDIAN
#endif
