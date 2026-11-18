#include "play/platform_ui.h"

#include <cmath>

#include "base/log.h"
#include "script/theme.h"

namespace dreamsy::play {

namespace {

// A finger that moves this far (reference px) is dragging a scroll list, not tapping a button.
constexpr float kDragThreshold = 8;

}  // namespace

PlatformUi::PlatformUi(script::Host& host, render::TextureStore& textures, const render::FontStore& fonts,
                       const input::InputUsage& usage, bool up_jumps, bool touch_controls)
    : host_(host),
      textures_(textures),
      fonts_(fonts),
      theme_(ui::ui_theme(script::resolve_theme(host.package().manifest))),
      keyboard_(up_jumps),
      controls_(usage, host.package().manifest.portrait()),
      touch_enabled_(touch_controls) {
  set_screen(1, {});
}

Status PlatformUi::init() {
  auto images = ui::create_ui_images(textures_);
  if (!images) return Error{images.error()};
  images_ = images.value();
  return {};
}

ui::UiScreen PlatformUi::screen() const { return {host_.ref_width(), host_.ref_height(), safe_}; }

void PlatformUi::set_screen(float points_per_ref, ui::SafeArea safe) {
  points_per_ref_ = points_per_ref > 0 ? points_per_ref : 1;
  safe_ = safe;
  input::ControlsScreen cs;
  cs.ref_w = static_cast<int>(host_.ref_width());
  cs.ref_h = static_cast<int>(host_.ref_height());
  cs.points_per_ref = points_per_ref_;
  cs.safe = {static_cast<float>(safe.top), static_cast<float>(safe.right), static_cast<float>(safe.bottom),
             static_cast<float>(safe.left)};
  controls_.set_screen(cs);
}

void PlatformUi::relayout() { nodes_ = ui::layout_ui(host_.world(), screen(), scroll_); }

void PlatformUi::toggle_pause() {
  if (host_.paused()) {
    host_.resume();
  } else {
    host_.pause();
  }
}

// ---------------------------------------------------------------- events

void PlatformUi::key(input::Key key, bool down) {
  // Esc / P open and close the pause menu (engine-web shell onKey).
  if (key == input::Key::Escape || key == input::Key::P) {
    if (down) toggle_pause();
    return;
  }
  if (down) {
    keyboard_.key_down(key, host_.input());
  } else {
    keyboard_.key_up(key, host_.input());
  }
}

void PlatformUi::blur() {
  keyboard_.blur(host_.input());
  controls_.release_all(host_.input());
  swallowed_.clear();
  touches_.clear();
}

void PlatformUi::gamepad(const input::GamepadState& pad) {
  if (pad.start && !gamepad_start_) toggle_pause();
  gamepad_start_ = pad.start;
  gamepad_.update(pad, host_.input());
}

void PlatformUi::wheel(input::Vec2 p, float dy) {
  relayout();
  for (size_t i = nodes_.size(); i-- > 0;) {
    const ui::UiNode& n = nodes_[i];
    if (n.content_height <= 0 || !n.rect.contains(p.x, p.y)) continue;
    if (n.clip && !n.clip->contains(p.x, p.y)) continue;
    scroll_[n.id] += dy;  // clamped by the next layout
    return;
  }
}

void PlatformUi::pointer(PointerPhase phase, int64_t id, input::Vec2 p) {
  input::InputState& in = host_.input();
  if (phase == PointerPhase::Down) {
    // 1. The pause menu (while paused it takes every touch), then the pause button.
    if (host_.paused()) {
      const ui::PauseMenuLayout menu = ui::layout_pause_menu(screen(), points_per_ref_, theme_);
      if (auto action = ui::hit_pause_menu(menu, p.x, p.y)) {
        host_.resume();
        if (*action == ui::PauseAction::Restart) host_.request_restart();
      } else if (!menu.panel.contains(p.x, p.y)) {
        host_.resume();  // a tap outside the panel closes the menu
      }
      swallowed_.insert(id);
      return;
    }
    if (ui::pause_button_rect(screen(), points_per_ref_).contains(p.x, p.y)) {
      host_.pause();
      swallowed_.insert(id);
      return;
    }
    // 2. The on-screen controls.
    if (touch_enabled_ && controls_.touch_down(id, p, in)) {
      swallowed_.insert(id);
      return;
    }
    // 3. The game: input.pointerDown always fires, then the dialog, UI, or world takes the tap.
    host_.pointer_down(p.x, p.y);
    GameTouch touch{p, p, {}, {}, false};
    render::DrawList scratch;
    ui::OverlayContext ctx{scratch, textures_, fonts_, theme_, images_, screen(), points_per_ref_};
    const ui::DialogLayout dialog = ui::layout_dialog(ctx, host_.dialogs().dialogs);
    if (auto option = ui::hit_dialog(dialog, p.x, p.y)) {
      host_.dialogs().tap(*option);
    } else {
      relayout();
      if (const ui::UiNode* hit = ui::hit_ui(nodes_, p.x, p.y)) {
        touch.scroll_panel = hit->content_height > 0 ? hit->id : hit->scroll_panel;
        const world::EntityId target = hit->id;
        if (hit->entity->type->name == "UIButton") {
          if (!hit->scroll_panel.is_null()) {
            touch.deferred = target;  // inside a scroll list: press on release unless dragged
          } else {
            host_.press(target);
            host_.tap_entity(target);
          }
        } else {
          host_.tap_entity(target);
        }
      } else {
        const world::Point w = host_.ref_to_world(p.x, p.y);
        host_.tap_world(w.x, w.y);
      }
    }
    touches_[id] = touch;
    return;
  }

  if (swallowed_.count(id)) {
    if (phase == PointerPhase::Move) {
      controls_.touch_move(id, p, in);
    } else {
      controls_.touch_up(id, in);
      swallowed_.erase(id);
    }
    return;
  }
  auto it = touches_.find(id);
  if (it == touches_.end()) return;  // a finger we never saw go down
  GameTouch& t = it->second;
  if (phase == PointerPhase::Move) {
    host_.pointer_move(p.x, p.y);
    if (!t.scroll_panel.is_null()) {
      if (std::hypot(p.x - t.start.x, p.y - t.start.y) > kDragThreshold) t.dragged = true;
      if (t.dragged) scroll_[t.scroll_panel] -= p.y - t.last.y;
    }
    t.last = p;
    return;
  }
  // Up or cancel (engine-web treats pointercancel like pointerup).
  const GameTouch done = t;
  touches_.erase(it);
  host_.pointer_up(p.x, p.y);
  if (phase == PointerPhase::Up && !done.deferred.is_null() && !done.dragged) {
    host_.press(done.deferred);
    host_.tap_entity(done.deferred);
  }
}

// ---------------------------------------------------------------- per frame

void PlatformUi::update(float dt) {
  controls_.set_dimmed(host_.dialogs().open());
  controls_.sync(host_.input(), dt);
  relayout();
}

void PlatformUi::draw(render::DrawList& out, double time) {
  relayout();
  ui::OverlayContext ctx{out, textures_, fonts_, theme_, images_, screen(), points_per_ref_};
  ui::draw_ui_entities(ctx, host_.world(), nodes_);
  ui::draw_toasts(ctx, host_.toasts().toasts());
  ui::draw_dialog(ctx, host_.dialogs().dialogs, time);
  if (touch_enabled_) ui::draw_touch_controls(ctx, controls_.view());
  if (host_.paused()) {
    ui::draw_pause_menu(ctx);
  } else {
    ui::draw_pause_button(ctx);
  }
}

}  // namespace dreamsy::play
