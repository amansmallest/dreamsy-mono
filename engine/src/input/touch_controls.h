// The on-screen controls for phones: a fixed joystick bottom-left, A/B/C buttons bottom-right,
// and an aim stick for twin-stick games (engine-web input/index.ts TouchControls + LookStick).
//
// This is the model only: layout, hit testing, which control a finger holds, what it writes into
// InputState, and what is visible. ui/overlay.h draws a ControlsView.
//
// Visibility (engine-web syncActive): a control shows only while the game is reading it, so title
// screens, menus and shops aren't covered by a joystick:
//   joystick   while scripts read move_x / move_y (recently_read, 0.75 s) or a finger holds it
//   A/B/C      while scripts read jump / action / action2, or the button is held
//   aim stick  while scripts read look_x / look_y, or a finger holds it
// A control that is hidden takes no touches. Which buttons exist comes from a scan of the scripts
// (usage.h) plus any button the game reads later (kits read them through config tables).
//
// Units: the layout is in points (CSS px; the numbers are engine-web's), so controls keep their
// physical size on any screen. set_screen() gives the points-per-reference-pixel factor of the
// current window; everything this class returns is in reference px.
#pragma once

#include <array>
#include <cstdint>
#include <optional>
#include <set>
#include <vector>

#include "input/input_state.h"
#include "input/usage.h"

namespace dreamsy::input {

// Per orientation, in points before the touch-size setting (engine-web touchLayout).
struct TouchLayout {
  float stick = 0;    // joystick diameter
  float knob = 0;     // knob diameter
  float stick_x = 0;  // joystick inset from the left edge (aim stick: right edge)
  float stick_y = 0;  // ... and from the bottom edge
  struct Slot {
    float right = 0, bottom = 0, size = 0;  // insets of the button's box from the right/bottom
  };
  std::array<Slot, 3> buttons;  // slots in order: the first visible button takes slot 0
};

TouchLayout touch_layout(bool portrait);

// Thumb-friendly stick shaping (engine-web shapeStick): radial dead zone 0.18 rescaled so its edge
// reads 0; then a secondary axis under half the main one is dropped (a thumb steering left/right
// drifts down; that must not brake a car). Diagonals pass through. Input and output -1..1.
Vec2 shape_stick(float x, float y);

inline constexpr float kStickDeadZone = 0.18f;
inline constexpr float kLookDeadZone = 0.15f;  // aim stick: per axis
inline constexpr float kMinTouchScale = 0.75f, kMaxTouchScale = 1.5f;

// Safe-area insets (notch, home indicator) that reach into the game rect, in reference px.
struct Insets {
  float top = 0, right = 0, bottom = 0, left = 0;
};

struct ControlsScreen {
  int ref_w = 720, ref_h = 1280;
  float points_per_ref = 1;  // layout points per reference px (CSS px per game px on the web)
  Insets safe;
};

struct Circle {
  Vec2 center;
  float radius = 0;
};

struct StickView {
  bool enabled = false;  // part of this game's controls at all
  float alpha = 0;       // 0..1 (fades in and out)
  bool held = false;     // a finger is on it
  Circle base;
  Circle knob;
};

struct ButtonView {
  const char* name = "";   // "jump" | "action" | "action2"
  const char* label = "";  // "A" | "B" | "C"
  uint32_t color = 0;      // 0xRRGGBB
  float alpha = 0;
  bool pressed = false;  // held by a finger, or by any device (keys)
  Circle circle;
};

struct ControlsView {
  float opacity = 1;  // whole-layer opacity (0.25 while a dialog is open)
  StickView stick;
  StickView look;
  std::vector<ButtonView> buttons;  // only the buttons this game shows
};

class TouchControls {
 public:
  TouchControls(InputUsage usage, bool portrait);

  void set_screen(const ControlsScreen& screen) { screen_ = screen; }
  // The platform "touch-control size" setting, clamped to 0.75..1.5.
  void set_scale(float scale);
  // Fade the controls while a dialog is open (jump/action still advance it).
  void set_dimmed(bool dimmed) { dimmed_ = dimmed; }

  // Touch (or mouse) events in reference px. `id` identifies the finger. Return true when a
  // control took the touch: then it must not reach the game (no pointerDown, no tap).
  bool touch_down(int64_t id, Vec2 p, InputState& input);
  bool touch_move(int64_t id, Vec2 p, InputState& input);
  bool touch_up(int64_t id, InputState& input);
  // Every finger lifts (focus lost, touches cancelled, scene reload).
  void release_all(InputState& input);

  // Once per frame: which controls show (from what scripts read), and the fades. `dt` = real
  // seconds since the last frame.
  void sync(const InputState& input, float dt);

  ControlsView view() const;

 private:
  struct Button {
    const char* name = "";
    const char* label = "";
    uint32_t color = 0;
    bool shown = false;  // part of this game's controls
    bool active = false;
    bool pressed = false;  // drawn pressed: a finger or any device holds it
    float alpha = 0;
    std::set<int64_t> fingers;
  };
  struct Stick {
    bool enabled = false;
    bool active = false;
    float alpha = 0;
    std::optional<int64_t> finger;
    Vec2 offset;  // knob offset from the center, reference px
  };

  // Geometry in reference px, from the screen, the scale and the shown buttons.
  float px(float points) const { return points / screen_.points_per_ref; }
  Circle stick_base(bool look) const;
  std::array<std::optional<Circle>, 3> button_circles() const;  // nullopt = not shown
  float stick_hit_radius() const { return px((layout_.stick / 2 + 22) * scale_); }
  float button_hit_radius(const Circle& c) const { return c.radius + px(14 * scale_); }
  float stick_max_offset() const { return px(layout_.stick * 0.42f * scale_); }

  void move_stick(Stick& s, Vec2 p, bool look, InputState& input);

  TouchLayout layout_;
  ControlsScreen screen_;
  float scale_ = 1;
  float lift_ = 0;  // buttons move up above the aim stick in twin-stick games
  bool dimmed_ = false;
  Stick stick_;
  Stick look_;
  std::array<Button, 3> buttons_;
};

}  // namespace dreamsy::input
