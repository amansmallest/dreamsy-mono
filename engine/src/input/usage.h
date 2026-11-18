// Which controls a game reads, found by scanning its script source (engine-web input/index.ts
// detectInputUsage). Phones show only those: input.axis("move_...") -> the joystick,
// input.axis("look_...") -> the aim stick, input.pressed/held("jump" | "action" | "action2") ->
// the A/B/C buttons. Kits read buttons through config tables (`input.pressed(b.jump)`), which a
// scan can't see; those buttons appear the first time the game reads them (touch_controls.h).
#pragma once

#include <set>
#include <string>
#include <string_view>

namespace dreamsy::input {

struct InputUsage {
  bool move = false;
  bool look = false;
  std::set<std::string> buttons;  // names in input.pressed("...") / input.held("...")

  bool any() const { return move || look || !buttons.empty(); }
};

// `source`: every script of the game, plus the sources of the kits it requires (the caller
// concatenates them, as engine-web does).
InputUsage detect_input_usage(std::string_view source);

// engine-web KeyboardInput: Up/W also jump unless the game's own scripts (not kits) contain "move_y".
bool scripts_mention_move_y(std::string_view game_scripts);

}  // namespace dreamsy::input
