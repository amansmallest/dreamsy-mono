// A renderer test scene built from a real package's assets (games/examples/feature-demo).
//
// Until the world (E3) fills draw lists from entities, the player shows this: the package's
// tile level, sprites with frame animation, jumping sprites with drop shadows, additive sparks,
// text with outlines and shadows, and a UI panel, in any of the four view modes (DREAMSY.MD §14.5).
#pragma once

#include <string>
#include <vector>

#include "pkg/package.h"
#include "render/draw_list.h"
#include "render/renderer.h"
#include "render/textures.h"

namespace dreamsy::player {

class DemoScene {
 public:
  // `package` and `textures` must outlive the scene.
  DemoScene(const pkg::Package& package, render::TextureStore& textures, const render::RenderStyle& style);

  // Rebuilds `out` for time `t` (seconds) in view mode `view`. `stats` is shown in the UI.
  void build(render::DrawList& out, render::ViewMode view, double t, const render::FrameStats& stats) const;

 private:
  void build_side(render::DrawList& out, double t) const;
  void build_ground(render::DrawList& out, render::ViewMode view, double t) const;
  void build_ui(render::DrawList& out, render::ViewMode view, const render::FrameStats& stats) const;

  render::ImageId image(const char* name) const { return textures_.find_asset(name); }

  const pkg::Package& package_;
  render::TextureStore& textures_;
  render::RenderStyle style_;
  // The package's level (data/levels/level.txt) as tiles, and its size in tiles.
  std::vector<render::Tile> level_tiles_;
  int level_cols_ = 0;
  int level_rows_ = 0;
};

const char* view_mode_name(render::ViewMode view);

}  // namespace dreamsy::player
