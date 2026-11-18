// Engine polish: 2D lighting props, mid-game start for tools, stacked panels, tappedAt, Text2D anchors,
// onTick/after handles, camera.viewSize/screen.size, pointer gestures, prop aliases/resets, validator.
// Port of engine-web/test/polish.test.ts (same numbers and thresholds).
#include <algorithm>
#include <cmath>

#include "kits/kit_test.h"
#include "pkg/catalog.h"
#include "pkg/validate.h"
#include "render/font.h"
#include "ui/layout.h"

using namespace dreamsy;
using namespace dreamsy::test;

namespace {

// TS pkg(): manifest (pixel preset, `manifest_extra` before [style]) + a main scene from JSON text.
FileMap make_pkg(const std::string& entities, FileMap files = {}, const std::string& manifest_extra = "",
                 const std::string& root = "world") {
  files["dreamsy.toml"] = "format = \"0\"\nname = \"P\"\ndimension = \"2d\"\nentry_scene = \"scenes/main.scene.json\"\n" +
                          manifest_extra + "\n[style]\npreset = \"pixel\"\n";
  files["scenes/main.scene.json"] = R"({"format": "0", "root": ")" + root + R"(", "entities": )" + entities + "}";
  return files;
}

// TS script(): a `world` root running scripts/client/main.luau. `top` = the ids of world's direct
// children (TS computes them: entities nobody lists as a child); `entities` = their JSON members.
FileMap script_pkg(const std::string& body, const std::string& top = "", const std::string& entities = "",
                   FileMap files = {}, const std::string& manifest_extra = "") {
  files["scripts/client/main.luau"] = body;
  return make_pkg(R"({"world": {"type": "Node2D", "scripts": ["scripts/client/main.luau"], "children": [)" + top + "]}" +
                      (entities.empty() ? "" : ", " + entities) + "}",
                  files, manifest_extra);
}

// TS logs(): info lines that aren't engine notes ("[...]").
std::vector<std::string> info_logs(const Game& g) {
  std::vector<std::string> out;
  for (const auto& l : g->logs())
    if (l.level == "info" && l.text.rfind("[", 0) != 0) out.push_back(l.text);
  return out;
}

bool has_line(const std::vector<std::string>& lines, const std::string& line) {
  return std::find(lines.begin(), lines.end(), line) != lines.end();
}

using Strs = std::vector<std::string>;

bool has_props(const char* type, const Strs& props) {
  const pkg::EntityType* t = pkg::Catalog::get().type(type);
  if (!t) return false;
  return std::all_of(props.begin(), props.end(), [&](const std::string& p) { return t->prop(p) != nullptr; });
}

std::string rect_text(const ui::Rect& r) {
  auto n = [](double v) { return std::to_string(static_cast<long long>(std::llround(v))); };
  return "[" + n(r.x) + "," + n(r.y) + "," + n(r.w) + "," + n(r.h) + "]";
}

std::vector<std::string> issue_codes(const FileMap& files) {
  auto f = pkg::Files::from_map(files);
  REQUIRE_MESSAGE(f.ok(), f.error());
  pkg::LoadResult r = pkg::load_package(std::move(f).value());
  std::vector<std::string> out;
  for (const auto& i : r.issues) out.push_back(i.code);
  return out;
}

}  // namespace

