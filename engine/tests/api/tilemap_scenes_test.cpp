// TileMap2D (tiles, physics, tileTouched, setTile) and scenes (loadScene, params, session scripts,
// the tile-quest example). Port of engine-web/test/tilemap-scenes.test.ts (same numbers and thresholds).
#include <algorithm>
#include <chrono>
#include <cmath>

#include "kits/kit_test.h"

using namespace dreamsy;
using namespace dreamsy::test;

namespace {

std::string manifest_for(const std::string& entry = "scenes/main.scene.json") {
  return "format = \"0\"\nname = \"T\"\ndimension = \"2d\"\nentry_scene = \"" + entry + "\"\n[style]\npreset = \"pixel\"\n";
}

const char* kTileset = R"({"tiles": {
  "#": {"color": "#888888", "solid": true},
  "B": {"color": "#aa5500", "solid": true, "tags": ["breakable"]},
  "^": {"color": "#ffffff", "tags": ["spike"]}}})";

// 20 cols x 8 rows, tile 16: floor on row 7, breakable bricks under x ~ 160..208, spike at col 15 row 6
const char* kGrid =
    "....................\n"
    "....................\n"
    "....................\n"
    "....................\n"
    "....................\n"
    "....................\n"
    "...............^....\n"
    "##########BBB#######";

// TS tilePkg(): a tile map (script on it), a dynamic player body and a label.
FileMap tile_pkg(const std::string& script, double px = 40, double py = 90) {
  char player[64];
  std::snprintf(player, sizeof player, "[%g, %g]", px, py);
  FileMap f;
  f["dreamsy.toml"] = manifest_for();
  f["scenes/main.scene.json"] = std::string(R"({"format": "0", "root": "world", "entities": {
    "world": {"type": "Node2D", "children": ["map", "player", "label"]},
    "map": {"type": "TileMap2D", "props": {"tile_size": 16, "tileset": "data/tilesets/t.json", "data": "file:data/levels/l.txt"}, "scripts": ["scripts/client/main.luau"]},
    "player": {"type": "Body2D", "props": {"position": )") + player +
                                R"(, "size": [12, 14], "body": "dynamic", "lock_rotation": true, "friction": 0}, "tags": ["player"]},
    "label": {"type": "UIText", "props": {"text": ""}}}})";
  f["data/tilesets/t.json"] = kTileset;
  f["data/levels/l.txt"] = std::string(kGrid) + "\n";
  f["scripts/client/main.luau"] = script;
  return f;
}

std::string label(Game& g) { return g->world().str(g.entity("label"), "text"); }

// TS setProp(e, "position", ...) on a body: move the entity and teleport its physics body.
void teleport(Game& g, world::EntityId e, double x, double y) {
  g->world().set_raw(*g->world().get(e), "position", world::Value::vec(x, y));
  g->physics()->sync_transform(e);
}

double now_ms() {
  return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count();
}

