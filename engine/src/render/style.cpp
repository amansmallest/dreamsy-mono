#include "render/style.h"

#include <algorithm>
#include <string>
#include <vector>

#include "pkg/package.h"
#include "render/font.h"

namespace dreamsy::render {

std::optional<Color> parse_hex_color(std::string_view hex) {
  if (hex.empty() || hex[0] != '#') return std::nullopt;
  hex.remove_prefix(1);
  auto nibble = [](char c) -> int {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
  };
  std::vector<int> v;
  for (char c : hex) {
    const int n = nibble(c);
    if (n < 0) return std::nullopt;
    v.push_back(n);
  }
  auto byte = [&](size_t i) { return static_cast<float>(v[i] * 16 + v[i + 1]) / 255.0f; };
  if (v.size() == 3) {
    return Color{static_cast<float>(v[0] * 17) / 255.0f, static_cast<float>(v[1] * 17) / 255.0f,
                 static_cast<float>(v[2] * 17) / 255.0f, 1};
  }
  if (v.size() == 6) return Color{byte(0), byte(2), byte(4), 1};
  if (v.size() == 8) return Color{byte(0), byte(2), byte(4), byte(6)};
  return std::nullopt;
}

namespace {

// engine-web core/theme.ts lum()
float luminance(Color c) { return 0.2126f * c.r + 0.7152f * c.g + 0.0722f * c.b; }

struct PresetDefaults {
  const char* background;
  FontId font;
};

PresetDefaults preset_defaults(std::string_view preset) {
  if (preset == "pixel") return {"#1a1c2c", FontId::Pixel};
  if (preset == "blocky") return {"#263238", FontId::Bold};
  if (preset == "toon") return {"#2b2d6e", FontId::Rounded};
  if (preset == "custom") return {"#202233", FontId::Bold};
  return {"#1d2230", FontId::Bold};  // clean
}

}  // namespace

RenderStyle style_from_manifest(const pkg::Manifest& m) {
  RenderStyle s;
  s.ref_w = m.reference_width();
  s.ref_h = m.reference_height();
  const std::string& preset = m.style.preset;
  s.nearest = preset == "pixel" || preset == "blocky";
  s.pixel_snap = preset == "pixel";

  // Clear color (renderer2d.ts): palette[0], else pixel #1a1c2c / others #20232a.
  std::optional<Color> clear;
  if (m.style.palette && !m.style.palette->empty()) clear = parse_hex_color(m.style.palette->front());
  s.clear_color = clear.value_or(*parse_hex_color(s.pixel_snap ? "#1a1c2c" : "#20232a"));

  // Theme background (theme.ts resolveTheme): [ui] background, else the darkest palette color
  // (palettes of 3+), else the preset's.
  const PresetDefaults d = preset_defaults(preset);
  std::optional<Color> bg;
  if (m.ui && m.ui->background) bg = parse_hex_color(*m.ui->background);
  if (!bg && m.style.palette && m.style.palette->size() >= 3) {
    for (const std::string& hex : *m.style.palette) {
      auto c = parse_hex_color(hex);
      if (c && (!bg || luminance(*c) < luminance(*bg))) bg = c;
    }
  }
  s.letterbox_color = bg.value_or(*parse_hex_color(d.background));

  s.theme_font = d.font;
  if (m.ui && m.ui->font) {
    const FontId f = font_from_name(*m.ui->font);
    if (f != FontId::Default) s.theme_font = f;
  }
  return s;
}

}  // namespace dreamsy::render
