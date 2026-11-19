// Engine features: sprite animation, tweens, particles, camera, save data, dialogs, collision layers,
// portrait layout math. Port of engine-web/test/features.test.ts (same numbers and thresholds).
#include <algorithm>
#include <cmath>

#include "kits/kit_test.h"
#include "render/view.h"
#include "ui/layout.h"

using namespace dreamsy;
using namespace dreamsy::test;

namespace {

const char* kSvg = R"(<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#f00"/></svg>)";

// An image asset: assets/<id>.svg + its meta file (TS asset()).
void add_asset(FileMap& files, const std::string& id) {
  files["assets/" + id + ".svg"] = kSvg;
  files["assets/" + id + ".meta.json"] = R"({"kind": "image", "file": ")" + id + R"(.svg"})";
}

// TS pkg(): a manifest (pixel preset, `manifest_extra` before [style]) and a main scene whose
// entities are given as JSON text, plus extra files.
FileMap make_pkg(const std::string& entities, FileMap files = {}, const std::string& manifest_extra = "") {
  files["dreamsy.toml"] = "format = \"0\"\nname = \"F\"\ndimension = \"2d\"\nentry_scene = \"scenes/main.scene.json\"\n" +
                          manifest_extra + "\n[style]\npreset = \"pixel\"\n";
  files["scenes/main.scene.json"] = R"({"format": "0", "root": "world", "entities": )" + entities + "}";
  return files;
}

// The fox animations + the three frame images (TS animFiles).
FileMap anim_files() {
  FileMap f;
  add_asset(f, "f1");
  add_asset(f, "f2");
  add_asset(f, "f3");
  f["data/anims/fox.json"] = R"({
    "run": {"frames": ["asset:f1", "asset:f2", "asset:f3"], "fps": 10},
    "jump": {"frames": ["asset:f1", "asset:f2"], "fps": 10, "loop": false, "next": "idle"},
    "idle": {"frames": ["asset:f3"], "fps": 1}
  })";
  return f;
}

bool any_match(const std::vector<std::string>& lines, const std::string& re) {
  return std::any_of(lines.begin(), lines.end(), [&](const std::string& l) { return matches(l, re); });
}
bool has_line(const std::vector<std::string>& lines, const std::string& line) {
  return std::find(lines.begin(), lines.end(), line) != lines.end();
}

// A component of a vector/color prop (TS e.get<number[]>(key)[i]).
double vec_at(Game& g, std::string_view id, std::string_view key, int i) {
  std::optional<world::Value> v = g->world().get_prop(g.entity(id), key);
  return v && v->kind == world::ValueKind::Vec ? v->v[i] : std::nan("");
}

// Sets a raw prop between ticks (TS `e.props.position = [x, y]`).
void set_position(Game& g, std::string_view id, double x, double y) {
  g->world().set_raw(g.entity(id), "position", world::Value::vec(x, y));
}

// ---- particles

// TS particleGame(): a Particles2D at (100, 100) with `props` (JSON members) and a script that logs
// its count at t = 1 s. `script` replaces that script when given.
Game particle_game(const std::string& props, uint32_t seed = 3, const std::string& script = "") {
  FileMap files;
  files["scripts/client/fx.luau"] = !script.empty() ? script :
      "local e = script.entity\nonTick(function() if time() > 0.99 and time() < 1.01 then print(\"count \" .. e.particleCount) end end)";
  script::HostOptions o;
  o.seed = seed;
  return start(make_pkg(R"({"world": {"type": "Node2D", "children": ["fx"]},
    "fx": {"type": "Particles2D", "props": {"position": [100, 100], )" + props + R"(}, "scripts": ["scripts/client/fx.luau"]}})",
                   files),
               o);
}

int particle_count(Game& g) {
  world::Entity& fx = g.entity("fx");
  return fx.emitter ? fx.emitter->count() : 0;
}

// ---- camera

