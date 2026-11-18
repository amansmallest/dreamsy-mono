#include "input/input_state.h"

#include <algorithm>
#include <cmath>

namespace dreamsy::input {

const char* swipe_dir_name(SwipeDir dir) {
  switch (dir) {
    case SwipeDir::Left: return "left";
    case SwipeDir::Right: return "right";
    case SwipeDir::Up: return "up";
    case SwipeDir::Down: return "down";
  }
  return "right";
}

// ---------------------------------------------------------------- platform side

void InputState::set_axis(std::string_view name, double value) {
  const double clamped = std::max(-1.0, std::min(1.0, value));
  auto it = axes_.find(name);
  if (it != axes_.end()) {
    it->second = clamped;
  } else {
    axes_.emplace(std::string(name), clamped);
  }
}

void InputState::set_button(std::string_view name, bool down) {
  const bool was_down = down_.find(name) != down_.end();
  if (down && !was_down) {
    edges_.emplace(name);
    down_.emplace(name);
  } else if (!down && was_down) {
    down_.erase(down_.find(name));
  }
}

void InputState::tap(std::string_view name) { edges_.emplace(name); }

void InputState::pointer_down(Vec2 p, std::optional<double> time) {
  pointer_ = p;
  pointer_clear_tick_ = -1;  // touching again cancels a pending grace-period clear
  gesture_ = Gesture{p, time.value_or(static_cast<double>(tick_) * kTickDt)};
}

void InputState::pointer_move(Vec2 p) {
  if (gesture_) pointer_ = p;
}

std::optional<Swipe> InputState::pointer_up(Vec2 p, std::optional<double> time) {
  const std::optional<Gesture> g = gesture_;
  gesture_.reset();
  pointer_ = p;
  // Keep input.pointer() visible during the next tick, even if down + up both happened between
  // two ticks: begin_tick() of tick N+1 keeps it, N+2 clears it.
  pointer_clear_tick_ = tick_ + 2;
  if (!g) return std::nullopt;

  const double dx = static_cast<double>(p.x) - g->start.x;
  const double dy = static_cast<double>(p.y) - g->start.y;
  const double dist = std::hypot(dx, dy);
  const double now = time.value_or(static_cast<double>(tick_) * kTickDt);
  const double dt = std::max(kTickDt, now - g->time);
  if (dist < kSwipeMinDistance || dt > kSwipeMaxTime) return std::nullopt;

  Swipe s;
  if (std::abs(dx) >= std::abs(dy)) {
    s.dir = dx > 0 ? SwipeDir::Right : SwipeDir::Left;
  } else {
    s.dir = dy > 0 ? SwipeDir::Down : SwipeDir::Up;
  }
  s.velocity = {static_cast<float>(dx / dt), static_cast<float>(dy / dt)};
  return s;
}

void InputState::hold_pointer(Vec2 p, int ticks) {
  pointer_ = p;
  pointer_clear_tick_ = tick_ + ticks + 1;
}

// ---------------------------------------------------------------- simulation side

void InputState::begin_tick() {
  tick_++;
  tick_edges_ = std::move(edges_);
  edges_.clear();  // a moved-from set is valid but unspecified; make it empty
  if (pointer_clear_tick_ == tick_) {
    pointer_.reset();
    pointer_clear_tick_ = -1;
  }
}

void InputState::reset() {
  axes_.clear();
  down_.clear();
  edges_.clear();
  tick_edges_.clear();
  pointer_.reset();
  pointer_clear_tick_ = -1;
  gesture_.reset();
}

// ---------------------------------------------------------------- reads

void InputState::note_read(std::string_view name) {
  auto it = last_read_.find(name);
  if (it != last_read_.end()) {
    it->second = tick_;
  } else {
    last_read_.emplace(std::string(name), tick_);
  }
}

double InputState::axis(std::string_view name) {
  note_read(name);
  return blocked ? 0 : raw_axis(name);
}

bool InputState::held(std::string_view name) {
  note_read(name);
  return !blocked && raw_held(name);
}

bool InputState::pressed(std::string_view name) {
  note_read(name);
  return !blocked && raw_pressed(name);
}

double InputState::raw_axis(std::string_view name) const {
  auto it = axes_.find(name);
  return it == axes_.end() ? 0 : it->second;
}

bool InputState::raw_held(std::string_view name) const { return down_.find(name) != down_.end(); }

bool InputState::raw_pressed(std::string_view name) const { return tick_edges_.find(name) != tick_edges_.end(); }

bool InputState::recently_read(std::string_view name, int64_t ticks) const {
  auto it = last_read_.find(name);
  return it != last_read_.end() && tick_ - it->second <= ticks;
}

}  // namespace dreamsy::input
