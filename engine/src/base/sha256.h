// SHA-256 (FIPS 180-4). Used for content addressing: every file in a Dreamsy pack carries its
// hash, and a package version is identified by the hash of its index (DREAMSY.MD §3.6).
#pragma once

#include <array>
#include <cstdint>
#include <span>
#include <string>

namespace dreamsy {

using Sha256Digest = std::array<uint8_t, 32>;

class Sha256 {
 public:
  Sha256();
  void update(std::span<const uint8_t> data);
  Sha256Digest finish();  // the object must not be used afterwards

  static Sha256Digest of(std::span<const uint8_t> data);

 private:
  void block(const uint8_t* p);

  uint32_t state_[8];
  uint8_t buffer_[64];
  size_t buffered_ = 0;
  uint64_t length_ = 0;  // bytes
};

std::string to_hex(const Sha256Digest& d);

}  // namespace dreamsy
