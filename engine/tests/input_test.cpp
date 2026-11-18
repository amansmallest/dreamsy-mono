// Input and platform UI (E5): InputState timing, gestures, keyboard/gamepad mapping, the input
// usage scan, the touch controls model, dialogs, toasts, UI layout, and the host's pointer/tap API.
// The rules come from engine-web (core/input.ts, core/dialog.ts, core/game.ts, input/index.ts).
#include <cmath>
#include <map>
#include <memory>
#include <string>

#include "doctest.h"
#include "input/gamepad.h"
#include "input/input_state.h"
#include "input/keyboard.h"
#include "input/touch_controls.h"
#include "input/usage.h"
#include "pkg/text.h"
#include "pkg/validate.h"
#include "render/atlas.h"
#include "render/font.h"
#include "script/host.h"
#include "ui/dialog.h"
#include "ui/layout.h"
#include "ui/overlay.h"
#include "ui/toasts.h"

using namespace dreamsy;
using input::InputState;

namespace {

ui::DialogState dialog(std::vector<std::string> lines, double speed = 40, bool blocking = true) {
  static int64_t next_id = 1;
  ui::DialogState d;
  d.id = next_id++;
  d.speed = speed;
  d.blocking = blocking;
  for (std::string& t : lines) {
    ui::DialogLine l;
    l.length = pkg::utf16_length(t);
    l.text = std::move(t);
    d.lines.push_back(std::move(l));
  }
  d.shown = speed > 0 ? 0 : static_cast<double>(d.lines[0].length);
  return d;
}

std::shared_ptr<const pkg::Package> game(const std::string& scene, const std::string& script, bool portrait = false) {
  std::map<std::string, std::string> files;
  files["dreamsy.toml"] = std::string("format = \"0\"\nname = \"t\"\ndimension = \"2d\"\nentry_scene = \"scenes/main.scene.json\"\n") +
                          (portrait ? "orientation = \"portrait\"\n" : "");
  files["scenes/main.scene.json"] = scene;
  files["scripts/client/main.luau"] = script;
  auto f = pkg::Files::from_map(files);
  REQUIRE(f.ok());
  pkg::LoadResult r = pkg::load_package(std::move(f).value());
  for (const auto& i : r.issues) MESSAGE(pkg::format_issue(i));
  REQUIRE(r.ok);
  return std::shared_ptr<const pkg::Package>(std::move(r.package));
}

std::string logs_of(const script::Host& h) {
  std::string out;
  for (const script::LogLine& l : h.logs()) {
    if (l.text.rfind("[scene]", 0) != 0) out += l.text + "\n";
  }
  for (char& c : out) {
    if (c == '\t') c = ' ';  // print() separates values with tabs
  }
  for (const script::ScriptError& e : h.errors()) out += "ERROR " + e.message + "\n";
  return out;
}

}  // namespace

// ---------------------------------------------------------------- InputState

TEST_CASE("input: pressed lasts exactly the tick after the edge; held is live; taps count") {
  InputState in;
  in.set_button("jump", true);
  CHECK(in.held("jump"));
  CHECK_FALSE(in.pressed("jump"));  // edges show up next tick
  in.begin_tick();
  CHECK(in.pressed("jump"));
  CHECK(in.held("jump"));
  in.set_button("jump", true);  // still down: no new edge
  in.begin_tick();
  CHECK_FALSE(in.pressed("jump"));
  CHECK(in.held("jump"));
  in.set_button("jump", false);
  CHECK_FALSE(in.held("jump"));

  // press + release between two ticks still registers as pressed (and not held)
  in.set_button("action", true);
  in.set_button("action", false);
  in.begin_tick();
  CHECK(in.pressed("action"));
  CHECK_FALSE(in.held("action"));
  in.tap("action2");
  in.begin_tick();
  CHECK(in.pressed("action2"));
  in.begin_tick();
  CHECK_FALSE(in.pressed("action2"));

  in.set_axis("move_x", 3);
  CHECK(in.axis("move_x") == 1);  // clamped
  in.set_axis("move_x", -0.25);
  CHECK(in.axis("move_x") == -0.25);
  CHECK(in.axis("unknown") == 0);
}

