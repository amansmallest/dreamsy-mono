// Depth sorting by view mode (docs/engine.md §14.5).
//
// sort_draw_list() returns the order to draw a DrawList's items in, as references into its
// vectors. It also inserts a drop shadow before each raised sprite (z > 0 with `shadow` set).
//
// Sort keys, per Space (world items first, then screen/UI items):
//
//   side      layer, z_index, submission order
//   topdown   layer, z_index, ground bucket, y + sort_offset,       submission order
//   oblique   layer, z_index, ground bucket, y + sort_offset, z,    submission order
//   iso       layer, z_index, ground bucket, x + y + sort_offset, z, submission order
//   UI        layer, z_index, submission order
//
// "Ground bucket" keeps things that lie flat on the ground under upright things of the same
// layer and z_index: tile chunks and ground rects (0), then shadows (1), then everything else (2).
//
// 2.5D blocks (sprites with a height, block_footprint()) sort by the center of their footprint.
// For things that only touch a block from beside, behind or in front, that gives the right order
// (in iso the blocks must be square for this: scene_draw splits long blocks into square cells).
// Something standing on raised ground (ground_z > 0) would sort before the block under it when it
// stands in the block's back half, so it is moved to right after the block it stands on (same
// layer and z_index, footprint contains its position, top = its ground_z); its shadow, which lies
// on that block's top, goes there too.
// Submission order is unique per item, so the order is total: equal items never swap between
// frames (no flicker), and the result is the same on every platform.
#pragma once

#include <cstdint>
#include <vector>

#include "render/draw_list.h"

namespace dreamsy::render {

enum class DrawKind : uint8_t { Sprite, Shadow, Rect, Text, TileChunk };

struct DrawRef {
  DrawKind kind = DrawKind::Sprite;
  uint32_t index = 0;  // into DrawList::sprites (Sprite, Shadow), rects, texts or tile_chunks
  friend bool operator==(DrawRef a, DrawRef b) { return a.kind == b.kind && a.index == b.index; }
};

struct SortedDrawList {
  std::vector<DrawRef> world;   // depth-sorted, drawn with the camera
  std::vector<DrawRef> screen;  // UI, drawn on top in reference px
};

// `out` is cleared and refilled (reuse it across frames to avoid allocations).
void sort_draw_list(const DrawList& list, SortedDrawList& out);

// True when the sprite gets a drop shadow.
bool casts_shadow(const SpriteCmd& s);

// True when the sprite is drawn as a 2.5D block in this view (height > 0, world space, not side).
bool is_block(ViewMode view, const SpriteCmd& s);

// A block's footprint on the ground (world px): centered on `position`, size x |scale|.
struct Footprint {
  float x0 = 0, y0 = 0, x1 = 0, y1 = 0;
};
Footprint block_footprint(const SpriteCmd& s);

}  // namespace dreamsy::render
