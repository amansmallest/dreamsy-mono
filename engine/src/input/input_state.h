// What scripts see of the player's input, one simulation tick at a time.
//
// Port of engine-web core/input.ts (InputState) plus the pointer/gesture part of core/game.ts
// (pointerDown / pointerUp / swipe). Everything here is deterministic and platform-free: the
// platform layer (keyboard.h, touch_controls.h, the sokol adapter) calls set_axis / set_button /
// pointer_*, and the script host reads axis / pressed / held / pointer for the Luau ops
// AXIS / PRESSED / HELD / POINTER.
//
// Names are strings, as in engine-web: the standard ones are the axes move_x, move_y, look_x,
// look_y and the buttons jump, action, action2, but kits read inputs through config tables, so any
// name works (it just never becomes true unless something sets it).
//
// Timing (same as engine-web):
//   - Button edges collected between two ticks become visible to pressed() for exactly one tick,
//     the tick after them. A press and release between two ticks still counts as pressed.
//   - held() is live: it reflects the button right now.
//   - The pointer stays visible for one more tick after it lifts, so a tap shorter than a frame is
//     still seen by onTick (the "1-tick grace").
//   - While `blocked` (a blocking ui.dialog is open) scripts see no input at all: axes read 0,
//     buttons false. Reads still count for recently_read() (the touch controls stay up, dimmed).
#pragma once

#include <cstdint>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <string_view>

namespace dreamsy::input {

// A point in reference (UI) pixels: 720x1280 portrait, 1280x720 landscape, (0,0) top-left.
struct Vec2 {
  float x = 0;
  float y = 0;
};

// The fixed simulation step (DREAMSY.MD §14.4): 60 Hz.
inline constexpr double kTickDt = 1.0 / 60.0;

// Swipe thresholds (engine-web core/game.ts SWIPE_MIN_DIST / SWIPE_MAX_TIME).
inline constexpr double kSwipeMinDistance = 40;  // reference px
inline constexpr double kSwipeMaxTime = 0.6;     // seconds

// input.recentlyRead window (engine-web: 45 ticks = 0.75 s).
inline constexpr int64_t kRecentlyReadTicks = 45;

enum class SwipeDir : uint8_t { Left, Right, Up, Down };
const char* swipe_dir_name(SwipeDir dir);  // "left" | "right" | "up" | "down" (the Luau strings)

// A finished swipe, for the input.swipe signal: direction and velocity in px/s.
struct Swipe {
  SwipeDir dir = SwipeDir::Right;
  Vec2 velocity;
};

class InputState {
 public:
  // ---- written by the platform (keyboard, touch controls, gamepad, harness) ----

  // Clamped to -1..1.
  void set_axis(std::string_view name, double value);
  // A press while up records an edge (seen by pressed() next tick).
  void set_button(std::string_view name, bool down);
  // Press and release within one tick: still registers as pressed (harness `press`).
  void tap(std::string_view name);

  // Pointer events in reference px. Call them as events arrive, not once per tick, and fire
  // the matching Luau signal right away (input.pointerDown / pointerUp / swipe) so a flick
  // shorter than a frame is never lost. `time` is the event time in seconds; leave it out to use
  // tick x kTickDt (engine-web does, for browser events). Swipe velocity uses at least one tick.
  void pointer_down(Vec2 p, std::optional<double> time = std::nullopt);
  void pointer_move(Vec2 p);  // only while a pointer is down
  // Returns the swipe when the gesture was >= 40 px within 0.6 s.
  std::optional<Swipe> pointer_up(Vec2 p, std::optional<double> time = std::nullopt);
  // Headless tap (engine-web Game.tapScreen): the pointer stays visible for `ticks` more ticks.
  void hold_pointer(Vec2 p, int ticks);

  // ---- called by the simulation ----

  // At the start of every tick, before any script runs: advances the tick counter, makes the
  // edges since the last tick visible to pressed(), and ends the pointer grace period.
  void begin_tick();
  // Forget everything (scene reload, focus lost).
  void reset();

  // A blocking dialog is open: scripts see no input. Set by ui::DialogSystem::step.
  bool blocked = false;

  // ---- read by scripts (count as reads) ----

  double axis(std::string_view name);
  bool held(std::string_view name);
  bool pressed(std::string_view name);
  // input.pointer(): reference px while touching (and one tick after), else nullopt. Not a
  // "read" for the controls, and not blocked (engine-web returns it even under a dialog).
  std::optional<Vec2> pointer() const { return pointer_; }

  // ---- engine-side reads (do not count as script reads, ignore `blocked`) ----

  double raw_axis(std::string_view name) const;
  bool raw_held(std::string_view name) const;
  bool raw_pressed(std::string_view name) const;

  // True if scripts read `name` within the last `ticks` ticks (touch controls show only then).
  bool recently_read(std::string_view name, int64_t ticks = kRecentlyReadTicks) const;
  // True if scripts ever read `name` (a button kits read through config shows up on first read).
  bool ever_read(std::string_view name) const { return last_read_.find(name) != last_read_.end(); }

  int64_t tick() const { return tick_; }
  bool gesture_active() const { return gesture_.has_value(); }

 private:
  void note_read(std::string_view name);

  // std::map / std::set with std::less<> so lookups by string_view don't allocate a string.
  std::map<std::string, double, std::less<>> axes_;
  std::set<std::string, std::less<>> down_;
  std::set<std::string, std::less<>> edges_;       // edges since the last tick
  std::set<std::string, std::less<>> tick_edges_;  // edges visible during this tick
  std::map<std::string, int64_t, std::less<>> last_read_;
  int64_t tick_ = 0;

  // Pointer + the gesture in progress (pointer_down -> pointer_up).
  struct Gesture {
    Vec2 start;
    double time = 0;
  };
  std::optional<Vec2> pointer_;
  int64_t pointer_clear_tick_ = -1;  // begin_tick() hides the pointer when tick_ reaches this
  std::optional<Gesture> gesture_;
};

}  // namespace dreamsy::input
