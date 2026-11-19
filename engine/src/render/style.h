// Render settings that come from the manifest ([style] preset and palette, [ui]).
//
// Mirrors engine-web: format/src/styles.ts render hints (texture filter, pixel snap),
// render/renderer2d.ts clear color, core/theme.ts background and font.
#pragma once

#include <optional>
#include <string_view>

#include "render/draw_list.h"

namespace dreamsy::pkg {
struct Manifest;
}

namespace dreamsy::render {

struct RenderStyle {
  int ref_w = 1280, ref_h = 720;  // reference screen (orientation)
  bool nearest = false;     // nearest-neighbor texture filtering (pixel, blocky)
  bool pixel_snap = false;  // pixel-art mode: reference-size target, snapped camera (pixel)
  Color clear_color;        // game background: palette[0], else a preset default
  Color letterbox_color;    // bars around the game: the theme background
  FontId theme_font = FontId::Bold;
};

RenderStyle style_from_manifest(const pkg::Manifest& m);

// "#rgb", "#rrggbb" or "#rrggbbaa" -> Color.
std::optional<Color> parse_hex_color(std::string_view hex);

}  // namespace dreamsy::render