// TS camGame(): `p` at (0, 0) with a script, followed by a Camera2D with extra props (JSON members).
Game cam_game(const std::string& cam, const std::string& script = "") {
  FileMap files;
  files["scripts/client/c.luau"] = script;
  return start(make_pkg(R"({"world": {"type": "Node2D", "children": ["p", "cam"]},
    "p": {"type": "Node2D", "props": {"position": [0, 0]}, "scripts": ["scripts/client/c.luau"]},
    "cam": {"type": "Camera2D", "props": {"follow": "p")" + (cam.empty() ? "" : ", " + cam) + R"(}}})",
                   files));
}

// ---- dialogs

Game dlg(const std::string& script) {
  FileMap files;
  files["scripts/client/d.luau"] = script;
  return start(make_pkg(R"({"world": {"type": "Node2D", "children": ["p"]}, "p": {"type": "Node2D", "scripts": ["scripts/client/d.luau"]}})",
                   files));
}

ui::DialogState* current_dialog(Game& g) {
  std::optional<ui::DialogState>& d = g->dialogs().dialogs.current;
  return d ? &*d : nullptr;
}

// ---- save data

FileMap save_pkg() {
  FileMap files;
  files["scripts/client/session.luau"] = R"(
      local n = save.get("runs", 0) + 1
      save.set("runs", n)
      save.set("profile", { name = "fox", levels = { 1, 2, 3 }, best = { time = 12.5 } })
      print("runs " .. n)
      game.sceneLoaded:connect(function(p)
        if p == "scenes/two.scene.json" then
          local prof = save.get("profile")
          print("two:" .. prof.name .. ":" .. #prof.levels .. ":" .. prof.best.time .. ":" .. save.get("runs"))
          local ok, err = pcall(function() save.set("bad", vec2(1, 2)) end)
          print(err)
          ok, err = pcall(function() save.set("huge", string.rep("x", 70000)) end)
          print(err)
          save.remove("profile")
          print("after remove " .. tostring(save.get("profile")))
        end
      end)
      after(0.1, function() loadScene("scenes/two.scene.json") end)
    )";
  files["scenes/two.scene.json"] = R"({"format": "0", "root": "two", "entities": {"two": {"type": "Node2D"}}})";
  return make_pkg(R"({"world": {"type": "Node2D"}})", files);
}

}  // namespace

TEST_SUITE("api features") {

// ---------------------------------------------------------------- sprite animation

TEST_CASE("features: sprite animation: advances frames at fps, loops, and plays from a scene prop") {
  Game g = start(make_pkg(R"({"world": {"type": "Node2D", "children": ["s"]},
    "s": {"type": "Sprite2D", "props": {"anims": "data/anims/fox.json", "anim": "run"}}})",
                     anim_files()));
  auto tex = [&] { return g->world().str(g.entity("s"), "texture"); };
  g.step(1);
  CHECK(tex() == "asset:f1");
  g.step(6);  // 7 ticks = 0.1167 s -> frame 1
  CHECK(tex() == "asset:f2");
  g.step(6);
  CHECK(tex() == "asset:f3");
  g.step(6);  // wraps
  CHECK(tex() == "asset:f1");
  CHECK_NO_ERRORS(g);
}

TEST_CASE("features: sprite animation: e:play on a body forwards to its sprite; non-loop fires animFinished then plays `next`; play() is idempotent") {
  FileMap files = anim_files();
  files["scripts/client/p.luau"] = R"(
          local e = script.entity
          finished = {}
          e.animFinished:connect(function(name) table.insert(finished, name) end)
          e:play("jump")
          onTick(function() if time() < 0.05 then e:play("jump") end end) -- calling every tick must not restart
          local ok, err = pcall(function() e:play("fly") end)
          print(err)
          onTick(function() if time() > 0.5 and time() < 0.52 then print("done:" .. table.concat(finished, ",")) end end)
        )";
  Game g = start(make_pkg(R"({"world": {"type": "Node2D", "children": ["body"]},
    "body": {"type": "Body2D", "props": {"body": "kinematic"}, "children": ["spr"], "scripts": ["scripts/client/p.luau"]},
    "spr": {"type": "Sprite2D", "props": {"anims": "data/anims/fox.json"}}})",
                     files));
  CHECK(g->world().str(g.entity("spr"), "anim") == "jump");
  g.step(14);  // 2 frames at 10 fps = 0.2 s -> finished at tick 12
  CHECK(g->world().str(g.entity("spr"), "anim") == "idle");
  CHECK(g->world().str(g.entity("spr"), "texture") == "asset:f3");
  g.step(20);
  CHECK_NO_ERRORS(g);
  const std::vector<std::string> logs = g.logs();
  CHECK(any_match(logs, R"(no animation "fly".*has: run, jump, idle)"));
  CHECK(has_line(logs, "done:jump"));
}