// TS scenesPkg(): scene a (a box that loads b with params), scene b, a session script.
FileMap scenes_pkg() {
  FileMap f;
  f["dreamsy.toml"] = manifest_for("scenes/a.scene.json");
  f["scenes/a.scene.json"] = R"({"format": "0", "root": "a_root", "entities": {
    "a_root": {"type": "Node2D", "children": ["a_label", "a_box"]},
    "a_label": {"type": "UIText", "props": {"text": ""}, "tags": ["label"]},
    "a_box": {"type": "Body2D", "props": {"body": "dynamic"}, "scripts": ["scripts/client/a.luau"]}}})";
  f["scenes/b.scene.json"] = R"({"format": "0", "root": "b_root", "entities": {
    "b_root": {"type": "Node2D", "children": ["b_label"]},
    "b_label": {"type": "UIText", "props": {"text": ""}, "tags": ["label"], "scripts": ["scripts/client/b.luau"]}}})";
  f["scripts/shared/state.luau"] = "return { ticksInA = 0 }";
  // session script: survives scene changes
  f["scripts/client/session.luau"] = R"(
      local state = require("../shared/state")
      local loads = {}
      game.sceneLoaded:connect(function(path)
        table.insert(loads, path)
        entitiesTagged("label")[1].text = table.concat(loads, ",") .. "|" .. tostring(currentScene()) .. "|" .. tostring(sceneParams().gold)
      end)
      every(0.5, function() state.sessionTicks = (state.sessionTicks or 0) + 1 end))";
  f["scripts/client/a.luau"] = R"(
      local state = require("../shared/state")
      onTick(function() state.ticksInA += 1 end)
      every(0.1, function() state.timerInA = (state.timerInA or 0) + 1 end)
      after(0.5, function()
        loadScene("scenes/b.scene.json", { gold = 42 })
        state.afterLoadCall = currentScene() -- switch happens at end of tick
      end))";
  f["scripts/client/b.luau"] = R"(
      local state = require("../shared/state")
      local frozenA, frozenTimer = state.ticksInA, state.timerInA
      script.entity.text = "b sees gold=" .. tostring(sceneParams().gold)
      after(0.5, function()
        state.report = table.concat({ tostring(state.ticksInA == frozenA), tostring(state.timerInA == frozenTimer),
          tostring(state.afterLoadCall), tostring((state.sessionTicks or 0) >= 1), tostring(entity("a_box")) }, ",")
        local ok, err = pcall(loadScene, "b")
        script.entity.text = state.report .. "|" .. tostring(err)
      end))";
  return f;
}

}  // namespace

TEST_SUITE("api tilemap_scenes") {

// ---------------------------------------------------------------- TileMap2D

TEST_CASE("tilemap_scenes: TileMap2D: player lands on solid tiles and walks across them without snagging") {
  Game g = start(tile_pkg(""));
  const world::EntityId p = g.id("player");
  g.step(90);
  // floor top = row 7 * 16 = 112; half height 7
  CHECK_CLOSE(g.pos("player").y, 105, 0);
  g.step(60, [&](int) { g.axis("move_x", 1); });
  // walk right across the "#" -> "B" seam region, setting velocity like a platformer would
  std::vector<double> ys;
  for (int i = 0; i < 60; i++) {
    g->physics()->set_velocity(p, 100, g->physics()->velocity(p).y);
    g.step();
    ys.push_back(g.pos("player").y);
  }
  CHECK(g.pos("player").x > 130);
  CHECK(*std::max_element(ys.begin(), ys.end()) - *std::min_element(ys.begin(), ys.end()) < 0.1);
  // one merged collider for the whole floor row
  CHECK(g->physics()->collider_count(g.id("map")) == 1);
  CHECK_NO_ERRORS(g);
}

TEST_CASE("tilemap_scenes: TileMap2D: tileAt / tagsAt / getTile / worldToCell / cellToWorld / cols / rows") {
  Game g = start(tile_pkg(R"(
      local m = script.entity
      local c, r = m:worldToCell(vec2(165, 120))
      local w = m:cellToWorld(10, 7)
      local tags = m:tagsAt(vec2(15 * 16 + 4, 6 * 16 + 4))
      entity("label").text = table.concat({
        tostring(m:tileAt(vec2(8, 120))), tostring(m:tileAt(vec2(8, 8))), tostring(m:tileAt(vec2(-5, 120))),
        tostring(m:getTile(10, 7)), tostring(c), tostring(r), tostring(w), tags[1] or "none", #m:tagsAt(vec2(8, 8)),
        m.cols, m.rows,
      }, ","))"));
  CHECK_NO_ERRORS(g);
  CHECK(label(g) == "#,nil,nil,B,10,7,vec2(168, 120),spike,0,20,8");
}

TEST_CASE("tilemap_scenes: TileMap2D: spike tag fires tileTouched -> script respawns the player") {
  Game g = start(tile_pkg(R"(
      local m = script.entity
      local player = entitiesTagged("player")[1]
      local spawnAt = player.position
      local deaths = 0
      m.tileTouched:connect(function(other, ch, col, row)
        if other == player and table.find(m:tagsAt(m:cellToWorld(col, row)), "spike") then
          deaths += 1
          player.position = spawnAt
          player.velocity = vec2(0, 0)
          entity("label").text = "deaths " .. deaths .. " at " .. col .. "," .. row
        end
      end))",
                          15 * 16 + 8, 40));
  g.step(20);
  CHECK(label(g) == "deaths 1 at 15,6");
  CHECK(g.pos("player").y < 80);  // back at spawn, falling again
  CHECK_NO_ERRORS(g);
}

TEST_CASE("tilemap_scenes: TileMap2D: setTile removes collision (and tileTouched reports solid tiles)") {
  Game g = start(tile_pkg(R"(
      local m = script.entity
      local touched = {}
      m.tileTouched:connect(function(other, ch, col, row) table.insert(touched, ch .. col) end)
      after(1.5, function()
        entity("label").text = table.concat(touched, " ")
        for c = 10, 12 do m:setTile(c, 7, nil) end
      end))",
                          11 * 16 + 8, 80));
  g.step(85);
  CHECK_CLOSE(g.pos("player").y, 105, 0);  // standing on the bricks
  g.step(10);
  CHECK(label(g) == "B11");
  g.step(40);
  CHECK(g.pos("player").y > 130);  // fell through the hole
  CHECK_NO_ERRORS(g);
}

