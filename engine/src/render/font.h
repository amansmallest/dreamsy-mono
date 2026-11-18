// Fonts and text layout (stb_truetype).
//
// The engine bundles the four engine-web theme fonts (third_party/fonts): pixel (DejaVu Sans Mono
// Bold: engine-web's pixel stack ends in the system monospace, which is what every device shows),
// rounded (Nunito), bold (Inter), serif (Source Serif 4), plus a symbol font (DejaVu Sans Bold
// subset: arrows, shapes, ★ ♥ ▶ ...) that every font falls back to for characters it lacks.
// Text sizes are CSS-style: `size` is the em size in pixels, line height is 1.2 x size, as in
// engine-web's Text2D.
//
// layout_text() is pure (no GPU, no atlas): it positions glyphs for a string, so tests and tools
// can measure text exactly as the renderer will draw it. FontStore rasterizes the glyphs the
// renderer needs into the atlas, once per (font, pixel size).
#pragma once

#include <cstdint>
#include <map>
#include <memory>
#include <optional>
#include <span>
#include <string_view>
#include <vector>

#include "base/result.h"
#include "render/atlas.h"
#include "render/draw_list.h"

namespace dreamsy::render {

// The bundled font file for a theme font (Default counts as Bold here).
std::span<const uint8_t> bundled_font(FontId id);

class Font;
// The symbol fallback font (loaded once, shared; nullptr if it fails to load).
const Font* symbol_font();

// "pixel" | "rounded" | "bold" | "serif" (manifest [ui] font, Text2D font) -> FontId; Default otherwise.
FontId font_from_name(std::string_view name);

// One TrueType font. The bytes must outlive it (bundled fonts are static data).
class Font {
 public:
  static Result<Font> load(std::span<const uint8_t> ttf);
  ~Font();
  Font(Font&&) noexcept;
  Font& operator=(Font&&) noexcept;

  // Scale from font units to pixels for an em size of `size` px (CSS font-size).
  float scale(float size) const;

  int glyph_index(char32_t codepoint) const;  // 0 = the font's "missing glyph"
  float advance(int glyph, float size) const;  // pixels
  float kerning(int left_glyph, int right_glyph, float size) const;  // pixels, usually <= 0
  // Ascent (> 0) and descent (< 0) in pixels.
  float ascent(float size) const;
  float descent(float size) const;

  // The glyph's coverage bitmap at `px` em pixels (8-bit alpha), and its offset from the pen
  // position on the baseline. Empty for blank glyphs (space).
  struct Bitmap {
    int width = 0, height = 0;
    int x0 = 0, y0 = 0;  // top-left of the bitmap relative to the pen (y down)
    std::vector<uint8_t> alpha;
  };
  Bitmap rasterize(int glyph, int px) const;

 private:
  struct Impl;  // stbtt_fontinfo (font.cpp)
  explicit Font(std::unique_ptr<Impl> impl);
  std::unique_ptr<Impl> impl_;
};

// ---------------------------------------------------------------- layout

struct PlacedGlyph {
  int glyph = 0;
  bool fallback = false;  // `glyph` is in symbol_font(), not the laid-out font
  float x = 0;  // pen position on the baseline, relative to the text block's top-left
  float y = 0;
};

struct TextLayout {
  float width = 0;   // widest line
  float height = 0;  // lines x line_height
  float line_height = 0;
  std::vector<float> line_widths;
  std::vector<PlacedGlyph> glyphs;
};

// Lays out UTF-8 text at em size `size`. Lines split at '\n'; each line is placed inside the
// block by `align`; the font's ascent..descent box is centered in each line. Characters the font
// lacks come from symbol_font() when it has them.
TextLayout layout_text(const Font& font, std::string_view utf8, float size, TextAlign align);

// Where the block's top-left goes for a text anchored at `position` (engine-web text2DOrigin):
// vertically centered; left / center / right edge at position.x.
Vec2 text_block_origin(Vec2 position, TextAlign align, float width, float height);

// Decodes one UTF-8 code point at `i` and advances `i`. Invalid bytes give U+FFFD.
char32_t next_codepoint(std::string_view s, size_t& i);

// ---------------------------------------------------------------- glyph cache

class FontStore {
 public:
  // `theme_font` is what FontId::Default means (the game's [ui] font).
  FontStore(Atlas& atlas, FontId theme_font);

  // Loads the bundled fonts. Call once.
  Status init();

  const Font& font(FontId id) const;
  FontId resolve(FontId id) const { return id == FontId::Default ? theme_font_ : id; }

  struct Glyph {
    bool blank = true;  // nothing to draw (space)
    AtlasRegion region;
    float x0 = 0, y0 = 0;  // bitmap offset from the pen, in raster pixels
    float w = 0, h = 0;    // bitmap size, in raster pixels
  };
  // The glyph rasterized at `px` em pixels (1..256), packed into the atlas on first use.
  // `fallback`: the index is in symbol_font() (PlacedGlyph::fallback).
  std::optional<Glyph> glyph(FontId id, int glyph_index, int px, bool fallback = false);

  size_t cached_glyphs() const { return glyphs_.size(); }

 private:
  Atlas& atlas_;
  FontId theme_font_;
  std::vector<Font> fonts_;  // Pixel, Rounded, Bold, Serif
  struct Key {
    uint8_t font;
    int glyph;
    int px;
    bool operator<(const Key& o) const {
      if (font != o.font) return font < o.font;
      if (glyph != o.glyph) return glyph < o.glyph;
      return px < o.px;
    }
  };
  std::map<Key, std::optional<Glyph>> glyphs_;  // nullopt = failed (logged once)
};

}  // namespace dreamsy::render
