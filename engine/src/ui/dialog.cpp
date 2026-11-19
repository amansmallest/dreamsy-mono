#include "ui/dialog.h"

#include <algorithm>
#include <cmath>

namespace dreamsy::ui {

void Dialogs::open(DialogState d) {
  if (current) queue.push_back(std::move(d));
  else current = std::move(d);
}

bool Dialogs::close(int64_t id) {
  if (current && current->id == id) {
    if (queue.empty()) current.reset();
    else {
      current = std::move(queue.front());
      queue.pop_front();
    }
    return true;
  }
  auto it = std::find_if(queue.begin(), queue.end(), [&](const DialogState& d) { return d.id == id; });
  if (it == queue.end()) return false;
  queue.erase(it);
  return true;
}

DialogDone Dialogs::finish(int choice) {
  DialogDone done{current->id, choice};
  if (queue.empty()) current.reset();
  else {
    current = std::move(queue.front());
    queue.pop_front();
  }
  return done;
}

bool Dialogs::line_done() const {
  return !current || current->shown >= static_cast<double>(current->lines[current->index].length);
}

std::optional<DialogDone> Dialogs::step(double dt, const DialogInput& in) {
  if (!current) return std::nullopt;
  DialogState& c = *current;
  const double len = static_cast<double>(c.lines[c.index].length);
  if (c.shown < len) c.shown = c.speed <= 0 ? len : std::min(len, c.shown + c.speed * dt);
  const bool typing = c.shown < len;
  const bool is_last = c.index >= c.lines.size() - 1;
  const int n_options = static_cast<int>(c.options.size());
  // choice: options are live once the prompt is fully shown
  if (c.choice && is_last && !typing) {
    if (in.nav) c.selected = ((c.selected + in.nav) % n_options + n_options) % n_options;
    if (in.tap && *in.tap >= 0 && *in.tap < n_options) return finish(*in.tap);
    if (in.confirm) return finish(c.selected);
    return std::nullopt;
  }
  if (in.tap && c.choice && *in.tap >= 0 && is_last) return finish(std::min(*in.tap, n_options - 1));
  if (!in.confirm && !in.tap) return std::nullopt;
  if (typing) {
    c.shown = len;
    return std::nullopt;
  }
  if (!is_last) {
    ++c.index;
    c.shown = 0;
    return std::nullopt;
  }
  return finish(-1);
}

std::optional<DialogDone> DialogSystem::step(input::InputState& input, double dt) {
  const bool was_blocking = dialogs.current && dialogs.current->blocking;
  std::optional<DialogDone> done;
  if (dialogs.current) {
    const double ny = input.raw_axis("move_y");
    const int dir = ny < -0.5 ? -1 : ny > 0.5 ? 1 : 0;
    DialogInput in;
    in.nav = dir != nav_prev_ ? dir : 0;  // an edge: only when the direction changes
    nav_prev_ = dir;
    in.confirm = input.raw_pressed("jump") || input.raw_pressed("action");
    in.tap = tap_;
    tap_.reset();
    done = dialogs.step(dt, in);
  } else {
    tap_.reset();
    nav_prev_ = 0;
  }
  input.blocked = was_blocking || (dialogs.current && dialogs.current->blocking);
  return done;
}

}  // namespace dreamsy::ui