TEST_CASE("input: blocked hides input from scripts, not from raw reads; reads still count") {
  InputState in;
  in.set_axis("move_x", 1);
  in.set_button("jump", true);
  in.begin_tick();
  in.blocked = true;
  CHECK(in.axis("move_x") == 0);
  CHECK_FALSE(in.held("jump"));
  CHECK_FALSE(in.pressed("jump"));
  CHECK(in.raw_axis("move_x") == 1);
  CHECK(in.raw_held("jump"));
  CHECK(in.raw_pressed("jump"));
  CHECK(in.recently_read("move_x"));  // the controls stay up while a dialog blocks
}

TEST_CASE("input: recently_read is a 45-tick window; raw reads don't count") {
  InputState in;
  CHECK_FALSE(in.recently_read("move_x"));
  in.raw_axis("move_x");
  CHECK_FALSE(in.ever_read("move_x"));
  in.axis("move_x");
  for (int i = 0; i < 45; i++) in.begin_tick();
  CHECK(in.recently_read("move_x"));
  in.begin_tick();
  CHECK_FALSE(in.recently_read("move_x"));
  CHECK(in.ever_read("move_x"));
}

TEST_CASE("input: the pointer stays visible one tick after it lifts (1-tick grace)") {
  InputState in;
  in.begin_tick();  // tick 1
  in.pointer_down({100, 200});
  REQUIRE(in.pointer());
  CHECK(in.pointer()->x == 100);
  in.pointer_move({110, 210});
  CHECK(in.pointer()->x == 110);
  in.pointer_up({120, 220});  // between tick 1 and 2
  in.begin_tick();            // tick 2: still visible
  REQUIRE(in.pointer());
  CHECK(in.pointer()->x == 120);
  in.begin_tick();  // tick 3: gone
  CHECK_FALSE(in.pointer());

  // a quick tap entirely between two ticks is still seen by the next tick
  in.pointer_down({5, 5});
  in.pointer_up({5, 5});
  in.begin_tick();
  CHECK(in.pointer());
  // touching again cancels the pending clear
  in.pointer_down({6, 6});
  in.begin_tick();
  in.begin_tick();
  CHECK(in.pointer());
  // moves without a gesture are ignored
  InputState idle;
  idle.pointer_move({1, 1});
  CHECK_FALSE(idle.pointer());
}

TEST_CASE("input: swipes need >= 40 px within 0.6 s; direction by the larger axis; velocity in px/s") {
  InputState in;
  in.pointer_down({0, 0}, 1.0);
  CHECK_FALSE(in.pointer_up({39, 0}, 1.1));  // too short
  in.pointer_down({0, 0}, 1.0);
  CHECK_FALSE(in.pointer_up({100, 0}, 1.61));  // too slow
  in.pointer_down({0, 0}, 1.0);
  auto s = in.pointer_up({100, 30}, 1.5);
  REQUIRE(s);
  CHECK(s->dir == input::SwipeDir::Right);
  CHECK(s->velocity.x == doctest::Approx(200));
  CHECK(s->velocity.y == doctest::Approx(60));
  in.pointer_down({0, 0}, 0);
  s = in.pointer_up({10, -50}, 0.25);
  REQUIRE(s);
  CHECK(s->dir == input::SwipeDir::Up);
  CHECK(std::string(input::swipe_dir_name(s->dir)) == "up");
  in.pointer_down({0, 0}, 0);
  s = in.pointer_up({-40, 40}, 0.1);  // equal axes: horizontal wins
  REQUIRE(s);
  CHECK(s->dir == input::SwipeDir::Left);
  // velocity uses at least one tick, so an instant flick isn't infinite
  in.pointer_down({0, 0}, 2);
  s = in.pointer_up({0, 60}, 2);
  REQUIRE(s);
  CHECK(s->dir == input::SwipeDir::Down);
  CHECK(s->velocity.y == doctest::Approx(60 * 60));
  // without event times, ticks are the clock: 37 ticks (0.617 s) is too slow, 36 is fine
  InputState t;
  t.pointer_down({0, 0});
  for (int i = 0; i < 37; i++) t.begin_tick();
  CHECK_FALSE(t.pointer_up({50, 0}));
  t.pointer_down({0, 0});
  for (int i = 0; i < 36; i++) t.begin_tick();
  CHECK(t.pointer_up({50, 0}));
  CHECK_FALSE(t.pointer_up({500, 0}));  // no gesture in progress
}

