// Generational handles and the pool that hands them out.
//
// Engine objects (entities, textures, bodies, sounds) are never referenced by raw pointer
// across frames. Instead you hold an Id<T>: an index into a pool plus a generation counter.
// When an object is removed its slot's generation goes up, so every old Id for that slot
// stops resolving. A stale Id gives nullptr from get() instead of reading freed memory.
//
//   Pool<Sprite> sprites;
//   Id<Sprite> id = sprites.insert(Sprite{...});
//   if (Sprite* s = sprites.get(id)) s->x += 1;
//   sprites.remove(id);
//   sprites.get(id);  // nullptr now
#pragma once

#include <cstdint>
#include <optional>
#include <utility>
#include <vector>

#include "base/check.h"

namespace dreamsy {

template <typename T>
struct Id {
  uint32_t index = 0;
  uint32_t generation = 0;  // 0 = never valid

  bool is_null() const { return generation == 0; }
  friend bool operator==(Id a, Id b) { return a.index == b.index && a.generation == b.generation; }
  friend bool operator!=(Id a, Id b) { return !(a == b); }
};

template <typename T>
class Pool {
 public:
  Id<T> insert(T value) {
    uint32_t index;
    if (!free_.empty()) {
      index = free_.back();
      free_.pop_back();
    } else {
      DREAMSY_CHECK(slots_.size() < UINT32_MAX, "pool is full");
      index = static_cast<uint32_t>(slots_.size());
      slots_.emplace_back();
    }
    Slot& slot = slots_[index];
    slot.value.emplace(std::move(value));
    ++count_;
    return Id<T>{index, slot.generation};
  }

  // Returns false if the id was already stale.
  bool remove(Id<T> id) {
    Slot* slot = live_slot(id);
    if (!slot) return false;
    slot->value.reset();
    // Skip 0 on wrap-around so a recycled slot never matches a null Id.
    slot->generation = slot->generation == UINT32_MAX ? 1 : slot->generation + 1;
    free_.push_back(id.index);
    --count_;
    return true;
  }

  T* get(Id<T> id) {
    Slot* slot = live_slot(id);
    return slot ? &*slot->value : nullptr;
  }
  const T* get(Id<T> id) const { return const_cast<Pool*>(this)->get(id); }

  bool contains(Id<T> id) const { return get(id) != nullptr; }
  size_t size() const { return count_; }
  bool empty() const { return count_ == 0; }

  // Visits live objects in slot order (stable, so iteration is deterministic).
  // Do not insert or remove inside the callback.
  template <typename F>
  void for_each(F&& fn) {
    for (uint32_t i = 0; i < slots_.size(); ++i) {
      Slot& slot = slots_[i];
      if (slot.value) fn(Id<T>{i, slot.generation}, *slot.value);
    }
  }

  void clear() {
    for (uint32_t i = 0; i < slots_.size(); ++i) {
      if (slots_[i].value) remove(Id<T>{i, slots_[i].generation});
    }
  }

 private:
  struct Slot {
    std::optional<T> value;
    uint32_t generation = 1;
  };

  Slot* live_slot(Id<T> id) {
    if (id.is_null() || id.index >= slots_.size()) return nullptr;
    Slot& slot = slots_[id.index];
    if (slot.generation != id.generation || !slot.value) return nullptr;
    return &slot;
  }

  std::vector<Slot> slots_;
  std::vector<uint32_t> free_;
  size_t count_ = 0;
};

}  // namespace dreamsy
