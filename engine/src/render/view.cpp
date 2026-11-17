#include "render/view.h"

#include <algorithm>
#include <cmath>

namespace dreamsy::render {

Fit fit_rect(int ref_w, int ref_h, float fb_w, float fb_h) {
  Fit f;
  f.ref_w = std::max(1, ref_w);
  f.ref_h = std::max(1, ref_h);
  const float rw = static_cast<float>(f.ref_w);
  const float rh = static_cast<float>(f.ref_h);
  f.s = std::max(1e-6f, std::min(fb_w / rw, fb_h / rh));
  f.w = rw * f.s;
  f.h = rh * f.s;
  f.x = (fb_w - f.w) / 2;
  f.y = (fb_h - f.h) / 2;
  return f;
}

Fit snap_fit(const Fit& fit) {
  Fit f = fit;
  f.x = std::round(fit.x);
  f.y = std::round(fit.y);
  f.w = std::max(1.0f, std::round(fit.w));
  f.h = std::max(1.0f, std::round(fit.h));
  return f;
}

Vec2 project(ViewMode view, float x, float y, float z) {
  if (view == ViewMode::Iso) return {x - y, (x + y) * 0.5f - z};
  return {x, y - z};
}

Vec2 unproject_ground(ViewMode view, Vec2 p) {
  if (view == ViewMode::Iso) {
    // p.x = x - y, p.y = (x + y) / 2  =>  x = p.y + p.x / 2, y = p.y - p.x / 2
    return {p.y + p.x * 0.5f, p.y - p.x * 0.5f};
  }
  return p;
}

Vec2 world_to_ref(ViewMode view, const Camera& cam, int ref_w, int ref_h, float x, float y, float z) {
  const Vec2 p = project(view, x, y, z);
  const Vec2 c = project(view, cam.center.x, cam.center.y, 0);
  return {(p.x - c.x) * cam.zoom + ref_w * 0.5f, (p.y - c.y) * cam.zoom + ref_h * 0.5f};
}

Vec2 ref_to_world(ViewMode view, const Camera& cam, int ref_w, int ref_h, Vec2 ref) {
  const Vec2 c = project(view, cam.center.x, cam.center.y, 0);
  const float zoom = cam.zoom != 0 ? cam.zoom : 1;
  const Vec2 p{c.x + (ref.x - ref_w * 0.5f) / zoom, c.y + (ref.y - ref_h * 0.5f) / zoom};
  return unproject_ground(view, p);
}

Vec2 framebuffer_to_ref(const Fit& fit, Vec2 p) { return {(p.x - fit.x) / fit.s, (p.y - fit.y) / fit.s}; }

Vec2 ref_to_framebuffer(const Fit& fit, Vec2 p) { return {fit.x + p.x * fit.s, fit.y + p.y * fit.s}; }

float snap_to_grid(float v, float units_per_px) {
  if (units_per_px <= 0) return v;
  return std::round(v * units_per_px) / units_per_px;
}

Vec2 snapped_camera_center(ViewMode view, const Camera& cam, bool pixel_snap) {
  Vec2 c = project(view, cam.center.x, cam.center.y, 0);
  if (pixel_snap) {
    // One target texel is 1/zoom projected units.
    c.x = snap_to_grid(c.x, cam.zoom);
    c.y = snap_to_grid(c.y, cam.zoom);
  }
  return c;
}

}  // namespace dreamsy::render
