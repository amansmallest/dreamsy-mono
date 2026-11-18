// The platform pause menu (engine-web render/shell.ts), drawn by the engine like the rest of the
// overlay. Games never build their own pause or settings UI (format/LUAU_API.md).
//
//   Paused       Resume, Restart, Leaderboard (games that use leaderboards), Settings, Controls, Quit
//   Settings     Music and Sound effects sliders, Mute all, Vibration, Touch controls size, Back
//   Controls     what each action is on the keyboard and on the touch screen, Back
//   Leaderboard  this device's results per board (tabs when there are several), Back
//
// Sizes are engine-web's CSS px ("points"), converted to reference px with points_per_ref, so the
// menu has the same physical size on every screen. It is centered in the window (letterbox bars
// included), like engine-web's overlay over the whole container.
//
// One function lays the menu out (layout_shell), and both drawing and hit testing use it, so what
// you see is what you tap. The menu only edits ShellData; the platform layer applies the result
// (host settings, touch-control size, resume, restart, quit).
#pragma once

#include <string>
#include <vector>

#include "input/usage.h"
#include "ui/layout.h"
#include "ui/overlay.h"

namespace dreamsy::ui {

enum class ShellView : uint8_t { Main, Settings, Controls, Leaderboard };

// The settings the menu edits (engine-web Settings; touch_size is the touch-control scale).
struct ShellSettings {
  double music = 0.7, sfx = 0.9;
  bool mute = false, vibration = true;
  float touch_size = 1;
};

// One finished run or submitted value on this device (the Leaderboard view).
struct LocalScore {
  std::string board;
  double value = 0;
  bool ascending = false;  // "asc": lower is better (times)
};

// What the menu shows. The platform layer fills it; the menu edits `settings`.
struct ShellData {
  ShellSettings settings;
  input::InputUsage usage;          // which rows the Controls view lists
  std::vector<std::string> boards;  // leaderboard boards of this game (empty: no Leaderboard button)
  std::vector<LocalScore> scores;
};

// What a tap asks the platform layer to do.
enum class ShellAction : uint8_t { None, Resume, Restart, Quit, SettingsChanged };

// One laid-out piece of the menu.
struct ShellItem {
  enum class Kind : uint8_t { Title, Button, Slider, Toggle, Choice, Text, Tab };
  Kind kind = Kind::Text;
  Rect rect;            // the whole row / button / cell
  Rect control;         // Slider: the track; Toggle: the switch; Choice: option i is `options[i]`
  std::vector<Rect> options;
  std::string text;     // label (already upper-cased for pixel themes where engine-web does)
  int id = 0;           // which button / setting (shell.cpp)
  bool primary = false; // primary button; selected tab
  float size = 15;      // text size, points converted to reference px
  float opacity = 1;    // Text: color alpha
  render::TextAlign align = render::TextAlign::Left;
  bool accent = false;  // Text: accent color, bold label column
};

struct ShellLayout {
  Rect window;  // dimmed
  Rect panel;
  std::vector<ShellItem> items;
};

class PauseShell {
 public:
  ShellView view() const { return view_; }
  // Opens on the main view.
  void open();
  // Esc / P while open: a sub-view goes back to the main view; returns false on the main view
  // (the caller closes the menu).
  bool back();

  ShellLayout layout(const OverlayContext& ctx, const ShellData& data) const;
  void draw(OverlayContext& ctx, const ShellData& data) const;

  // Pointer events while the menu is open (reference px). A tap outside the panel resumes.
  enum class Phase : uint8_t { Down, Move, Up };
  ShellAction pointer(Phase phase, double x, double y, const OverlayContext& ctx, ShellData& data);

 private:
  ShellView view_ = ShellView::Main;
  std::string board_;   // Leaderboard view: the board shown
  int dragging_ = -1;   // id of the slider a finger is dragging, -1 = none
};

// "track_3" -> "Track 3" (engine-web boardLabel).
std::string board_label(const std::string& board);
// engine-web formatBoardValue: times (asc) as m:ss.cc, scores as integers or with 2 decimals.
std::string format_board_value(double value, bool ascending);

}  // namespace dreamsy::ui
