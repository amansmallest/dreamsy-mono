// Stable hashing for state hashes (DREAMSY.MD §14.4).
//
// FNV-1a, 64-bit. Not cryptographic; used to compare simulation state across runs, machines
// and engines. Values are hashed by their bytes in little-endian order, so the result is the
// same on every platform we target (all little-endian).
#pragma once

#include <cstdint>
#include <cstring>
#include <string_view>
#include <type_traits>

namespace dreamsy {

class Hasher {
 public:
  void bytes(const void* data, size_t size) {
    auto p = static_cast<const unsigned char*>(data);
    for (size_t i = 0; i < size; ++i) {
      state_ ^= p[i];
      state_ *= 0x100000001b3ull;
    }
  }

  template <typename T>
  void add(T value) {
    static_assert(std::is_arithmetic_v<T>, "add() takes numbers; use bytes() or str() otherwise");
    if constexpr (std::is_floating_point_v<T>) {
      if (value == 0) value = 0;  // fold -0.0 into +0.0
    }
    bytes(&value, sizeof value);
  }

  void str(std::string_view s) {
    add(static_cast<uint64_t>(s.size()));
    bytes(s.data(), s.size());
  }

  uint64_t value() const { return state_; }

 private:
  uint64_t state_ = 0xcbf29ce484222325ull;
};

}  // namespace dreamsy
