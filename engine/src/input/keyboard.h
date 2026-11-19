// Keyboard -> actions (engine-web input/index.ts KeyboardInput).
//
//   move_x / move_y   arrows or WASD (move_y is +1 for down)
//   jump              Space, Z, and Up/W in games that never read move_y (platformers)
//   action            E, J, Enter, X
//   action2           Q, K, C
//
// The platform layer translates its key codes into Key (input/sokol_events.h does it for
// sokol_app) and calls key_down / key_up; the mapper writes the axes and buttons into InputState
// after every change, exactly like engine-web's apply().
#pragma once

#include <cstdint>
#include <set>

#include "input/input_state.h"

namespace dreamsy::input {

// The keys the engine maps. Anything else is Other (ignored).
enum class Key : uint8_t {
  Other,
  Left, Right, Up, Down,
  A, C, D, E, J, K, Q, S, W, X, Z,
  Space, Enter, Escape, P,
};

class KeyboardMapper {
 public:
  // `up_jumps`: Up/W also press jump. engine-web turns this on when no script mentions
  // "move_y" (scan the scripts with usage.h scripts_mention_move_y()).
  explicit KeyboardMapper(bool up_jumps = true) : up_jumps_(up_jumps) {}

  void key_down(Key key, InputState& input);
  void key_up(Key key, InputState& input);
  // Window lost focus: every key counts as released.
  void blur(InputState& input);

  bool is_down(Key key) const { return down_.count(key) > 0; }

 private:
  void apply(InputState& input) const;
  bool any(std::initializer_list<Key> keys) const;

  bool up_jumps_;
  std::set<Key> down_;
};

}  // namespace dreamsy::input
