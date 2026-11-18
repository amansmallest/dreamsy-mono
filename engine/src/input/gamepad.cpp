#include "input/gamepad.h"

#include <cmath>

namespace dreamsy::input {

namespace {

// Radial dead zone, rescaled so the edge of the zone reads 0 (no jump in speed).
void dead_zone(float& x, float& y) {
  const float len = std::sqrt(x * x + y * y);
  if (len < kGamepadDeadZone) {
    x = y = 0;
    return;
  }
  const float k = std::fmin(1.0f, (len - kGamepadDeadZone) / (1 - kGamepadDeadZone)) / len;
  x *= k;
  y *= k;
}

}  // namespace

void GamepadMapper::update(const GamepadState& pad, InputState& input) {
  std::array<float, 4> axes{};
  std::array<bool, 3> buttons{};
  if (pad.connected) {
    float mx = pad.left_x, my = pad.left_y, lx = pad.right_x, ly = pad.right_y;
    dead_zone(mx, my);
    dead_zone(lx, ly);
    if (pad.dpad_left || pad.dpad_right) mx = (pad.dpad_right ? 1.0f : 0.0f) - (pad.dpad_left ? 1.0f : 0.0f);
    if (pad.dpad_up || pad.dpad_down) my = (pad.dpad_down ? 1.0f : 0.0f) - (pad.dpad_up ? 1.0f : 0.0f);
    axes = {mx, my, lx, ly};
    buttons = {pad.a, pad.b || pad.x, pad.y};
  }
  static constexpr const char* kAxes[] = {"move_x", "move_y", "look_x", "look_y"};
  static constexpr const char* kButtons[] = {"jump", "action", "action2"};
  for (size_t i = 0; i < axes.size(); i++) {
    if (axes[i] != axes_[i]) input.set_axis(kAxes[i], axes[i]);
  }
  for (size_t i = 0; i < buttons.size(); i++) {
    if (buttons[i] != buttons_[i]) input.set_button(kButtons[i], buttons[i]);
  }
  axes_ = axes;
  buttons_ = buttons;
}

}  // namespace dreamsy::input
