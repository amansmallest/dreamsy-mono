// topdown kit: headless core simulation tests (movement, combat + i-frames, enemies, items gating,
// keys/doors, puzzles, room transitions, warps, NPCs/shops, bosses, save) + a scripted end-to-end run
// of games/examples/kit-topdown. Port of engine-web/test/kits/topdown.test.ts (same numbers).
#include <algorithm>
#include <cmath>

#include "kits/kit_test.h"

using namespace dreamsy;
using namespace dreamsy::test;

namespace {

const char* kExample = "games/examples/kit-topdown";

const std::string kTileset = R"({"tiles":{
  "_":{"color":"#3a6a3a"},
  "#":{"color":"#666677","solid":true,"tags":["solid"]},
  "R":{"color":"#887755","tags":["rough"]},
  "X":{"color":"#776655","tags":["cracked"]},
  "L":{"color":"#aa8833","tags":["locked"]},
  "~":{"color":"#112233","tags":["gap"]},
  "O":{"color":"#cccccc","tags":["hook"]},
  "k":{"color":"#ffee00","tags":["key"]},
  "$":{"color":"#00ff88","tags":["rupee"]},
  "B":{"color":"#8899aa","tags":["block"]},
  "p":{"color":"#333355","tags":["plate"]},
  "G":{"color":"#aa3333","tags":["gate"]},
  "w":{"color":"#ff00ff","tags":["warp","to_other"]},
  "P":{"tags":["player_start"]},
  "s":{"tags":["enemy","blob"]},
  "c":{"tags":["enemy","bull"]},
  "a":{"tags":["enemy","archer"]},
  "n":{"tags":["enemy","nest"]},
  "K":{"tags":["boss","golem"]},
  "N":{"tags":["npc","merchant"]},
  "C":{"tags":["chest","bombs"]},
  "E":{"tags":["entry","from_other"]}
}})";

const std::string kContent = R"(
kit.setup({
  items = {
    sword = { name = "Sword", kind = "sword", damage = 2 },
    boots = { name = "Boots", kind = "boots", passes = { "rough" }, speed_mult = 1.25, equip = false },
    bombs = { name = "Bombs", kind = "bomb", ammo = 5, max = 10, fuse = 1, radius = 24, breaks = { "cracked" } },
    hookshot = { name = "Hookshot", kind = "hookshot", range = 112, speed = 300 },
    bow = { name = "Bow", kind = "bow", ammo = 10, damage = 2 },
    rupee = { kind = "rupee", amount = 1 },
    heart = { kind = "heart", amount = 2 },
    key = { kind = "key" },
    heart_container = { kind = "heart_container" },
  },
  enemies = {
    blob = { behaviour = "wanderer", hp = 2, speed = 20, drops = {} },
    bull = { behaviour = "charger", hp = 4, speed = 20, aggro = 120, drops = {} },
    archer = { behaviour = "archer", hp = 2, shoot = { interval = 0.6, range = 200, keep = 0 }, drops = {} },
    nest = { behaviour = "spawner", hp = 3, spawn = { enemy = "blob", interval = 0.5, max = 2 }, drops = {} },
  },
  bosses = {
    golem = { name = "Golem", hp = 6, iframes = 0.2, phases = {
      { ["until"] = 0.5, steps = { { ["do"] = "wait", time = 0.3 }, { ["do"] = "shoot", pattern = "ring", count = 6 } } },
      { ["until"] = 0, steps = { { ["do"] = "chase", time = 0.5 }, { ["do"] = "summon", enemy = "blob", count = 1 } } },
    } },
  },
  npcs = { merchant = { name = "Moss", dialog = { "Hello!" }, gives = "boots", shop = { { item = "bombs", price = 5 } } } },
  warps = { to_other = { scene = "scenes/other.scene.json", entry = "from_other" } },
})
)";

// Map rows -> a JSON string literal ("row1\nrow2").
std::string json_rows(const std::vector<std::string>& rows) { return "\"" + join(rows, "\\n") + "\""; }

std::vector<std::string> floor_rows(size_t cols, size_t rows) { return std::vector<std::string>(rows, std::string(cols, '_')); }