TEST_SUITE("api polish") {

// ---------------------------------------------------------------- 2D lighting

TEST_CASE("polish: 2D lighting: catalog: Light2D, Lighting2D, emissive + blend props") {
  CHECK(has_props("Light2D", {"radius", "color", "energy", "falloff", "flicker", "flicker_speed", "enabled"}));
  CHECK(has_props("Lighting2D", {"ambient", "darkness", "vignette"}));
  for (const char* t : {"Sprite2D", "Text2D", "Particles2D"}) CHECK_MESSAGE(has_props(t, {"emissive"}), t);
  for (const char* t : {"Sprite2D", "Particles2D"}) CHECK_MESSAGE(has_props(t, {"blend"}), t);
}

TEST_CASE("polish: 2D lighting: lights follow their parent, flicker deterministically, are tweenable and capped at 64 nearest") {
  // Portable part. NOT PORTED: collectLights / lightAt / flickerFactor / lightingState. Their C++
  // counterparts (collect_lighting, flicker_factor) are private to play/scene_draw.cpp and the
  // dreamsy_play library isn't linked into the tests; the light math itself runs in the renderer's
  // shader. What this checks: the scene state those functions read.
  Game g = start(script_pkg(R"(
      local torch = entity("torch")
      tween(torch, { energy = 0 }, 1, "linear")
      for i = 1, 70 do spawn("Light2D", { position = vec2(i * 100, 0), radius = 50 }) end
    )",
                            R"("dark", "player")", R"(
      "dark": {"type": "Lighting2D", "props": {"ambient": "#000000", "darkness": 1, "vignette": 0.3}},
      "player": {"type": "Node2D", "props": {"position": [300, 200]}, "children": ["torch"]},
      "torch": {"type": "Light2D", "props": {"position": [10, 0], "radius": 100, "color": "#ffffff", "energy": 1}})"));
  CHECK_NO_ERRORS(g);
  const world::World& w = g->world();
  CHECK(w.num(g.entity("dark"), "darkness") == 1);
  CHECK_CLOSE(w.num(g.entity("dark"), "vignette"), 0.3, 2);
  CHECK(g.of_type("Light2D").size() == 71);  // 64 nearest of these would be drawn
  // the torch's world position follows its parent
  world::Mat2D m = w.global(g.id("torch"));
  CHECK(m.tx == 310);
  CHECK(m.ty == 200);
  g->world().set_raw(g.entity("player"), "position", world::Value::vec(500, 500));
  m = w.global(g.id("torch"));
  CHECK(m.tx == 510);
  CHECK(m.ty == 500);
  // tween energy -> 0: the torch drops out (collect_lighting skips energy <= 0)
  g.step(61);
  CHECK(w.num(g.entity("torch"), "energy") <= 0);
}

// "2D lighting: no Lighting2D (or hidden) = no darkness; disabled lights are skipped": NOT PORTED. It
// asserts lightingState() == null and collectLights() == [], both private to play/scene_draw.cpp
// (collect_lighting), which the test binary doesn't link.

// ---------------------------------------------------------------- tools start mid-game

namespace {
FileMap mid_game_pkg() {
  FileMap files;
  files["scripts/client/main.luau"] = R"(
      local p = sceneParams()
      print("scene", currentScene(), "level", p.level, "coins", save.get("coins", 0), "clock", clock.now())
    )";
  files["scenes/level.scene.json"] =
      R"({"format": "0", "root": "w2", "entities": {"w2": {"type": "Node2D", "scripts": ["scripts/client/main.luau"]}}})";
  return make_pkg(R"({"world": {"type": "Node2D"}})", files);
}
}  // namespace

TEST_CASE("polish: tools start mid-game: Game.load scene + sceneParams; simulate scene/sceneParams/save/clock") {
  const FileMap p = mid_game_pkg();
  script::HostOptions o;
  o.scene = "scenes/level.scene.json";
  o.scene_params = parse_json(R"({"level": 3})");
  Game g = start(p, o);
  const Strs l = info_logs(g);
  REQUIRE(l.size() == 1);
  CHECK(matches(l[0], "^scene\tscenes/level\\.scene\\.json\tlevel\t3\tcoins\t0"));

  SimulateOptions so;
  so.scene = "scenes/level.scene.json";
  so.scene_params = parse_json(R"({"level": 7})");
  so.save = parse_json(R"({"coins": 42})");
  so.clock = 1000;
  PlaytestReport r = simulate(p, {}, 0.1, so);
  CHECK(r.errors.empty());
  CHECK(matches(join(r.logs), "level\t7\tcoins\t42\tclock\t1000"));
  CHECK(J(&r.save).dump() == R"({"coins":42})");
}

TEST_CASE("polish: tools start mid-game: simulate autoDialog answers choices; audio summary is not capped") {
  FileMap extra;
  extra["data/sfx/blip.json"] = R"({"freq": 600})";
  const FileMap p = script_pkg(R"(
      ui.choice("Pick", { "A", "B", "C" }, function(i) print("picked", i) end)
      for i = 1, 700 do sfx.play("blip") end
    )",
                               "", "", extra);
  SimulateOptions so;
  so.auto_dialog = "2";
  PlaytestReport r = simulate(p, {}, 1, so);
  CHECK(r.errors.empty());
  CHECK(contains(join(r.logs), "picked\t2"));
  CHECK(r.sfx["blip"] == 700);
}

// ---------------------------------------------------------------- UIPanel layout = stack

