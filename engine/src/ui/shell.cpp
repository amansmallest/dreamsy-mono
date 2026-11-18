#include "ui/shell.h"

#include <algorithm>
#include <cmath>
#include <cstdio>

#include "ui/overlay_draw.h"

namespace dreamsy::ui {

using namespace draw;
using Kind = ShellItem::Kind;

namespace {

// Button and setting ids (ShellItem::id).
enum Id : int {
  kResume = 1, kRestart, kLeaderboard, kSettings, kControls, kQuit, kBack,
  kMusic, kSfx, kMute, kVibration, kTouchSize,
  kTabBase = 1000,  // leaderboard tab i = kTabBase + i
};

constexpr float kTouchSizes[] = {0.8f, 1.0f, 1.25f};  // S M L (engine-web)
constexpr int kLayer = 5;                             // above the overlay's layers (overlay.h)

// Line heights: titles, labels and table text inherit the page's `line-height: 1.4`; buttons and
// tabs set a `font` shorthand, which means `line-height: normal` (about 1.2 for the system fonts).
constexpr double kTextLineHeight = 1.4;
constexpr double kLineHeight = 1.2;

// Builds the item list top to bottom inside the panel's content box.
struct Column {
  double x = 0, w = 0;  // content box, reference px
  double y = 0;         // next item's top (relative to the panel top until placed)
  double k = 1;         // reference px per point
  double gap = 10;      // points between items (flex gap)
  std::vector<ShellItem> items;
  bool first = true;

