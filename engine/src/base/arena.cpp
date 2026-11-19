#include "base/arena.h"

#include <algorithm>

#include "base/check.h"

namespace dreamsy {

Arena::Arena(size_t block_size) : block_size_(block_size) {
  DREAMSY_CHECK(block_size > 0, "arena block size must be > 0");
}

void* Arena::alloc_bytes(size_t size, size_t align) {
  DREAMSY_CHECK(align != 0 && (align & (align - 1)) == 0, "alignment must be a power of two");
  if (!blocks_.empty()) {
    Block& block = blocks_.back();
    auto base = reinterpret_cast<uintptr_t>(block.data.get());
    uintptr_t aligned = (base + offset_ + align - 1) & ~(uintptr_t{align} - 1);
    size_t start = aligned - base;
    if (start <= block.size && size <= block.size - start) {
      offset_ = start + size;
      used_ += size;
      return block.data.get() + start;
    }
  }
  // New block, big enough for this request even if it is larger than the default.
  size_t needed = size + align;
  Block block{std::make_unique<std::byte[]>(std::max(block_size_, needed)), std::max(block_size_, needed)};
  blocks_.push_back(std::move(block));
  offset_ = 0;
  return alloc_bytes(size, align);
}

void Arena::reset() {
  if (blocks_.size() > 1) blocks_.erase(blocks_.begin() + 1, blocks_.end());
  offset_ = 0;
  used_ = 0;
}

}  // namespace dreamsy