TEST_CASE("features: sprite animation: auto_flip faces the body's horizontal velocity") {
  Game g = start(make_pkg(R"({"world": {"type": "Node2D", "children": ["body"]},
    "body": {"type": "Body2D", "props": {"body": "kinematic"}, "children": ["spr"]},
    "spr": {"type": "Sprite2D", "props": {"auto_flip": true}}})"));
  auto flip = [&] { return g->world().flag(g.entity("spr"), "flip_h"); };
  g.step(2);
  CHECK_FALSE(flip());
  g->physics()->set_velocity(g.id("body"), -100, 0);
  g.step(2);
  CHECK(flip());
  g->physics()->set_velocity(g.id("body"), 100, 0);
  g.step(2);
  CHECK_FALSE(flip());
}

// ---------------------------------------------------------------- tweens

TEST_CASE("features: tweens: interpolates position/scale/rotation/modulate with easings and fires done") {
  FileMap files;
  files["scripts/client/t.luau"] = R"(
          local e = script.entity
          local t = tween(e, { position = vec2(100, 50), rotation = 90, modulate = color("#000000") }, 1, "linear")
          t.done:connect(function() print("tween done at " .. string.format("%.2f", time())) end)
          tween(e, { scale = vec2(2, 2) }, 0.5, { easing = "quad_out", delay = 0.5 })
        )";
  Game g = start(make_pkg(R"({"world": {"type": "Node2D", "children": ["s"]},
    "s": {"type": "Sprite2D", "props": {"position": [0, 0]}, "scripts": ["scripts/client/t.luau"]}})",
                     files));
  g.step(30);  // 0.5 s
  CHECK_CLOSE(g.pos("s").x, 50, 5);
  CHECK_CLOSE(g.pos("s").y, 25, 5);
  CHECK_CLOSE(g->world().num(g.entity("s"), "rotation"), 45, 5);
  CHECK_CLOSE(vec_at(g, "s", "modulate", 0), 0.5, 5);
  CHECK_CLOSE(vec_at(g, "s", "scale", 0), 1, 5);  // delayed
  g.step(15);  // 0.75 s: scale quad_out at p = 0.5 -> 0.75
  CHECK_CLOSE(vec_at(g, "s", "scale", 0), 1.75, 5);
  g.step(20);
  CHECK(g.pos("s").x == 100);
  CHECK(g.pos("s").y == 50);
  CHECK(vec_at(g, "s", "scale", 0) == 2);
  CHECK(vec_at(g, "s", "scale", 1) == 2);
  CHECK(has_line(g.logs(), "tween done at 1.00"));
  CHECK(g->tween_count() == 0);
  CHECK_NO_ERRORS(g);
}

