#include "world/tween.h"

#include <algorithm>
#include <cmath>
#include <numbers>

namespace dreamsy::world {

namespace {

constexpr double kPi = std::numbers::pi;
constexpr double c1 = 1.70158, c2 = c1 * 1.525, c3 = c1 + 1;

// JS `x ** 2` / `x ** 3` call pow(), which can round differently from x * x * x; use pow too.
double sq(double x) { return std::pow(x, 2.0); }
double cube(double x) { return std::pow(x, 3.0); }

double bounce_out(double t) {
  const double n1 = 7.5625, d1 = 2.75;
  if (t < 1 / d1) return n1 * t * t;
  if (t < 2 / d1) {
    t -= 1.5 / d1;
    return n1 * t * t + 0.75;
  }
  if (t < 2.5 / d1) {
    t -= 2.25 / d1;
    return n1 * t * t + 0.9375;
  }
  t -= 2.625 / d1;
  return n1 * t * t + 0.984375;
}

struct NamedEasing {
  std::string_view name;
  Easing fn;
};

// Same order as tween.ts EASINGS (error messages list them in this order).
const NamedEasing kEasings[] = {
    {"linear", [](double t) { return t; }},
    {"quad_in", [](double t) { return t * t; }},
    {"quad_out", [](double t) { return 1 - (1 - t) * (1 - t); }},
    {"quad_in_out", [](double t) { return t < 0.5 ? 2 * t * t : 1 - sq(-2 * t + 2) / 2; }},
    {"cubic_in", [](double t) { return t * t * t; }},
    {"cubic_out", [](double t) { return 1 - cube(1 - t); }},
    {"cubic_in_out", [](double t) { return t < 0.5 ? 4 * t * t * t : 1 - cube(-2 * t + 2) / 2; }},
    {"sine_in", [](double t) { return 1 - std::cos((t * kPi) / 2); }},
    {"sine_out", [](double t) { return std::sin((t * kPi) / 2); }},
    {"sine_in_out", [](double t) { return -(std::cos(kPi * t) - 1) / 2; }},
    {"expo_in", [](double t) { return t == 0 ? 0.0 : std::pow(2.0, 10 * t - 10); }},
    {"expo_out", [](double t) { return t == 1 ? 1.0 : 1 - std::pow(2.0, -10 * t); }},
    {"back_in", [](double t) { return c3 * t * t * t - c1 * t * t; }},
    {"back_out", [](double t) { return 1 + c3 * cube(t - 1) + c1 * sq(t - 1); }},
    {"back_in_out",
     [](double t) {
       return t < 0.5 ? (sq(2 * t) * ((c2 + 1) * 2 * t - c2)) / 2 : (sq(2 * t - 2) * ((c2 + 1) * (t * 2 - 2) + c2) + 2) / 2;
     }},
    {"elastic_out",
     [](double t) {
       return t == 0 || t == 1 ? t : std::pow(2.0, -10 * t) * std::sin((t * 10 - 0.75) * ((2 * kPi) / 3)) + 1;
     }},
    {"bounce_out", bounce_out},
};

}  // namespace

Easing find_easing(std::string_view name) {
  for (const NamedEasing& e : kEasings)
    if (e.name == name) return e.fn;
  return nullptr;
}

const std::vector<std::string_view>& easing_names() {
  static const std::vector<std::string_view> names = [] {
    std::vector<std::string_view> out;
    for (const NamedEasing& e : kEasings) out.push_back(e.name);
    return out;
  }();
  return names;
}

TweenProgress tween_progress(const Tween& tw) {
  const double local = tw.t - tw.delay;
  if (local < 0) return {-1, false};
  const double d = std::max(1e-6, tw.duration);
  if (!tw.loop) {
    if (!tw.yoyo) {
      const double p = std::min(1.0, local / d);
      return {p >= 1 ? 1 : tw.ease(p), p >= 1};
    }
    // yoyo once: there (duration) and back (duration)
    const double p = std::min(1.0, local / (2 * d));
    return {p >= 1 ? 0 : tw.ease(p < 0.5 ? p * 2 : (1 - p) * 2), p >= 1};
  }
  const double cycle = tw.yoyo ? 2 * d : d;
  const double ph = std::fmod(local, cycle);  // JS % on positive numbers
  const double p = tw.yoyo ? (ph < d ? ph / d : 2 - ph / d) : ph / d;
  return {tw.ease(p), false};
}

Value track_value(const TweenTrack& tr, double k) {
  double out[4] = {0, 0, 0, 0};
  for (size_t i = 0; i < tr.from.size() && i < 4; ++i) out[i] = tr.from[i] + (tr.to[i] - tr.from[i]) * k;
  switch (tr.kind) {
    case TweenTrack::Kind::Number: return Value::number(out[0]);
    case TweenTrack::Kind::Vec2: return Value::vec(out[0], out[1]);
    case TweenTrack::Kind::Color:
      for (double& x : out) x = std::clamp(x, 0.0, 1.0);
      return Value::color(out[0], out[1], out[2], out[3]);
  }
  return Value::number(out[0]);
}

}  // namespace dreamsy::world
