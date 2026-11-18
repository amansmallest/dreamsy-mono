// Drawing the screen-space UI into the renderer's draw list: UI entities (UIPanel / UIText /
// UIButton), toasts, ui.dialog / ui.choice, the on-screen touch controls and the pause button.
//
// A port of how engine-web draws them as HTML (render/ui.ts, render/shell.ts, input/index.ts,
// render/theme.ts panelSurface), turned into rects, sprites and text in reference px. Everything
// is Space::Screen; the layers keep the platform UI above the game's UI:
//
//   layer 0  UI entities (ui/layout.h draw order)
//   layer 1  toasts
//   layer 2  dialog
//   layer 3  touch controls
//   layer 4  pause button
//
// The renderer has no scissor yet, so clipping (scroll lists, clip = true) is done here: rects and
// images are cut exactly; a text line is dropped when its middle is outside the clip.
// Rounded corners are drawn with quarter-circle sprites (UiImages), shadows as offset shapes.
#pragma once

#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "input/touch_controls.h"
#include "render/draw_list.h"
#include "render/font.h"
#include "render/textures.h"
#include "script/theme.h"
#include "ui/dialog.h"
#include "ui/layout.h"
#include "ui/toasts.h"

namespace dreamsy::ui {

// The [ui] theme as colors (script::resolve_theme gives hex strings).
struct UiTheme {
  enum class Panel : uint8_t { Pixel, Rounded, Sharp, Outlined };
  render::Color primary, accent, background, text;
  Panel panel = Panel::Rounded;
  render::FontId font = render::FontId::Bold;
  bool pixel_font() const { return font == render::FontId::Pixel; }
};
UiTheme ui_theme(const script::Theme& theme);

// Generated images the overlay needs (packed once into the atlas).
struct UiImages {
  render::ImageId circle;  // anti-aliased white disc
  render::ImageId ring;    // white ring, thickness 2/116 of the diameter (the joystick border)
};
Result<UiImages> create_ui_images(render::TextureStore& textures);

// Everything a draw call needs. `points_per_ref`: layout points (CSS px) per reference px, for
// the parts engine-web sizes in CSS px (pause button, touch controls).
struct OverlayContext {
  render::DrawList& out;
  render::TextureStore& textures;
  const render::FontStore& fonts;
  const UiTheme& theme;
  const UiImages& images;
  UiScreen screen;
  float points_per_ref = 1;
};

// ---- UI entities

void draw_ui_entities(OverlayContext& ctx, const world::World& w, const std::vector<UiNode>& nodes);

// ---- toasts

void draw_toasts(OverlayContext& ctx, const std::vector<Toast>& toasts);

// ---- dialogs

// Where the open dialog's parts are (reference px): the box and each option button.
struct DialogLayout {
  bool open = false;
  bool blocking = false;
  Rect box;
  std::vector<Rect> options;  // choice options (empty until the prompt is fully typed)
};
DialogLayout layout_dialog(const OverlayContext& ctx, const Dialogs& dialogs);
void draw_dialog(OverlayContext& ctx, const Dialogs& dialogs, double time);
// A tap on the dialog: an option index, -1 for the box (or anywhere, while blocking), nullopt
// when the tap misses a non-blocking dialog.
std::optional<int> hit_dialog(const DialogLayout& layout, double x, double y);

// ---- touch controls and the pause button

void draw_touch_controls(OverlayContext& ctx, const input::ControlsView& view);

Rect pause_button_rect(const UiScreen& screen, float points_per_ref);
void draw_pause_button(OverlayContext& ctx);

// ---- helpers (exposed for tests)

// Greedy word wrap (CSS white-space: pre-wrap + word-break: break-word): lines split at '\n',
// then at spaces before `max_width`; a word longer than a line breaks between characters.
std::vector<std::string> wrap_text(const render::Font& font, std::string_view text, float size, float max_width);

}  // namespace dreamsy::ui
