// Drawing helpers shared by the overlay (ui/overlay.cpp) and the pause shell (ui/shell.cpp):
// colors, a clipped "pen" that adds Screen items to the draw list, rounded rects and the theme's
// panel surface (engine-web render/theme.ts panelSurface). Internal to src/ui.
#pragma once

#include <algorithm>
#include <cmath>
#include <optional>
#include <string>
#include <string_view>

#include "ui/overlay.h"

namespace dreamsy::ui::draw {

using render::Color;
using render::FontId;
using render::ImageId;
using render::TextAlign;
using render::UvRect;

// ---------------------------------------------------------------- colors

inline Color hex(uint32_t rgb, float a = 1) {
  return {static_cast<float>((rgb >> 16) & 255) / 255.0f, static_cast<float>((rgb >> 8) & 255) / 255.0f,
          static_cast<float>(rgb & 255) / 255.0f, a};
}
inline Color with_alpha(Color c, float a) { return {c.r, c.g, c.b, a}; }
inline Color from_value(const std::optional<world::Value>& v, Color fallback) {
  if (!v || v->kind != world::ValueKind::Vec || v->n != 4) return fallback;
  return {static_cast<float>(v->v[0]), static_cast<float>(v->v[1]), static_cast<float>(v->v[2]),
          static_cast<float>(v->v[3])};
}
// engine-web theme.ts lum(): relative luminance of the sRGB bytes.
inline float lum(Color c) { return 0.2126f * c.r + 0.7152f * c.g + 0.0722f * c.b; }
// Readable text on `bg` (engine-web onColor).
inline Color on_color(Color bg, Color light) { return lum(bg) > 0.6f ? hex(0x111111) : light; }

inline float f(double v) { return static_cast<float>(v); }

// ---------------------------------------------------------------- clipped primitives

// One drawing pass: where commands go, and the clip / layer they use.
struct Pen {
  render::DrawList& out;
  int32_t layer = 0;
  std::optional<Rect> clip;

  render::SortInfo sort() const {
    render::SortInfo s;
    s.layer = layer;
    return s;
  }

  // A solid rect, cut to the clip.
  void rect(Rect r, Color c) {
    if (!(c.a > 0)) return;
    if (clip) r = intersect(r, *clip);
    if (r.w <= 0 || r.h <= 0) return;
    render::RectCmd cmd;
    cmd.space = render::Space::Screen;
    cmd.position = {f(r.x), f(r.y)};
    cmd.size = {f(r.w), f(r.h)};
    cmd.color = c;
    cmd.sort = sort();
    out.add(cmd);
  }

  // An image region stretched over `r`, cut to the clip (the UVs are cut by the same fraction).
  void image(Rect r, ImageId id, UvRect uv, Color tint) {
    if (!(tint.a > 0)) return;
    if (clip) {
      const Rect c = intersect(r, *clip);
      if (c.w <= 0 || c.h <= 0) return;
      const double du = (uv.u1 - uv.u0) / r.w, dv = (uv.v1 - uv.v0) / r.h;
      uv = {f(uv.u0 + (c.x - r.x) * du), f(uv.v0 + (c.y - r.y) * dv), f(uv.u0 + (c.x + c.w - r.x) * du),
            f(uv.v0 + (c.y + c.h - r.y) * dv)};
      r = c;
    }
    if (r.w <= 0 || r.h <= 0) return;
    render::SpriteCmd s;
    s.space = render::Space::Screen;
    s.image = id;
    s.src = uv;
    s.position = {f(r.x), f(r.y)};
    s.anchor = {0, 0};
    s.size = {f(r.w), f(r.h)};
    s.tint = tint;
    s.sort = sort();
    out.add(s);
  }