TEST_CASE("features: tweens: cancel stops it, loop+yoyo keeps going, bad props are clear errors") {
  FileMap files;
  files["scripts/client/t.luau"] = R"(
          local a, b = script.entity, entity("b")
          local t = tween(a, { position = vec2(100, 0) }, 1, "linear")
          after(0.25, function() t:cancel() end)
          tween(b, { position = vec2(0, 60) }, 0.5, { easing = "sine_in_out", loop = true, yoyo = true })
          local ok, err = pcall(function() tween(a, { text = "x" }, 1) end)
          print(err)
          ok, err = pcall(function() tween(a, { position = vec2(1, 1) }, 1, "wobble") end)
          print(err)
        )";
  Game g = start(make_pkg(R"({"world": {"type": "Node2D", "children": ["a", "b"]},
    "a": {"type": "Sprite2D", "scripts": ["scripts/client/t.luau"]}, "b": {"type": "Sprite2D"}})",
                     files));
  g.step(60);
  CHECK_CLOSE(g.pos("a").x, (14.0 / 60) * 100, 5);  // timers run before tweens: cancelled at tick 15
  CHECK_CLOSE(g.pos("b").y, 0, 3);                   // 1 s = one full there-and-back
  g.step(30);
  CHECK_CLOSE(g.pos("b").y, 60, 3);
  const std::string logs = g.log_text();
  CHECK(matches(logs, R"(no tweenable property "text")"));
  CHECK(matches(logs, R"(unknown easing "wobble")"));
}

// ---------------------------------------------------------------- particles

TEST_CASE("features: particles: emits at rate, ages out, bursts, caps at max_particles") {
  Game g = particle_game(R"("rate": 60, "lifetime": 2, "lifetime_random": 0)");
  g.step(60);
  CHECK(particle_count(g) >= 59);
  CHECK(particle_count(g) <= 60);
  CHECK(any_match(g.logs(), R"(^count \d+$)"));
  g.step(180);  // steady state: rate x lifetime
  CHECK(particle_count(g) >= 118);
  CHECK(particle_count(g) <= 121);

  // TS calls game.burst() between ticks; the C++ host's burst is internal, so the script bursts
  // (e:burst, the same code path) on tick 5 and logs the counts right after each burst.
  Game g2 = particle_game(R"("emitting": false, "max_particles": 50, "lifetime": 0.5, "lifetime_random": 0)", 3, R"(
    local e = script.entity
    local n = 0
    onTick(function()
      n += 1
      if n == 5 then
        print("before " .. e.particleCount)
        e:burst(30)
        print("b1 " .. e.particleCount)
        e:burst(30)
        print("b2 " .. e.particleCount)
      end
    end)
  )");
  g2.step(5);
  CHECK(g2.logs_with("before ") == std::vector<std::string>{"0"});
  CHECK(g2.logs_with("b1 ") == std::vector<std::string>{"30"});
  CHECK(g2.logs_with("b2 ") == std::vector<std::string>{"50"});  // capped
  CHECK(particle_count(g2) == 50);
  g2.step(31);  // > 0.5 s
  CHECK(particle_count(g2) == 0);
  CHECK_NO_ERRORS(g2);
}

TEST_CASE("features: particles: is deterministic for a seed, moves with gravity in world space") {
  const std::string props = R"("rate": 30, "gravity": [0, 600], "direction": -90, "spread": 30)";
  Game a = particle_game(props), b = particle_game(props);
  a.step(40);
  b.step(40);
  const world::Emitter& ea = *a.entity("fx").emitter;
  const world::Emitter& eb = *b.entity("fx").emitter;
  REQUIRE(ea.count() == eb.count());
  for (int i = 0; i < ea.count(); i++) CHECK(ea.x(i) == eb.x(i));
  // TS: the oldest particle went up, then fell back down: its vy > -120. The C++ emitter doesn't
  // expose velocities, so compare positions with a gravity-free run of the same seed (same random
  // draws, same particles): gravity has pulled the oldest particle down by g t^2 / 2.
  Game n = particle_game(R"("rate": 30, "gravity": [0, 0], "direction": -90, "spread": 30)");
  n.step(40);
  const world::Emitter& en = *n.entity("fx").emitter;
  REQUIRE(en.count() == ea.count());
  int oldest = 0;
  for (int i = 1; i < ea.count(); i++)
    if (ea.age(i) > ea.age(oldest)) oldest = i;
  const double t = ea.age(oldest);
  CHECK(ea.y(oldest) - en.y(oldest) == doctest::Approx(600 * t * t / 2).epsilon(0.1));
  // vy = vy0 + g t with vy0 >= -120 * 1.3 (speed 120, speed_random 0.3): > -120 once g t > 36.
  CHECK(-120 * 1.3 + 600 * t > -120);
}