// ---------------------------------------------------------------- devices

TEST_CASE("keyboard: arrows/WASD, jump/action/action2 keys, Up jumps only when move_y is unused") {
  InputState in;
  input::KeyboardMapper kb(true);
  kb.key_down(input::Key::Left, in);
  kb.key_down(input::Key::D, in);
  CHECK(in.raw_axis("move_x") == 0);  // both cancel
  kb.key_up(input::Key::Left, in);
  CHECK(in.raw_axis("move_x") == 1);
  kb.key_down(input::Key::W, in);
  CHECK(in.raw_axis("move_y") == -1);
  CHECK(in.raw_held("jump"));  // up_jumps
  kb.key_down(input::Key::Enter, in);
  kb.key_down(input::Key::C, in);
  CHECK(in.raw_held("action"));
  CHECK(in.raw_held("action2"));
  kb.blur(in);
  CHECK_FALSE(in.raw_held("jump"));
  CHECK(in.raw_axis("move_x") == 0);

  input::KeyboardMapper topdown(false);
  topdown.key_down(input::Key::Up, in);
  CHECK_FALSE(in.raw_held("jump"));
  topdown.key_down(input::Key::Space, in);
  CHECK(in.raw_held("jump"));
  CHECK(input::scripts_mention_move_y("input.axis('move_y')"));
}

TEST_CASE("gamepad: dead zone, d-pad, buttons; an idle pad never overrides other devices") {
  InputState in;
  input::GamepadMapper pad;
  input::GamepadState s;
  s.connected = true;
  s.left_x = 0.1f;  // inside the dead zone
  pad.update(s, in);
  CHECK(in.raw_axis("move_x") == 0);
  in.set_axis("move_x", 1);  // the keyboard
  pad.update(s, in);         // unchanged pad: no write
  CHECK(in.raw_axis("move_x") == 1);
  s.left_x = 1;
  s.a = true;
  pad.update(s, in);
  CHECK(in.raw_axis("move_x") == 1);
  CHECK(in.raw_held("jump"));
  s.left_x = 0;
  s.dpad_up = true;
  s.a = false;
  s.y = true;
  pad.update(s, in);
  CHECK(in.raw_axis("move_x") == 0);
  CHECK(in.raw_axis("move_y") == -1);
  CHECK_FALSE(in.raw_held("jump"));
  CHECK(in.raw_held("action2"));
}

TEST_CASE("usage scan finds axes and buttons like engine-web's regexes") {
  input::InputUsage u = input::detect_input_usage(R"lua(
    if input . pressed ( "jump" ) then end
    local h = input.held('action2')
    local x = input.axis("move_x")
    local cfg = input.pressed(b.jump)   -- through a table: not seen
    local s = "input.held(\"bogus x\")" -- not a word
  )lua");
  CHECK(u.move);
  CHECK_FALSE(u.look);
  CHECK(u.buttons == std::set<std::string>{"jump", "action2"});
  CHECK(input::detect_input_usage("input.axis('look_y')").look);
  CHECK_FALSE(input::detect_input_usage("input.pointer()").any());
}

// ---------------------------------------------------------------- touch controls

