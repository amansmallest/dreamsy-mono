// Tweens: animate entity props over time, advanced by the fixed tick. A port of
// engine-web/core/tween.ts (same easings, same progress rules).
#pragma once

#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

#include "world/world.h"

namespace dreamsy::world {

using Easing = double (*)(double);

// nullptr for unknown names. Names: linear, quad_in, quad_out, ... (tween.ts EASINGS).
Easing find_easing(std::string_view name);
const std::vector<std::string_view>& easing_names();
inline constexpr std::string_view kDefaultEasing = "quad_out";

struct TweenTrack {
  enum class Kind { Number, Vec2, Color };
  std::string key;
  Kind kind = Kind::Number;
  std::vector<double> from, to;
};

struct Tween {
  int64_t id = 0;
  EntityId entity;
  std::vector<TweenTrack> tracks;
  double duration = 0;
  double delay = 0;
  double t = 0;  // seconds since creation
  Easing ease = nullptr;
  bool loop = false;
  bool yoyo = false;
};

// Eased progress at the tween's current time; k < 0 = still in its delay.
struct TweenProgress {
  double k = 0;
  bool finished = false;
};
TweenProgress tween_progress(const Tween& tw);
// The track's value at progress k (colors clamp to 0..1; numbers and vectors may overshoot).
Value track_value(const TweenTrack& tr, double k);

}  // namespace dreamsy::world
