// ui.dialog / ui.choice state machine (deterministic, stepped by the tick). A port of
// engine-web/core/dialog.ts. The renderer (E4) draws `current`.
#pragma once

#include <cstdint>
#include <deque>
#include <optional>
#include <string>
#include <vector>

namespace dreamsy::script {

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
  double shown = 0;  // characters revealed in the current line (typewriter)
  double speed = 40; // characters per second; 0 = instant
  std::vector<std::string> options;
  int selected = 0;
  bool top = false;  // position "top" (else "bottom")
  bool blocking = true;
};

struct DialogInput {
  bool confirm = false;          // jump/action pressed this tick
  int nav = 0;                   // -1 up, +1 down, 0 none (edge)
  std::optional<int> tap;        // option index, -1 = the box
};

struct DialogDone {
  int64_t id = 0;
  int choice = -1;  // 0-based option, -1 for plain dialogs
};

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

 private:
  DialogDone finish(int choice);
};

}  // namespace dreamsy::script