TEST_CASE("touch controls: layout per orientation, stick shaping, buttons, visibility from reads") {
  input::InputUsage usage;
  usage.move = true;
  usage.buttons = {"jump"};
  input::TouchControls tc(usage, true);
  input::ControlsScreen screen;  // 720x1280, 1 point per reference px
  tc.set_screen(screen);
  InputState in;

  // Nothing read yet: everything hidden, and hidden controls take no touches.
  tc.sync(in, 1);
  input::ControlsView v = tc.view();
  CHECK(v.stick.alpha == 0);
  REQUIRE(v.buttons.size() == 1);
  CHECK(v.buttons[0].alpha == 0);
  CHECK_FALSE(tc.touch_down(1, v.stick.base.center, in));

  // The game reads move_x and jump: they fade in (180 ms).
  in.axis("move_x");
  in.pressed("jump");
  tc.sync(in, 0.09f);
  CHECK(tc.view().stick.alpha == doctest::Approx(0.5));
  tc.sync(in, 1);
  v = tc.view();
  CHECK(v.stick.alpha == 1);
  // portrait layout: stick 116 at (28, 40) from the bottom-left; A (96) at right 26 / bottom 52
  CHECK(v.stick.base.radius == 58);
  CHECK(v.stick.base.center.x == 28 + 58);
  CHECK(v.stick.base.center.y == 1280 - 40 - 58);
  CHECK(v.buttons[0].circle.center.x == 720 - 26 - 48);
  CHECK(v.buttons[0].circle.center.y == 1280 - 52 - 48);

  // Push the stick right, inside the radius: shaped axes; a small down drift is dropped.
  const input::Vec2 c = v.stick.base.center;
  const float max = 116 * 0.42f;
  CHECK(tc.touch_down(7, {c.x + max, c.y + 5}, in));
  CHECK(in.raw_axis("move_x") > 0.9);
  CHECK(in.raw_axis("move_y") == 0);
  CHECK(tc.touch_move(7, {c.x + 5, c.y + 3}, in));  // inside the dead zone
  CHECK(in.raw_axis("move_x") == 0);
  CHECK(tc.touch_move(7, {c.x + 300, c.y + 300}, in));  // clamped: diagonal passes through
  CHECK(in.raw_axis("move_x") == doctest::Approx(std::sqrt(0.5)).epsilon(0.01));
  CHECK(in.raw_axis("move_y") == doctest::Approx(std::sqrt(0.5)).epsilon(0.01));
  CHECK(tc.view().stick.held);
  CHECK(tc.touch_up(7, in));
  CHECK(in.raw_axis("move_x") == 0);

  // Two fingers on A: released only when both lift.
  const input::Vec2 a = v.buttons[0].circle.center;
  CHECK(tc.touch_down(1, a, in));
  CHECK(tc.touch_down(2, {a.x + 50, a.y}, in));  // inside the 14 pt hit margin
  CHECK(in.raw_held("jump"));
  tc.touch_up(1, in);
  CHECK(in.raw_held("jump"));
  tc.touch_up(2, in);
  CHECK_FALSE(in.raw_held("jump"));
  CHECK_FALSE(tc.touch_down(3, {360, 300}, in));  // the game gets this one

  // A button the scan missed shows up once read; slots follow order (A, then B).
  in.held("action");
  tc.sync(in, 1);
  v = tc.view();
  REQUIRE(v.buttons.size() == 2);
  CHECK(std::string(v.buttons[1].label) == "B");
  CHECK(v.buttons[1].circle.radius == 38);

  // Stop reading: after 45 ticks the controls fade out.
  for (int i = 0; i < 46; i++) in.begin_tick();
  tc.sync(in, 1);
  CHECK(tc.view().stick.alpha == 0);
  CHECK(tc.view().buttons[0].alpha == 0);

  // Dialogs dim the layer; the touch-size setting grows controls from their corner.
  tc.set_dimmed(true);
  tc.set_scale(5);  // clamped to 1.5
  v = tc.view();
  CHECK(v.opacity == 0.25f);
  CHECK(v.stick.base.radius == doctest::Approx(58 * 1.5));
  CHECK(v.stick.base.center.x == doctest::Approx(28 + 58 * 1.5));
}

TEST_CASE("touch controls: points per reference px and safe area; look stick lifts the buttons") {
  input::InputUsage usage;
  usage.look = true;
  usage.buttons = {"jump"};
  input::TouchControls tc(usage, false);  // landscape: stick 100 at (28, 28)
  input::ControlsScreen screen;
  screen.ref_w = 1280;
  screen.ref_h = 720;
  screen.points_per_ref = 0.5f;  // one point = two reference px
  screen.safe.bottom = 20;
  tc.set_screen(screen);
  InputState in;
  in.axis("look_x");
  in.pressed("jump");
  tc.sync(in, 1);
  input::ControlsView v = tc.view();
  CHECK(v.look.base.radius == 100);
  CHECK(v.look.base.center.x == 1280 - 56 - 100);
  CHECK(v.look.base.center.y == 720 - 20 - 56 - 100);
  // A sits above the aim stick: bottom (38 + 100 + 40) points
  CHECK(v.buttons[0].circle.center.y == doctest::Approx(720 - 20 - (38 + 140) * 2 - 88));
  // The aim stick: per-axis dead zone 0.15, no shaping
  CHECK(tc.touch_down(4, {v.look.base.center.x + 84, v.look.base.center.y + 10}, in));
  CHECK(in.raw_axis("look_x") > 0.99);  // clamped to the rim
  CHECK(in.raw_axis("look_y") == 0);
  tc.release_all(in);
  CHECK(in.raw_axis("look_x") == 0);
  CHECK(input::shape_stick(0.1f, 0.1f).x == 0);
}