TEST_CASE("polish: UIPanel layout = stack: stacks visible children in order with gap/padding; hidden ones take no space; taps hit stacked rects") {
  Game g = start(script_pkg(R"(
      entity("b2").pressed:connect(function() print("b2") end)
    )",
                            R"("list")", R"(
      "list": {"type": "UIPanel", "props": {"size": [300, 600], "layout": "stack", "gap": 10, "padding": 20, "scroll": true}, "children": ["b1", "hid", "b2", "b3"]},
      "b1": {"type": "UIButton", "props": {"size": [200, 50]}},
      "hid": {"type": "UIButton", "props": {"size": [200, 500], "visible": false}},
      "b2": {"type": "UIButton", "props": {"size": [200, 60], "anchor": "top", "offset": [0, 5]}},
      "b3": {"type": "UIButton", "props": {"size": [100, 40], "anchor": "top_right"}})"));
  CHECK_NO_ERRORS(g);
  auto r = [&](const char* id) { return rect_text(ui::ui_child_rect(g->world(), g.id(id), 300, 600)); };
  CHECK(r("b1") == "[0,20,200,50]");
  CHECK(r("b2") == "[50," + std::to_string(20 + 50 + 10 + 5) + ",200,60]");
  CHECK(r("b3") == "[200," + std::to_string(20 + 50 + 10 + 5 + 60 + 10) + ",100,40]");
  CHECK(g.tap(150, 100) == "b2");
  CHECK(has_line(info_logs(g), "b2"));
  // non-stack panels keep anchors
  g->world().set_raw(g.entity("list"), "layout", world::Value::string("none"));
  CHECK(r("b3") == "[200,0,100,40]");
}

// ---------------------------------------------------------------- tappedAt

TEST_CASE("polish: tappedAt (cell taps): reports local coords from the sprite's top-left, even when scaled/moved") {
  Game g = start(script_pkg(R"(
      entity("board").tappedAt:connect(function(p)
        print("cell", math.floor(p.x / 50), math.floor(p.y / 50), p.x, p.y)
      end)
    )",
                            R"("board")", R"("board": {"type": "Sprite2D", "props": {"position": [400, 300], "size": [400, 400]}})"));
  CHECK_NO_ERRORS(g);
  g->tap_world(200 + 75, 100 + 120);  // the board spans 200..600 x 100..500
  CHECK(info_logs(g) == Strs{"cell\t1\t2\t75\t120"});
}

// ---------------------------------------------------------------- Text2D align anchor

TEST_CASE("polish: Text2D align anchor: center = centered on position, left = starts at position, right = ends at position; vertically centered") {
  // engine-web text2DOrigin(align, w, h) is the offset from the position; C++ text_block_origin
  // returns the block's top-left for a position, so position (0, 0) gives the same offset.
  render::Vec2 o = render::text_block_origin({0, 0}, render::TextAlign::Center, 100, 20);
  CHECK(o.x == -50);
  CHECK(o.y == -10);
  o = render::text_block_origin({0, 0}, render::TextAlign::Left, 100, 20);
  CHECK(o.x == 0);
  CHECK(o.y == -10);
  o = render::text_block_origin({0, 0}, render::TextAlign::Right, 100, 20);
  CHECK(o.x == -100);
  CHECK(o.y == -10);
  const pkg::PropDef* align = pkg::Catalog::get().type("Text2D")->prop("align");
  REQUIRE(align);
  REQUIRE(align->default_value);
  CHECK(align->default_value->text == "center");
}

// ---------------------------------------------------------------- handles

TEST_CASE("polish: handles: onTick -> Connection, after/every -> Timer: onTick:disconnect stops it; after():cancel prevents it") {
  Game g = start(script_pkg(R"(
      local n = 0
      local c
      c = onTick(function() n += 1 if n == 3 then c:disconnect() end end)
      local t = after(0.05, function() print("after fired") end)
      t:cancel()
      local e = every(0.02, function() print("every") end)
      after(0.03, function() e:cancel() end)
      after(0.1, function() print("n", n, c.connected) end)
    )"));
  g.step(10);
  CHECK_NO_ERRORS(g);
  CHECK(info_logs(g) == Strs{"every", "n\t3\tfalse"});
}

// ---------------------------------------------------------------- camera.viewSize / screen.size

TEST_CASE("polish: camera.viewSize / screen.size: reference size per orientation; view size divides by zoom") {
  Game g = start(script_pkg(R"(
      print(screen.size(), camera.viewSize())
      entity("cam").zoom = 2
      print(camera.viewSize())
    )",
                            R"("cam")", R"("cam": {"type": "Camera2D"})", {}, "orientation = \"portrait\""));
  CHECK_NO_ERRORS(g);
  CHECK(info_logs(g) == Strs{"vec2(720, 1280)\tvec2(720, 1280)", "vec2(360, 640)"});
}