TEST_CASE("features: particles: e:burst from Luau") {
  FileMap files;
  files["scripts/client/b.luau"] = "script.entity:burst(12)\nprint(\"n=\" .. script.entity.particleCount)";
  Game g = start(make_pkg(R"({"world": {"type": "Node2D", "children": ["fx"]},
    "fx": {"type": "Particles2D", "props": {"emitting": false}, "scripts": ["scripts/client/b.luau"]}})",
                     files));
  CHECK(has_line(g.logs(), "n=12"));
  CHECK_NO_ERRORS(g);
}

// ---------------------------------------------------------------- camera

TEST_CASE("features: camera: shake offsets decay to zero and are deterministic") {
  // p sits at (0, 0) and the camera follows it, so the view center is the shake offset.
  auto run = [](double& final_x) {
    Game g = cam_game("", "camera.shake(10, 0.5)");
    std::vector<std::pair<double, double>> offs;
    g.step(40, [&](int) {
      const script::Host::CameraView v = g->camera_view();
      offs.push_back({v.x, v.y});
    });
    final_x = g->camera_view().x;
    return offs;
  };
  double final_x = -1;
  const auto offs = run(final_x);
  std::vector<double> mags;
  for (const auto& [x, y] : offs) mags.push_back(std::hypot(x, y));
  CHECK(*std::max_element(mags.begin(), mags.begin() + 10) > 3);
  CHECK(std::all_of(mags.begin(), mags.end(), [](double m) { return m <= 10 * std::sqrt(2.0) + 1e-9; }));
  CHECK(std::all_of(mags.begin() + 31, mags.end(), [](double m) { return m == 0; }));
  CHECK(final_x == 0);
  double again = -1;
  CHECK(run(again) == offs);
}

TEST_CASE("features: camera: smoothing lags behind, deadzone holds still, limits clamp the view") {
  Game g = cam_game(R"("smoothing": 0.5)");
  g.step(1);
  set_position(g, "p", 200, 0);
  g.step(1);
  const double x1 = g->camera_view().x;
  CHECK(x1 > 0);
  CHECK(x1 < 200);
  g.step(120);
  CHECK_CLOSE(g->camera_view().x, 200, 1);

  Game d = cam_game(R"("deadzone": [100, 100])");
  d.step(1);
  set_position(d, "p", 40, 0);
  d.step(1);
  CHECK(d->camera_view().x == 0);
  set_position(d, "p", 80, 0);
  d.step(1);
  CHECK(d->camera_view().x == 30);

  // landscape 1280x720 view; limits 0..2000 x 0..720 -> x in [640, 1360], y fixed at 360
  Game l = cam_game(R"("limit_min": [0, 0], "limit_max": [2000, 720])");
  l.step(1);
  CHECK(l->camera_view().x == 640);
  CHECK(l->camera_view().y == 360);
  set_position(l, "p", 5000, 100);
  l.step(1);
  CHECK(l->camera_view().x == 1360);
  CHECK(l->camera_view().y == 360);
}

TEST_CASE("features: camera: zoomTo tweens the camera zoom; screenToWorld matches the view") {
  Game g = cam_game("", R"(
      local t = camera.zoomTo(2, 0.5)
      t.done:connect(function()
        local w = camera.screenToWorld(vec2(0, 0))
        print("tl", w.x, w.y)
        local s = camera.worldToScreen(vec2(0, 0))
        print("center", s.x, s.y)
      end)
    )");
  g.step(40);
  CHECK(g->world().num(g.entity("cam"), "zoom") == 2);
  const std::vector<std::string> logs = g.logs();
  CHECK(has_line(logs, "tl\t-320\t-180"));
  CHECK(has_line(logs, "center\t640\t360"));
  CHECK_NO_ERRORS(g);
}