// ---------------------------------------------------------------- dialogs

TEST_CASE("dialog: typewriter timing, confirm finishes the line then advances, done after the last") {
  ui::DialogSystem sys;
  InputState in;
  sys.dialogs.open(dialog({"Hello", "Bye"}, 60));  // 60 chars/s = 1 char per tick
  for (int i = 0; i < 3; i++) {
    in.begin_tick();
    CHECK_FALSE(sys.step(in, input::kTickDt));
  }
  CHECK(sys.dialogs.current->shown == doctest::Approx(3));
  CHECK(in.blocked);
  // first press: finish the typewriter
  in.tap("jump");
  in.begin_tick();
  CHECK_FALSE(sys.step(in, input::kTickDt));
  CHECK(sys.dialogs.line_done());
  CHECK(sys.dialogs.current->index == 0);
  // next press (a tap on the box): next line
  sys.tap(-1);
  in.begin_tick();
  CHECK_FALSE(sys.step(in, input::kTickDt));
  CHECK(sys.dialogs.current->index == 1);
  CHECK(sys.dialogs.current->shown == 0);
  // an instant finish then done
  in.tap("action");
  in.begin_tick();
  sys.step(in, input::kTickDt);
  in.tap("action");
  in.begin_tick();
  auto done = sys.step(in, input::kTickDt);
  REQUIRE(done);
  CHECK(done->choice == -1);
  CHECK_FALSE(sys.open());
  CHECK(in.blocked);  // the closing tick still swallows the press
  in.begin_tick();
  sys.step(in, input::kTickDt);
  CHECK_FALSE(in.blocked);
}

TEST_CASE("dialog: choices navigate with move_y edges, confirm or tap picks; queued dialogs follow") {
  ui::DialogSystem sys;
  InputState in;
  ui::DialogState c = dialog({"Pick"}, 0);
  c.choice = true;
  c.options = {"a", "b", "c"};
  const int64_t first = c.id;
  sys.dialogs.open(c);
  ui::DialogState next = dialog({"After"}, 0, false);
  sys.dialogs.open(next);
  CHECK(sys.dialogs.queue.size() == 1);

  in.set_axis("move_y", 1);  // down: one step per edge, not per tick
  for (int i = 0; i < 3; i++) {
    in.begin_tick();
    sys.step(in, input::kTickDt);
  }
  CHECK(sys.dialogs.current->selected == 1);
  in.set_axis("move_y", 0);
  in.begin_tick();
  sys.step(in, input::kTickDt);
  in.set_axis("move_y", -1);
  in.begin_tick();
  sys.step(in, input::kTickDt);
  in.set_axis("move_y", 0);
  in.begin_tick();
  sys.step(in, input::kTickDt);
  in.set_axis("move_y", -1);  // wraps around to the last option
  in.begin_tick();
  sys.step(in, input::kTickDt);
  CHECK(sys.dialogs.current->selected == 2);
  in.set_axis("move_y", 0);
  sys.tap(1);
  in.begin_tick();
  auto done = sys.step(in, input::kTickDt);
  REQUIRE(done);
  CHECK(done->id == first);
  CHECK(done->choice == 1);
  REQUIRE(sys.open());
  CHECK(sys.dialogs.current->lines[0].text == "After");
  in.begin_tick();
  sys.step(in, input::kTickDt);
  CHECK_FALSE(in.blocked);  // the non-blocking one lets input through
  CHECK(sys.dialogs.close(sys.dialogs.current->id));
  CHECK_FALSE(sys.open());
  sys.tap(0);  // ignored without a dialog
  CHECK_FALSE(sys.step(in, input::kTickDt));
}

TEST_CASE("dialog: tapping an option while the prompt types accepts it") {
  ui::Dialogs d;
  ui::DialogState c = dialog({"A long prompt"}, 10);
  c.choice = true;
  c.options = {"yes", "no"};
  d.open(c);
  ui::DialogInput in;
  in.tap = 5;  // clamped to the last option
  auto done = d.step(input::kTickDt, in);
  REQUIRE(done);
  CHECK(done->choice == 1);
}

