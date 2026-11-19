// ui.dialog / ui.choice: the dialog queue and its state machine (deterministic, stepped by the
// tick). A port of engine-web/core/dialog.ts plus Game.stepDialogs / dialogTap (core/game.ts).
//
// The script host owns one DialogSystem: the DIALOG op opens and closes dialogs, step() runs once
// per tick (after input.begin_tick, before timers) and returns a finished dialog for the host to
// fire Dialog.done with. ui/overlay.h draws `current` and hit-tests taps on it.
//
//   Players advance with a tap anywhere, or jump/action: the first press finishes the typewriter,
//   the next shows the next line. Choices: tap an option, or up/down + jump/action. Dialogs opened
//   while one is showing queue up. A blocking dialog (the default) hides all input from scripts.
#pragma once

#include <cstdint>
#include <deque>
#include <optional>
#include <string>
#include <vector>

#include "input/input_state.h"

namespace dreamsy::ui {

struct DialogLine {
  std::string text;
  std::optional<std::string> speaker, portrait;
  size_t length = 0;  // text length in UTF-16 units (what engine-web's typewriter counts)
};

struct DialogState {
  int64_t id = 0;
  bool choice = false;  // "choice" (options) or "dialog"
  std::vector<DialogLine> lines;
  size_t index = 0;
  double shown = 0;   // characters (UTF-16 units) revealed in the current line (typewriter)
  double speed = 40;  // characters per second; 0 = instant
  std::vector<std::string> options;
  int selected = 0;
  bool top = false;  // position "top" (else "bottom")
  bool blocking = true;
};

struct DialogInput {
  bool confirm = false;    // jump/action pressed this tick
  int nav = 0;             // -1 up, +1 down, 0 none (edge)
  std::optional<int> tap;  // option index, -1 = the box
};

struct DialogDone {
  int64_t id = 0;
  int choice = -1;  // 0-based option, -1 for plain dialogs
};

// The queue and the per-dialog state machine (engine-web Dialogs).
class Dialogs {
 public:
  std::optional<DialogState> current;
  std::deque<DialogState> queue;

  void open(DialogState d);
  bool close(int64_t id);  // without firing; true if it was open or queued
  void clear() {
    current.reset();
    queue.clear();
  }
  std::optional<DialogDone> step(double dt, const DialogInput& in);

  // The current line is fully typed (or nothing is open).
  bool line_done() const;

 private:
  DialogDone finish(int choice);
};

// Dialogs + the input glue around them (engine-web Game.stepDialogs and dialogTap).
class DialogSystem {
 public:
  Dialogs dialogs;

  // A tap on the open dialog: an option index (0-based) for a choice option, -1 for the box.
  // Applied on the next step(). Ignored when no dialog is open.
  void tap(int option = -1) {
    if (dialogs.current) tap_ = option;
  }

  // Once per tick, right after input.begin_tick(). Reads jump/action/move_y raw (a blocking
  // dialog hides them from scripts, not from itself), advances the dialog, and sets
  // input.blocked. The tick a blocking dialog closes still swallows its confirm press.
  std::optional<DialogDone> step(input::InputState& input, double dt);

  bool open() const { return dialogs.current.has_value(); }
  void clear() { dialogs.clear(); }

 private:
  std::optional<int> tap_;
  int nav_prev_ = 0;  // last move_y direction, so holding up/down moves the selection once
};

}  // namespace dreamsy::ui
