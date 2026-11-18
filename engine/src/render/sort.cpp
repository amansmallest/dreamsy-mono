#include "render/sort.h"

#include <algorithm>
#include <cmath>

namespace dreamsy::render {

namespace {

// Everything the comparison needs, copied into one small struct so sorting doesn't chase pointers.
struct Key {
  int32_t layer = 0;
  int32_t z_index = 0;
  uint8_t bucket = 2;  // 0 ground, 1 shadow, 2 upright
  float depth = 0;     // y or x+y (+ sort_offset)
  float z = 0;
  uint32_t order = 0;
  uint8_t sub = 1;  // a shadow (0) draws right before its sprite (1) when everything else is equal
  DrawRef ref;
};

// NaN would break the sort's ordering rules (and could crash std::sort): treat it as 0.
float finite(float v) { return std::isfinite(v) ? v : 0.0f; }

Key make_key(ViewMode view, const SortInfo& s, uint8_t bucket, float x, float y, float z, DrawRef ref) {
  Key k;
  k.layer = s.layer;
  k.z_index = s.z_index;
  k.order = s.order;
  k.ref = ref;
  k.bucket = bucket;
  x = finite(x);
  y = finite(y);
  switch (view) {
    case ViewMode::Side:
      break;  // layer, z_index, order only
    case ViewMode::TopDown:
      k.depth = y + finite(s.sort_offset);
      break;
    case ViewMode::Oblique:
      k.depth = y + finite(s.sort_offset);
      k.z = finite(z);
      break;
    case ViewMode::Iso:
      k.depth = x + y + finite(s.sort_offset);
      k.z = finite(z);
      break;
  }
  return k;
}

bool less_world(ViewMode view, const Key& a, const Key& b) {
  if (a.layer != b.layer) return a.layer < b.layer;
  if (a.z_index != b.z_index) return a.z_index < b.z_index;
  if (view != ViewMode::Side) {
    if (a.bucket != b.bucket) return a.bucket < b.bucket;
    if (a.depth != b.depth) return a.depth < b.depth;
    if (a.z != b.z) return a.z < b.z;
  }
  if (a.order != b.order) return a.order < b.order;
  if (a.sub != b.sub) return a.sub < b.sub;
  // Only reached for items with the same `order` (filled in by hand, not via DrawList::add()):
  // fall back to kind and index so the result is still deterministic.
  if (a.ref.kind != b.ref.kind) return a.ref.kind < b.ref.kind;
  return a.ref.index < b.ref.index;
}

}  // namespace

bool casts_shadow(const SpriteCmd& s) { return s.shadow && s.space == Space::World && s.z > 0; }

void sort_draw_list(const DrawList& list, SortedDrawList& out) {
  out.world.clear();
  out.screen.clear();
  const ViewMode view = list.view;

  std::vector<Key> world;
  std::vector<Key> screen;
  world.reserve(list.item_count() + 16);

  auto add = [&](Space space, Key k) { (space == Space::World ? world : screen).push_back(k); };

  for (uint32_t i = 0; i < list.sprites.size(); i++) {
    const SpriteCmd& s = list.sprites[i];
    add(s.space, make_key(view, s.sort, 2, s.position.x, s.position.y, s.z, {DrawKind::Sprite, i}));
    if (casts_shadow(s)) {
      // The shadow sits on the ground under the sprite: same depth, bucket 1, height 0.
      Key k = make_key(view, s.sort, 1, s.position.x, s.position.y, 0, {DrawKind::Shadow, i});
      k.sub = 0;
      world.push_back(k);
    }
  }
  for (uint32_t i = 0; i < list.rects.size(); i++) {
    const RectCmd& r = list.rects[i];
    const bool ground = r.ground && r.space == Space::World;
    // Upright rects sort by their bottom edge (their "feet"), ground rects by their center.
    const float cx = r.position.x + r.size.x * 0.5f;
    const float cy = r.position.y + (ground ? r.size.y * 0.5f : r.size.y);
    add(r.space, make_key(view, r.sort, ground ? 0 : 2, cx, cy, r.z, {DrawKind::Rect, i}));
  }
  for (uint32_t i = 0; i < list.texts.size(); i++) {
    const TextCmd& t = list.texts[i];
    add(t.space, make_key(view, t.sort, 2, t.position.x, t.position.y, t.z, {DrawKind::Text, i}));
  }
  for (uint32_t i = 0; i < list.tile_chunks.size(); i++) {
    const TileChunkCmd& c = list.tile_chunks[i];
    world.push_back(make_key(view, c.sort, 0, c.origin.x, c.origin.y, 0, {DrawKind::TileChunk, i}));
  }

  std::sort(world.begin(), world.end(), [view](const Key& a, const Key& b) { return less_world(view, a, b); });
  std::sort(screen.begin(), screen.end(),
            [](const Key& a, const Key& b) { return less_world(ViewMode::Side, a, b); });

  out.world.reserve(world.size());
  for (const Key& k : world) out.world.push_back(k.ref);
  out.screen.reserve(screen.size());
  for (const Key& k : screen) out.screen.push_back(k.ref);
}

}  // namespace dreamsy::render