// One area scene: camera, a floor TileMap2D, the object TileMap2D (runs main.luau) and the hero.
std::string area_scene(const std::string& root, const std::vector<std::string>& map, size_t cols, size_t rows) {
  const std::string r = root;
  return R"({"format":"0","root":")" + r + R"(","entities":{
    ")" + r + R"(":{"type":"Node2D","children":[")" + r + R"(_cam",")" + r + R"(_floor",")" + r + R"(_obj",")" + r + R"(_hero"]},
    ")" + r + R"(_cam":{"type":"Camera2D","props":{"zoom":3,"position":[80,64]}},
    ")" + r + R"(_floor":{"type":"TileMap2D","props":{"tile_size":16,"tileset":"data/tilesets/t.json","data":)" +
         json_rows(floor_rows(cols, rows)) + R"(,"collision":false},"tags":["area_map"]},
    ")" + r + R"(_obj":{"type":"TileMap2D","props":{"tile_size":16,"tileset":"data/tilesets/t.json","data":)" +
         json_rows(map) + R"(,"collision":false},"tags":["area_map"],"scripts":["scripts/client/main.luau"]},
    ")" + r + R"(_hero":{"type":"Node2D","props":{"position":[40,40]},"tags":["player"],"children":[")" + r + R"(_hero_sprite"]},
    ")" + r + R"(_hero_sprite":{"type":"Sprite2D","props":{"size":[12,14],"modulate":"#40a0ff"}}
  }})";
}

struct AreaOpts {
  std::vector<std::string> grid;
  std::string script = {}, area_opts = {};
  std::optional<std::pair<int, int>> room = {};
};

// TS areaPkg(): a "topdown" package with scenes/main (the grid) and scenes/other (a warp target).
FileMap area_pkg(const AreaOpts& o) {
  size_t cols = o.grid[0].size(), rows = o.grid.size();
  std::string room = o.room ? "room = { " + std::to_string(o.room->first) + ", " + std::to_string(o.room->second) + " }," : "";
  return {
      {"dreamsy.toml", manifest("\"topdown\"", "scenes/main.scene.json", "portrait", "pixel")},
      {"scenes/main.scene.json", area_scene("main", o.grid, cols, rows)},
      {"scenes/other.scene.json", area_scene("other", {"__________", "____E_____", "__________"}, cols, rows)},
      {"data/tilesets/t.json", kTileset},
      {"scripts/shared/setup.luau", "local kit = require(\"@kit/topdown\")\n" + kContent + "\nreturn kit"},
      {"scripts/client/main.luau", R"(
local kit = require("../shared/setup")
local area = kit.area.start({ id = currentScene(), hud = false, start_items = { "sword" }, )" + room + " " + o.area_opts + R"( })
for _, ev in { "hurt", "death", "enemyKilled", "item", "doorOpened", "broke", "roomEnter", "warp", "talk", "bought", "chest", "puzzleSolved", "bossDefeated", "bossPhase", "hooked", "hookLanded", "blockPushed", "roomCleared" } do
  area.events:on(ev, function(a) print("EV " .. ev .. " " .. tostring(if type(a) == "table" then (a.id or a.key or "") else a)) end)
end
)" + o.script + "\n"},
  };
}

Game area(const AreaOpts& o, const Json* save = nullptr) {
  script::HostOptions opts;
  opts.budget_ms = budget(250);
  if (save) opts.save = *save;
  return start(area_pkg(o), opts);
}

world::Point hero_pos(const Game& g) {
  for (world::EntityId e : g->world().walk()) {
    const world::Entity& ent = *g->world().get(e);
    if (std::find(ent.tags.begin(), ent.tags.end(), "player") != ent.tags.end()) return g->world().vec(ent, "position");
  }
  FAIL("no player entity");
  return {};
}
std::vector<std::string> events(const Game& g) { return g.logs_with("EV "); }
bool has(const std::vector<std::string>& v, std::string_view s) { return std::find(v.begin(), v.end(), s) != v.end(); }
int count_prefix(const std::vector<std::string>& v, std::string_view p) {
  int n = 0;
  for (const std::string& s : v) n += s.rfind(p, 0) == 0;
  return n;
}
void move(Game& g, double x, double y) {
  g.axis("move_x", x);
  g.axis("move_y", y);
}
void tap(Game& g, std::string_view button) { g->input().tap(button); }
// steps(g, n, each): `each(i)` before tick i.
void steps(Game& g, int n, const std::function<void(int)>& each = {}) { g.step(n, each); }

