// Arena (bump) allocator for short-lived scratch memory.
//
// Allocation is a pointer bump; everything is freed at once by reset(). The tick loop gives
// each frame an arena and resets it at the end, so per-frame temporaries cost almost nothing
// and can't leak.
//
// Only trivially destructible types may live in an arena, because reset() does not run
// destructors. (std::string and std::vector are not allowed; plain structs, numbers and
// arrays of them are.)
#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <new>
#include <span>
#include <type_traits>
#include <vector>

namespace dreamsy {

class Arena {
 public:
  explicit Arena(size_t block_size = 64 * 1024);
  Arena(const Arena&) = delete;
  Arena& operator=(const Arena&) = delete;

  // Raw bytes. `align` must be a power of two. Never returns nullptr.
  void* alloc_bytes(size_t size, size_t align = alignof(std::max_align_t));

  template <typename T, typename... Args>
  T* make(Args&&... args) {
    static_assert(std::is_trivially_destructible_v<T>, "arena types must be trivially destructible");
    return new (alloc_bytes(sizeof(T), alignof(T))) T{std::forward<Args>(args)...};
  }

  // `count` value-initialized Ts (zeroed for plain structs).
  template <typename T>
  std::span<T> make_array(size_t count) {
    static_assert(std::is_trivially_destructible_v<T>, "arena types must be trivially destructible");
    T* first = static_cast<T*>(alloc_bytes(sizeof(T) * count, alignof(T)));
    for (size_t i = 0; i < count; ++i) new (first + i) T{};
    return {first, count};
  }

  // Frees everything. Keeps the first block's memory for reuse.
  void reset();

  size_t bytes_used() const { return used_; }

 private:
  struct Block {
    std::unique_ptr<std::byte[]> data;
    size_t size = 0;
  };

  size_t block_size_;
  std::vector<Block> blocks_;
  size_t offset_ = 0;  // into blocks_.back()
  size_t used_ = 0;
};

}  // namespace dreamsy