// ---------------------------------------------------------------- save data

TEST_CASE("features: save data: persists across loadScene and across game launches (shared host), with JSON + size checks") {
  const FileMap files = save_pkg();
  Game g = start(files);
  g.step(20);
  CHECK_NO_ERRORS(g);
  const std::vector<std::string> logs = g.logs();
  CHECK(has_line(logs, "runs 1"));
  CHECK(has_line(logs, "two:fox:3:12.5:1"));
  CHECK(any_match(logs, R"(save values must be nil, booleans)"));
  CHECK(any_match(logs, R"(max 65536 \(64KB\))"));
  CHECK(has_line(logs, "after remove nil"));
  CHECK(J(&g.save()).dump() == R"({"runs":1})");
  // a second launch with the same save host (TS MemorySaveHost): the save data carries over
  script::HostOptions o;
  o.save = g.save();
  Game g2 = start(files, o);
  CHECK(has_line(g2.logs(), "runs 2"));
}

// ---------------------------------------------------------------- dialogs

TEST_CASE("features: dialogs: typewriter, advance with jump/action, blocks game input, done fires") {
  Game g = dlg(R"(
      jumps = 0
      onTick(function() if input.pressed("jump") then jumps += 1 end end)
      local d = ui.dialog({ "Hello there!", { text = "I'm the fox.", speaker = "Fox", portrait = "asset:f1" } }, { speed = 30 })
      d.done:connect(function() print("dialog done, jumps " .. jumps) end)
      after(3, function() print("later jumps " .. jumps) end)
    )");
  REQUIRE(current_dialog(g));
  CHECK(current_dialog(g)->lines[0].text == "Hello there!");
  g.step(10);  // 1/6 s at 30 cps = 5 chars
  CHECK(std::floor(current_dialog(g)->shown) == 5);
  g->input().tap("jump");
  g.step(1);  // first press completes the line
  CHECK(current_dialog(g)->shown == 12);
  CHECK(current_dialog(g)->index == 0);
  g->input().tap("action");
  g.step(1);  // next line
  REQUIRE(current_dialog(g));
  CHECK(current_dialog(g)->index == 1);
  CHECK(current_dialog(g)->lines[1].speaker.value_or("") == "Fox");
  g->input().tap("jump");
  g.step(1);
  g->input().tap("jump");
  g.step(1);  // close
  CHECK(current_dialog(g) == nullptr);
  g.step(5);
  g->input().tap("jump");
  g.step(1);  // now the game sees jumps
  g.step(200);
  const std::vector<std::string> logs = g.logs();
  CHECK(has_line(logs, "dialog done, jumps 0"));
  CHECK(has_line(logs, "later jumps 1"));
  CHECK_NO_ERRORS(g);
}

TEST_CASE("features: dialogs: choice: navigate with move_y, confirm with action -> callback gets 1-based index; taps work headless") {
  Game g = dlg(R"(
      ui.choice("Take the key?", { "Yes", "No", "Maybe" }, function(i) print("picked " .. i)
        local d2 = ui.dialog("Ok!", { speed = 0 })
        d2.done:connect(function() print("bye") end)
      end, { speed = 0 })
    )");
  g.step(2);
  g.axis("move_y", 1);
  g.step(1);
  g.axis("move_y", 0);
  g.step(1);
  g.axis("move_y", 1);
  g.step(1);
  g.axis("move_y", 0);
  g.step(1);
  REQUIRE(current_dialog(g));
  CHECK(current_dialog(g)->selected == 2);
  g->input().tap("action");
  g.step(1);
  CHECK(has_line(g.logs(), "picked 3"));
  REQUIRE(current_dialog(g));
  CHECK(current_dialog(g)->lines[0].text == "Ok!");
  CHECK(g.tap(360, 640) == "dialog");
  g.step(1);
  CHECK(current_dialog(g) == nullptr);
  CHECK(has_line(g.logs(), "bye"));
  CHECK_NO_ERRORS(g);
}

