// Deterministic random numbers.
//
// sfc32, bit-for-bit identical to engine-web/core/random.ts, so the same seed gives the same
// sequence in both engines (the conformance suite relies on this, docs/engine.md §14.8).
// The simulation must only use this, never rand() or the OS RNG (§14.4).
#pragma once

#include <cstdint>

namespace dreamsy {

class Rng {
 public:
  explicit Rng(uint32_t seed) : d_(seed) {
    for (int i = 0; i < 15; ++i) next_u32();
  }

  uint32_t next_u32() {
    uint32_t t = a_ + b_;
    a_ = b_ ^ (b_ >> 9);
    b_ = c_ + (c_ << 3);
    c_ = (c_ << 21) | (c_ >> 11);
    d_ = d_ + 1;
    t = t + d_;
    c_ = c_ + t;
    return t;
  }

  // [0, 1), same value as Random.next() in the TS engine.
  double next() { return next_u32() / 4294967296.0; }

 private:
  uint32_t a_ = 0x9e3779b9;
  uint32_t b_ = 0x243f6a88;
  uint32_t c_ = 0xb7e15162;
  uint32_t d_;
};

}  // namespace dreamsy
