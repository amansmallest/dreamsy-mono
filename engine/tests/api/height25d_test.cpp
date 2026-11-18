// 2.5D height (DREAMSY.MD §14.5): z-range collision filtering through the host, z props from
// scripts, camera.view, iso camera math and the scene view override.
// Port of engine-web/test/height25d.test.ts.
//
// The first TS test ("falls to the floor, lands on a block and on a raised tile map; onGround /
// groundZ") is already covered with the same scene and numbers by host_world_test.cpp "2.5D: jump
// onto a block and a raised tile map; onGround, groundZ; ..." (topdown: no planar gravity is also
// asserted by physics_test.cpp "2.5D: z ranges gate collisions...").
#include "kits/kit_test.h"

using namespace dreamsy;
using namespace dreamsy::test;

namespace {

const char* kWorld = R"(
  "hero": {"type": "Body2D", "props": {"position": [40, 100], "body": "dynamic", "size": [16, 12], "height": 24, "z": 5}},
  "step": {"type": "Body2D", "props": {"position": [200, 100], "size": [40, 40], "height": 20}},
  "terrace": {"type": "TileMap2D", "props": {"position": [300, 80], "tile_size": 20, "tileset": "data/tilesets/t.json", "data": "##\n##", "height": 40}},
  "wall": {"type": "Body2D", "props": {"position": [100, 300], "size": [20, 100], "height": 16}})";

// TS package_files(view, entities, script): `entities` is JSON object members, `children` their ids.
FileMap package_files(const std::string& view, const std::string& entities, const std::string& children, const std::string& script = "") {
  return {
      {"dreamsy.toml",
       "format = \"0\"\nname = \"H\"\ndimension = \"2d\"\nview = \"" + view + "\"\nentry_scene = \"scenes/main.scene.json\"\n"},
      {"scenes/main.scene.json", R"({"format": "0", "root": "world", "entities": {"world": {"type": "Node2D", "children": [)" +
                                     children + "]}," + entities + "}}"},
      {"scenes/side.scene.json", R"({"format": "0", "root": "s", "view": "side", "entities": {"s": {"type": "Node2D"}}})"},
      {"scripts/client/main.luau", script},
      {"data/tilesets/t.json", R"({"tiles": {"#": {"color": "#8080ff", "solid": true}}})"},
  };
}

const char* kChildren = R"("hero", "step", "terrace", "wall")";

}  // namespace

TEST_SUITE("api height25d") {

TEST_CASE("height25d: z ranges gate collisions: high bodies pass over walls, flat ones are blocked") {
  Game g = start(package_files("oblique",
                     std::string(kWorld) + R"(,
    "high": {"type": "Body2D", "props": {"position": [40, 280], "body": "dynamic", "size": [10, 10], "height": 8, "z": 30, "z_gravity_scale": 0}},
    "flat": {"type": "Body2D", "props": {"position": [40, 320], "body": "dynamic", "size": [10, 10]}})",
                     std::string(kChildren) + R"(, "high", "flat")"));
  g->physics()->set_velocity(g.id("high"), 120, 0);
  g->physics()->set_velocity(g.id("flat"), 120, 0);
  g.step(90);
  CHECK(g.pos("high").x > 150);
  CHECK(g.pos("flat").x < 90.5);
}

TEST_CASE("height25d: scripts read and write z props; camera.view, iso camera math, scene view override") {
  Game g = start(package_files("iso", kWorld, kChildren, R"(
      local hero = entity("hero")
      print(camera.view(), hero.z, hero.height, hero.z_gravity_scale, hero.onGround)
      local back = camera.screenToWorld(camera.worldToScreen(vec2(140, 60)))
      print(math.floor(back.x + 0.5), math.floor(back.y + 0.5))
      local d = camera.screenDirToWorld(vec2(1, 0))
      print(math.floor(d.x * 1000 + 0.5) / 1000, math.floor(d.y * 1000 + 0.5) / 1000)
      local ok, err = pcall(function() hero.groundZ = 3 end)
      print(err)
      game.sceneLoaded:connect(function(path) print(path, camera.view()) end)
      loadScene("scenes/side.scene.json")
    )"));
  g.step(3);
  CHECK_NO_ERRORS(g);
  const std::string out = g.log_text();
  CHECK(contains(out, "iso\t5\t24\t1\tfalse"));
  CHECK(contains(out, "140\t60"));
  CHECK(contains(out, "0.707\t-0.707"));
  CHECK(contains(out, "groundZ is read-only"));
  CHECK(contains(out, "scenes/side.scene.json\tside"));
}

}  // TEST_SUITE
