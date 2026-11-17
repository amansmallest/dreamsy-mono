#include "render/font.h"

#include <algorithm>
#include <cmath>
#include <string>

#include "base/log.h"
#include "stb_truetype.h"

// The bundled font files, embedded at build time (cmake/embed_files.cmake), in this order:
// Pixel, Rounded, Bold, Serif.
namespace dreamsy::render::embedded {
size_t file_count();
std::span<const uint8_t> file_data(size_t index);
}  // namespace dreamsy::render::embedded

namespace dreamsy::render {

std::span<const uint8_t> bundled_font(FontId id) {
  switch (id) {
    case FontId::Pixel: return embedded::file_data(0);
    case FontId::Rounded: return embedded::file_data(1);
    case FontId::Serif: return embedded::file_data(3);
    case FontId::Bold:
    case FontId::Default: return embedded::file_data(2);
  }
  return {};
}

FontId font_from_name(std::string_view name) {
  if (name == "pixel") return FontId::Pixel;
  if (name == "rounded") return FontId::Rounded;
  if (name == "bold") return FontId::Bold;
  if (name == "serif") return FontId::Serif;
  return FontId::Default;
}

// ---------------------------------------------------------------- Font

struct Font::Impl {
  stbtt_fontinfo info{};
  int ascent = 0, descent = 0, line_gap = 0;  // font units
};

Font::Font(std::unique_ptr<Impl> impl) : impl_(std::move(impl)) {}
Font::~Font() = default;
Font::Font(Font&&) noexcept = default;
Font& Font::operator=(Font&&) noexcept = default;

Result<Font> Font::load(std::span<const uint8_t> ttf) {
  if (ttf.size() < 12) return Error{"font file too small"};
  auto impl = std::make_unique<Impl>();
  const int offset = stbtt_GetFontOffsetForIndex(ttf.data(), 0);
  if (offset < 0 || !stbtt_InitFont(&impl->info, ttf.data(), offset)) return Error{"can't read font"};
  stbtt_GetFontVMetrics(&impl->info, &impl->ascent, &impl->descent, &impl->line_gap);
  return Font(std::move(impl));
}

float Font::scale(float size) const { return stbtt_ScaleForMappingEmToPixels(&impl_->info, size); }

int Font::glyph_index(char32_t codepoint) const {
  return stbtt_FindGlyphIndex(&impl_->info, static_cast<int>(codepoint));
}

float Font::advance(int glyph, float size) const {
  int adv = 0, lsb = 0;
  stbtt_GetGlyphHMetrics(&impl_->info, glyph, &adv, &lsb);
  return static_cast<float>(adv) * scale(size);
}

float Font::kerning(int left, int right, float size) const {
  return static_cast<float>(stbtt_GetGlyphKernAdvance(&impl_->info, left, right)) * scale(size);
}

float Font::ascent(float size) const { return static_cast<float>(impl_->ascent) * scale(size); }
float Font::descent(float size) const { return static_cast<float>(impl_->descent) * scale(size); }

Font::Bitmap Font::rasterize(int glyph, int px) const {
  Bitmap b;
  const float s = scale(static_cast<float>(px));
  int x0 = 0, y0 = 0, x1 = 0, y1 = 0;
  stbtt_GetGlyphBitmapBox(&impl_->info, glyph, s, s, &x0, &y0, &x1, &y1);
  const int w = x1 - x0, h = y1 - y0;
  if (w <= 0 || h <= 0 || w > 1024 || h > 1024) return b;
  b.width = w;
  b.height = h;
  b.x0 = x0;
  b.y0 = y0;
  b.alpha.assign(static_cast<size_t>(w) * h, 0);
  stbtt_MakeGlyphBitmap(&impl_->info, b.alpha.data(), w, h, w, s, s, glyph);
  return b;
}

// ---------------------------------------------------------------- layout

char32_t next_codepoint(std::string_view s, size_t& i) {
  const auto byte = [&](size_t k) { return static_cast<uint8_t>(s[k]); };
  const uint8_t c = byte(i);
  int extra = 0;
  char32_t cp = 0;
  if (c < 0x80) {
    i += 1;
    return c;
  } else if ((c & 0xE0) == 0xC0) {
    extra = 1;
    cp = c & 0x1F;
  } else if ((c & 0xF0) == 0xE0) {
    extra = 2;
    cp = c & 0x0F;
  } else if ((c & 0xF8) == 0xF0) {
    extra = 3;
    cp = c & 0x07;
  } else {
    i += 1;
    return 0xFFFD;
  }
  if (i + extra >= s.size()) {  // truncated sequence
    i += 1;
    return 0xFFFD;
  }
  for (int k = 1; k <= extra; k++) {
    const uint8_t cc = byte(i + k);
    if ((cc & 0xC0) != 0x80) {
      i += 1;
      return 0xFFFD;
    }
    cp = (cp << 6) | (cc & 0x3F);
  }
  i += 1 + extra;
  if (cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return 0xFFFD;
  return cp;
}

TextLayout layout_text(const Font& font, std::string_view utf8, float size, TextAlign align) {
  TextLayout out;
  out.line_height = std::ceil(size * 1.2f);
  // Offset from a line's vertical center to its baseline: centers the ascent..descent box.
  const float baseline = (font.ascent(size) + font.descent(size)) * 0.5f;

  // Pass 1: glyphs and pen x per line (left aligned).
  std::vector<size_t> line_start{0};
  float pen = 0;
  int prev = -1;
  size_t i = 0;
  while (i < utf8.size()) {
    const char32_t cp = next_codepoint(utf8, i);
    if (cp == '\n') {
      out.line_widths.push_back(pen);
      line_start.push_back(out.glyphs.size());
      pen = 0;
      prev = -1;
      continue;
    }
    if (cp == '\r') continue;
    const int g = font.glyph_index(cp);
    if (prev >= 0) pen += font.kerning(prev, g, size);
    out.glyphs.push_back({g, pen, 0});
    pen += font.advance(g, size);
    prev = g;
  }
  out.line_widths.push_back(pen);

  // Pass 2: align each line inside the block and set baselines.
  for (float w : out.line_widths) out.width = std::max(out.width, w);
  const size_t lines = out.line_widths.size();
  out.height = out.line_height * static_cast<float>(lines);
  for (size_t line = 0; line < lines; line++) {
    const float w = out.line_widths[line];
    const float dx = align == TextAlign::Left ? 0 : align == TextAlign::Right ? out.width - w : (out.width - w) * 0.5f;
    const float y = out.line_height * (static_cast<float>(line) + 0.5f) + baseline;
    const size_t end = line + 1 < lines ? line_start[line + 1] : out.glyphs.size();
    for (size_t g = line_start[line]; g < end; g++) {
      out.glyphs[g].x += dx;
      out.glyphs[g].y = y;
    }
  }
  return out;
}

Vec2 text_block_origin(Vec2 position, TextAlign align, float width, float height) {
  const float dx = align == TextAlign::Left ? 0 : align == TextAlign::Right ? -width : -width * 0.5f;
  return {position.x + dx, position.y - height * 0.5f};
}

// ---------------------------------------------------------------- FontStore

FontStore::FontStore(Atlas& atlas, FontId theme_font) : atlas_(atlas), theme_font_(theme_font) {
  if (theme_font_ == FontId::Default) theme_font_ = FontId::Bold;
}

Status FontStore::init() {
  fonts_.clear();
  for (FontId id : {FontId::Pixel, FontId::Rounded, FontId::Bold, FontId::Serif}) {
    auto f = Font::load(bundled_font(id));
    if (!f) return Error{"bundled font: " + f.error()};
    fonts_.push_back(std::move(f).value());
  }
  return {};
}

const Font& FontStore::font(FontId id) const {
  DREAMSY_CHECK(fonts_.size() == 4, "FontStore::init() not called");
  // FontId: Default 0, Pixel 1, Rounded 2, Bold 3, Serif 4  ->  fonts_[0..3]
  return fonts_[static_cast<size_t>(resolve(id)) - 1];
}

std::optional<FontStore::Glyph> FontStore::glyph(FontId id, int glyph_index, int px) {
  px = std::clamp(px, 1, 256);
  const FontId fid = resolve(id);
  const Key key{static_cast<uint8_t>(fid), glyph_index, px};
  if (auto it = glyphs_.find(key); it != glyphs_.end()) return it->second;

  Font::Bitmap bmp = font(fid).rasterize(glyph_index, px);
  Glyph g;
  if (!bmp.alpha.empty()) {
    // White glyph, coverage in alpha, premultiplied: (a, a, a, a).
    Image img;
    img.width = bmp.width;
    img.height = bmp.height;
    img.pixels.resize(bmp.alpha.size() * 4);
    for (size_t k = 0; k < bmp.alpha.size(); k++) {
      const uint8_t a = bmp.alpha[k];
      img.pixels[k * 4 + 0] = a;
      img.pixels[k * 4 + 1] = a;
      img.pixels[k * 4 + 2] = a;
      img.pixels[k * 4 + 3] = a;
    }
    auto region = atlas_.add(img);
    if (!region) {
      log_warn("render: glyph: " + region.error());
      glyphs_.emplace(key, std::nullopt);
      return std::nullopt;
    }
    g.blank = false;
    g.region = region.value();
    g.x0 = static_cast<float>(bmp.x0);
    g.y0 = static_cast<float>(bmp.y0);
    g.w = static_cast<float>(bmp.width);
    g.h = static_cast<float>(bmp.height);
  }
  glyphs_.emplace(key, g);
  return g;
}

}  // namespace dreamsy::render
