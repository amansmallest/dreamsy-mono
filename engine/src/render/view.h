// Screen math: letterboxing, view-mode projection, camera, pixel snapping. No GPU, no state.
//
// Three coordinate spaces:
//   framebuffer px  the real window/canvas in device pixels
//   reference px    the fixed game screen (720x1280 portrait, 1280x720 landscape), letterboxed
//                   into the framebuffer (engine-web core/view2d.ts fitRect)
//   world px        the game world; the camera maps it to reference px (draw_list.h)
#pragma once

#include "render/draw_list.h"

namespace dreamsy::render {

// The letterboxed game rectangle inside a framebuffer (engine-web Fit).
struct Fit {
  float x = 0, y = 0;  // top-left of the game rect, framebuffer px
  float w = 1, h = 1;  // size of the game rect, framebuffer px
  float s = 1;         // framebuffer px per reference px
  int ref_w = 1280, ref_h = 720;
};

// Fit a ref_w x ref_h reference screen into a W x H framebuffer, centered (letterbox / pillarbox).
Fit fit_rect(int ref_w, int ref_h, float fb_w, float fb_h);

// Pixel-art mode renders the world into a reference-size target, then scales it up with nearest
// filtering. The game rect is rounded to whole framebuffer pixels so every texel edge is sharp.
Fit snap_fit(const Fit& fit);

// World point (x, y, height z) -> projected 2D point, before the camera (see draw_list.h).
Vec2 project(ViewMode view, float x, float y, float z);
// Inverse of project() for points on the ground (z = 0).
Vec2 unproject_ground(ViewMode view, Vec2 p);

// World -> reference px through the camera, and back (ground plane). `ref_w/ref_h` is the
// reference screen. Matches engine-web worldToRef / refToWorld for side and topdown.
Vec2 world_to_ref(ViewMode view, const Camera& cam, int ref_w, int ref_h, float x, float y, float z);
Vec2 ref_to_world(ViewMode view, const Camera& cam, int ref_w, int ref_h, Vec2 ref);

// Framebuffer px -> reference px (for input), and back.
Vec2 framebuffer_to_ref(const Fit& fit, Vec2 p);
Vec2 ref_to_framebuffer(const Fit& fit, Vec2 p);

// Pixel-art mode: moves the camera so world pixels land exactly on target texels (no shimmer
// when the camera moves by fractions of a pixel). Returns the projected camera center to use.
Vec2 snapped_camera_center(ViewMode view, const Camera& cam, bool pixel_snap);

// Rounds v to the nearest multiple of 1/units_per_px (e.g. units_per_px = zoom).
float snap_to_grid(float v, float units_per_px);

}  // namespace dreamsy::render