// ---------------------------------------------------------------- toasts

TEST_CASE("toasts: at most 4, oldest dropped, expire in game time") {
  ui::ToastQueue q;
  for (int i = 1; i <= 5; i++) q.push(i, "t" + std::to_string(i), 0, i);
  REQUIRE(q.toasts().size() == 4);
  CHECK(q.toasts().front().text == "t2");
  q.expire(2);  // "until > now" survives
  CHECK(q.toasts().size() == 3);
  CHECK(q.toasts().front().text == "t3");
  q.expire(10);
  CHECK(q.toasts().empty());
}

// ---------------------------------------------------------------- UI layout

TEST_CASE("UI layout: anchors in the safe area, stack panels, z order, scroll clamp and clip") {
  const char* scene = R"({"format": "0", "root": "world", "entities": {
    "world": {"type": "Node2D", "children": ["panel", "top", "under"]},
    "panel": {"type": "UIPanel", "props": {"anchor": "bottom_right", "size": [300, 200], "offset": [-10, -10],
              "layout": "stack", "padding": 8, "scroll": true}, "children": ["a", "hidden", "b"]},
    "a": {"type": "UIButton"},
    "hidden": {"type": "UIText", "props": {"visible": false}},
    "b": {"type": "UIButton", "props": {"anchor": "right", "size": [100, 200]}},
    "top": {"type": "UIText", "props": {"z_index": 5}},
    "under": {"type": "UIText"}
  }})";
  auto h = script::Host::create(game(scene, ""));
  REQUIRE_MESSAGE(h.ok(), h.error());
  const world::World& w = h.value()->world();
  const world::EntityId panel = w.by_id("panel"), a = w.by_id("a"), b = w.by_id("b");
  const world::EntityId top = w.by_id("top"), under = w.by_id("under");

  CHECK(ui::anchor_rect("center", {0, 0}, {100, 50}, 0, 0, 1280, 720).x == 590);

  ui::UiScreen screen{1280, 720, {20, 0, 30, 0}};
  ui::ScrollOffsets scroll;
  scroll[panel] = 1000;  // clamped to content - height
  std::vector<ui::UiNode> nodes = ui::layout_ui(w, screen, scroll);
  REQUIRE(nodes.size() == 5);  // the hidden text is left out
  // draw order: z 0 first (panel, its children, `under`), then `top` (z 5)
  CHECK(nodes[0].id == panel);
  CHECK(nodes[3].id == under);
  CHECK(nodes[4].id == top);
  CHECK(nodes[4].rect.y == 20);  // top-level anchors inside the safe area
  const ui::Rect pr = nodes[0].rect;
  CHECK(pr.x == 1280 - 300 - 10);
  CHECK(pr.y == 720 - 30 - 200 - 10);
  // content: padding 8 + a (48) + gap 12 + b (200) + 16 = 284; scroll range 84
  CHECK(nodes[0].content_height == doctest::Approx(284));
  CHECK(scroll[panel] == doctest::Approx(84));
  CHECK(nodes[1].rect.y == doctest::Approx(pr.y + 8 - 84));
  CHECK(nodes[2].rect.x == doctest::Approx(pr.x + 200));  // right column
  REQUIRE(nodes[2].clip);
  CHECK(nodes[2].scroll_panel == panel);
  // hit testing: clipped parts don't hit; `under` is input-transparent text
  CHECK(ui::hit_ui(nodes, pr.x + 250, pr.y + 50)->id == b);
  CHECK(ui::hit_ui(nodes, pr.x + 10, pr.y - 30) == nullptr);
  // headless (engine-web uiRect/uiHit): no safe area, no scrolling
  CHECK(ui::ui_rect_headless(w, top, 1280, 720).y == 0);
  CHECK(ui::ui_hit_headless(w, pr.x + 20, pr.y + 50 + 30, 1280, 720) == a);
}

