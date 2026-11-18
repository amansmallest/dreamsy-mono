#include "input/keyboard.h"

namespace dreamsy::input {

void KeyboardMapper::key_down(Key key, InputState& input) {
  if (key == Key::Other) return;
  down_.insert(key);
  apply(input);
}

void KeyboardMapper::key_up(Key key, InputState& input) {
  if (key == Key::Other) return;
  down_.erase(key);
  apply(input);
}

void KeyboardMapper::blur(InputState& input) {
  down_.clear();
  apply(input);
}

bool KeyboardMapper::any(std::initializer_list<Key> keys) const {
  for (Key k : keys) {
    if (down_.count(k)) return true;
  }
  return false;
}

void KeyboardMapper::apply(InputState& input) const {
  const int x = (any({Key::Right, Key::D}) ? 1 : 0) - (any({Key::Left, Key::A}) ? 1 : 0);
  const int y = (any({Key::Down, Key::S}) ? 1 : 0) - (any({Key::Up, Key::W}) ? 1 : 0);
  input.set_axis("move_x", x);
  input.set_axis("move_y", y);
  input.set_button("jump", any({Key::Space, Key::Z}) || (up_jumps_ && any({Key::Up, Key::W})));
  input.set_button("action", any({Key::E, Key::J, Key::Enter, Key::X}));
  input.set_button("action2", any({Key::Q, Key::K, Key::C}));
}

}  // namespace dreamsy::input