TEST_CASE("tilemap_scenes: TileMap2D: setTile rejects unknown tiles and out-of-bounds cells with clear errors") {
  Game g = start(tile_pkg(R"(
      local m = script.entity
      local ok1, e1 = pcall(function() m:setTile(0, 0, "Z") end)
      local ok2, e2 = pcall(function() m:setTile(99, 0, "#") end)
      entity("label").text = tostring(e1) .. " | " .. tostring(e2))"));
  CHECK(matches(label(g), R"(tile "Z" is not defined in data\/tilesets\/t\.json)"));
  CHECK(matches(label(g), R"(cell \(99, 0\) is outside the map)"));
}

TEST_CASE("tilemap_scenes: TileMap2D: perf: 500x40 map loads and steps fast") {
  // rolling terrain + platforms + spikes, ~20k cells
  std::string rows;
  for (int r = 0; r < 40; r++) {
    for (int c = 0; c < 500; c++) {
      const int ground = 30 + static_cast<int>(world::js_round(3 * std::sin(c / 9.0)));  // Math.round
      rows += r >= ground                         ? '#'
              : (r == 20 && c % 13 < 6)           ? '#'
              : (r == ground - 1 && c % 29 == 0)  ? '^'
              : (r == 12 && c % 17 < 3)           ? 'B'
                                                  : '.';
    }
    if (r < 39) rows += '\n';
  }
  FileMap big = tile_pkg("script.entity.tileTouched:connect(function() end)", 40, 300);
  big["data/levels/l.txt"] = rows;
  const double t0 = now_ms();
  Game g = start(big);
  const double load_ms = now_ms() - t0;
  const world::EntityId map = g.id("map");
  const int colliders = g->physics()->collider_count(map);
  const double t1 = now_ms();
  g.step(600, [&](int) { g.axis("move_x", 1); });
  const double step_ms = (now_ms() - t1) / 600;
  const double t2 = now_ms();
  for (int i = 0; i < 20; i++) {
    g.entity("map").tiles->set(100 + i, 30, nullptr);
    g->physics()->mark_dirty(map);
    g.step();
  }
  const double edit_ms = (now_ms() - t2) / 20;
  MESSAGE("perf 500x40: load " << load_ms << " ms, " << colliders << " colliders, step " << step_ms
                               << " ms/tick, setTile+rebuild " << edit_ms << " ms");
  CHECK(colliders < 1500);
  CHECK(step_ms < 4);  // holds even in the debug + ASan build (~0.07 ms/tick measured)
  CHECK_NO_ERRORS(g);
}

// ---------------------------------------------------------------- scenes

TEST_CASE("tilemap_scenes: scenes: loadScene tears down the old scene, passes params, keeps session scripts") {
  Game g = start(scenes_pkg());
  CHECK(g->scene() == "scenes/a.scene.json");
  CHECK(g->world().str(g.entity("a_label"), "text") == "scenes/a.scene.json|scenes/a.scene.json|nil");
  g.step(31);
  CHECK(g->scene() == "scenes/b.scene.json");
  CHECK_FALSE(g.alive("a_box"));
  // b.luau ran first (sees params), then sceneLoaded fired in the session script
  CHECK(g->world().str(g.entity("b_label"), "text") == "scenes/a.scene.json,scenes/b.scene.json|scenes/b.scene.json|42");
  g.step(40);
  const std::string text = g->world().str(g.entity("b_label"), "text");
  const size_t bar = text.find('|');
  REQUIRE(bar != std::string::npos);
  CHECK(text.substr(0, bar) == "true,true,scenes/a.scene.json,true,nil");
  CHECK(matches(text.substr(bar + 1), R"(no scene "b" \(did you mean "scenes\/b\.scene\.json"\?\))"));
  CHECK_NO_ERRORS(g);
}

TEST_CASE("tilemap_scenes: scenes: tile-quest: title -> level_1 (spikes, coins, bricks) -> level_2 -> win, state carried by the session") {
  script::HostOptions o;
  o.seed = 1;
  o.budget_ms = budget(250);
  Game g = start_dir("games/examples/tile-quest", {}, o);
  CHECK(g->scene() == "scenes/title.scene.json");
  g.press("start_button");
  g.step();
  CHECK(g->scene() == "scenes/level_1.scene.json");
  bool level_toast = false;
  for (const auto& t : g->toasts().toasts()) level_toast = level_toast || t.text == "LEVEL 1";
  CHECK(level_toast);
  auto hud = [&]() -> std::string {
    for (const char* id : {"hud_1", "hud_2"})
      if (g.alive(id)) return g->world().str(g.entity(id), "text");
    return "";
  };
  auto player = [&] {
    std::vector<world::EntityId> ps = g->world().tagged("player");  // the host's avatar
    REQUIRE(!ps.empty());
    return ps[0];
  };
  auto player_pos = [&] { return g->world().vec(*g->world().get(player()), "position"); };

  // run right: collect the 3 ground coins, then fall into spike pit A (cols 24-26) and respawn
  bool deaths_seen = false;
  g.step(300, [&](int) {
    g.axis("move_x", 1);
    if (matches(hud(), "DEATHS 1")) deaths_seen = true;
  });
  CHECK(matches(hud(), "COINS 3"));
  CHECK(deaths_seen);
  CHECK(player_pos().x < 24 * 16);  // respawned at the start, stuck before the pit

  // brick: stand under col 48 (bricks on row 13) and jump -> brick removed
  g.axis("move_x", 0);
  world::Entity& map1 = g.entity("map_1");
  teleport(g, player(), 48 * 16 + 8, 265);
  g.step(10);
  REQUIRE(map1.tiles);
  const world::TileKind* brick = map1.tiles->kind_at(48, 13);
  CHECK((brick && brick->ch == 'B'));
  g.button("jump", true);
  g.step(40);
  g.button("jump", false);
  const world::TileKind* gone = map1.tiles->kind_at(48, 13);
  CHECK((gone == nullptr || gone->index == 0));  // TS: kindAt(...) === undefined (empty cell)

  // flag -> level 2
  teleport(g, player(), 114 * 16 + 8, 265);
  g.step(30, [&](int) { g.axis("move_x", 1); });
  CHECK(g->scene() == "scenes/level_2.scene.json");
  CHECK(matches(hud(), "LEVEL 2 {3}COINS 4 {3}DEATHS 1"));

  // flag -> win; params show totals
  teleport(g, player(), 114 * 16 + 8, 265);
  g.step(30, [&](int) { g.axis("move_x", 1); });
  CHECK(g->scene() == "scenes/win.scene.json");
  CHECK(g->world().str(g.entity("win_stats"), "text") == "COINS 4    DEATHS 1");
  g.press("again_button");
  g.step();
  CHECK(g->scene() == "scenes/title.scene.json");
  int scene_logs = 0;
  for (const std::string& l : g.logs()) scene_logs += matches(l, "^scene ") ? 1 : 0;
  CHECK(scene_logs == 5);  // the session saw every scene
  CHECK_NO_ERRORS(g);
}

}  // TEST_SUITE