  // One line of text. `x` is the left edge / center / right edge (align); `y` the line's middle.
  void text(std::string_view str, FontId font, float size, Color color, TextAlign align, float x, float y,
            Color outline = {0, 0, 0, 0}, float outline_size = 0, Color shadow = {0, 0, 0, 0},
            render::Vec2 shadow_offset = {2, 2}) {
    if (str.empty() || !(color.a > 0)) return;
    render::TextCmd t;
    // Text is cut by the renderer's scissor (a line half inside a scroll list shows its visible half).
    if (clip) t.clip = {f(clip->x), f(clip->y), f(clip->w), f(clip->h), true};
    t.space = render::Space::Screen;
    t.text = std::string(str);
    t.font = font;
    t.size = size;
    t.color = color;
    t.align = align;
    t.position = {x, y};
    t.outline = outline;
    t.outline_size = outline_size;
    t.shadow = shadow;
    t.shadow_offset = shadow_offset;
    t.sort = sort();
    out.add(std::move(t));
  }
};

// A filled circle (the generated disc image).
inline void circle(Pen& pen, const UiImages& img, input::Circle c, Color color) {
  pen.image({c.center.x - c.radius, c.center.y - c.radius, c.radius * 2.0, c.radius * 2.0}, img.circle, {}, color);
}

// A rect with rounded corners: a cross of rects plus four quarter discs.
inline void round_rect(Pen& pen, const UiImages& img, Rect r, double radius, Color c) {
  radius = std::max(0.0, std::min({radius, r.w / 2, r.h / 2}));
  if (radius < 0.5) {
    pen.rect(r, c);
    return;
  }
  const double d = radius;
  pen.rect({r.x + d, r.y, r.w - 2 * d, r.h}, c);
  pen.rect({r.x, r.y + d, d, r.h - 2 * d}, c);
  pen.rect({r.x + r.w - d, r.y + d, d, r.h - 2 * d}, c);
  pen.image({r.x, r.y, d, d}, img.circle, {0, 0, 0.5f, 0.5f}, c);
  pen.image({r.x + r.w - d, r.y, d, d}, img.circle, {0.5f, 0, 1, 0.5f}, c);
  pen.image({r.x, r.y + r.h - d, d, d}, img.circle, {0, 0.5f, 0.5f, 1}, c);
  pen.image({r.x + r.w - d, r.y + r.h - d, d, d}, img.circle, {0.5f, 0.5f, 1, 1}, c);
}

// The outline of a rounded rect, `t` px thick (outlined panels).
inline void round_outline(Pen& pen, const UiImages& img, Rect r, double radius, double t, Color c) {
  radius = std::max(t, std::min({radius, r.w / 2, r.h / 2}));
  const double d = radius;
  pen.rect({r.x + d, r.y, r.w - 2 * d, t}, c);
  pen.rect({r.x + d, r.y + r.h - t, r.w - 2 * d, t}, c);
  pen.rect({r.x, r.y + d, t, r.h - 2 * d}, c);
  pen.rect({r.x + r.w - t, r.y + d, t, r.h - 2 * d}, c);
  // Corners: quarters of the ring image (its stroke is thinner than `t`; close enough).
  pen.image({r.x, r.y, d, d}, img.ring, {0, 0, 0.5f, 0.5f}, c);
  pen.image({r.x + r.w - d, r.y, d, d}, img.ring, {0.5f, 0, 1, 0.5f}, c);
  pen.image({r.x, r.y + r.h - d, d, d}, img.ring, {0, 0.5f, 0.5f, 1}, c);
  pen.image({r.x + r.w - d, r.y + r.h - d, d, d}, img.ring, {0.5f, 0.5f, 1, 1}, c);
}

// engine-web render/theme.ts panelSurface: the panel/button look for the theme's panel style.
inline void panel_surface(Pen& pen, const OverlayContext& ctx, Rect r, Color bg, bool small) {
  const UiTheme& t = ctx.theme;
  switch (t.panel) {
    case UiTheme::Panel::Pixel: {
      // Stepped pixel border: a hard outline on the four sides (not the corners) and an inner
      // shade along the bottom.
      const double b = small ? 3 : 4;
      const Color edge = with_alpha(t.text, 0.95f);
      pen.rect(r, bg);
      pen.rect({r.x, r.y - b, r.w, b}, edge);
      pen.rect({r.x, r.y + r.h, r.w, b}, edge);
      pen.rect({r.x - b, r.y, b, r.h}, edge);
      pen.rect({r.x + r.w, r.y, b, r.h}, edge);
      pen.rect({r.x, r.y + r.h - b, r.w, b}, {0, 0, 0, 0.45f});
      return;
    }
    case UiTheme::Panel::Sharp:
      pen.rect({r.x, r.y + 6, r.w, r.h}, {0, 0, 0, 0.35f});
      pen.rect(r, bg);
      return;
    case UiTheme::Panel::Outlined: {
      const double radius = small ? 10 : 14;
      round_rect(pen, ctx.images, r, radius, with_alpha(t.background, 0.6f));
      round_outline(pen, ctx.images, r, radius, 2, t.text);
      return;
    }
    case UiTheme::Panel::Rounded: {
      const double radius = small ? 14 : 22;
      // box-shadow 0 10px 30px rgba(0,0,0,0.35), approximated by one offset shape
      round_rect(pen, ctx.images, {r.x - 2, r.y + 8, r.w + 4, r.h + 4}, radius + 2, {0, 0, 0, 0.18f});
      round_rect(pen, ctx.images, r, radius, bg);
      return;
    }
  }
}

// ---------------------------------------------------------------- text

inline float measure(const render::Font& font, std::string_view s, float size) {
  return render::layout_text(font, s, size, TextAlign::Left).width;
}

inline std::string upper_ascii(std::string s) {
  for (char& c : s) {
    if (c >= 'a' && c <= 'z') c = static_cast<char>(c - 'a' + 'A');
  }
  return s;
}

}  // namespace dreamsy::ui::draw