TEST_CASE("features: dialogs: playtest simulate() reports dialog lines and advances them with presses") {
  FileMap files;
  files["scripts/client/s.luau"] = "ui.dialog({ { text = \"One\", speaker = \"A\" }, \"Two\" }, { speed = 0 })\nsave.set(\"seen\", true)";
  TimelineStep press;
  press.t = 0.5;
  press.press = {"jump"};
  PlaytestReport r = simulate(make_pkg(R"({"world": {"type": "Node2D"}})", files), {press}, 1);
  CHECK(r.errors.empty());
  CHECK(r.dialog_log == std::vector<std::string>{"A: One", "Two"});
  CHECK(r.dialog.value_or("") == "Two");
  CHECK(J(&r.save).dump() == R"({"seen":true})");
}

// ---------------------------------------------------------------- collision layers

TEST_CASE("features: collision layers: bodies only collide with layers in their mask; areas only detect masked layers") {
  FileMap files;
  files["scripts/client/z.luau"] = "script.entity.bodyEntered:connect(function(o) print(\"zone \" .. o.id) end)";
  Game g = start(make_pkg(R"({
    "world": {"type": "Node2D", "children": ["floor", "player", "enemy", "zone", "ghost"]},
    "floor": {"type": "Body2D", "props": {"position": [200, 300], "size": [800, 20], "layer": "world"}},
    "player": {"type": "Body2D", "props": {"position": [200, 100], "size": [20, 20], "body": "dynamic", "lock_rotation": true, "layer": "player", "mask": "world,pickup"}, "tags": ["player"]},
    "enemy": {"type": "Body2D", "props": {"position": [200, 40], "size": [20, 20], "body": "dynamic", "lock_rotation": true, "layer": "enemy", "mask": "world"}},
    "ghost": {"type": "Body2D", "props": {"position": [400, 100], "size": [20, 20], "body": "dynamic", "layer": "enemy", "mask": "enemy"}},
    "zone": {"type": "Area2D", "props": {"position": [200, 280], "size": [100, 20], "mask": "player"}, "scripts": ["scripts/client/z.luau"]}})",
                     files, "[physics]\nlayers = [\"player\", \"enemy\", \"world\", \"pickup\"]"));
  g.step(120);
  CHECK_NO_ERRORS(g);
  // both rest on the floor (top 290, half height 10): the enemy fell through the player instead of stacking
  CHECK_CLOSE(g.pos("player").y, 280, 0);
  CHECK_CLOSE(g.pos("enemy").y, 280, 0);
  CHECK(g.pos("ghost").y > 400);  // the ghost collides with nothing but enemies: falls through the floor
  const std::vector<std::string> logs = g.logs();
  CHECK(has_line(logs, "zone player"));
  CHECK_FALSE(has_line(logs, "zone enemy"));
}

TEST_CASE("features: collision layers: unknown layer names are errors (script) and validator issues (scene)") {
  FileMap files;
  files["scripts/client/b.luau"] =
      "local ok, err = pcall(function() script.entity.layer = \"lava\" end)\nprint(err)\nprint(script.entity.layer == \"\")";
  Game g = start(make_pkg(R"({"world": {"type": "Node2D", "children": ["b"]}, "b": {"type": "Body2D", "scripts": ["scripts/client/b.luau"]}})",
                     files, "[physics]\nlayers = [\"player\"]"));
  const std::vector<std::string> logs = g.logs();
  CHECK(any_match(logs, R"(unknown collision layer "lava" \(layers: player\))"));
  CHECK(has_line(logs, "true"));
}

// ---------------------------------------------------------------- phone layout

