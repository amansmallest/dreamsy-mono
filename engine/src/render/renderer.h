// The GPU renderer (sokol_gfx): draws a DrawList into the window.
//
// One frame:
//   1. sort the draw list by view mode (sort.h)
//   2. build batched quads (geometry.h); images and glyphs are packed into the atlas on first use
//   3. upload atlas pages that changed, and all vertices (one buffer write)
//   4. smooth mode:     draw the world (then the Lighting2D multiply quad and emissive items), then
//                       the UI, straight into the letterboxed game rect
//      pixel-art mode:  draw the world into a reference-size texture (1 texel = 1 reference px),
//                       scale it into the game rect with nearest filtering, then draw the UI on
//                       top at full resolution (crisp text)
// Each batch is one draw call: one per atlas page, whatever the mix of images, text and blending.
//
// Shaders are written by hand for Metal (macOS/iOS) and GLSL ES 3.0 (WebGL2, Android) in
// renderer.cpp; there is one tiny shader, so sokol-shdc isn't needed yet (docs/engine.md §14.12
// plans it for custom materials).
#pragma once

#include <cstdint>
#include <vector>

#include "base/result.h"
#include "render/draw_list.h"
#include "render/font.h"
#include "render/geometry.h"
#include "render/sort.h"
#include "render/style.h"
#include "render/textures.h"
#include "render/view.h"
#include "sokol_gfx.h"

namespace dreamsy::render {

struct FrameStats {
  uint32_t draw_calls = 0;
  uint32_t quads = 0;
  uint32_t culled = 0;
  uint32_t atlas_pages = 0;
  uint32_t page_uploads = 0;  // pages (re)uploaded this frame
};

class Renderer {
 public:
  // Call after sg_setup(). `style` comes from style_from_manifest().
  Status init(const RenderStyle& style);
  // Releases GPU resources. Call before sg_shutdown().
  void shutdown();

  // Draws one frame into `swapchain` (fb_w x fb_h framebuffer pixels). Call once per frame,
  // then sg_commit().
  void draw(const DrawList& list, TextureStore& textures, FontStore& fonts, const sg_swapchain& swapchain, int fb_w,
            int fb_h);

  const FrameStats& stats() const { return stats_; }
  // The game rect of the last frame (for mapping input to reference px).
  const Fit& fit() const { return fit_; }

 private:
  struct PageTexture {
    sg_image image{};
    sg_view view{};
    uint32_t version = 0;
    bool valid = false;
  };
  void sync_pages(const Atlas& atlas);
  void ensure_vertex_capacity(size_t vertex_count);
  void ensure_target();
  // Where reference px land in the current pass's pixels (for scissors): x/y offset, the pass's
  // full size w/h, and px per reference px.
  struct PassArea {
    float x = 0, y = 0, w = 1, h = 1, s = 1;
  };
  void draw_batches(const std::vector<Batch>& batches, sg_sampler sampler, const PassArea& area);
  // The Lighting2D multiply quad (draw_list.h Lighting); `target`: into the pixel-art target.
  void push_lighting_quad(const DrawList& list);
  void draw_lighting(const DrawList& list, bool target);

  RenderStyle style_;
  bool ready_ = false;
  sg_shader shader_{};
  sg_pipeline pipeline_screen_{};  // into the swapchain
  sg_pipeline pipeline_target_{};  // into the pixel-art target (RGBA8, no depth)
  sg_shader light_shader_{};       // Lighting2D
  sg_pipeline light_pipeline_screen_{};
  sg_pipeline light_pipeline_target_{};
  uint32_t light_first_quad_ = 0;  // the lighting quad, at the end of the frame's vertices
  sg_buffer vertices_{};
  size_t vertex_capacity_ = 0;
  sg_buffer indices_{};
  sg_sampler atlas_sampler_{};
  sg_sampler nearest_sampler_{};
  std::vector<PageTexture> pages_;

  // Pixel-art target.
  sg_image target_{};
  sg_view target_color_{};    // as a color attachment
  sg_view target_texture_{};  // as a texture

  sg_bindings bindings_{};
  SortedDrawList sorted_;
  FrameGeometry geometry_;
  std::vector<Batch> composite_;  // the target -> screen quad (pixel art)
  FrameStats stats_;
  Fit fit_;
};

}  // namespace dreamsy::render
