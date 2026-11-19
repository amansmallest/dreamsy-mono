// Script host + world (E3): entity ops as scripts see them. Parity with engine-web is checked by
// tests/conformance/run_compare.py; these tests cover the behavior natively.
#include <map>
#include <memory>
#include <string>

#include "doctest.h"
#include "physics/physics2d.h"
#include "pkg/validate.h"
#include "script/host.h"

using namespace dreamsy;
using namespace dreamsy::script;

namespace {

const char* kScene = R"({"format": "0", "root": "world", "entities": {
  "world": {"type": "Node2D", "children": ["hero", "floor", "coin", "fx", "cam", "map"]},
  "hero": {"type": "Body2D", "props": {"position": [40, 100], "body": "dynamic", "size": [16, 16], "lock_rotation": true},
           "scripts": ["scripts/client/hero.luau"], "tags": ["player"], "children": ["hero_sprite"]},
  "hero_sprite": {"type": "Sprite2D", "props": {"anims": "data/anims/hero.json"}},
  "floor": {"type": "Body2D", "props": {"position": [160, 140], "size": [400, 16]}},
  "coin": {"type": "Area2D", "props": {"position": [40, 124], "size": [8, 8]}, "tags": ["coin"]},
  "fx": {"type": "Particles2D", "props": {"emitting": false}},
  "cam": {"type": "Camera2D", "props": {"follow": "hero"}},
  "map": {"type": "TileMap2D", "props": {"position": [0, 200], "tileset": "data/tilesets/t.json", "data": "#.#\n###"}}
}})";

std::shared_ptr<const pkg::Package> game(std::map<std::string, std::string> files) {
  files["dreamsy.toml"] = "format = \"0\"\nname = \"t\"\ndimension = \"2d\"\nentry_scene = \"scenes/main.scene.json\"\n";
  files["scenes/main.scene.json"] = kScene;
  files["scenes/other.scene.json"] = R"({"format": "0", "root": "o", "entities": {"o": {"type": "Node2D"}}})";
  files["data/anims/hero.json"] = R"({"idle": {"frames": ["asset:a", "asset:b"], "fps": 10}, "hit": {"frames": ["asset:a", "asset:b"], "fps": 20, "loop": false, "next": "idle"}})";
  files["data/tilesets/t.json"] = R"({"tiles": {"#": {"color": "#8080ff", "solid": true, "tags": ["ground"]}}})";
  files["assets/a.meta.json"] = R"({"kind": "image", "file": "a.png"})";
  files["assets/a.png"] = "\x89PNG";
  files["assets/b.meta.json"] = R"({"kind": "image", "file": "b.png"})";
  files["assets/b.png"] = "\x89PNG";
  if (!files.count("scripts/client/hero.luau")) files["scripts/client/hero.luau"] = "";
  auto f = pkg::Files::from_map(files);
  REQUIRE(f.ok());
  pkg::LoadResult r = pkg::load_package(std::move(f).value());
  for (const auto& i : r.issues) MESSAGE(pkg::format_issue(i));
  REQUIRE(r.ok);
  return std::shared_ptr<const pkg::Package>(std::move(r.package));
}

struct Run {
  std::unique_ptr<Host> host;
  std::string logs, errors;
};

Run run(std::shared_ptr<const pkg::Package> pkg, int ticks) {
  auto h = Host::create(pkg);
  REQUIRE_MESSAGE(h.ok(), h.error());
  Run out{std::move(h).value(), {}, {}};
  for (int i = 0; i < ticks; ++i) out.host->step();
  for (const LogLine& l : out.host->logs()) out.logs += l.text + "\n";
  for (const ScriptError& e : out.host->errors()) out.errors += e.script + ":" + std::to_string(e.line) + ": " + e.message + "\n";
  return out;
}

}  // namespace