// ---------------------------------------------------------------- pointer gestures

TEST_CASE("polish: pointer gestures: pointerDown/pointerUp/swipe fire even when down+up happen between ticks; input.pointer() survives one tick") {
  Game g = start(script_pkg(R"(
      input.pointerDown:connect(function(p) print("down", p.x, p.y) end)
      input.pointerUp:connect(function(p) print("up", p.x, p.y) end)
      input.swipe:connect(function(dir, v) print("swipe", dir, v.x > 0) end)
      onTick(function() local p = input.pointer() if p then print("ptr", p.x) end end)
    )"));
  g->pointer_down(100, 500);
  g->pointer_up(300, 510);  // same tick: a flick
  g.step();
  CHECK_NO_ERRORS(g);
  CHECK(info_logs(g) == Strs{"down\t100\t500", "up\t300\t510", "swipe\tright\ttrue", "ptr\t300"});
  g.step(3);
  const Strs l = info_logs(g);
  CHECK(std::count_if(l.begin(), l.end(), [](const std::string& s) { return s.rfind("ptr", 0) == 0; }) == 1);
}

TEST_CASE("polish: pointer gestures: simulate swipe timeline step") {
  const FileMap p = script_pkg(R"(input.swipe:connect(function(dir) print("swipe", dir) end))");
  TimelineStep s;
  s.t = 0.2;
  s.swipe = TimelineStep::Swipe{{360, 900}, {360, 600}, 0.1};
  PlaytestReport r = simulate(p, {s}, 0.5);
  CHECK(contains(join(r.logs), "swipe\tup"));
}

TEST_CASE("polish: pointer gestures: open dialogs take taps before any UI panel (modal panels don't stall them)") {
  Game g = start(script_pkg(R"(
      entity("modal").tapped:connect(function() print("modal") end)
      ui.dialog({ "hello" }, { speed = 0 }).done:connect(function() print("done") end)
    )",
                            R"("modal")", R"("modal": {"type": "UIPanel", "props": {"size": [720, 1280], "z_index": 4096}})"));
  g.step();
  CHECK(g.tap(360, 640) == "dialog");
  g.step(2);
  CHECK(info_logs(g) == Strs{"done"});
}

// ---------------------------------------------------------------- props

TEST_CASE("polish: props: aliases and nil resets: Sprite2D color aliases modulate; nil resets to the default") {
  Game g = start(script_pkg(R"(
      local s = entity("s")
      print(s.color, s.modulate)
      s.color = color("#00ff00")
      print(s.modulate)
      s.modulate = nil
      print(s.modulate)
      local b = entity("b")
      b.text = nil
      print(b.text, b.icon)
    )",
                            R"("s", "b")", R"("s": {"type": "Sprite2D", "props": {"color": "#ff0000"}}, "b": {"type": "UIButton", "props": {"text": "Go"}})"));
  CHECK_NO_ERRORS(g);
  CHECK(info_logs(g) == Strs{"#ff0000\t#ff0000", "#00ff00", "#ffffff", "Button\tnil"});
  std::optional<world::Value> m = g->world().get_prop(g.entity("s"), "modulate");
  REQUIRE(m);
  CHECK(*m == world::Value::color(1, 1, 1, 1));
}

// ---------------------------------------------------------------- validator

TEST_CASE("polish: validator: screen-only scenes don't warn about a missing camera; world scenes still do") {
  const Strs ui_codes = issue_codes(make_pkg(R"({"ui": {"type": "Folder", "children": ["t"]}, "t": {"type": "UIText", "props": {"text": "hi"}}})",
                                             {}, "", "ui"));
  CHECK_FALSE(has_line(ui_codes, "scene.no_camera"));
  const Strs world_codes = issue_codes(make_pkg(R"({"world": {"type": "Node2D"}})"));
  CHECK(has_line(world_codes, "scene.no_camera"));
}

TEST_CASE("polish: validator: new UIPanel / UIText props are in the catalog") {
  CHECK(has_props("UIPanel", {"layout", "gap", "padding", "tint", "radius", "clip"}));
  CHECK(has_props("UIText", {"valign"}));
}

}  // TEST_SUITE
