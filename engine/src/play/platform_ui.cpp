#include "play/platform_ui.h"

#include <algorithm>
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
      touch_enabled_(touch_controls),
      usage_(usage) {
  set_screen(1, {});
  // Leaderboard boards the scripts name (engine-web Game.scanBoards): leaderboard.start/finish/submit("board".
  for (const std::string& path : host.package().files.paths("scripts/")) {
    const auto text = host.package().files.text(path);
    if (!text) continue;
    const std::string_view src = *text;
    for (size_t at = src.find("leaderboard"); at != std::string_view::npos; at = src.find("leaderboard", at + 1)) {
      size_t i = at + 11;
      auto skip = [&] { while (i < src.size() && (src[i] == ' ' || src[i] == '\t')) i++; };
      skip();
      if (i >= src.size() || src[i] != '.') continue;
      i++;
      skip();
      bool call = false;
      for (const char* fn : {"start", "finish", "submit"}) {
        const std::string_view name(fn);
        if (src.substr(i, name.size()) == name) {
          i += name.size();
          call = true;
          break;
        }
      }
      if (!call) continue;
      if (boards_.empty()) boards_.push_back("");  // used, maybe without a literal board name
      skip();
      if (i >= src.size() || src[i] != '(') continue;
      i++;
      skip();
      if (i >= src.size() || src[i] != '"') continue;
      const size_t end = src.find('"', i + 1);
      if (end == std::string_view::npos) continue;
      const std::string board(src.substr(i + 1, end - i - 1));
      if (std::find(boards_.begin(), boards_.end(), board) == boards_.end()) boards_.push_back(board);
    }
  }
  // "" only marked "uses leaderboards"; a named board replaces it.
  if (boards_.size() > 1) boards_.erase(boards_.begin());
  if (boards_.size() == 1 && boards_[0].empty()) boards_[0] = "fastest";
}

Status PlatformUi::init() {
  auto images = ui::create_ui_images(textures_);
  if (!images) return Error{images.error()};
  images_ = images.value();
  return {};
}

ui::UiScreen PlatformUi::screen() const { return {host_.ref_width(), host_.ref_height(), safe_, window_}; }

void PlatformUi::set_screen(float points_per_ref, ui::SafeArea safe, ui::Rect window) {
  points_per_ref_ = points_per_ref > 0 ? points_per_ref : 1;
  safe_ = safe;
  window_ = window;
  // The controls hang from the window's corners (engine-web: the container), so their insets from
  // the game rect are negative where letterbox bars are. Device safe areas: TODO(E9).
  const ui::Rect win = screen().window();
  input::ControlsScreen cs;
  cs.ref_w = static_cast<int>(host_.ref_width());
  cs.ref_h = static_cast<int>(host_.ref_height());
  cs.points_per_ref = points_per_ref_;
  cs.safe = {static_cast<float>(win.y), static_cast<float>(host_.ref_width() - (win.x + win.w)),
             static_cast<float>(host_.ref_height() - (win.y + win.h)), static_cast<float>(win.x)};
  controls_.set_screen(cs);
}

void PlatformUi::set_settings(const ui::ShellSettings& s) {
  host_.settings.music = s.music;
  host_.settings.sfx = s.sfx;
  host_.settings.mute = s.mute;
  host_.settings.vibration = s.vibration;
  touch_size_ = s.touch_size;
  controls_.set_scale(s.touch_size);
}

void PlatformUi::relayout() { nodes_ = ui::layout_ui(host_.world(), screen(), scroll_); }

void PlatformUi::open_pause() {
  if (host_.paused()) return;
  host_.pause();
  shell_.open();
}

void PlatformUi::close_pause() {
  shell_fingers_.clear();
  host_.resume();
}

ui::ShellData PlatformUi::shell_data() const {
  ui::ShellData d;
  d.settings = {host_.settings.music, host_.settings.sfx, host_.settings.mute, host_.settings.vibration, touch_size_};
  d.usage = usage_;
  d.boards = boards_;
  for (const script::Host::LocalScore& s : host_.local_scores()) {
    d.scores.push_back({s.board, s.value, s.ascending});
    if (std::find(d.boards.begin(), d.boards.end(), s.board) == d.boards.end()) d.boards.push_back(s.board);
  }
  return d;
}

void PlatformUi::apply(ui::ShellAction action, const ui::ShellData& data) {
  switch (action) {
    case ui::ShellAction::None: break;
    case ui::ShellAction::Resume: close_pause(); break;
    case ui::ShellAction::Restart:
      close_pause();
      host_.request_restart();
      break;
    case ui::ShellAction::Quit:
      if (on_quit) on_quit();
      break;
    case ui::ShellAction::SettingsChanged:
      set_settings(data.settings);
      if (on_settings) on_settings(data.settings);
      break;
  }
}

// ---------------------------------------------------------------- events

void PlatformUi::key(input::Key key, bool down) {
  // Esc / P open the pause menu; in the menu they go back a view, then close it (engine-web shell onKey).
  if (key == input::Key::Escape || key == input::Key::P) {
    if (!down) return;
    if (!host_.paused()) open_pause();
    else if (!shell_.back()) close_pause();
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
  if (pad.start && !gamepad_start_) {
    if (!host_.paused()) open_pause();
    else close_pause();
  }
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
      render::DrawList scratch;
      ui::OverlayContext ctx{scratch, textures_, fonts_, theme_, images_, screen(), points_per_ref_};
      ui::ShellData data = shell_data();
      shell_fingers_.insert(id);
      apply(shell_.pointer(ui::PauseShell::Phase::Down, p.x, p.y, ctx, data), data);
      return;
    }
    if (ui::pause_button_rect(screen(), points_per_ref_).contains(p.x, p.y)) {
      open_pause();
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

  if (shell_fingers_.count(id)) {
    render::DrawList scratch;
    ui::OverlayContext ctx{scratch, textures_, fonts_, theme_, images_, screen(), points_per_ref_};
    ui::ShellData data = shell_data();
    const auto phase_of = phase == PointerPhase::Move ? ui::PauseShell::Phase::Move : ui::PauseShell::Phase::Up;
    if (phase != PointerPhase::Move) shell_fingers_.erase(id);
    apply(shell_.pointer(phase_of, p.x, p.y, ctx, data), data);
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

void PlatformUi::draw(render::DrawList& out) {
  relayout();
  ui::OverlayContext ctx{out, textures_, fonts_, theme_, images_, screen(), points_per_ref_};
  ui::draw_ui_entities(ctx, host_.world(), nodes_);
  ui::draw_toasts(ctx, host_.toasts().toasts());
  ui::draw_dialog(ctx, host_.dialogs().dialogs);
  if (touch_enabled_) ui::draw_touch_controls(ctx, controls_.view());
  if (host_.paused()) {
    shell_.draw(ctx, shell_data());
  } else {
    ui::draw_pause_button(ctx);
  }
}

}  // namespace dreamsy::play
