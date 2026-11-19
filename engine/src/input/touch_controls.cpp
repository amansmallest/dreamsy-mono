#include "input/touch_controls.h"

#include <algorithm>
#include <cmath>

namespace dreamsy::input {

namespace {

float distance(Vec2 a, Vec2 b) { return std::hypot(a.x - b.x, a.y - b.y); }

// Moves `alpha` toward 1 or 0 over 180 ms (engine-web: `transition: opacity 180ms`).
void fade(float& alpha, bool on, float dt) {
  const float step = dt / 0.18f;
  alpha = on ? std::min(1.0f, alpha + step) : std::max(0.0f, alpha - step);
}

}  // namespace

TouchLayout touch_layout(bool portrait) {
  // Portrait: thumbs low on the screen, above the home indicator; bigger targets.
  if (portrait) return {116, 48, 28, 40, {{{26, 52, 96}, {136, 30, 76}, {44, 166, 76}}}};
  return {100, 42, 28, 28, {{{26, 38, 88}, {124, 24, 68}, {42, 136, 68}}}};
}

Vec2 shape_stick(float x, float y) {
  const float len = std::hypot(x, y);
  if (len < kStickDeadZone) return {0, 0};
  const float k = std::min(1.0f, (len - kStickDeadZone) / (1 - kStickDeadZone)) / len;
  float ax = x * k, ay = y * k;
  if (std::abs(ay) < std::abs(ax) * 0.5f) {
    ay = 0;
  } else if (std::abs(ax) < std::abs(ay) * 0.5f) {
    ax = 0;
  }
  return {ax, ay};
}

TouchControls::TouchControls(InputUsage usage, bool portrait)
    : layout_(touch_layout(portrait)) {
  buttons_[0].name = "jump", buttons_[0].label = "A", buttons_[0].color = 0x3fb950;
  buttons_[1].name = "action", buttons_[1].label = "B", buttons_[1].color = 0xf0883e;
  buttons_[2].name = "action2", buttons_[2].label = "C", buttons_[2].color = 0x58a6ff;
  stick_.enabled = usage.move;
  look_.enabled = usage.look;
  for (Button& b : buttons_) b.shown = usage.buttons.count(b.name) > 0;
  lift_ = usage.look ? layout_.stick + 40 : 0;
}

void TouchControls::set_scale(float scale) { scale_ = std::clamp(scale, kMinTouchScale, kMaxTouchScale); }

// ---------------------------------------------------------------- geometry

// The joystick hangs from its bottom-left corner (aim stick: bottom-right), so the touch-size
// setting grows it toward the screen center and never moves its corner.
Circle TouchControls::stick_base(bool look) const {
  const float d = px(layout_.stick * scale_);
  const float bottom = screen_.safe.bottom + px(layout_.stick_y);
  const float y = static_cast<float>(screen_.ref_h) - bottom - d / 2;
  if (look) {
    const float right = screen_.safe.right + px(layout_.stick_x);
    return {{static_cast<float>(screen_.ref_w) - right - d / 2, y}, d / 2};
  }
  return {{screen_.safe.left + px(layout_.stick_x) + d / 2, y}, d / 2};
}

// Visible buttons take the layout slots in fixed order (A jump, B action, C action2). Buttons
// hang from their bottom-right corner; the insets scale with the touch size (engine-web place()).
std::array<std::optional<Circle>, 3> TouchControls::button_circles() const {
  std::array<std::optional<Circle>, 3> out;
  size_t slot = 0;
  for (size_t i = 0; i < buttons_.size(); i++) {
    if (!buttons_[i].shown || slot >= layout_.buttons.size()) continue;
    const TouchLayout::Slot& s = layout_.buttons[slot++];
    const float d = px(s.size * scale_);
    const float right = screen_.safe.right + px(s.right * scale_);
    const float bottom = screen_.safe.bottom + px((s.bottom + lift_) * scale_);
    out[i] = Circle{{static_cast<float>(screen_.ref_w) - right - d / 2, static_cast<float>(screen_.ref_h) - bottom - d / 2},
                    d / 2};
  }
  return out;
}

// ---------------------------------------------------------------- events

bool TouchControls::touch_down(int64_t id, Vec2 p, InputState& input) {
  // Topmost first, like the DOM order in engine-web: buttons, then the aim stick, then the joystick.
  const auto circles = button_circles();
  for (size_t n = buttons_.size(); n-- > 0;) {
    Button& b = buttons_[n];
    if (!circles[n] || !b.active) continue;
    if (distance(p, circles[n]->center) > button_hit_radius(*circles[n])) continue;
    b.fingers.insert(id);
    input.set_button(b.name, true);
    return true;
  }
  for (bool look : {true, false}) {
    Stick& s = look ? look_ : stick_;
    if (!s.enabled || !s.active) continue;
    if (distance(p, stick_base(look).center) > stick_hit_radius()) continue;
    if (s.finger) return true;  // already held by another finger: swallow the touch
    s.finger = id;
    move_stick(s, p, look, input);
    return true;
  }
  return false;
}

bool TouchControls::touch_move(int64_t id, Vec2 p, InputState& input) {
  if (stick_.finger == id) {
    move_stick(stick_, p, false, input);
    return true;
  }
  if (look_.finger == id) {
    move_stick(look_, p, true, input);
    return true;
  }
  for (const Button& b : buttons_) {
    if (b.fingers.count(id)) return true;  // the button keeps the finger until it lifts
  }
  return false;
}

bool TouchControls::touch_up(int64_t id, InputState& input) {
  for (bool look : {false, true}) {
    Stick& s = look ? look_ : stick_;
    if (s.finger != id) continue;
    s.finger.reset();
    s.offset = {};
    input.set_axis(look ? "look_x" : "move_x", 0);
    input.set_axis(look ? "look_y" : "move_y", 0);
    return true;
  }
  for (Button& b : buttons_) {
    if (!b.fingers.erase(id)) continue;
    if (b.fingers.empty()) input.set_button(b.name, false);
    return true;
  }
  return false;
}

void TouchControls::release_all(InputState& input) {
  for (bool look : {false, true}) {
    Stick& s = look ? look_ : stick_;
    if (s.finger) touch_up(*s.finger, input);
  }
  for (Button& b : buttons_) {
    if (b.fingers.empty()) continue;
    b.fingers.clear();
    input.set_button(b.name, false);
  }
}

// The knob follows the finger, clamped to 0.42 x the stick diameter from the center.
void TouchControls::move_stick(Stick& s, Vec2 p, bool look, InputState& input) {
  const Vec2 center = stick_base(look).center;
  const float max = stick_max_offset();
  float dx = p.x - center.x, dy = p.y - center.y;
  const float len = std::hypot(dx, dy);
  if (len > max) {
    dx = dx / len * max;
    dy = dy / len * max;
  }
  s.offset = {dx, dy};
  if (look) {
    const float ax = dx / max, ay = dy / max;
    input.set_axis("look_x", std::abs(ax) < kLookDeadZone ? 0 : ax);
    input.set_axis("look_y", std::abs(ay) < kLookDeadZone ? 0 : ay);
  } else {
    const Vec2 a = shape_stick(dx / max, dy / max);
    input.set_axis("move_x", a.x);
    input.set_axis("move_y", a.y);
  }
}

// ---------------------------------------------------------------- per frame

void TouchControls::sync(const InputState& input, float dt) {
  // A control the scan missed appears the first time the game reads it.
  if (input.ever_read("move_x") || input.ever_read("move_y")) stick_.enabled = true;
  for (Button& b : buttons_) {
    if (input.ever_read(b.name)) b.shown = true;
  }

  stick_.active = stick_.finger.has_value() || input.recently_read("move_x") || input.recently_read("move_y");
  look_.active = look_.finger.has_value() || input.recently_read("look_x") || input.recently_read("look_y");
  for (Button& b : buttons_) b.active = input.recently_read(b.name) || input.raw_held(b.name) || !b.fingers.empty();

  fade(stick_.alpha, stick_.enabled && stick_.active, dt);
  fade(look_.alpha, look_.enabled && look_.active, dt);
  for (Button& b : buttons_) fade(b.alpha, b.shown && b.active, dt);
  for (Button& b : buttons_) b.pressed = !b.fingers.empty() || input.raw_held(b.name);
}

ControlsView TouchControls::view() const {
  ControlsView v;
  v.opacity = dimmed_ ? 0.25f : 1.0f;
  for (bool look : {false, true}) {
    const Stick& s = look ? look_ : stick_;
    StickView& out = look ? v.look : v.stick;
    out.enabled = s.enabled;
    out.alpha = s.alpha;
    out.held = s.finger.has_value();
    out.base = stick_base(look);
    out.knob = {{out.base.center.x + s.offset.x, out.base.center.y + s.offset.y}, px(layout_.knob * scale_) / 2};
  }
  const auto circles = button_circles();
  for (size_t i = 0; i < buttons_.size(); i++) {
    if (!circles[i]) continue;
    const Button& b = buttons_[i];
    ButtonView bv;
    bv.name = b.name;
    bv.label = b.label;
    bv.color = b.color;
    bv.alpha = b.alpha;
    bv.pressed = b.pressed;
    bv.circle = *circles[i];
    v.buttons.push_back(bv);
  }
  return v;
}

}  // namespace dreamsy::input
