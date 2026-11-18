// Turns a sorted draw list into batched quads: the CPU half of the sprite batcher.
//
// Every visible thing becomes textured quads (4 vertices) in reference pixels. Consecutive quads
// that use the same atlas page share one batch, and each batch is one draw call. Alpha and
// additive blending share batches too: colors are premultiplied, and an additive quad is just
// one with alpha 0 (it adds its color and hides nothing), so one GPU blend mode does both.
//
// No GPU here, so batching is unit-tested (tests/render_test.cpp). renderer.cpp uploads
// FrameGeometry::vertices and issues one draw per batch.
#pragma once

#include <cstdint>
#include <vector>

#include "render/draw_list.h"
#include "render/font.h"
#include "render/sort.h"
#include "render/textures.h"

namespace dreamsy::render {

struct Vertex {
  float x = 0, y = 0;  // reference px
  float u = 0, v = 0;  // atlas page coordinates 0..1
  uint32_t color = 0;  // premultiplied RGBA8, red in the lowest byte
};

struct Batch {
  uint16_t page = 0;         // atlas page (texture)
  uint32_t first_quad = 0;   // into FrameGeometry::vertices / 4
  uint32_t quad_count = 0;
};

// Quads per batch are capped so a 16-bit index buffer (0..65535) can address them.
inline constexpr uint32_t kMaxQuadsPerBatch = 16384;

struct FrameGeometry {
  std::vector<Vertex> vertices;
  std::vector<Batch> world;   // world pass: depth-sorted, camera applied
  std::vector<Batch> screen;  // UI pass, on top
  uint32_t culled = 0;        // quads skipped because they were off screen

  void clear() {
    vertices.clear();
    world.clear();
    screen.clear();
    culled = 0;
  }
  uint32_t quad_count() const { return static_cast<uint32_t>(vertices.size() / 4); }
};

struct GeometryParams {
  int ref_w = 1280, ref_h = 720;
  // Real pixels per reference px in each pass: fonts and SVGs are rasterized at this resolution
  // so they stay crisp. Smooth mode: the letterbox scale for both. Pixel-art mode: world = 1 (the
  // world is drawn into a reference-size target), screen = the letterbox scale.
  float world_raster_scale = 1;
  float screen_raster_scale = 1;
  bool pixel_snap = false;  // pixel-art: snap the camera and quads to whole target pixels
};

// Packs RGBA (straight alpha) into a premultiplied vertex color. Add blending gives alpha 0.
uint32_t pack_color(Color c, BlendMode blend = BlendMode::Alpha);

// Builds `out` (cleared first) from `list` in the order of `sorted`. Images and glyphs are loaded
// into the atlas as they are first used.
void build_geometry(const DrawList& list, const SortedDrawList& sorted, TextureStore& textures, FontStore& fonts,
                    const GeometryParams& params, FrameGeometry& out);

// Appends one quad (corners clockwise from top-left) to `batches`, merging with the last batch
// when it uses the same page. Used by build_geometry() and the renderer's composite pass.
void push_quad(FrameGeometry& geo, std::vector<Batch>& batches, uint16_t page, const Vec2 corners[4], const UvRect& uv,
               uint32_t color);

}  // namespace dreamsy::render
