// Depth sorting by view mode (DREAMSY.MD §14.5).
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

}  // namespace dreamsy::render