  // Starts a new item `h` reference px tall; returns its top.
  double next(double h) {
    if (!first) y += gap * k;
    first = false;
    const double top = y;
    y += h;
    return top;
  }
};

}  // namespace

std::string board_label(const std::string& board) {
  std::string out;
  for (char c : board) {
    const bool sep = c == '_' || c == ':' || c == '.' || c == '-';
    if (sep) {
      if (!out.empty() && out.back() != ' ') out += ' ';
    } else {
      out += c;
    }
  }
  while (!out.empty() && out.back() == ' ') out.pop_back();
  if (!out.empty() && out[0] >= 'a' && out[0] <= 'z') out[0] = static_cast<char>(out[0] - 'a' + 'A');
  return out;
}

std::string format_board_value(double value, bool ascending) {
  char buf[48];
  if (ascending) {
    const long long cs = std::max(0LL, std::llround(value * 100));
    std::snprintf(buf, sizeof buf, "%02lld:%02lld.%02lld", cs / 6000, (cs % 6000) / 100, cs % 100);
  } else if (value == std::floor(value) && std::abs(value) < 1e15) {
    std::snprintf(buf, sizeof buf, "%lld", static_cast<long long>(value));
  } else {
    std::snprintf(buf, sizeof buf, "%.2f", value);
  }
  return buf;
}

void PauseShell::open() {
  view_ = ShellView::Main;
  dragging_ = -1;
}

bool PauseShell::back() {
  if (view_ == ShellView::Main) return false;
  view_ = ShellView::Main;
  dragging_ = -1;
  return true;
}

ShellLayout PauseShell::layout(const OverlayContext& ctx, const ShellData& data) const {
  const UiTheme& t = ctx.theme;
  const bool pixel = t.pixel_font();
  const double k = 1.0 / ctx.points_per_ref;
  const render::Font& face = ctx.fonts.font(ctx.fonts.resolve(t.font));
  auto label = [&](std::string s) { return pixel ? upper_ascii(std::move(s)) : s; };  // text-transform: uppercase

  ShellLayout out;
  out.window = ctx.screen.window();
  // Panel: min(400px, 100%) inside the overlay's 16px padding; padding 22 22 18; gap 10.
  const double width = std::min(400 * k, out.window.w - 32 * k);
  Column col;
  col.k = k;
  col.x = 22 * k;
  col.w = width - 44 * k;

  auto title = [&](const std::string& text) {
    const double size = (pixel ? 20 : 26) * k;
    ShellItem it;
    it.kind = Kind::Title;
    it.rect = {col.x, col.next(size * kTextLineHeight), col.w, size * kTextLineHeight};
    col.y += 8 * k;  // margin-bottom 8
    it.text = label(text);
    it.size = static_cast<float>(size);
    it.align = render::TextAlign::Center;
    col.items.push_back(it);
  };
  auto button = [&](const std::string& text, int id, bool primary = false) {
    const double size = (pixel ? 15 : 18) * k;
    const double h = size * (pixel ? kLineHeight : 1.17) + 26 * k;  // padding 13 16
    ShellItem it;
    it.kind = Kind::Button;
    it.rect = {col.x, col.next(h), col.w, h};
    it.text = label(text);
    it.id = id;
    it.primary = primary;
    it.size = static_cast<float>(size);
    it.align = render::TextAlign::Center;
    col.items.push_back(it);
  };
  // A settings row: label left, a control of `cw` x `ch` points right (padding 4 2, 15px bold).
  auto row = [&](Kind kind, const std::string& text, int id, double cw, double ch) -> ShellItem& {
    const double h = std::max(ch, 15 * kTextLineHeight) * k + 8 * k;
    ShellItem it;
    it.kind = kind;
    it.rect = {col.x, col.next(h), col.w, h};
    it.control = {col.x + col.w - 2 * k - cw * k, it.rect.y + (h - ch * k) / 2, cw * k, ch * k};
    it.text = text;
    it.id = id;
    it.size = static_cast<float>(15 * k);
    col.items.push_back(it);
    return col.items.back();
  };
  auto text_item = [&](double x, double y, double w, double h, std::string text, double size_pt, render::TextAlign align,
                       float opacity = 1, bool accent = false) {
    ShellItem it;
    it.kind = Kind::Text;
    it.rect = {x, y, w, h};
    it.text = std::move(text);
    it.size = static_cast<float>(size_pt * k);
    it.align = align;
    it.opacity = opacity;
    it.accent = accent;
    col.items.push_back(it);
  };
  auto width_of = [&](const std::string& s, double size_pt) {
    return static_cast<double>(measure(face, s, static_cast<float>(size_pt * k)));
  };

  switch (view_) {
    case ShellView::Main:
      title("Paused");
      button("Resume", kResume, true);
      button("Restart", kRestart);
      if (!data.boards.empty()) button("Leaderboard", kLeaderboard);
      button("Settings", kSettings);
      button("Controls", kControls);
      button("Quit", kQuit);
      break;

    case ShellView::Settings: {
      title("Settings");
      // Range inputs are 55% of the row; Chrome draws them about 21px tall with their margins.
      const double slider_w = (col.w - 4 * k) * 0.55 / k;
      row(Kind::Slider, "Music", kMusic, slider_w, 21);
      row(Kind::Slider, "Sound effects", kSfx, slider_w, 21);
      row(Kind::Toggle, "Mute all", kMute, 48, 26);
      row(Kind::Toggle, "Vibration", kVibration, 48, 26);
      ShellItem& choice = row(Kind::Choice, "Touch controls", kTouchSize, 3 * 38 + 2 * 6, 32);
      for (int i = 0; i < 3; i++) {
        choice.options.push_back({choice.control.x + i * 44 * k, choice.control.y, 38 * k, 32 * k});
      }
      button("Back", kBack, true);
      break;
    }

    case ShellView::Controls: {
      title("Controls");
      // grid: auto 1fr 1fr, gap 8px 12px, 14px text, margin 4 0 8; header row 12px, uppercase, 60%.
      struct Row {
        std::string action, keys, touch;
      };
      std::vector<Row> rows;
      if (data.usage.move) rows.push_back({"Move", "Arrows / WASD", "Left joystick"});
      const struct {
        const char* name;
        Row row;
      } buttons[] = {{"jump", {"Jump", "Space / Z / Up", "A button"}},
                     {"action", {"Action", "E / J / Enter", "B button"}},
                     {"action2", {"Action 2", "Q / K / C", "C button"}}};
      for (const auto& b : buttons) {
        if (data.usage.buttons.count(b.name)) rows.push_back(b.row);
      }
      rows.push_back({"Tap / click", "Mouse", "Tap the screen"});
      rows.push_back({"Pause", "Esc / P", "Pause button"});
      double first = 0;
      for (const Row& r : rows) first = std::max(first, width_of(r.action, 14));
      const double rest = std::max(0.0, (col.w - first - 24 * k) / 2);
      const double xs[3] = {col.x, col.x + first + 12 * k, col.x + first + 12 * k + rest + 12 * k};
      const double header_h = 12 * kTextLineHeight * k, row_h = 14 * kTextLineHeight * k;
      const double table_h = header_h + static_cast<double>(rows.size()) * (row_h + 8 * k);
      double y = col.next(table_h + 12 * k) + 4 * k;  // margin 4 top, 8 bottom
      text_item(xs[1], y, rest, header_h, "KEYBOARD", 12, render::TextAlign::Left, 0.6f);
      text_item(xs[2], y, rest, header_h, "TOUCH", 12, render::TextAlign::Left, 0.6f);
      y += header_h + 8 * k;
      for (const Row& r : rows) {
        text_item(xs[0], y, first, row_h, r.action, 14, render::TextAlign::Left, 1, true);
        text_item(xs[1], y, rest, row_h, r.keys, 14, render::TextAlign::Left);
        text_item(xs[2], y, rest, row_h, r.touch, 14, render::TextAlign::Left);
        y += row_h + 8 * k;
      }
      button("Back", kBack, true);
      break;
    }

    case ShellView::Leaderboard: {
      title("Leaderboard");
      const std::string board = !board_.empty() ? board_ : data.boards.empty() ? "fastest" : data.boards.front();
      if (data.boards.size() > 1) {
        // Tabs: 13px bold, padding 6 10, gap 6, wrapping, centered.
        const double h = (13 * kLineHeight + 12) * k;
        std::vector<std::vector<std::pair<size_t, double>>> lines(1);
        double line_w = 0;
        for (size_t i = 0; i < data.boards.size(); i++) {
          const double w = width_of(board_label(data.boards[i]), 13) + 20 * k;
          if (!lines.back().empty() && line_w + 6 * k + w > col.w) {
            lines.emplace_back();
            line_w = 0;
          }
          line_w += (lines.back().empty() ? 0 : 6 * k) + w;
          lines.back().push_back({i, w});
        }
        const double top = col.next(static_cast<double>(lines.size()) * h + static_cast<double>(lines.size() - 1) * 6 * k);
        for (size_t l = 0; l < lines.size(); l++) {
          double total = 0;
          for (const auto& [i, w] : lines[l]) total += w;
          total += static_cast<double>(lines[l].size() - 1) * 6 * k;
          double x = col.x + (col.w - total) / 2;
          for (const auto& [i, w] : lines[l]) {
            ShellItem tab;
            tab.kind = Kind::Tab;
            tab.rect = {x, top + static_cast<double>(l) * (h + 6 * k), w, h};
            tab.text = board_label(data.boards[i]);
            tab.id = kTabBase + static_cast<int>(i);
            tab.primary = data.boards[i] == board;
            tab.size = static_cast<float>(13 * k);
            tab.align = render::TextAlign::Center;
            col.items.push_back(tab);
            x += w + 6 * k;
          }
        }
      } else {
        const double h = 13 * kTextLineHeight * k;
        col.y -= 6 * k;  // margin-top -6
        text_item(col.x, col.next(h), col.w, h, board_label(board), 13, render::TextAlign::Center, 0.7f);
      }
      // This device's runs on the board, best first (top 10): "#rank  you  value".
      std::vector<LocalScore> runs;
      for (const LocalScore& s : data.scores) {
        if (s.board == board) runs.push_back(s);
      }
      std::stable_sort(runs.begin(), runs.end(), [](const LocalScore& a, const LocalScore& b) {
        return a.ascending ? a.value < b.value : a.value > b.value;
      });
      if (runs.size() > 10) runs.resize(10);
      const double row_h = 15 * kTextLineHeight * k;
      if (runs.empty()) {
        const double top = col.next(60 * k);
        text_item(col.x, top + 8 * k, col.w, row_h, "No runs yet. Be the first!", 15, render::TextAlign::Center, 0.7f);
      } else {
        const double h = std::max(60 * k, static_cast<double>(runs.size()) * (row_h + 6 * k) - 6 * k);
        double y = col.next(h);
        double rank_w = 0;
        for (size_t i = 0; i < runs.size(); i++) rank_w = std::max(rank_w, width_of("#" + std::to_string(i + 1), 15));
        for (size_t i = 0; i < runs.size(); i++) {
          text_item(col.x, y, rank_w, row_h, "#" + std::to_string(i + 1), 15, render::TextAlign::Left, 0.7f);
          text_item(col.x + rank_w + 10 * k, y, col.w / 2, row_h, "you", 15, render::TextAlign::Left);
          text_item(col.x + col.w, y, col.w / 2, row_h, format_board_value(runs[i].value, runs[i].ascending), 15,
                    render::TextAlign::Right);
          y += row_h + 6 * k;
        }
      }
      button("Back", kBack, true);
      break;
    }
  }

  // Center the panel in the window and move the items into place.
  const double height = 22 * k + col.y + 18 * k;
  out.panel = {out.window.x + (out.window.w - width) / 2, out.window.y + (out.window.h - height) / 2, width, height};
  for (ShellItem& it : col.items) {
    auto move = [&](Rect& r) {
      r.x += out.panel.x;
      r.y += out.panel.y + 22 * k;
    };
    move(it.rect);
    move(it.control);
    for (Rect& o : it.options) move(o);
  }
  out.items = std::move(col.items);
  return out;
}

void PauseShell::draw(OverlayContext& ctx, const ShellData& data) const {
  const UiTheme& t = ctx.theme;
  const double k = 1.0 / ctx.points_per_ref;
  const ShellLayout l = layout(ctx, data);
  const bool square = t.panel == UiTheme::Panel::Pixel || t.panel == UiTheme::Panel::Sharp;
  Pen pen{ctx.out, kLayer, std::nullopt};
  pen.rect(l.window, {0, 0, 0, 0.55f});
  panel_surface(pen, ctx, l.panel, with_alpha(t.background, 0.96f), false);
  const Color on_primary = on_color(t.primary, hex(0xffffff));
  auto text_x = [](const ShellItem& it) {
    return it.align == render::TextAlign::Center ? f(it.rect.x + it.rect.w / 2)
           : it.align == render::TextAlign::Right ? f(it.rect.x) : f(it.rect.x);
  };

  for (const ShellItem& it : l.items) {
    const float cy = f(it.rect.y + it.rect.h / 2);
    switch (it.kind) {
      case Kind::Title:
        pen.text(it.text, t.font, it.size, t.accent, render::TextAlign::Center, text_x(it), cy);
        break;
      case Kind::Button:
        if (t.panel == UiTheme::Panel::Outlined) {
          if (it.primary) round_rect(pen, ctx.images, it.rect, 10, t.primary);
          round_outline(pen, ctx.images, it.rect, 10, 2, it.primary ? t.primary : t.text);
        } else {
          panel_surface(pen, ctx, it.rect, it.primary ? t.primary : with_alpha(t.text, 0.12f), true);
        }
        pen.text(it.text, t.font, it.size, it.primary ? on_primary : t.text, render::TextAlign::Center, text_x(it), cy);
        break;
      case Kind::Tab:
        round_rect(pen, ctx.images, it.rect, square ? 0 : 8 * k, it.primary ? t.primary : with_alpha(t.text, 0.15f));
        pen.text(it.text, t.font, it.size, it.primary ? on_primary : t.text, render::TextAlign::Center, text_x(it), cy);
        break;
      case Kind::Text:
        pen.text(it.text, t.font, it.size, with_alpha(it.accent ? t.accent : t.text, it.opacity), it.align, text_x(it), cy);
        break;
      case Kind::Slider: {
        pen.text(it.text, t.font, it.size, t.text, render::TextAlign::Left, f(it.rect.x + 2 * k), cy);
        const double v = std::clamp(it.id == kMusic ? data.settings.music : data.settings.sfx, 0.0, 1.0);
        // Chrome's range input with accent-color: a rounded track filled up to the thumb.
        const Rect& c = it.control;
        const double th = 16 * k, track_h = 6 * k;
        const double x0 = c.x + th / 2, x1 = c.x + c.w - th / 2, tx = x0 + (x1 - x0) * v;
        const double ty = c.y + c.h / 2;
        round_rect(pen, ctx.images, {c.x, ty - track_h / 2, c.w, track_h}, track_h / 2, with_alpha(t.text, 0.3f));
        round_rect(pen, ctx.images, {c.x, ty - track_h / 2, tx - c.x, track_h}, track_h / 2, t.primary);
        pen.image({tx - th / 2, ty - th / 2, th, th}, ctx.images.circle, {}, t.primary);
        break;
      }
      case Kind::Toggle: {
        pen.text(it.text, t.font, it.size, t.text, render::TextAlign::Left, f(it.rect.x + 2 * k), cy);
        const bool on = it.id == kMute ? data.settings.mute : data.settings.vibration;
        const Rect& c = it.control;
        round_rect(pen, ctx.images, c, square ? 0 : 13 * k, on ? t.primary : with_alpha(t.text, 0.25f));
        const Rect knob{c.x + (on ? 25 : 3) * k, c.y + 3 * k, 20 * k, 20 * k};
        if (square) {
          pen.rect(knob, t.text);
        } else {
          pen.image(knob, ctx.images.circle, {}, t.text);
        }
        break;
      }
      case Kind::Choice: {
        pen.text(it.text, t.font, it.size, t.text, render::TextAlign::Left, f(it.rect.x + 2 * k), cy);
        const char* names[] = {"S", "M", "L"};
        for (size_t i = 0; i < it.options.size(); i++) {
          const bool sel = std::abs(data.settings.touch_size - kTouchSizes[i]) < 0.01f;
          const Rect& o = it.options[i];
          round_rect(pen, ctx.images, o, square ? 0 : 8 * k, sel ? t.primary : with_alpha(t.text, 0.15f));
          pen.text(names[i], t.font, f(14 * k), sel ? on_primary : t.text, render::TextAlign::Center, f(o.x + o.w / 2),
                   f(o.y + o.h / 2));
        }
        break;
      }
    }
  }
}

ShellAction PauseShell::pointer(Phase phase, double x, double y, const OverlayContext& ctx, ShellData& data) {
  const ShellLayout l = layout(ctx, data);
  auto set_slider = [&](const ShellItem& it) {
    const double th = 16.0 / ctx.points_per_ref;
    const double v = std::clamp((x - it.control.x - th / 2) / std::max(1.0, it.control.w - th), 0.0, 1.0);
    (it.id == kMusic ? data.settings.music : data.settings.sfx) = std::round(v * 100) / 100;  // a 0..100 range input
  };
  if (phase != Phase::Down) {
    if (dragging_ < 0) return ShellAction::None;
    for (const ShellItem& it : l.items) {
      if (it.kind == Kind::Slider && it.id == dragging_) set_slider(it);
    }
    if (phase == Phase::Up) dragging_ = -1;
    return ShellAction::SettingsChanged;
  }

  if (!l.panel.contains(x, y)) return ShellAction::Resume;  // a tap on the dimmed area closes the menu
  for (const ShellItem& it : l.items) {
    switch (it.kind) {
      case Kind::Button:
        if (!it.rect.contains(x, y)) break;
        switch (it.id) {
          case kResume: return ShellAction::Resume;
          case kRestart: return ShellAction::Restart;
          case kQuit: return ShellAction::Quit;
          case kLeaderboard: view_ = ShellView::Leaderboard; return ShellAction::None;
          case kSettings: view_ = ShellView::Settings; return ShellAction::None;
          case kControls: view_ = ShellView::Controls; return ShellAction::None;
          case kBack: view_ = ShellView::Main; return ShellAction::None;
          default: return ShellAction::None;
        }
      case Kind::Tab:
        if (!it.rect.contains(x, y)) break;
        board_ = data.boards[static_cast<size_t>(it.id - kTabBase)];
        return ShellAction::None;
      case Kind::Slider: {
        Rect hit = it.control;  // the thumb overhangs the track a little
        hit.y = it.rect.y;
        hit.h = it.rect.h;
        if (!hit.contains(x, y)) break;
        dragging_ = it.id;
        set_slider(it);
        return ShellAction::SettingsChanged;
      }
      case Kind::Toggle:
        if (!it.control.contains(x, y)) break;
        if (it.id == kMute) data.settings.mute = !data.settings.mute;
        else data.settings.vibration = !data.settings.vibration;
        return ShellAction::SettingsChanged;
      case Kind::Choice:
        for (size_t i = 0; i < it.options.size(); i++) {
          if (!it.options[i].contains(x, y)) continue;
          data.settings.touch_size = kTouchSizes[i];
          return ShellAction::SettingsChanged;
        }
        break;
      case Kind::Title:
      case Kind::Text: break;
    }
  }
  return ShellAction::None;
}

}  // namespace dreamsy::ui
