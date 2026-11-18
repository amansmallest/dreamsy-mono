// The platform layer between devices and a running game: input routing, the on-screen controls,
// the game's UI entities, toasts, dialogs and the pause button.
//
// The player translates its window events (sokol_app) into the calls below and draws with draw()
// after play::draw_world(). Per frame:
//
//   ui.set_screen(...)                 window size changed (points per reference px, safe area)
//   ui.key(...) / ui.pointer(...) ...  as events arrive (between ticks)
//   if (!ui.paused()) host.step() ...  the fixed 60 Hz ticks
//   ui.update(dt)                      controls visibility, fades
//   play::draw_world(...); ui.draw(...)
//
// Pointer routing, topmost first (engine-web's DOM stacking): the pause button (and the pause
// overlay while paused), the touch controls, then the game: input.pointerDown fires for every
// other touch, then the open dialog takes the tap, else the topmost UI element (UIButton.pressed +
// tapped; buttons inside scroll lists fire on release so drags scroll), else the world
// (tapped / tileTapped / tappedAt).
#pragma once

#include <functional>
#include <memory>
#include <optional>
#include <string>

#include "input/gamepad.h"
#include "input/keyboard.h"
#include "input/touch_controls.h"
#include "render/draw_list.h"
#include "render/font.h"
#include "render/textures.h"
#include "script/host.h"
#include "ui/layout.h"
#include "ui/overlay.h"
#include "ui/shell.h"

namespace dreamsy::play {

enum class PointerPhase : uint8_t { Down, Move, Up, Cancel };

// The mouse uses this finger id.
inline constexpr int64_t kMousePointerId = -1;

class PlatformUi {
 public:
  // `usage`: what the game's scripts read (input/usage.h; scan the game's and its kits' sources).
  // `touch_controls`: show on-screen controls (touch devices; or forced for testing with a mouse).
  PlatformUi(script::Host& host, render::TextureStore& textures, const render::FontStore& fonts,
             const input::InputUsage& usage, bool up_jumps, bool touch_controls);

  // Generates the overlay's images. Call once before draw().
  Status init();

  // The window: layout points per reference px (CSS px per game px on the web; framebuffer px per
  // reference px / dpi scale natively), the safe area inside the game rect, and the whole window in
  // reference px (letterbox bars included; the pause button, menu and touch controls go there).
  void set_screen(float points_per_ref, ui::SafeArea safe, ui::Rect window = {});
  // Touch-control size setting (0.75..1.5).
  void set_touch_scale(float scale) { controls_.set_scale(scale); }
  bool touch_controls_enabled() const { return touch_enabled_; }
  void set_touch_controls(bool on) { touch_enabled_ = on; }

  // ---- events (reference px)
  void key(input::Key key, bool down);
  void blur();  // focus lost: keys and fingers released
  void pointer(PointerPhase phase, int64_t id, input::Vec2 p);
  void wheel(input::Vec2 p, float dy);  // scroll lists; dy > 0 scrolls down
  void gamepad(const input::GamepadState& pad);

  // ---- per frame
  void update(float dt);
  void draw(render::DrawList& out);

  bool paused() const { return host_.paused(); }

  // The pause menu's Quit: the player decides what quitting means (close the app, go back).
  std::function<void()> on_quit;
  // Settings changed in the pause menu (already applied to the host and the controls), to persist.
  std::function<void(const ui::ShellSettings&)> on_settings;
  // Settings loaded by the player at start (applied to the host and the controls).
  void set_settings(const ui::ShellSettings& s);

  // The laid-out UI of the last update() (tests, tools).
  const std::vector<ui::UiNode>& ui_nodes() const { return nodes_; }

 private:
  ui::UiScreen screen() const;
  void relayout();
  void tap_game(int64_t id, input::Vec2 p);
  void open_pause();
  void close_pause();
  ui::ShellData shell_data() const;
  void apply(ui::ShellAction action, const ui::ShellData& data);

  script::Host& host_;
  render::TextureStore& textures_;
  const render::FontStore& fonts_;
  ui::UiTheme theme_;
  ui::UiImages images_;
  input::KeyboardMapper keyboard_;
  input::GamepadMapper gamepad_;
  input::TouchControls controls_;
  bool touch_enabled_;
  bool gamepad_start_ = false;

  float points_per_ref_ = 1;
  ui::SafeArea safe_;
  ui::Rect window_;
  input::InputUsage usage_;
  std::vector<std::string> boards_;  // leaderboard boards named in the scripts
  float touch_size_ = 1;
  ui::PauseShell shell_;
  std::set<int64_t> shell_fingers_;  // fingers on the open pause menu (slider drags)
  ui::ScrollOffsets scroll_;
  std::vector<ui::UiNode> nodes_;

  // Fingers that belong to the game (not the controls / pause button), and a pending scroll drag
  // or deferred button press per finger.
  struct GameTouch {
    input::Vec2 start;
    input::Vec2 last;
    world::EntityId scroll_panel;  // a scroll list under the finger (drag scrolls it)
    world::EntityId deferred;      // a button inside a scroll list: pressed on release if no drag
    bool dragged = false;
  };
  std::map<int64_t, GameTouch> touches_;
  std::set<int64_t> swallowed_;  // fingers taken by the controls or the pause button
};

}  // namespace dreamsy::play
