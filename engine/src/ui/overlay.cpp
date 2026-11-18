#include "ui/overlay.h"

#include <algorithm>
#include <cmath>

#include "pkg/text.h"
#include "render/style.h"

namespace dreamsy::ui {

using render::Color;
using render::FontId;
using render::ImageId;
using render::TextAlign;
using render::UvRect;

namespace {

// ---------------------------------------------------------------- colors

Color hex(uint32_t rgb, float a = 1) {
  return {static_cast<float>((rgb >> 16) & 255) / 255.0f, static_cast<float>((rgb >> 8) & 255) / 255.0f,
          static_cast<float>(rgb & 255) / 255.0f, a};
}
Color with_alpha(Color c, float a) { return {c.r, c.g, c.b, a}; }
Color faded(Color c, float k) { return {c.r, c.g, c.b, c.a * k}; }
Color from_value(const std::optional<world::Value>& v, Color fallback) {
  if (!v || v->kind != world::ValueKind::Vec || v->n != 4) return fallback;
  return {static_cast<float>(v->v[0]), static_cast<float>(v->v[1]), static_cast<float>(v->v[2]),
          static_cast<float>(v->v[3])};
}
// engine-web theme.ts lum(): relative luminance of the sRGB bytes.
float lum(Color c) { return 0.2126f * c.r + 0.7152f * c.g + 0.0722f * c.b; }
// Readable text on `bg` (engine-web onColor).
Color on_color(Color bg, Color light) { return lum(bg) > 0.6f ? hex(0x111111) : light; }

float f(double v) { return static_cast<float>(v); }

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
    if (clip && (y < clip->y || y > clip->y + clip->h)) return;  // drop lines outside the clip
    render::TextCmd t;
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
void circle(Pen& pen, const UiImages& img, input::Circle c, Color color) {
  pen.image({c.center.x - c.radius, c.center.y - c.radius, c.radius * 2.0, c.radius * 2.0}, img.circle, {}, color);
}

// A rect with rounded corners: a cross of rects plus four quarter discs.
void round_rect(Pen& pen, const UiImages& img, Rect r, double radius, Color c) {
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
void round_outline(Pen& pen, const UiImages& img, Rect r, double radius, double t, Color c) {
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
void panel_surface(Pen& pen, const OverlayContext& ctx, Rect r, Color bg, bool small) {
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

float measure(const render::Font& font, std::string_view s, float size) {
  return render::layout_text(font, s, size, TextAlign::Left).width;
}

struct LineRange {
  size_t begin = 0, end = 0;  // bytes in the source; the next line starts after a consumed break
};

// The wrap behind wrap_text(), as byte ranges of `text` (so a typewriter can show a prefix).
std::vector<LineRange> wrap_ranges(const render::Font& font, std::string_view text, float size, float max_width) {
  std::vector<LineRange> lines;
  auto fits = [&](size_t from, size_t to) { return measure(font, text.substr(from, to - from), size) <= max_width; };
  size_t para = 0;
  while (true) {
    const size_t nl = text.find('\n', para);
    const size_t para_end = nl == std::string_view::npos ? text.size() : nl;
    size_t start = para;
    if (start == para_end) lines.push_back({start, start});  // an empty line keeps its height
    while (start < para_end) {
      // Take words while the line still fits.
      size_t end = start, pos = start;
      while (true) {
        size_t word_end = std::min(text.find(' ', pos), para_end);
        if (!fits(start, word_end)) break;
        end = word_end;
        if (word_end >= para_end) break;
        pos = word_end + 1;
      }
      if (end == start) {
        // Not even the first word fits: cut it between characters (at least one per line).
        size_t i = start;
        while (i < para_end && text[i] != ' ') {
          size_t j = i;
          render::next_codepoint(text, j);
          if (i > start && !fits(start, j)) break;
          i = j;
        }
        end = i;
      }
      lines.push_back({start, end});
      start = end < para_end && text[end] == ' ' ? end + 1 : end;  // the break space is consumed
    }
    if (nl == std::string_view::npos) break;
    para = nl + 1;
  }
  return lines;
}

// Bytes of `s` that hold its first `units` UTF-16 code units (typewriter prefix).
size_t utf16_prefix_bytes(std::string_view s, size_t units) {
  size_t i = 0, n = 0;
  while (i < s.size() && n < units) {
    size_t j = i;
    const char32_t cp = render::next_codepoint(s, j);
    n += cp >= 0x10000 ? 2 : 1;
    i = j;
  }
  return i;
}

std::string upper_ascii(std::string s) {
  for (char& c : s) {
    if (c >= 'a' && c <= 'z') c = static_cast<char>(c - 'a' + 'A');
  }
  return s;
}

FontId font_prop(const world::World& w, const world::Entity& e) {
  const std::string name = w.str(e, "font");
  return name.empty() || name == "default" ? FontId::Default : render::font_from_name(name);
}

}  // namespace

// ---------------------------------------------------------------- theme, images

UiTheme ui_theme(const script::Theme& t) {
  UiTheme out;
  auto color = [](const std::string& h, Color fallback) { return render::parse_hex_color(h).value_or(fallback); };
  out.primary = color(t.primary, hex(0x3d7eff));
  out.accent = color(t.accent, hex(0xffb547));
  out.background = color(t.background, hex(0x1d2230));
  out.text = color(t.text, hex(0xf5f7fb));
  out.panel = t.panel == "pixel"      ? UiTheme::Panel::Pixel
              : t.panel == "sharp"    ? UiTheme::Panel::Sharp
              : t.panel == "outlined" ? UiTheme::Panel::Outlined
                                      : UiTheme::Panel::Rounded;
  out.font = render::font_from_name(t.font);
  if (out.font == FontId::Default) out.font = FontId::Bold;
  return out;
}

Result<UiImages> create_ui_images(render::TextureStore& textures) {
  // Discs with a 1.5 px soft edge, drawn at 256 px so they stay smooth when scaled.
  auto disc = [](int size, float ring_thickness) {
    render::Image img;
    img.width = img.height = size;
    img.pixels.resize(static_cast<size_t>(size) * size * 4);
    const float r = static_cast<float>(size) / 2;
    for (int y = 0; y < size; y++) {
      for (int x = 0; x < size; x++) {
        const float d = std::hypot(static_cast<float>(x) + 0.5f - r, static_cast<float>(y) + 0.5f - r);
        float a = std::clamp(r - d, 0.0f, 1.5f) / 1.5f;  // outer edge
        if (ring_thickness > 0) a *= std::clamp(d - (r - ring_thickness), 0.0f, 1.5f) / 1.5f;  // inner edge
        uint8_t* p = &img.pixels[(static_cast<size_t>(y) * size + x) * 4];
        p[0] = p[1] = p[2] = 255;
        p[3] = static_cast<uint8_t>(std::lround(a * 255));
      }
    }
    return img;
  };
  UiImages out;
  auto circle = textures.add_image("<ui-circle>", disc(256, 0));
  if (!circle) return Error{circle.error()};
  auto ring = textures.add_image("<ui-ring>", disc(256, 256.0f * 2 / 116));
  if (!ring) return Error{ring.error()};
  out.circle = circle.value();
  out.ring = ring.value();
  return out;
}

std::vector<std::string> wrap_text(const render::Font& font, std::string_view text, float size, float max_width) {
  std::vector<std::string> out;
  for (const LineRange& r : wrap_ranges(font, text, size, max_width)) out.emplace_back(text.substr(r.begin, r.end - r.begin));
  return out;
}

// ---------------------------------------------------------------- UI entities

void draw_ui_entities(OverlayContext& ctx, const world::World& w, const std::vector<UiNode>& nodes) {
  const UiTheme& theme = ctx.theme;
  for (const UiNode& n : nodes) {
    const world::Entity& e = *n.entity;
    const std::string& type = e.type->name;
    Pen pen{ctx.out, 0, n.clip ? std::optional<Rect>(scaled_rect(n, *n.clip)) : std::nullopt};
    const Rect r = scaled_rect(n, n.rect);
    const float ks = f(n.sy);  // text scales with the element

    if (type == "UIPanel") {
      const double radius_prop = w.num(e, "radius");
      const double radius = radius_prop >= 0 ? radius_prop
                            : theme.panel == UiTheme::Panel::Pixel || theme.panel == UiTheme::Panel::Sharp ? 0
                                                                                                           : 12;
      round_rect(pen, ctx.images, r, radius * n.sx, from_value(w.get_prop(e, "background"), {0, 0, 0, 0.67f}));
      const std::string image = w.str(e, "image");
      if (!image.empty()) {
        const ImageId id = ctx.textures.find_asset(image);
        if (id.valid()) pen.image(r, id, {}, from_value(w.get_prop(e, "tint"), {1, 1, 1, 1}));
      }
      continue;
    }

    const FontId font = font_prop(w, e);
    const float size = f(w.num(e, "font_size")) * ks;
    const render::Font& face = ctx.fonts.font(ctx.fonts.resolve(font));
    const Color color = from_value(w.get_prop(e, "color"), {1, 1, 1, 1});

    if (type == "UIButton") {
      // background (12 px corners) + box-shadow 0 3px 0 rgba(0,0,0,0.3)
      round_rect(pen, ctx.images, {r.x, r.y + 3, r.w, r.h}, 12, {0, 0, 0, 0.3f});
      round_rect(pen, ctx.images, r, 12, from_value(w.get_prop(e, "background"), {0.2f, 0.2f, 0.2f, 0.8f}));
      // Content: icon and/or text, centered as a row (icon left) or column (icon top), padding 0 8.
      const std::string text = w.str(e, "text");
      const bool top = w.str(e, "icon_position") == "top";
      const std::string icon = w.str(e, "icon");
      const ImageId icon_id = icon.empty() ? ImageId{} : ctx.textures.find_asset(icon);
      double icon_px = 0;
      if (icon_id.valid()) {
        const double prop = w.num(e, "icon_size");
        icon_px = (prop > 0 ? prop : std::round(n.rect.h * (top ? 0.45 : 0.7))) * n.sy;
      }
      const float line_h = size * 1.15f;
      std::vector<std::string> lines;
      if (!text.empty()) lines = wrap_text(face, text, size, std::max(1.0f, f(r.w - 16 * n.sx)));
      float text_w = 0;
      for (const std::string& l : lines) text_w = std::max(text_w, measure(face, l, size));
      const double text_h = line_h * static_cast<double>(lines.size());
      const double gap = icon_px > 0 && !lines.empty() ? (top ? 4 : 10) : 0;
      const double cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      if (top) {
        const double total = icon_px + gap + text_h;
        double y = cy - total / 2;
        if (icon_px > 0) pen.image({cx - icon_px / 2, y, icon_px, icon_px}, icon_id, {}, {1, 1, 1, 1});
        y += icon_px + gap;
        for (const std::string& l : lines) {
          pen.text(l, font, size, color, TextAlign::Center, f(cx), f(y + line_h / 2));
          y += line_h;
        }
      } else {
        const double total = icon_px + gap + text_w;
        double x = cx - total / 2;
        if (icon_px > 0) pen.image({x, cy - icon_px / 2, icon_px, icon_px}, icon_id, {}, {1, 1, 1, 1});
        x += icon_px + gap;
        double y = cy - text_h / 2;
        for (const std::string& l : lines) {
          const TextAlign align = icon_px > 0 ? TextAlign::Left : TextAlign::Center;
          pen.text(l, font, size, color, align, f(icon_px > 0 ? x : cx), f(y + line_h / 2));
          y += line_h;
        }
      }
      continue;
    }

    if (type == "UIText") {
      const std::string text = w.str(e, "text");
      if (text.empty()) continue;
      const std::string align_s = w.str(e, "align"), valign = w.str(e, "valign");
      const TextAlign align = align_s == "center" ? TextAlign::Center : align_s == "right" ? TextAlign::Right : TextAlign::Left;
      const float line_h = size * 1.15f;
      const std::vector<std::string> lines = wrap_text(face, text, size, std::max(1.0f, f(r.w)));
      const double h = line_h * static_cast<double>(lines.size());
      double y = valign == "top" ? r.y : valign == "bottom" ? r.y + r.h - h : r.y + (r.h - h) / 2;
      const float x = align == TextAlign::Left ? f(r.x) : align == TextAlign::Right ? f(r.x + r.w) : f(r.x + r.w / 2);
      Color outline = from_value(w.get_prop(e, "outline"), {0, 0, 0, 0});
      float outline_size = f(w.num(e, "outline_size")) * ks;
      Color shadow = from_value(w.get_prop(e, "shadow"), {0, 0, 0, 0});
      const world::Point so = w.vec(e, "shadow_offset");
      render::Vec2 shadow_offset{f(so.x) * ks, f(so.y) * ks};
      if (!(outline.a > 0 && outline_size > 0) && !(shadow.a > 0)) {
        shadow = {0, 0, 0, 0.45f};  // engine-web's default text-shadow: 0 2px 0 rgba(0,0,0,0.45)
        shadow_offset = {0, 2 * ks};
      }
      if (!(outline_size > 0)) outline = {0, 0, 0, 0};
      for (const std::string& l : lines) {
        pen.text(l, font, size, color, align, x, f(y + line_h / 2), outline, outline_size, shadow, shadow_offset);
        y += line_h;
      }
    }
  }
}

// ---------------------------------------------------------------- toasts

void draw_toasts(OverlayContext& ctx, const std::vector<Toast>& toasts) {
  if (toasts.empty()) return;
  const UiTheme& t = ctx.theme;
  const double ref_w = ctx.screen.ref_w;
  const float size = t.pixel_font() ? 22 : 28;
  const render::Font& face = ctx.fonts.font(ctx.fonts.resolve(t.font));
  const float line_h = size * 1.2f;
  const double max_w = ref_w * 0.86;
  Pen pen{ctx.out, 1, std::nullopt};
  double y = ctx.screen.safe.top + ctx.screen.ref_h * 0.16;
  for (const Toast& toast : toasts) {
    const std::vector<std::string> lines = wrap_text(face, toast.text, size, f(max_w - 44));
    float text_w = 0;
    for (const std::string& l : lines) text_w = std::max(text_w, measure(face, l, size));
    const double w = std::min(max_w, static_cast<double>(text_w) + 44);
    const double h = line_h * static_cast<double>(std::max<size_t>(1, lines.size())) + 24;
    const Rect box{ref_w / 2 - w / 2, y, w, h};
    panel_surface(pen, ctx, box, with_alpha(t.background, 0.9f), true);
    double ly = y + 12;
    for (const std::string& l : lines) {
      pen.text(l, t.font, size, t.text, TextAlign::Center, f(ref_w / 2), f(ly + line_h / 2));
      ly += line_h;
    }
    y += h + 8;
  }
}

// ---------------------------------------------------------------- dialogs

namespace {

// Sizes from engine-web render/ui.ts updateDialog.
struct DialogMetrics {
  bool portrait;
  double margin, fs, pad_top, pad_x, pad_bottom, min_h, portrait_px;
};

DialogMetrics dialog_metrics(const OverlayContext& ctx) {
  const bool portrait = ctx.screen.ref_h > ctx.screen.ref_w;
  const bool pixel = ctx.theme.pixel_font();
  return {portrait,
          portrait ? 24.0 : 40.0,
          pixel ? (portrait ? 26.0 : 24.0) : (portrait ? 34.0 : 30.0),
          portrait ? 26.0 : 22.0,
          28,
          portrait ? 30.0 : 26.0,
          portrait ? 220.0 : 170.0,
          portrait ? 136.0 : 120.0};
}

// Everything about the open dialog's geometry, shared by layout_dialog and draw_dialog.
struct DialogGeometry {
  Rect box;
  bool has_portrait = false;
  Rect portrait;
  double col_x = 0, col_w = 0;
  double speaker_y = 0;  // middle of the speaker line
  double text_y = 0;     // top of the text
  std::vector<LineRange> lines;
  double option_top = 0;
  std::vector<Rect> options;
  double fs = 0, line_h = 0, option_h = 0;
};

DialogGeometry dialog_geometry(const OverlayContext& ctx, const DialogState& d) {
  const DialogMetrics m = dialog_metrics(ctx);
  const SafeArea& safe = ctx.screen.safe;
  const DialogLine& line = d.lines[d.index];
  const bool is_last = d.index + 1 >= d.lines.size();
  const render::Font& face = ctx.fonts.font(ctx.fonts.resolve(ctx.theme.font));
  DialogGeometry g;
  g.fs = m.fs;
  g.line_h = m.fs * 1.35;

  const double box_x = safe.left + m.margin;
  const double box_w = ctx.screen.ref_w - safe.left - safe.right - 2 * m.margin;
  g.has_portrait = line.portrait.has_value() && ctx.textures.find_asset(*line.portrait).valid();
  double col_x = box_x + m.pad_x;
  if (g.has_portrait) col_x += m.portrait_px + 22;
  g.col_x = col_x;
  g.col_w = std::max(1.0, box_x + box_w - m.pad_x - col_x);

  // Column content height: speaker, gap 10, text (full text: the box doesn't grow while typing),
  // options (margin 8, gap 12).
  double h = 0;
  if (line.speaker) {
    g.speaker_y = m.fs * 0.8 * 1.2 / 2;
    h += m.fs * 0.8 * 1.2 + 10;
  }
  g.text_y = h;
  g.lines = wrap_ranges(face, line.text, f(m.fs), f(g.col_w));
  h += g.line_h * static_cast<double>(std::max<size_t>(1, g.lines.size()));
  if (d.choice && is_last) {
    const double ofs = std::round(m.fs * 0.9);
    g.option_h = std::max(64.0, ofs * 1.2 + (m.portrait ? 36 : 28));
    h += 8 + 10;  // margin-top 8 + the column gap
    g.option_top = h;
    h += g.option_h * static_cast<double>(d.options.size()) + 12.0 * static_cast<double>(d.options.size() - 1);
  }
  double box_h = m.pad_top + std::max(h, g.has_portrait ? m.portrait_px : 0.0) + m.pad_bottom;
  box_h = std::max(box_h, m.min_h);
  const double box_y = d.top ? safe.top + m.margin + 64 : ctx.screen.ref_h - safe.bottom - m.margin - box_h;
  g.box = {box_x, box_y, box_w, box_h};
  if (g.has_portrait) g.portrait = {box_x + m.pad_x, box_y + m.pad_top, m.portrait_px, m.portrait_px};
  const double top = box_y + m.pad_top;
  g.speaker_y += top;
  g.text_y += top;
  g.option_top += top;
  for (size_t i = 0; i < d.options.size() && d.choice && is_last; i++) {
    g.options.push_back({col_x, g.option_top + static_cast<double>(i) * (g.option_h + 12), g.col_w, g.option_h});
  }
  return g;
}

}  // namespace

DialogLayout layout_dialog(const OverlayContext& ctx, const Dialogs& dialogs) {
  DialogLayout out;
  if (!dialogs.current) return out;
  const DialogState& d = *dialogs.current;
  const DialogGeometry g = dialog_geometry(ctx, d);
  out.open = true;
  out.blocking = d.blocking;
  out.box = g.box;
  if (dialogs.line_done()) out.options = g.options;  // options are hidden (and untappable) while typing
  return out;
}

std::optional<int> hit_dialog(const DialogLayout& layout, double x, double y) {
  if (!layout.open) return std::nullopt;
  for (size_t i = 0; i < layout.options.size(); i++) {
    if (layout.options[i].contains(x, y)) return static_cast<int>(i);
  }
  if (layout.box.contains(x, y) || layout.blocking) return -1;
  return std::nullopt;
}

void draw_dialog(OverlayContext& ctx, const Dialogs& dialogs, double time) {
  if (!dialogs.current) return;
  const DialogState& d = *dialogs.current;
  const UiTheme& t = ctx.theme;
  const DialogGeometry g = dialog_geometry(ctx, d);
  const DialogLine& line = d.lines[d.index];
  const bool line_done = dialogs.line_done();
  const bool is_last = d.index + 1 >= d.lines.size();
  Pen pen{ctx.out, 2, std::nullopt};

  panel_surface(pen, ctx, g.box, with_alpha(t.background, 0.95f), false);
  if (g.has_portrait) {
    panel_surface(pen, ctx, g.portrait, with_alpha(t.text, 0.08f), true);
    const double inner = g.portrait.w * 0.84;  // background-size: 84%
    pen.image({g.portrait.x + (g.portrait.w - inner) / 2, g.portrait.y + (g.portrait.h - inner) / 2, inner, inner},
              ctx.textures.find_asset(*line.portrait), {}, {1, 1, 1, 1});
  }
  if (line.speaker) {
    const std::string speaker = t.pixel_font() ? upper_ascii(*line.speaker) : *line.speaker;
    pen.text(speaker, t.font, f(std::round(g.fs * 0.8)), t.accent, TextAlign::Left, f(g.col_x), f(g.speaker_y));
  }
  // The typed part of each wrapped line.
  const size_t visible = utf16_prefix_bytes(line.text, static_cast<size_t>(std::floor(d.shown)));
  double y = g.text_y;
  for (const LineRange& r : g.lines) {
    if (r.begin >= visible) break;
    const std::string_view s = std::string_view(line.text).substr(r.begin, std::min(r.end, visible) - r.begin);
    pen.text(s, t.font, f(g.fs), t.text, TextAlign::Left, f(g.col_x), f(y + g.line_h / 2));
    y += g.line_h;
  }
  if (d.choice && is_last) {
    if (!line_done) return;  // options appear once the prompt is typed
    const float ofs = f(std::round(g.fs * 0.9));
    for (size_t i = 0; i < g.options.size(); i++) {
      const bool sel = static_cast<int>(i) == d.selected;
      const Rect& r = g.options[i];
      if (t.panel == UiTheme::Panel::Outlined) {
        if (sel) round_rect(pen, ctx.images, r, 10, t.primary);
        round_outline(pen, ctx.images, r, 10, 2, sel ? t.primary : t.text);
      } else {
        panel_surface(pen, ctx, r, sel ? t.primary : with_alpha(t.text, 0.12f), true);
      }
      const Color c = sel ? on_color(t.primary, hex(0xffffff)) : t.text;
      // "▶ " in engine-web; the bundled fonts are Latin-1, so a guillemet marks the selection.
      const std::string label = (sel ? "\xC2\xBB " : "") + d.options[i];
      pen.text(label, t.font, ofs, c, TextAlign::Left, f(r.x + (ctx.screen.ref_h > ctx.screen.ref_w ? 20 : 18)),
               f(r.y + r.h / 2));
    }
  } else if (line_done) {
    // The "next" marker (engine-web: ▼ at right 22, bottom 12): a small bobbing diamond.
    const double s = std::round(g.fs * 0.5);
    const double bob = std::sin(time * 6) * 3;
    render::SpriteCmd mark;
    mark.space = render::Space::Screen;
    mark.position = {f(g.box.x + g.box.w - 22 - s / 2), f(g.box.y + g.box.h - 12 - s + bob)};
    mark.size = {f(s), f(s)};
    mark.rotation = 0.785398f;
    mark.tint = t.accent;
    mark.sort.layer = 2;
    ctx.out.add(mark);
  }
}

// ---------------------------------------------------------------- touch controls, pause button

void draw_touch_controls(OverlayContext& ctx, const input::ControlsView& view) {
  Pen pen{ctx.out, 3, std::nullopt};
  const float shadow_px = 4 / ctx.points_per_ref;
  for (int look = 0; look < 2; look++) {
    const input::StickView& s = look ? view.look : view.stick;
    const float k = s.alpha * view.opacity;
    if (!s.enabled || !(k > 0)) continue;
    circle(pen, ctx.images, s.base, look ? Color{1, 1, 1, 0.10f * k} : Color{1, 1, 1, 0.12f * k});
    pen.image({s.base.center.x - s.base.radius, s.base.center.y - s.base.radius, s.base.radius * 2.0, s.base.radius * 2.0},
              ctx.images.ring, {}, look ? hex(0xff7878, 0.45f * k) : Color{1, 1, 1, 0.35f * k});
    circle(pen, ctx.images, s.knob, look ? hex(0xffa0a0, 0.6f * k) : Color{1, 1, 1, 0.55f * k});
  }
  for (const input::ButtonView& b : view.buttons) {
    const float k = b.alpha * view.opacity;
    if (!(k > 0)) continue;
    input::Circle shadow = b.circle;
    shadow.center.y += shadow_px;
    circle(pen, ctx.images, shadow, {0, 0, 0, 0.3f * k});
    circle(pen, ctx.images, b.circle, hex(b.color, (b.pressed ? 1.0f : 0.78f) * k));
    pen.text(b.label, FontId::Bold, std::round(b.circle.radius * 2 * 0.32f), {1, 1, 1, k}, TextAlign::Center,
             b.circle.center.x, b.circle.center.y);
  }
}

Rect pause_button_rect(const UiScreen& screen, float points_per_ref) {
  const double k = 1.0 / points_per_ref;
  const double size = 44 * k, inset = 12 * k;
  return {screen.ref_w - screen.safe.right - inset - size, screen.safe.top + inset, size, size};
}

void draw_pause_button(OverlayContext& ctx) {
  const Rect r = pause_button_rect(ctx.screen, ctx.points_per_ref);
  const double k = 1.0 / ctx.points_per_ref;
  Pen pen{ctx.out, 4, std::nullopt};
  panel_surface(pen, ctx, r, with_alpha(ctx.theme.background, 0.75f), true);
  // Two bars, 5 x 16 points, 6 apart.
  const double bw = 5 * k, bh = 16 * k, gap = 6 * k;
  const double x0 = r.x + r.w / 2 - gap / 2 - bw, y0 = r.y + r.h / 2 - bh / 2;
  pen.rect({x0, y0, bw, bh}, ctx.theme.text);
  pen.rect({x0 + bw + gap, y0, bw, bh}, ctx.theme.text);
}

}  // namespace dreamsy::ui