TEST_CASE("UI text wraps at spaces, keeps newlines, and breaks long words") {
  render::Atlas atlas;
  render::FontStore fonts(atlas, render::FontId::Bold);
  REQUIRE(fonts.init().ok());
  const render::Font& font = fonts.font(render::FontId::Bold);
  const float w = render::layout_text(font, "hello world", 20, render::TextAlign::Left).width;
  CHECK(ui::wrap_text(font, "hello world", 20, w + 1) == std::vector<std::string>{"hello world"});
  CHECK(ui::wrap_text(font, "hello world", 20, w - 1) == std::vector<std::string>{"hello", "world"});
  CHECK(ui::wrap_text(font, "a\n\nb", 20, 500) == std::vector<std::string>{"a", "", "b"});
  std::vector<std::string> cut = ui::wrap_text(font, "abcdefghij", 20, 30);
  CHECK(cut.size() > 2);
  std::string joined;
  for (const std::string& s : cut) joined += s;
  CHECK(joined == "abcdefghij");
}

// ---------------------------------------------------------------- host

TEST_CASE("host: pointer signals and swipes fire immediately; tap_screen presses UI, then the world") {
  const char* scene = R"({"format": "0", "root": "world", "entities": {
    "world": {"type": "Node2D", "children": ["btn", "box"]},
    "btn": {"type": "UIButton", "props": {"anchor": "center", "size": [200, 80], "text": "Go"}},
    "box": {"type": "Sprite2D", "props": {"position": [100, 100], "size": [40, 40]}}
  }})";
  auto pkg = game(scene, R"(
    input.pointerDown:connect(function(p) print("down", p.x, p.y) end)
    input.pointerUp:connect(function(p) print("up", p.x, p.y) end)
    input.swipe:connect(function(dir, v) print("swipe", dir, math.floor(v.x)) end)
    entity("btn").pressed:connect(function() print("pressed") end)
    entity("btn").tapped:connect(function() print("btn tapped") end)
    entity("box").tapped:connect(function() print("box tapped") end)
    game.paused:connect(function() print("paused") end)
    game.resumed:connect(function() print("resumed") end)
  )");
  auto h = script::Host::create(pkg);
  REQUIRE_MESSAGE(h.ok(), h.error());
  script::Host& host = *h.value();
  host.step();
  host.pointer_down(10, 20, 0);
  host.pointer_move(60, 20);
  host.pointer_up(110, 20, 0.5);
  CHECK(host.tap_screen(640, 360) == "btn");
  CHECK(host.tap_screen(100, 100) == "box");
  CHECK(host.tap_screen(5, 700) == "");
  host.pause();
  host.pause();
  CHECK(host.paused());
  host.resume();
  CHECK(logs_of(host) ==
        "down 10 20\nup 110 20\nswipe right 200\n"
        "down 640 360\nup 640 360\npressed\nbtn tapped\n"
        "down 100 100\nup 100 100\nbox tapped\n"
        "down 5 700\nup 5 700\n"
        "paused\nresumed\n");
  // tap_screen keeps input.pointer() for 5 ticks
  for (int i = 0; i < 5; i++) host.step();
  CHECK(host.input().pointer());
  host.step();
  CHECK_FALSE(host.input().pointer());
}

TEST_CASE("host: ui.toast queues (max 4, game time); dialogs block input and take taps") {
  const char* scene = R"({"format": "0", "root": "world", "entities": {"world": {"type": "Node2D"}}})";
  auto pkg = game(scene, R"(
    for i = 1, 5 do ui.toast("t" .. i, i) end
    local d = ui.choice("Pick one", {"red", "blue"}, function(i) print("picked", i) end, {speed = 0})
    onTick(function() if input.axis("move_x") ~= 0 then print("input leaked") end end)
  )");
  auto h = script::Host::create(pkg);
  REQUIRE_MESSAGE(h.ok(), h.error());
  script::Host& host = *h.value();
  REQUIRE(host.toasts().toasts().size() == 4);
  CHECK(host.toasts().toasts().front().text == "t2");
  host.input().set_axis("move_x", 1);
  host.step();
  host.step();
  CHECK(host.toasts().toasts().size() == 4);  // t2 lasts 2 s
  host.input().set_axis("move_x", 0);
  CHECK(host.tap_screen(10, 10) == "dialog");
  host.dialogs().tap(1);  // the platform's option hit test
  host.step();
  for (int i = 0; i < 120; i++) host.step();
  CHECK(host.toasts().toasts().size() == 3);
  CHECK(logs_of(host) == "picked 2\n");
}
