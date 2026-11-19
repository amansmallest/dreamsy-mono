// ui.toast: short messages near the top of the screen (engine-web Game.toasts).
//
// Toasts live in game time (scaled by the time scale, frozen while paused), like engine-web:
// the TOAST op pushes one that lasts `seconds` (default 2), and the host expires them at the end
// of every tick. At most 4 are shown; a fifth pushes the oldest out. ui/overlay.h draws them.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace dreamsy::ui {

inline constexpr size_t kMaxToasts = 4;
inline constexpr double kDefaultToastSeconds = 2;

struct Toast {
  int64_t id = 0;
  std::string text;
  double until = 0;  // game time when it disappears
};

class ToastQueue {
 public:
  // A new toast visible until `now + seconds`. `id` must be unique (the host's id counter).
  void push(int64_t id, std::string text, double now, double seconds = kDefaultToastSeconds);
  // Drops the toasts whose time is up (until <= now). Call at the end of every tick.
  void expire(double now);
  void clear() { toasts_.clear(); }

  // Oldest first (drawn top to bottom).
  const std::vector<Toast>& toasts() const { return toasts_; }

 private:
  std::vector<Toast> toasts_;
};

}  // namespace dreamsy::ui