TEST_CASE("attached scripts see their entity; props, tags, tree and lookups work") {
  auto r = run(game({{"scripts/client/hero.luau", R"(
    local me = script.entity
    print(me.id, me.type, me.parent.id, #me:children(), me:children()[1].id)
    print(me.position, me.size, me.visible, me.z_index)
    me:addTag("brave")
    print(me:hasTag("brave"), #entitiesTagged("player"), entity("coin").shape, entity("nope"))
    entity("hero_sprite").color = color("#ff0000")
    print(entity("hero_sprite").modulate)
    me.name = "Hero"
    print(me.name, tostring(me))
    local ok, err = pcall(function() me.size = 3 end)
    print(err)
    ok, err = pcall(function() me.id = "x" end)
    print(err)
    print(entity("cam").follow == me, entity("map").cols, entity("map").rows)
  )"}}),
               0);
  CHECK(r.errors.empty());
  CHECK(r.logs ==
        "hero\tBody2D\tworld\t1\thero_sprite\n"
        "vec2(40, 100)\tvec2(16, 16)\ttrue\t0\n"
        "true\t1\trect\tnil\n"
        "#ff0000\n"
        "Hero\tEntity(hero)\n"  // tostring(entity) shows the id (fixed in the prelude, both engines)
        "Body2D.size expects a Vec2 (use vec2(x, y)), got 3\n"
        "id is read-only\n"
        "true\t3\t2\n");
}

TEST_CASE("spawn, clone (runs scripts), destroy (drops callbacks) and stale handles") {
  auto r = run(game({{"scripts/client/main.luau", R"(
    local b = spawn("Body2D", { position = vec2(5, 6), body = "dynamic" })
    print(b.id, b.position, b.parent.id, b.destroyed)
    local c = entity("hero"):clone()
    print(c.id, #c:children(), #entitiesTagged("player"))
    local n = 0
    onTick(function() n += 1 end)
    after(0.05, function()
      b:destroy()
      print("destroyed", b.destroyed, pcall(function() return b.position end))
    end)
    local ok, err = pcall(function() spawn("Nope") end)
    print(err)
    ok, err = pcall(function() entity("world"):destroy() end)
    print(err)
  )"},
                     {"scripts/client/hero.luau", R"(
    local me = script.entity
    print("hero script", me.id)
    onTick(function() if me.id ~= "hero" then me:destroy() end end)
  )"}}),
               10);
  CHECK(r.errors.empty());
  CHECK(r.logs ==
        "hero script\thero\n"
        "rt_1\tvec2(5, 6)\tworld\tfalse\n"
        "hero script\trt_2\n"
        "rt_2\t1\t2\n"
        "spawn: unknown entity type \"Nope\"\n"
        "cannot destroy the scene root\n"
        "destroyed\ttrue\tfalse\tentity was destroyed\n");
  // the clone destroyed itself from its own onTick; its callbacks are gone with it
  CHECK(r.host->world().tagged("player").size() == 1);
}

TEST_CASE("physics events reach scripts: bodyEntered on areas and bodies, onFloor, velocity") {
  auto r = run(game({{"scripts/client/main.luau", R"(
    entity("coin").bodyEntered:connect(function(other) print("coin <-", other.id, math.floor(time() * 60 + 0.5)) entity("coin"):destroy() end)
    entity("hero").bodyEntered:connect(function(other) print("hero <-", other.id) end)
    after(1, function() local h = entity("hero") print("floor", h.onFloor, math.floor(h.position.y + 0.5), math.abs(h.velocity.y) < 1) end)
  )"}}),
               70);
  CHECK(r.errors.empty());
  CHECK(r.logs.find("coin <-\thero") != std::string::npos);
  CHECK(r.logs.find("hero <-\tfloor") != std::string::npos);
  CHECK(r.logs.find("floor\ttrue\t124\ttrue") != std::string::npos);
  CHECK_FALSE(r.host->world().alive(r.host->world().by_id("coin")));
}

TEST_CASE("tweens, sprite animation, particles, camera and tiles") {
  auto r = run(game({{"scripts/client/main.luau", R"(
    local spr = entity("hero_sprite")
    local tw = tween(spr, { position = vec2(10, 0), color = "#000000" }, 0.1, "linear")
    tw.done:connect(function() print("tween done", spr.position, spr.modulate) end)
    spr:play("hit")
    spr.animFinished:connect(function(name) print("anim finished", name, spr.anim) end)
    entity("fx"):burst(5)
    print("particles", entity("fx").particleCount)
    camera.shake(4, 0.2)
    print("camera", camera.center(), camera.viewSize(), screen.size())
    local map = entity("map")
    print(map:tileAt(vec2(1, 201)), map:tileAt(vec2(17, 201)), map:isSolid(1, 1), map:cellToWorld(1, 0))
    map:setTile(1, 0, "#")
    print(map:getTile(1, 0), map:tileDef("#").color, map:tagsAt(vec2(20, 205))[1])
    local ok, err = pcall(function() map:setTile(9, 0, "#") end)
    print(err)
    ok, err = pcall(function() tween(spr, { texture = 1 }, 1) end)
    print(err)
  )"}}),
               12);
  CHECK(r.errors.empty());
  INFO(r.logs);
  CHECK(r.logs.find("particles\t5\n") != std::string::npos);
  CHECK(r.logs.find("tween done\tvec2(10, 0)\t#000000\n") != std::string::npos);
  CHECK(r.logs.find("anim finished\thit\thit\n") != std::string::npos);  // fired before `next` chains
  const world::World& w = r.host->world();
  CHECK(w.str(*w.get(w.by_id("hero_sprite")), "anim") == "idle");  // ...then it chained to idle
  CHECK(r.logs.find("camera\tvec2(40, 100)\tvec2(1280, 720)\tvec2(1280, 720)\n") != std::string::npos);  // follows the hero
  CHECK(r.logs.find("#\tnil\ttrue\tvec2(24, 208)\n") != std::string::npos);
  CHECK(r.logs.find("#\t#8080ff\tground\n") != std::string::npos);
  CHECK(r.logs.find("setTile: cell (9, 0) is outside the map (cols 0..2, rows 0..1)\n") != std::string::npos);
  CHECK(r.logs.find("has no tweenable property \"texture\"") != std::string::npos);
  CHECK(r.host->tween_count() == 0);
}

TEST_CASE("loadScene tears down entities and attached scripts; session scripts survive") {
  auto r = run(game({{"scripts/client/main.luau", R"(
    game.sceneLoaded:connect(function(path) print("loaded", path, entity("hero") ~= nil) end)
    after(0.05, function() loadScene("scenes/other.scene.json") end)
  )"},
                     {"scripts/client/hero.luau", R"(
    local me = script.entity
    every(0.02, function() print("tick", me.id) end)
  )"}}),
               10);
  CHECK(r.errors.empty());
  // the hero's timer ran until the switch and never after
  size_t ticks = 0;
  for (size_t at = r.logs.find("tick\thero"); at != std::string::npos; at = r.logs.find("tick\thero", at + 1)) ++ticks;
  CHECK(ticks == 2);
  CHECK(r.logs.find("loaded\tscenes/other.scene.json\tfalse") != std::string::npos);
  CHECK(r.host->world().count() == 1);
}

TEST_CASE("state hashes are reproducible and change with the simulation") {
  auto pkg = game({{"scripts/client/main.luau", R"(entity("fx").emitting = true)"}});
  auto a = run(pkg, 30), b = run(pkg, 30), c = run(pkg, 31);
  CHECK(a.host->state_hash() == b.host->state_hash());
  CHECK(a.host->state_hash() != c.host->state_hash());
}

// ---------------------------------------------------------------- 2.5D from the package (E7)

namespace {

std::shared_ptr<const pkg::Package> game25(const std::string& manifest_extra, const std::string& scene,
                                           const std::string& script) {
  std::map<std::string, std::string> files;
  files["dreamsy.toml"] =
      "format = \"0\"\nname = \"t\"\ndimension = \"2d\"\nentry_scene = \"scenes/main.scene.json\"\n" + manifest_extra;
  files["scenes/main.scene.json"] = scene;
  files["scenes/side.scene.json"] = R"({"format": "0", "root": "s", "view": "side", "entities": {"s": {"type": "Node2D"}}})";
  files["scripts/client/main.luau"] = script;
  files["data/tilesets/t.json"] = R"({"tiles": {"#": {"color": "#8080ff", "solid": true}}})";
  auto f = pkg::Files::from_map(files);
  REQUIRE(f.ok());
  pkg::LoadResult r = pkg::load_package(std::move(f).value());
  for (const auto& i : r.issues) MESSAGE(pkg::format_issue(i));
  REQUIRE(r.ok);
  return std::shared_ptr<const pkg::Package>(std::move(r.package));
}

const char* kScene25 = R"({"format": "0", "root": "world", "entities": {
  "world": {"type": "Node2D", "children": ["hero", "step", "terrace", "cam"]},
  "hero": {"type": "Body2D", "props": {"position": [40, 100], "body": "dynamic", "size": [16, 12], "height": 24, "z": 5}},
  "step": {"type": "Body2D", "props": {"position": [200, 100], "size": [40, 40], "height": 20}},
  "terrace": {"type": "TileMap2D", "props": {"position": [300, 80], "tile_size": 20, "tileset": "data/tilesets/t.json", "data": "##\n##", "height": 40}},
  "cam": {"type": "Camera2D", "props": {"position": [100, 100]}}
}})";

}  // namespace

TEST_CASE("2.5D: manifest view, scene override, z props from the scene and from scripts") {
  auto r = run(game25("view = \"oblique\"\n", kScene25, R"(
    local hero = entity("hero")
    print(camera.view(), hero.z, hero.height, hero.z_velocity, hero.z_gravity_scale)
    hero.z_gravity_scale = 0.5
    hero.z_velocity = 100
    print(hero.z_velocity, hero.z_gravity_scale, entity("step").z, entity("terrace").height)
    local ok, err = pcall(function() hero.onGround = true end)
    print(err)
    ok, err = pcall(function() entity("cam").z = 3 end)
    print(err)
    hero.z_gravity_scale = nil
    print(hero.z_gravity_scale)
  )"), 0);
  // The script runs at spawn; the scene's z = 5 is what it sees.
  CHECK(r.errors == "");
  CHECK(r.logs.find("oblique\t5\t24\t0\t1\n") != std::string::npos);
  CHECK(r.logs.find("100\t0.5\t0\t40\n") != std::string::npos);
  CHECK(r.logs.find("onGround is read-only") != std::string::npos);
  CHECK(r.logs.find("Camera2D \"cam\" has no property \"z\"") != std::string::npos);
  CHECK(r.logs.find("\n1\n") != std::string::npos);  // nil resets to the catalog default
  CHECK(r.host->world().view == world::ViewMode::Oblique);
}

TEST_CASE("2.5D: jump onto a block and a raised tile map; onGround, groundZ; tweens and clones keep z") {
  auto pkg = game25("view = \"topdown\"\n", kScene25, R"(
    local hero = entity("hero")
    local log = {}
    onTick(function()
      log[#log + 1] = { hero.z, hero.onGround, hero.groundZ }
    end)
    _G.log = log
  )");
  auto h = Host::create(pkg);
  REQUIRE(h.ok());
  Host& host = *h.value();
  world::World& w = host.world();
  world::Entity* hero = w.get(w.by_id("hero"));
  physics::Physics2D& ph = *host.physics();
  host.step();
  // z = 5 from the scene, nothing under it: falls to the floor.
  for (int i = 0; i < 30; ++i) host.step();
  CHECK(hero->z == 0);
  CHECK(ph.on_ground(w.by_id("hero")));
  // Teleport over the block and drop onto it.
  hero->z = 60;
  w.set_raw(*hero, "position", world::Value::vec(200, 100));
  ph.sync_transform(w.by_id("hero"));
  for (int i = 0; i < 60; ++i) host.step();
  CHECK(hero->z == 20);
  CHECK(ph.ground_of(w.by_id("hero")) == 20);
  CHECK(ph.on_ground(w.by_id("hero")));
  // Over a solid tile of the raised map (top at 40).
  hero->z = 80;
  w.set_raw(*hero, "position", world::Value::vec(310, 90));
  ph.sync_transform(w.by_id("hero"));
  for (int i = 0; i < 60; ++i) host.step();
  CHECK(hero->z == 40);
  CHECK(ph.ground_below(310, 90, 100) == 40);
  CHECK(ph.ground_below(310, 90, 30) == 0);  // below the map's top: the map doesn't count
  CHECK(ph.ground_below(200, 100, 100) == 20);
  CHECK(ph.ground_below(240, 100, 100) == 0);  // beside the block
  // A jump leaves the ground.
  hero->z_velocity = 300;
  host.step();
  CHECK_FALSE(ph.on_ground(w.by_id("hero")));
  CHECK(hero->z > 40);
}

TEST_CASE("2.5D: scene view overrides the manifest; side scenes keep planar gravity; iso camera math") {
  auto r = run(game25("view = \"iso\"\n", kScene25, R"(
    local p = camera.worldToScreen(vec2(140, 60))
    local back = camera.screenToWorld(p)
    print(math.floor(back.x + 0.5), math.floor(back.y + 0.5))
    local d = camera.screenDirToWorld(vec2(1, 0))
    print(math.floor(d.x * 1000 + 0.5) / 1000, math.floor(d.y * 1000 + 0.5) / 1000)
    loadScene("scenes/side.scene.json")
    game.sceneLoaded:connect(function(path) print(path, camera.view()) end)
  )"), 3);
  CHECK(r.errors == "");
  CHECK(r.logs.find("140\t60\n") != std::string::npos);
  // iso: screen right = world (+x, -y) / sqrt(2)
  CHECK(r.logs.find("0.707\t-0.707\n") != std::string::npos);
  CHECK(r.logs.find("scenes/side.scene.json\tside") != std::string::npos);
  CHECK(r.host->world().view == world::ViewMode::Side);
}

TEST_CASE("2.5D: a body pressed against a block's side climbs onto it by jumping (no stale recycled contact)") {
  const char* scene = R"({"format": "0", "root": "world", "entities": {
    "world": {"type": "Node2D", "children": ["hero", "wall"]},
    "hero": {"type": "Body2D", "props": {"position": [100, 200], "body": "dynamic", "size": [20, 14], "height": 28, "lock_rotation": true, "friction": 0}},
    "wall": {"type": "Body2D", "props": {"position": [100, 120], "size": [64, 64], "height": 48}}
  }})";
  auto pkg = game25("view = \"oblique\"\n", scene, R"(
    local hero = entity("hero")
    local t = 0
    onTick(function()
      t += 1
      hero.velocity = vec2(0, if t < 60 then -150 else -40)  -- walk up the screen into the wall, then ease off
      if t == 60 then hero.z_velocity = 420 end      -- jump while pressed against it
      if t == 120 then print("z", hero.z, "ground", hero.groundZ) end
    end)
  )");
  auto h = Host::create(pkg);
  REQUIRE(h.ok());
  for (int i = 0; i < 120; ++i) h.value()->step();
  std::string logs;
  for (const LogLine& l : h.value()->logs()) logs += l.text + "\n";
  CHECK(logs == "z\t48\tground\t48\n");  // on top of the wall, not stuck at its foot
}