TEST_CASE("features: phone layout (portrait 720x1280): fits the reference screen with letterbox/pillarbox math") {
  // render::Fit is float32 (engine-web uses doubles): TS's 9-digit checks would test float rounding,
  // so they use 6 digits for the scale and 3-4 digits for pixel sizes (float32 has ~7 significant digits).
  // iPhone 14 portrait 390x844: width-limited
  const render::Fit f = render::fit_rect(720, 1280, 390, 844);
  CHECK_CLOSE(f.s, 390.0 / 720, 6);
  CHECK_CLOSE(f.w, 390, 4);
  CHECK_CLOSE(f.h, 693.33, 1);
  CHECK(f.x == 0);
  CHECK_CLOSE(f.y, (844 - 693.333) / 2, 2);
  // landscape game on a 2:1 phone in landscape: height-limited, pillarboxed
  const render::Fit l = render::fit_rect(1280, 720, 1688, 844);
  CHECK_CLOSE(l.s, 844.0 / 720, 6);
  CHECK_CLOSE(l.x, (1688 - 1280 * (844.0 / 720)) / 2, 3);
  CHECK(l.y == 0);
}

TEST_CASE("features: phone layout (portrait 720x1280): safe-area insets only cost space where they reach into the game rect (ref px)") {
  // ENGINE GAP (not compiled): engine-web's safeInsets(fit, insets, W, H) has no C++ counterpart yet
  // (apps/player/main.cpp: "Safe-area insets: TODO(E9)"). TS asserts: 390x844 with insets 47/34 ->
  // all 0 (they lie in the letterbox bars); 360x640 with insets 30/20 -> top 60, bottom 40 ref px.
  // The anchor math inside the safe area does exist (ui::anchor_rect), with those insets:
  const double top = 60, bottom = 40;
  const ui::Rect a = ui::anchor_rect("bottom_right", {-10, -10}, {100, 50}, 0, top, 720, 1280 - top - bottom);
  CHECK(a.x == 610);
  CHECK(a.y == 1280 - 40 - 60);
  CHECK(a.w == 100);
  CHECK(a.h == 50);
  const ui::Rect b = ui::anchor_rect("top", {0, 8}, {200, 40}, 0, 60, 720, 1180);
  CHECK(b.x == 260);
  CHECK(b.y == 68);
  CHECK(b.w == 200);
  CHECK(b.h == 40);
}

TEST_CASE("features: phone layout (portrait 720x1280): portrait games get a 720x1280 view; landscape (no orientation) stays 1280x720") {
  FileMap files;
  files["scripts/client/b.luau"] = "script.entity.pressed:connect(function() print(\"pressed\") end)";
  Game p = start(make_pkg(R"({"world": {"type": "Node2D", "children": ["b"]},
    "b": {"type": "UIButton", "props": {"anchor": "bottom", "offset": [0, -40], "size": [300, 100]}, "scripts": ["scripts/client/b.luau"]}})",
                     files, "orientation = \"portrait\""));
  CHECK(p->ref_width() == 720);
  CHECK(p->ref_height() == 1280);
  // TS view2D(p, 390, 844): the view is the reference size, centered on the camera (no camera:
  // top-left is (0, 0)). The C++ view is the host's camera view over the reference screen.
  CHECK(p->camera_view().x == 360);
  CHECK(p->camera_view().y == 640);
  CHECK(p->camera_view().zoom == 1);
  const ui::Rect r = ui::ui_rect_headless(p->world(), p.id("b"), 720, 1280);
  CHECK(r.x == 210);
  CHECK(r.y == 1140);
  CHECK(r.w == 300);
  CHECK(r.h == 100);
  CHECK(p.tap(360, 1190) == "b");
  CHECK(has_line(p.logs(), "pressed"));
  Game l = start(make_pkg(R"({"world": {"type": "Node2D"}})"));
  CHECK(l->ref_width() == 1280);
  CHECK(l->ref_height() == 720);
  // TS view2D(l, 1280, 720): w, h, scale = 1280, 720, 1
  CHECK(render::fit_rect(1280, 720, 1280, 720).s == 1);
  CHECK(l->camera_view().zoom == 1);
}

}  // TEST_SUITE
