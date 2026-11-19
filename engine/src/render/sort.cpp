#include "render/sort.h"

#include <algorithm>
#include <cmath>
#include <optional>

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

bool casts_shadow(const SpriteCmd& s) { return s.shadow && s.space == Space::World && s.z > s.ground_z; }

bool is_block(ViewMode view, const SpriteCmd& s) {
  return s.height > 0 && s.space == Space::World && view != ViewMode::Side;
}

Footprint block_footprint(const SpriteCmd& s) {
  const float hw = std::abs(s.size.x * s.scale.x) * 0.5f, hd = std::abs(s.size.y * s.scale.y) * 0.5f;
  return {s.position.x - hw, s.position.y - hd, s.position.x + hw, s.position.y + hd};
}

void sort_draw_list(const DrawList& list, SortedDrawList& out) {
  out.world.clear();
  out.screen.clear();
  const ViewMode view = list.view;

  std::vector<Key> world;
  std::vector<Key> screen;
  world.reserve(list.item_count() + 16);

  auto add = [&](Space space, Key k) { (space == Space::World ? world : screen).push_back(k); };

  // 2.5D blocks, for moving things that stand on raised ground (see sort.h).
  std::vector<uint32_t> blocks;
  if (view != ViewMode::Side) {
    for (uint32_t i = 0; i < list.sprites.size(); i++)
      if (is_block(view, list.sprites[i])) blocks.push_back(i);
  }
  // The depth key of the block under a raised item, or nothing.
  auto supporting_depth = [&](const SpriteCmd& s) -> std::optional<float> {
    std::optional<float> best;
    for (uint32_t b : blocks) {
      const SpriteCmd& blk = list.sprites[b];
      if (&blk == &s || blk.sort.layer != s.sort.layer || blk.sort.z_index != s.sort.z_index) continue;
      if (std::abs(blk.z + blk.height - s.ground_z) > 0.5f) continue;
      const Footprint f = block_footprint(blk);
      if (s.position.x < f.x0 || s.position.x > f.x1 || s.position.y < f.y0 || s.position.y > f.y1) continue;
      const float d = make_key(view, blk.sort, 2, blk.position.x, blk.position.y, 0, {}).depth;
      if (!best || d > *best) best = d;
    }
    return best;
  };

  for (uint32_t i = 0; i < list.sprites.size(); i++) {
    const SpriteCmd& s = list.sprites[i];
    Key k = make_key(view, s.sort, 2, s.position.x, s.position.y, s.z, {DrawKind::Sprite, i});
    std::optional<float> on_block;
    if (!blocks.empty() && s.ground_z > 0 && !is_block(view, s) && s.space == Space::World) {
      on_block = supporting_depth(s);
      // Just after the block: the gap is far below a pixel, so it never passes anything else.
      if (on_block && k.depth <= *on_block) k.depth = *on_block + 0.001f;
    }
    add(s.space, k);
    if (casts_shadow(s)) {
      // The shadow lies on the ground under the sprite: right before it. On the floor it goes in
      // the shadow bucket (under everything upright); on a block it must come after that block.
      Key sk = make_key(view, s.sort, s.ground_z > 0 ? 2 : 1, s.position.x, s.position.y, s.ground_z,
                        {DrawKind::Shadow, i});
      if (s.ground_z > 0) sk.depth = k.depth;
      sk.sub = 0;
      world.push_back(sk);
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
