// Toolchain smoke checks (slice E0).
//
// These prove the vendored libraries are built and linked correctly on every target. They
// are not engine systems: the real script host arrives in E2 (src/script/) and the real
// physics world in E3 (src/physics/), and this file goes away then.
#pragma once

#include <cstdint>
#include <string>
#include <string_view>

#include "base/result.h"

namespace dreamsy::dev {

// Compiles and runs `source` in a sandboxed Luau VM. Returns everything the script print()ed,
// one line per call, or the compile/runtime error.
Result<std::string> run_luau(std::string_view source);

// Drops `bodies` boxes (x positions from Rng(seed)) onto the ground, steps the Box2D world
// `steps` times at 60 Hz, and hashes every body's position and rotation. The same inputs
// must give the same hash on every platform (docs/engine.md §14.4).
uint64_t physics_hash(uint32_t seed, int bodies, int steps);

}  // namespace dreamsy::dev