// player_offset {0,-4}: entity y = feet y - 4
const std::vector<std::string> kOpen = {
    "##########", "#________#", "#_P______#", "#________#", "#________#", "#________#", "#________#", "##########",
};

}  // namespace

TEST_SUITE("kit topdown") {

TEST_CASE("topdown: movement: moves at speed in 8 directions (diagonals normalized) and collides with walls") {
  Game g = area({kOpen});
  steps(g, 2);
  world::Point p0 = hero_pos(g);
  steps(g, 30, [&](int) { move(g, 1, 0); });
  CHECK_CLOSE(hero_pos(g).x - p0.x, 40, 0);  // 80 px/s x 0.5 s
  world::Point p1 = hero_pos(g);
  steps(g, 15, [&](int) { move(g, -1, 1); });
  CHECK_CLOSE(std::hypot(hero_pos(g).x - p1.x, hero_pos(g).y - p1.y), 20, 0);
  steps(g, 200, [&](int) { move(g, 1, 0); });
  // wall at col 9 -> x = 144 - 5 (hitbox half-width)
  CHECK_CLOSE(hero_pos(g).x, 139, 1);
  CHECK_NO_ERRORS(g);
}

TEST_CASE("topdown: combat: sword kills an enemy; contact hurts once per i-frame window with knockback") {
  std::vector<std::string> grid = kOpen;
  grid[2] = "#_P_s____#";
  Game g = area({grid, "for _, e in area.enemies do e.def.speed = 0 end", "player = { hearts = 3 }"});
  steps(g, 2);
  // walk up to it, face right and swing
  steps(g, 60, [&](int i) {
    move(g, i < 12 ? 1 : 0, 0);
    if (i % 12 == 0 && i >= 12) tap(g, "action");
  });
  CHECK(has(events(g), "enemyKilled blob"));
  // second blob: walk into it
  Game g2 = area({grid, "for _, e in area.enemies do e.def.speed = 0 end"});
  steps(g2, 2);
  double hx = hero_pos(g2).x;
  steps(g2, 40, [&](int) { move(g2, 1, 0); });
  std::vector<std::string> hurts;
  for (const std::string& e : events(g2))
    if (e.rfind("hurt", 0) == 0) hurts.push_back(e);
  CHECK(hurts.size() == 1);
  CHECK(join(hurts) == "hurt 1");
  CHECK_NO_ERRORS(g);
  CHECK_NO_ERRORS(g2);
  CHECK(hx > 0);
}

TEST_CASE("topdown: combat: charger charges when aligned; archer shoots; spawner spawns") {
  std::vector<std::string> grid = kOpen;
  grid[2] = "#_P_____c#";
  Game g = area({grid});
  steps(g, 120);
  CHECK(count_prefix(events(g), "hurt") > 0);
  std::vector<std::string> grid2 = kOpen;
  grid2[2] = "#_P_____a#";
  Game g2 = area({grid2, R"(area.events:on("enemy_shoot", function() print("SHOT") end))"});
  steps(g2, 120);
  CHECK(has(g2.logs(), "SHOT"));
  std::vector<std::string> grid3 = kOpen;
  grid3[5] = "#______n_#";
  Game g3 = area({grid3, R"(onTick(function() if time() > 2 and time() < 2.02 then print("COUNT " .. #area.enemies) end end))"});
  steps(g3, 130);
  CHECK(has(g3.logs(), "COUNT 3"));
  CHECK_NO_ERRORS(g);
  CHECK_NO_ERRORS(g2);
  CHECK_NO_ERRORS(g3);
}

TEST_CASE("topdown: ai enemies: behaviour \"ai\" drives an @kit/ai brain with the kit's grid collision (turret shoots, chase hurts)") {
  std::vector<std::string> grid = kOpen;
  grid[2] = "#_P_____s#";
  Game g = area({grid, R"(
      kit.content.register("enemies", "blob", { behaviour = "ai", hp = 2, ai = { behavior = "turret", fireEvery = 0.5, firstShot = 0.2, range = 200 } })
      area.events:on("enemy_shoot", function() print("SHOT") end)
      area:addEnemy("blob", area:roomCell(0, 0, 5, 5)))"});
  steps(g, 90);
  CHECK(has(g.logs(), "SHOT"));
  CHECK_NO_ERRORS(g);
  Game g2 = area({kOpen, R"(
      kit.content.register("enemies", "hunter", { behaviour = "ai", hp = 2, ai = { behavior = "chase", speed = 60, aggro = 200 } })
      area:addEnemy("hunter", area:roomCell(0, 0, 7, 5)))"});
  steps(g2, 120);
  CHECK(count_prefix(events(g2), "hurt") > 0);
  CHECK_NO_ERRORS(g2);
}

TEST_CASE("topdown: items gate areas: rough ground blocks until boots; bombs break cracked walls; hookshot crosses a gap") {
  std::vector<std::string> grid = kOpen;
  grid[2] = "#_P_R____#";
  Game g = area({grid});
  steps(g, 60, [&](int) { move(g, 1, 0); });
  CHECK(hero_pos(g).x < 64);
  Game g2 = area({grid, R"(area:give("boots"))"});
  steps(g2, 60, [&](int) { move(g2, 1, 0); });
  CHECK(hero_pos(g2).x > 90);

  std::vector<std::string> grid_x = kOpen;
  grid_x[2] = "#_P_X____#";
  Game g3 = area({grid_x, R"(area:give("bombs"))"});
  steps(g3, 20, [&](int) { move(g3, 1, 0); });
  move(g3, 0, 0);
  tap(g3, "action2");
  steps(g3, 80);
  CHECK(has(events(g3), "broke cracked"));
  steps(g3, 60, [&](int) { move(g3, 1, 0); });
  CHECK(hero_pos(g3).x > 90);

  std::vector<std::string> grid_h = kOpen;
  grid_h[2] = "#_P~~~_O_#";
  Game g4 = area({grid_h, R"(area:give("hookshot"))"});
  steps(g4, 30, [&](int) { move(g4, 1, 0); });
  CHECK(hero_pos(g4).x < 48);
  move(g4, 0, 0);
  tap(g4, "action2");
  steps(g4, 60);
  CHECK(has(events(g4), "hookLanded nil"));
  CHECK_CLOSE(hero_pos(g4).x, 104, 0);  // pulled across the gap, next to the post (col 6)
  CHECK_NO_ERRORS(g);
  CHECK_NO_ERRORS(g2);
  CHECK_NO_ERRORS(g3);
  CHECK_NO_ERRORS(g4);
}

TEST_CASE("topdown: keys, doors, chests, save: locked door needs a key; picking up the key opens it; state survives a reload") {
  std::vector<std::string> grid = kOpen;
  grid[2] = "#_P__L___#";
  grid[5] = "#_k______#";
  Game g = area({grid});
  steps(g, 60, [&](int) { move(g, 1, 0); });
  CHECK(hero_pos(g).x < 80);
  CHECK_FALSE(has(events(g), "doorOpened locked"));
  // fetch the key (col 2, row 5)
  steps(g, 60, [&](int) { move(g, -1, 1); });
  CHECK(has(events(g), "item key"));
  steps(g, 36, [&](int) { move(g, 0, -1); });
  steps(g, 90, [&](int) { move(g, 1, 0); });
  CHECK(has(events(g), "doorOpened locked"));
  CHECK(hero_pos(g).x > 100);
  CHECK_NO_ERRORS(g);
  J p = J(&g.save())["core"]["d"]["topdown"];
  bool done_key = false;
  for (const std::string& k : p["done"].keys()) done_key = done_key || matches(k, ":5:2$");
  CHECK_MESSAGE(done_key, p["done"].dump());
  // reload: door stays open, key stays taken, keys spent
  Json saved = g.save();
  Game g2 = area({grid}, &saved);
  steps(g2, 90, [&](int) { move(g2, 1, 0); });
  CHECK(hero_pos(g2).x > 100);
  CHECK_FALSE(has(events(g2), "item key"));
  CHECK_NO_ERRORS(g2);
}

TEST_CASE("topdown: keys, doors, chests, save: chests give items; NPC dialog gives items; shops sell for rupees") {
  std::vector<std::string> grid = kOpen;
  grid[2] = "#_P_C____#";
  grid[4] = "#_N______#";
  grid[5] = "#_$$$$$$_#";
  Game g = area({grid});
  steps(g, 10, [&](int) { move(g, 1, 0); });
  move(g, 0, 0);
  tap(g, "action");
  steps(g, 5);
  CHECK(has(events(g), "chest bombs"));
  // talk to the NPC below-left: face down from (2,3)
  steps(g, 10, [&](int) { move(g, -1, 0.0); });
  steps(g, 12, [&](int) { move(g, 0, 1); });
  move(g, 0, 0);
  tap(g, "action");
  steps(g, 3);
  CHECK(has(events(g), "talk merchant"));
  auto& dialogs = g->dialogs().dialogs;
  CHECK(dialogs.current.has_value());
  // advance dialog: confirm until the shop choice; pick option 1 (bombs, 5 rupees) - but we have 0 rupees
  for (int i = 0; i < 20 && !(dialogs.current && dialogs.current->choice); ++i) {
    g->dialogs().tap(-1);
    steps(g, 8);
  }
  CHECK(has(events(g), "item boots"));
  g->dialogs().tap(0);
  steps(g, 5);
  CHECK_FALSE(has(events(g), "bought bombs"));
  CHECK_NO_ERRORS(g);
}

TEST_CASE("topdown: puzzles, rooms, warps: pushing a block onto a plate opens the gate") {
  Game g = area({{
      "##########",
      "#________#",
      "#_P_B_p__#",
      "#________#",
      "######G###",
      "#________#",
      "#________#",
      "##########",
  }});
  steps(g, 120, [&](int) { move(g, 1, 0); });
  CHECK(count_prefix(events(g), "blockPushed") >= 2);
  CHECK(has(events(g), "puzzleSolved 0,0"));
  CHECK_NO_ERRORS(g);
}

TEST_CASE("topdown: puzzles, rooms, warps: walking off a room slides the camera into the next room; enemies spawn per room; minimap marks visits") {
  AreaOpts o{{
      "####################",
      "#__________________#",
      "#_P________________#",
      "#__________________#",
      "#____________s_____#",
      "#__________________#",
      "#__________________#",
      "####################",
  }};
  o.room = {{10, 8}};
  o.script = R"(onTick(function() print("ROOM " .. area.room.key .. " " .. #area.room.live) end))";
  Game g = area(o);
  steps(g, 5);
  CHECK(has(g.logs(), "ROOM 0,0 0"));
  steps(g, 150, [&](int) { move(g, 1, 0); });
  CHECK(has(events(g), "roomEnter 1,0"));
  CHECK(has(g.logs(), "ROOM 1,0 1"));
  CHECK(g.pos("main_cam").x > 160);  // camera now on room 1 (x 160..320)
  // TS toEqual({ "0,0": true, "1,0": true }) ignores key order: compare sorted keys + values
  J visited = J(&g.save())["core"]["d"]["topdown"]["visited"]["scenes/main.scene.json"];
  std::vector<std::string> rooms = visited.keys();
  std::sort(rooms.begin(), rooms.end());
  CHECK(join(rooms, " ") == "0,0 1,0");
  for (const std::string& k : rooms) CHECK(visited[k].b());
  CHECK_NO_ERRORS(g);
}

TEST_CASE("topdown: puzzles, rooms, warps: warps load the target scene at its entry point") {
  std::vector<std::string> grid = kOpen;
  grid[2] = "#_P__w___#";
  Game g = area({grid});
  for (int i = 0; i < 60 && g->scene() == "scenes/main.scene.json"; ++i) {
    move(g, 1, 0);
    g.step();
  }
  CHECK(has(events(g), "warp to_other"));
  CHECK(g->scene() == "scenes/other.scene.json");
  move(g, 0, 0);
  steps(g, 2);
  world::Point p = hero_pos(g);
  CHECK_CLOSE(p.x, 72, 0);  // entry E at col 4, row 1 -> (72, 24) feet, entity y -4
  CHECK_CLOSE(p.y, 20, 0);
  CHECK_NO_ERRORS(g);
}

TEST_CASE("topdown: bosses: boss runs its phase patterns and is defeated by the sword; drops are given") {
  std::vector<std::string> grid = kOpen;
  grid[4] = "#_____K__#";
  Game g = area({grid, R"(
      onTick(function()
        local b = area.bosses[1]
        if b and b.alive and time() > 0.5 then area:damageBoss(b, 1) end
      end))",
                 "player = { hearts = 20 }"});
  steps(g, 400);
  std::vector<std::string> ev = events(g);
  CHECK(count_prefix(ev, "bossPhase") > 0);
  CHECK(has(ev, "bossDefeated golem"));
  CHECK_NO_ERRORS(g);
}

// ---------------------------------------------------------------- example game

TEST_CASE("topdown example: kit.setup() reads data/*.json (no Luau mirror); JSON has the kit schemas' required fields") {
  FileMap pkg = read_dir(kExample);
  CHECK(pkg.count("scripts/shared/content.luau") == 0);
  std::vector<std::string> ids;
  const std::pair<const char*, const char*> kinds[] = {{"items", "item"}, {"enemies", "enemy"}, {"bosses", "boss"}, {"npcs", "npc"}};
  for (const auto& [dir, s] : kinds) {
    Json schema = read_json(std::string("kits/topdown/schemas/") + s + ".json");
    for (const std::string& p : paths_with(pkg, std::string("data/") + dir + "/")) {
      Json v = parse_json(pkg[p]);
      for (const std::string& k : J(&schema)["required"].strs()) CHECK_MESSAGE(J(&v).has(k), p << "." << k);
      ids.push_back(std::string(dir) + "/" + J(&v)["id"].str());
    }
  }
  Json warps = parse_json(pkg["data/warps.json"]);
  for (const std::string& id : J(&warps).keys()) {
    CHECK_MESSAGE(pkg.count(J(&warps)[id]["scene"].str()) == 1, id);
    ids.push_back("warps/" + id);
  }
  script::HostOptions probe_opts;
  probe_opts.budget_ms = budget(250);
  Game g = start_dir(kExample, {{"scripts/client/zz_probe.luau", R"(
local kit = require("@kit/topdown")
for _, kind in kit.content.KINDS do for id in kit.content.all(kind) do print("HAS " .. kind .. "/" .. id) end end)"}}, probe_opts);
  std::vector<std::string> got = g.logs_with("HAS ");
  std::sort(got.begin(), got.end());
  std::sort(ids.begin(), ids.end());
  CHECK(join(got, ",") == join(ids, ","));
  CHECK_NO_ERRORS(g);
}

TEST_CASE("topdown example: scripted end-to-end run: elder -> grotto -> bombs -> key -> hookshot -> boss key -> boss -> home, zero script errors" *
          doctest::test_suite("slow")) {
  const std::string autoplay = R"(
local kit = require("@kit/topdown")
local P = kit.progress
local co
local function wait(t) local u = time() + t while time() < u do coroutine.yield() end end
local function waitScene(s) while currentScene() ~= s or kit.area.current == nil or kit.area.current.loadedFor ~= s do coroutine.yield() end wait(0.1) end
local held = nil
local function A() return kit.area.current end
local function hold(x, y, t) held = { x = x, y = y } wait(t) held = nil end
local function at(rx, ry, c, r, face) local x, y = A():roomCell(rx, ry, c, r) A():teleport(x, y, face) A().hero.iframes = 1e6 wait(0.1) end
local function interact() A():interact() wait(0.2) while ui.dialogOpen() do coroutine.yield() end wait(0.2) end
local function use() A():useItem() end
kit.area.events = kit.area.events
game.sceneLoaded:connect(function(path)
  local a = kit.area.current
  if a then
    a.loadedFor = path
    a.o.input = function(inp) if held then inp.x, inp.y = held.x, held.y end return inp end
    a.events:on("item", function(id) print("ITEM " .. id) end)
    a.events:on("doorOpened", function(tag) print("DOOR " .. tag) end)
    a.events:on("broke", function(tag) print("BROKE " .. tag) end)
    a.events:on("puzzleSolved", function() print("PUZZLE") end)
    a.events:on("hookLanded", function() print("HOOKED") end)
    a.events:on("bossDefeated", function(b) print("BOSS " .. b.id) end)
  end
end)
co = coroutine.create(function()
  waitScene("scenes/overworld.scene.json")
  at(0, 0, 3, 5, "up") interact()                               -- Granny Wick gives the sword
  at(1, 1, 7, 5, "up") hold(0, -1, 0.5)                         -- into the grotto
  waitScene("scenes/grotto.scene.json")
  at(0, 1, 4, 5, "down") hold(0, 1, 2.2)                        -- block onto the plate -> gate opens
  at(0, 1, 7, 2, "up") interact()                               -- chest: bombs
  at(0, 1, 7, 10, "down") use() wait(1.8)                       -- bomb the cracked wall
  at(0, 1, 7, 11, "down") hold(0, 1, 1.2)                       -- walk through into the key room
  at(0, 2, 7, 7, "up") interact()                               -- chest: small key
  at(1, 1, 12, 6, "right") hold(1, 0, 0.6)                      -- unlock the east door
  at(2, 1, 11, 10, "up") interact()                             -- chest: hookshot
  at(2, 1, 3, 6, "up") use() wait(1.0)                          -- hook across the pit
  hold(1, 0, 0.4) hold(0, -1, 0.1)
  at(2, 0, 7, 6, "up") interact()                               -- chest: boss key
  at(1, 1, 7, 2, "up") hold(0, -1, 1.5)                         -- boss door, walk in
  local b = A().bosses[1]
  while b and b.alive do A():damageBoss(b, 2) wait(0.7) end
  wait(1.5)
  for _, p in A().pickups do A():teleport(p.x, p.y) end
  wait(0.5)
  at(1, 0, 7, 2, "up") hold(0, -1, 0.3)                         -- stairs home
  waitScene("scenes/overworld.scene.json")
  print("HOME hearts=" .. P.get().hearts .. " cleared=" .. tostring(P.flag("grotto_cleared")))
  at(0, 0, 3, 5, "up") interact()
  print("ALL DONE")
end)
onTick(function()
  if co and coroutine.status(co) == "suspended" then
    local ok, err = coroutine.resume(co)
    if not ok then print("AUTOPLAY ERROR " .. tostring(err)) co = nil end
  end
end))";
  script::HostOptions opts;
  opts.seed = 5;
  opts.budget_ms = budget(250);
  Game g = start_dir(kExample, {{"scripts/client/zz_autoplay.luau", autoplay}}, opts);
  // step until "ALL DONE" is printed (checked on the new log lines only)
  bool all_done = false;
  size_t seen = 0;
  for (int i = 0; i < 60 * 120 && !all_done; ++i) {
    if (g->dialogs().open() && i % 6 == 0) g->dialogs().tap(-1);
    g.step();
    const auto& lines = g->logs();
    for (; seen < lines.size(); ++seen) all_done = all_done || lines[seen].text == "ALL DONE";
  }
  std::vector<std::string> l;
  for (const std::string& x : g.logs())
    if (matches(x, "^(ITEM|DOOR|BROKE|PUZZLE|HOOKED|BOSS|HOME|ALL|AUTOPLAY)")) l.push_back(x);
  MESSAGE(join(l));
  CHECK(has(l, "ALL DONE"));
  for (const char* want : {"ITEM sword", "PUZZLE", "ITEM bombs", "BROKE cracked", "ITEM small_key", "DOOR locked",
                           "ITEM hookshot", "HOOKED", "ITEM boss_key", "DOOR boss_locked", "BOSS mire_warden",
                           "ITEM heart_container"}) {
    CAPTURE(want);
    CHECK(has(l, want));
  }
  CHECK(has(l, "HOME hearts=4 cleared=true"));
  J d = J(&g.save())["core"]["d"];
  // bag: [id, count] pairs (non-array entries are skipped, like the TS filter(Array.isArray))
  std::map<std::string, double> bag;
  for (const J& e : d["inventories"]["bag"].values())
    if (e.is_array()) bag[e[0].str()] = e[1].num();
  CHECK(bag["sword"] == 1);
  CHECK(bag["bombs"] == 1);
  CHECK(bag["hookshot"] == 1);
  CHECK(d["topdown"]["bosses"]["mire_warden"].b());
  CHECK(d["flags"]["grotto_cleared"].b());
  CHECK_NO_ERRORS(g);
}

}  // TEST_SUITE
