// Gamepad -> actions. engine-web has no gamepad support; this is the hook the platform layer
// calls once per frame with a polled pad (the W3C "standard" layout: Gamepad API on the web,
// GameController on iOS, Android input later). Polling itself is not wired yet (see README).
//
//   left stick / d-pad   move_x, move_y (radial dead zone 0.2)
//   right stick          look_x, look_y (dead zone 0.2)
//   A (bottom)           jump
//   B (right), X (left)  action
//   Y (top)              action2
//
// The mapper only writes when the pad's values change, so an idle pad never overrides the
// keyboard or the touch controls (all of them write the same InputState, last writer wins).
#pragma once

#include <array>

#include "input/input_state.h"

namespace dreamsy::input {

struct GamepadState {
  bool connected = false;
  float left_x = 0, left_y = 0;    // -1..1, y down
  float right_x = 0, right_y = 0;  // -1..1, y down
  bool dpad_left = false, dpad_right = false, dpad_up = false, dpad_down = false;
  bool a = false, b = false, x = false, y = false;
  bool start = false;  // opens the pause menu (the shell reads it)
};

inline constexpr float kGamepadDeadZone = 0.2f;

class GamepadMapper {
 public:
  void update(const GamepadState& pad, InputState& input);

 private:
  // Last written values: move_x, move_y, look_x, look_y, jump, action, action2.
  std::array<float, 4> axes_{};
  std::array<bool, 3> buttons_{};
};

}  // namespace dreamsy::input
