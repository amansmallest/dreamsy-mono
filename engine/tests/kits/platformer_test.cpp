// platformer kit: headless core simulation tests (controller feel, tiles, enemies, bosses,
// checkpoints, world unlocks, save) + a scripted end-to-end run of games/examples/kit-platformer.
// Port of engine-web/test/kits/platformer.test.ts (same numbers and thresholds).
//
// The kit's controller is script-side (it moves Node2Ds itself, no physics engine), so the feel
// numbers match engine-web exactly. Not ported: the leaderboard ghost (engine-web recorded the
// player's frames with each submission; the C++ engine doesn't record ghosts).
#include "kits/kit_test.h"

#include <algorithm>
#include <limits>
#include <set>

using namespace dreamsy;
using namespace dreamsy::test;

namespace {

const double kInf = std::numeric_limits<double>::infinity();

std::string platformer_manifest(const std::string& entry = "scenes/main.scene.json") {
  return "format = \"0\"\nname = \"P\"\ndimension = \"2d\"\norientation = \"landscape\"\nentry_scene = \"" + entry +
         "\"\nkits = [\"platformer\"]\n[style]\npreset = \"pixel\"\n";
}

const std::string kTileset = R"({"tiles":{
  "#":{"color":"#888888","solid":true,"tags":["solid"]},
  "=":{"color":"#aa7744","tags":["oneway"]},
  "H":{"color":"#ccaa44","tags":["ladder"]},
  "^":{"color":"#ffffff","tags":["hazard"]},
  "S":{"color":"#ff44aa","solid":true,"tags":["solid","spring"]},
  "B":{"color":"#aa5500","solid":true,"tags":["breakable"]},
  "o":{"color":"#ffdd00","tags":["coin"]},
  "*":{"color":"#00ffff","tags":["gem"]},
  "P":{"tags":["player_start"]},
  "C":{"tags":["checkpoint"]},
  "G":{"tags":["goal"]},
  "s":{"tags":["enemy","slime"]},
  "h":{"tags":["enemy","hopper"]},
  "f":{"tags":["enemy","bat"]},
  "t":{"tags":["enemy","gunner"]},
  "c":{"tags":["enemy","dog"]},
  "T":{"tags":["enemy","cannon"]},
  "K":{"tags":["boss","king"]},
  "M":{"tags":["platform","move_x","range_3"]},
  "d":{"tags":["powerup","double_jump"]},
  "w":{"tags":["powerup","wall_jump"]},
  "D":{"tags":["powerup","dash"]}}})";

const std::string kContent = R"(
kit.setup({
  enemies = {
    slime = { behaviour = "patroller", size = { 12, 10 }, speed = 30 },
    hopper = { behaviour = "hopper", size = { 12, 12 }, hop = { interval = 0.5, height = 32, speed = 50 } },
    bat = { behaviour = "flyer", size = { 12, 10 }, speed = 40, fly = { pattern = "sine", amplitude = 16, period = 1, range = 32 } },
    gunner = { behaviour = "shooter", size = { 12, 14 }, shoot = { interval = 0.5, speed = 120, range = 400 } },
    dog = { behaviour = "chaser", size = { 14, 10 }, speed = 30, chase = { range = 200 } },
    cannon = { behaviour = "turret", size = { 14, 14 }, stompable = false, shoot = { interval = 0.5, aim = "fixed", angle = 180, speed = 100 } },
  },
  bosses = {
    king = { name = "King", hp = 3, size = { 24, 24 }, iframes = 0.3, phases = {
      { ["until"] = 0.5, steps = { { ["do"] = "walk", speed = 40, time = 0.5 }, { ["do"] = "wait", time = 0.2 } } },
      { ["until"] = 0, speed_mult = 2, steps = { { ["do"] = "jump", height = 30, toward = "player" }, { ["do"] = "shoot", count = 3, spread = 30, speed = 100 } } },
    } },
  },
})
)";

using Grid = std::vector<std::string>;

struct LevelOpts {
  Grid grid;
  std::string script;
  std::string level_opts;
  double player_x = 40, player_y = 40;
};

// TS levelPkg(): a camera, the tile map (data/levels/l.txt), a Node2D player with a sprite, and a
// client script that starts a kit level and prints "EV <event> <arg>" for every level event.
FileMap level_pkg(const LevelOpts& o) {
  std::string scene = R"({"format":"0","root":"world","entities":{
    "world":{"type":"Node2D","children":["cam","map","player","label"]},
    "cam":{"type":"Camera2D","props":{"zoom":2,"position":[320,180]}},
    "map":{"type":"TileMap2D","props":{"tile_size":16,"tileset":"data/tilesets/t.json","data":"file:data/levels/l.txt"}},
    "player":{"type":"Node2D","props":{"position":[)" +
                      std::to_string(o.player_x) + "," + std::to_string(o.player_y) + R"(]},"tags":["player"],"children":["player_sprite"]},
    "player_sprite":{"type":"Sprite2D","props":{"size":[12,14],"modulate":"#ff8800"}},
    "label":{"type":"UIText","props":{"text":""}}}})";
  return {
      {"dreamsy.toml", platformer_manifest()},
      {"scenes/main.scene.json", scene},
      {"data/tilesets/t.json", kTileset},
      {"data/levels/l.txt", join(o.grid) + "\n"},
      {"scripts/client/main.luau", "\nlocal kit = require(\"@kit/platformer\")\n" + kContent +
                                       "\nlocal level = kit.level.start({ map = entity(\"map\"), player = entity(\"player\"), id = \"test\", hud = false, " +
                                       o.level_opts + R"( })
for _, ev in { "coin", "gem", "hurt", "death", "respawn", "checkpoint", "complete", "enemyKilled", "stomp", "powerup", "break", "spring", "bossDefeated", "bossPhase", "secret" } do
  level.events:on(ev, function(a) print("EV " .. ev .. " " .. tostring(if type(a) == "table" then (a.id or "") else a)) end)
end
)" + o.script + "\n"},
  };
}

// Kit games are script-heavy: the sanitizer-scaled CPU budget (not what these tests check).
script::HostOptions opts() {
  script::HostOptions h;
  h.budget_ms = budget(250);
  return h;
}

Game load_level(const LevelOpts& o) { return start(level_pkg(o), opts()); }

// The player's y / x (TS pos(g)[1] / pos(g)[0]).
double py(const Game& g) { return g.pos("player").y; }
double px(const Game& g) { return g.pos("player").x; }

// "EV ..." lines without the prefix.
std::vector<std::string> events(const Game& g) { return g.logs_with("EV "); }
bool has(const std::vector<std::string>& list, const std::string& x) {
  return std::find(list.begin(), list.end(), x) != list.end();
}
bool any_starts(const std::vector<std::string>& list, const std::string& prefix) {
  for (const std::string& s : list)
    if (s.rfind(prefix, 0) == 0) return true;
  return false;
}

// Platformer progress = the "platformer" section of the core save (key "core").
J prog(const Game& g) { return J(&g.save())["core"]["d"]["platformer"]; }

void hold(Game& g, double axis, bool jump = false) {
  g.axis("move_x", axis);
  g.button("jump", jump);
}

// A copy of a grid with the player start tile removed (TS FLAT.map(r => r.replace("P", "."))).
Grid no_p(Grid grid) {
  for (std::string& r : grid) {
    size_t at = r.find('P');
    if (at != std::string::npos) r[at] = '.';
  }
  return grid;
}

// 40 cols x 12 rows, floor at row 11 (top y = 176). Player body 12x14 -> standing center y = 169.
const Grid kFlat = {
    "........................................", "........................................",
    "........................................", "........................................",
    "........................................", "........................................",
    "........................................", "........................................",
    "........................................", "........................................",
    "..P.....................................", "########################################",
};

// floor cols 0..9 then a pit, wall on the far right for wall tests
const Grid kLedge = {
    "........................................", "........................................",
    "........................................", "........................................",
    "........................................", "........................................",
    "........................................", "........................................",
    "........................................", "........................................",
    "..P.....................................", "##########..........................####",
};

const Grid kWalls = {
    "#......................................#", "#......................................#",
    "#......................................#", "#......................................#",
    "#..............#.......................#", "#..............#.......................#",
    "#..............#.......................#", "#..............#.......................#",
    "#..............#.......................#", "#..............#.......................#",
    "#.P............#.......................#", "########################################",
};

// PROBE <json> lines: enemies, bosses, health and projectile count every tick.
const std::string kProbeEnemies = R"(
onTick(function()
  local list = {}
  for _, en in level.enemies do table.insert(list, string.format('{"id":"%s","x":%.2f,"y":%.2f,"alive":%s,"dir":%d}', en.id, en.x, en.y, tostring(en.alive), en.dir)) end
  local bs = {}
  for _, b in level.bosses do table.insert(bs, string.format('{"x":%.2f,"y":%.2f,"hp":%d,"phase":%d,"alive":%s,"awake":%s}', b.x, b.y, b.hp, b.phase, tostring(b.alive), tostring(b.awake))) end
  print('PROBE {"t":' .. string.format("%.3f", time()) .. ',"health":' .. level.health .. ',"proj":' .. #level.projectiles .. ',"enemies":[' .. table.concat(list, ",") .. '],"bosses":[' .. table.concat(bs, ",") .. ']}')
end))";

// The parsed PROBE lines (Json values; view them with J).
std::vector<Json> probes(const Game& g) {
  std::vector<Json> out;
  for (const std::string& text : g.logs_with("PROBE ")) out.push_back(parse_json(text));
  return out;
}

// The enemy with this id in a probe (null view if absent).
J enemy(const Json& probe, const std::string& id) {
  for (J e : J(&probe)["enemies"].values())
    if (e["id"].str() == id) return e;
  return J();
}

// TS enemyGrid(): FLAT without the player start, row 10 replaced.
Grid enemy_grid(const std::string& row10) {
  Grid grid = no_p(kFlat);
  grid[10] = row10;
  return grid;
}

const std::string kWorld = R"(kit.setup({ world = { map_scene = "scenes/map.scene.json", worlds = {
    { id = "w1", name = "Meadow", levels = {
      { id = "1-1", name = "First Steps", scene = "scenes/main.scene.json", gems = 1 },
      { id = "1-2", name = "Second", scene = "scenes/main.scene.json" },
      { id = "1-s", name = "Secret", scene = "scenes/main.scene.json", secret = true, unlock = { gems = 1 } },
    } },
    { id = "w2", name = "Caves", levels = {
      { id = "2-1", name = "Dark", scene = "scenes/main.scene.json", unlock = { world = "w1" } },
    } },
  } } }))";

// TS mapPkg(): a map scene, an empty level scene, the world setup as a shared module.
FileMap map_pkg(const std::string& script) {
  return {
      {"dreamsy.toml", platformer_manifest("scenes/map.scene.json")},
      {"scenes/map.scene.json",
       R"({"format":"0","root":"m","entities":{"m":{"type":"Node2D","children":["mcam"]},"mcam":{"type":"Camera2D","props":{"zoom":1}}}})"},
      {"scenes/main.scene.json",
       R"({"format":"0","root":"w","entities":{"w":{"type":"Node2D","children":["lbl"]},"lbl":{"type":"UIText","props":{"text":""}}}})"},
      {"scripts/shared/setup.luau", "local kit = require(\"@kit/platformer\")\n" + kWorld + "\nreturn kit"},
      {"scripts/client/session.luau", "local kit = require(\"../shared/setup\")\n" + script},
  };
}

const char* kExample = "games/examples/kit-platformer";

}  // namespace

TEST_SUITE("kit platformer") {

// ---------------------------------------------------------------- controller feel

TEST_CASE("platformer: controller feel: lands on the floor and jumps to the configured height (variable jump cuts it short)") {
  Game g = load_level({kFlat, "", "controller = { jump_height = 56, jump_time = 0.36 }"});
  g.step(10);
  CHECK_NO_ERRORS(g);
  CHECK_CLOSE(py(g), 169, 1);
  // full jump: hold the button
  double min_y = kInf;
  g.step(60, [&](int) {
    hold(g, 0, true);
    min_y = std::min(min_y, py(g));
  });
  const double full = 169 - min_y;
  CHECK(full > 56 * 0.95);
  CHECK(full < 56 * 1.06);
  g.step(60, [&](int) { hold(g, 0, false); });
  CHECK_CLOSE(py(g), 169, 1);
  // short hop: release after 4 ticks
  min_y = kInf;
  g.step(60, [&](int i) {
    hold(g, 0, i < 4);
    min_y = std::min(min_y, py(g));
  });
  const double hop = 169 - min_y;
  CHECK(hop < full * 0.5);
  CHECK(hop > 4);
  CHECK_NO_ERRORS(g);
}

// ---------------------------------------------------------------- coyote time + jump buffer

namespace {
// Walk off the ledge, press jump `late` ticks after the feet leave it; returns the ys after leaving.
std::vector<double> off_ledge(int late) {
  Game g = load_level({kLedge, "", "controller = { coyote_time = 0.1 }"});
  g.step(5);
  int left = -1;
  std::vector<double> ys;
  for (int i = 0; i < 120; ++i) {
    const double x = px(g);
    if (left < 0 && x - 6 > 160) left = i;  // body fully past the ledge edge (x = 160)
    hold(g, 1, left >= 0 && i >= left + late && i < left + late + 20);
    g.step();
    if (left >= 0) ys.push_back(py(g));
  }
  CHECK_NO_ERRORS(g);
  return ys;
}
double min_of(const std::vector<double>& v) { return v.empty() ? kInf : *std::min_element(v.begin(), v.end()); }
double max_of(const std::vector<double>& v) { return v.empty() ? -kInf : *std::max_element(v.begin(), v.end()); }
}  // namespace

TEST_CASE("platformer: coyote time: jumping within coyote time after leaving a ledge still jumps") {
  CHECK(min_of(off_ledge(3)) < 169 - 30);
}

TEST_CASE("platformer: coyote time: jumping after coyote time does nothing") {
  CHECK(min_of(off_ledge(12)) >= 169 - 0.01);
}

TEST_CASE("platformer: jump buffer: a jump pressed shortly before landing is buffered") {
  // dry run: when does a fall from y=40 land?
  const Grid nop = no_p(kFlat);
  Game dry = load_level({nop, "", "", 64, 40});
  int land = -1;
  for (int i = 0; i < 120 && land < 0; ++i) {
    dry.step();
    if (std::fabs(py(dry) - 169) < 0.01) land = i;
  }
  CHECK(land > 10);
  auto run = [&](int early) {
    Game g = load_level({nop, "", "", 64, 40});
    double min_after = kInf;
    for (int i = 0; i < land + 30; ++i) {
      g.button("jump", i >= land - early && i < land - early + 20);
      g.step();
      if (i > land + 2) min_after = std::min(min_after, py(g));
    }
    return min_after;
  };
  CHECK(run(5) < 169 - 20);   // 5 ticks = 83 ms < 120 ms buffer
  CHECK(run(12) > 169 - 1);   // 200 ms early: dropped
}

// ---------------------------------------------------------------- abilities

TEST_CASE("platformer: abilities: double jump only after unlocking (powerup tile), saved to progress") {
  Grid grid = kFlat;
  grid[10] = "..P.d...................................";
  Game g = load_level({grid, "", ""});
  auto jump_twice = [&] {
    double min_y = kInf;
    g.step(60, [&](int i) {
      g.button("jump", i < 19 || (i >= 22 && i < 40));
      min_y = std::min(min_y, py(g));
    });
    g.step(40, [&](int) { g.button("jump", false); });
    return 169 - min_y;
  };
  g.step(5);
  const double single = jump_twice();
  g.step(40, [&](int) { hold(g, 1); });  // walk over the powerup
  hold(g, 0);
  g.step(20);
  CHECK(has(events(g), "powerup double_jump"));
  const double dbl = jump_twice();
  CHECK(single > 50);
  CHECK(single < 60);
  CHECK(dbl > single + 30);
  CHECK(prog(g)["abilities"]["double_jump"].b());
  CHECK_NO_ERRORS(g);
}

TEST_CASE("platformer: abilities: wall slide caps fall speed; wall jump kicks away from the wall") {
  Game g = load_level({kWalls, "", "controller = { abilities = { wall_slide = true, wall_jump = true } }"});
  g.step(5);
  // walk to the wall at x=240 (col 15), jump up along it, wait until falling
  g.step(100, [&](int) { hold(g, 1); });
  CHECK_CLOSE(px(g), 240 - 6, 1);
  g.step(30, [&](int i) { hold(g, 1, i < 20); });
  g.step(5, [&](int) { hold(g, 1, false); });
  const double y0 = py(g);
  g.step(10, [&](int) { hold(g, 1, false); });
  const double v = (py(g) - y0) / (10.0 / 60);
  CHECK_CLOSE(px(g), 240 - 6, 0);
  CHECK(v <= 61);
  CHECK(v > 0);
  // wall jump: press jump while holding into the wall
  const double x0 = px(g), yj = py(g);
  g.step(12, [&](int i) { hold(g, 1, i < 8); });
  CHECK(px(g) < x0 - 10);
  CHECK(py(g) < yj - 10);
  CHECK_NO_ERRORS(g);
}

TEST_CASE("platformer: abilities: wall jumps climb a 3-tile chimney") {
  const Grid grid = {
      "#.....#.................................", "#.....#.................................",
      "#.....#.................................", "#.....#.................................",
      "#.....#.................................", "#.....#.................................",
      "##.....#................................", "##...#..................................",
      "##...#..................................", "##...#..................................",
      "##...#..................................", "########################################",
  };
  // chimney cols 2..4 between walls (TS: every row becomes "##...#" + the rest from col 6)
  Grid chim;
  for (const std::string& r : grid) chim.push_back("##...#" + r.substr(6));
  Game g = load_level({chim, "", "controller = { abilities = { wall_slide = true, wall_jump = true } }", 56, 160});
  g.step(10);
  double min_y = kInf;
  int dir = 1;
  for (int i = 0; i < 360; ++i) {
    // bot: push toward a wall; when touching it in the air, jump away and switch direction
    const double x = px(g);
    if (dir > 0 && x >= 80 - 6 - 0.5) {
      g.button("jump", true);
      dir = -1;
    } else if (dir < 0 && x <= 32 + 6 + 0.5) {
      g.button("jump", true);
      dir = 1;
    } else if (i % 30 == 0) {
      g.button("jump", true);
    } else {
      g.button("jump", false);
    }
    g.axis("move_x", dir);
    g.step();
    min_y = std::min(min_y, py(g));
  }
  CHECK(min_y < 60);  // climbed most of the 11-row chimney
  CHECK_NO_ERRORS(g);
}

TEST_CASE("platformer: abilities: dash covers dash_speed x dash_time horizontally and refills on the ground") {
  Game g = load_level({kFlat, "", "controller = { abilities = { dash = true }, dash_speed = 300, dash_time = 0.2 }"});
  g.step(5);
  const double x0 = px(g);
  g.button("action", true);
  g.step();
  g.button("action", false);
  g.step(11);
  const double d = px(g) - x0;
  CHECK(d > 300 * 0.2 * 0.85);
  CHECK(d < 300 * 0.2 * 1.15);
  CHECK_CLOSE(py(g), 169, 1);  // no gravity drop during the dash
  CHECK_NO_ERRORS(g);
}

TEST_CASE("platformer: abilities: ladders: climb up with move_y, jump-through ladder top") {
  const Grid grid = {
      "........................................", "........................................",
      "........................................", "........................................",
      "....=====H==............................", ".........H..............................",
      ".........H..............................", ".........H..............................",
      ".........H..............................", ".........H..............................",
      "..P......H..............................", "########################################",
  };
  Game g = load_level({grid, "", ""});
  g.step(5);
  // walk to the ladder (col 9 center = 152)
  for (int i = 0; i < 200 && std::fabs(px(g) - 152) > 2; ++i) {
    hold(g, px(g) < 152 ? 0.5 : -0.5);
    g.step();
  }
  hold(g, 0);
  g.step(90, [&](int) { g.axis("move_y", -1); });
  g.axis("move_y", 0);
  g.step(30);
  // standing on the platform row 4 (top y = 64) -> center 57
  CHECK_CLOSE(py(g), 57, 0);
  CHECK_NO_ERRORS(g);
}

// ---------------------------------------------------------------- level features

TEST_CASE("platformer: level features: one-way platforms: land from above, jump through from below, drop with down+jump") {
  Grid grid = no_p(kFlat);
  grid[8] = "....======..............................";
  Game g = load_level({grid, "", "", 88, 160});
  g.step(10);
  CHECK_CLOSE(py(g), 169, 1);
  g.step(40, [&](int i) { hold(g, 0, i < 20); });  // jump through the platform (top y = 128)
  g.step(40, [&](int) { hold(g, 0, false); });
  CHECK_CLOSE(py(g), 128 - 7, 1);
  // drop through
  g.axis("move_y", 1);
  g.button("jump", true);
  g.step();
  g.button("jump", false);
  g.step(40);
  g.axis("move_y", 0);
  CHECK_CLOSE(py(g), 169, 1);
  CHECK_NO_ERRORS(g);
}

TEST_CASE("platformer: level features: springs bounce, breakable blocks break when bonked from below") {
  Grid grid = no_p(kFlat);
  grid[11] = "####S###################################";
  grid[7] = "..........B.............................";
  Game g = load_level({grid, "", "", 72, 100});
  double min_y = kInf;
  g.step(80, [&](int) { min_y = std::min(min_y, py(g)); });
  CHECK(has(events(g), "spring nil"));
  CHECK(min_y < 169 - 100);  // spring_height 120 from where it lands
  // walk under the brick (col 10 -> x 168) and jump
  Game g2 = load_level({grid, "", "", 168, 160});
  g2.step(10);
  g2.step(30, [&](int i) { hold(g2, 0, i < 20); });
  CHECK(any_starts(events(g2), "break"));
  CHECK_NO_ERRORS(g);
  CHECK_NO_ERRORS(g2);
}

TEST_CASE("platformer: level features: hazards kill, the player respawns at the last checkpoint with full health") {
  Grid grid = kFlat;
  grid[10] = "..P...C.........^.......................";
  Game g = load_level({grid, "", "respawn_delay = 0.5"});
  for (int i = 0; i < 200 && !has(events(g), "death hurt"); ++i) {
    hold(g, 1);
    g.step();
  }
  hold(g, 0);
  g.step(60);
  const std::vector<std::string> ev = events(g);
  CHECK(has(ev, "checkpoint "));
  CHECK(has(ev, "death hurt"));
  CHECK(has(ev, "respawn nil"));
  g.step(5);
  // respawned at the checkpoint (col 6 -> x 104), not the start
  CHECK(px(g) < 200);
  CHECK(px(g) > 90);
  CHECK_NO_ERRORS(g);
}

TEST_CASE("platformer: level features: falling out of the level kills; coins + gems count; goal completes and saves stats") {
  Grid grid = kFlat;
  grid[10] = "..P.oo*oo..........G....................";
  Game g = load_level(
      {grid, "", "complete_delay = 0.2, on_complete = function(st) print('DONE ' .. st.coins .. ' ' .. st.gemsFound) end"});
  g.step(200, [&](int) { hold(g, 1); });
  const std::vector<std::string> ev = events(g);
  CHECK(std::count_if(ev.begin(), ev.end(), [](const std::string& e) { return e.rfind("coin", 0) == 0; }) == 4);
  CHECK(has(ev, "gem 1"));
  CHECK(any_starts(ev, "complete"));
  CHECK(has(g.logs(), "DONE 4 1"));
  J p = prog(g);
  CHECK(p["completed"]["test"].b());
  CHECK(p["coins"]["test"].num() == 4);
  CHECK(p["gems"]["test"]["1"].b());
  CHECK(p["best"]["test"].num() > 0.5);
  // platform leaderboard: level start -> complete timed by the engine (TS MemoryLeaderboardHost.submitted;
  // here the host's local scores). The TS test also checks the submission's ghost has > 3 frames:
  // not portable, the C++ engine doesn't record ghosts.
  const auto& scores = g->local_scores();
  REQUIRE(scores.size() == 1);
  CHECK(scores[0].board == "level_test");
  CHECK(scores[0].ascending);  // order "asc"
  CHECK_CLOSE(scores[0].value, p["best"]["test"].num(), 1);
  CHECK_NO_ERRORS(g);
}

TEST_CASE("platformer: level features: moving platforms carry the player") {
  Grid grid = no_p(kFlat);
  grid[8] = "....MM..................................";
  Game g = load_level({grid, "", "", 80, 100});
  g.step(30);
  const double y = py(g);
  CHECK(y < 130);  // standing on the platform (row 8 -> top 128)
  const double x0 = px(g);
  g.step(40);
  CHECK(std::fabs(px(g) - x0) > 10);
  CHECK_CLOSE(py(g), y, 0);
  CHECK_NO_ERRORS(g);
}

// ---------------------------------------------------------------- enemies

TEST_CASE("platformer: enemies: patroller walks and turns at walls and ledges") {
  Grid grid = enemy_grid("...........s.........#..................");
  grid[11] = "#################.......################";
  Game g = load_level({grid, kProbeEnemies, "", 600, 160});
  g.step(600);
  const std::vector<Json> ps = probes(g);
  std::vector<double> xs;
  std::set<int64_t> dirs;
  for (const Json& p : ps) {
    xs.push_back(J(&p)["enemies"][0]["x"].num());
    dirs.insert(J(&p)["enemies"][0]["dir"].i());
  }
  // ledge at x=272 (col 17): never walks past it
  CHECK(max_of(xs) < 272);
  CHECK(min_of(xs) < 170);
  CHECK(dirs.size() == 2);
  CHECK_NO_ERRORS(g);
}

TEST_CASE("platformer: enemies: hopper hops, flyer bobs without falling, chaser chases the player") {
  Game g = load_level({enemy_grid("....h.......f.........c................."), kProbeEnemies, "", 500, 160});
  g.step(240);
  const std::vector<Json> ps = probes(g);
  REQUIRE(!ps.empty());
  std::vector<double> hop_y, bat_y;
  for (const Json& p : ps) {
    hop_y.push_back(enemy(p, "hopper")["y"].num());
    bat_y.push_back(enemy(p, "bat")["y"].num());
  }
  CHECK(min_of(hop_y) < 170 - 20);
  CHECK(max_of(bat_y) - min_of(bat_y) > 16);
  CHECK(max_of(bat_y) < 176);
  // ran toward the player at x=500
  CHECK(enemy(ps.back(), "dog")["x"].num() > enemy(ps.front(), "dog")["x"].num() + 50);
  CHECK_NO_ERRORS(g);
}

TEST_CASE("platformer: enemies: shooter + turret fire projectiles that hurt the player") {
  Game g = load_level({enemy_grid("..P......t.............................."), kProbeEnemies, "health = 5"});
  g.step(240);
  double max_proj = 0;
  for (const Json& p : probes(g)) max_proj = std::max(max_proj, J(&p)["proj"].num());
  CHECK(max_proj > 0);
  CHECK(any_starts(events(g), "hurt"));
  Game g2 = load_level({enemy_grid("..P...........T........................."), kProbeEnemies, "health = 5"});
  g2.step(240);
  CHECK(any_starts(events(g2), "hurt"));
  CHECK_NO_ERRORS(g);
  CHECK_NO_ERRORS(g2);
}

TEST_CASE("platformer: enemies: stomping kills; walking into an enemy hurts with knockback + i-frames") {
  Game g = load_level({enemy_grid("..........s............................."), kProbeEnemies, "", 160, 60});
  g.step(60);
  CHECK(has(events(g), "stomp slime"));
  CHECK(has(events(g), "enemyKilled slime"));
  Game g2 = load_level({enemy_grid("..P.......s............................."), kProbeEnemies, ""});
  g2.step(120, [&](int) { hold(g2, 1); });
  const std::vector<std::string> ev = events(g2);
  CHECK(std::count_if(ev.begin(), ev.end(), [](const std::string& e) { return e.rfind("hurt", 0) == 0; }) ==
        1);  // i-frames: one hit, not one per tick
  const std::vector<Json> ps = probes(g2);
  REQUIRE(!ps.empty());
  CHECK(J(&ps.back())["health"].num() == 2);
  CHECK_NO_ERRORS(g);
  CHECK_NO_ERRORS(g2);
}

TEST_CASE("platformer: enemies: player shots kill shootable enemies") {
  Game g = load_level({enemy_grid("..P.......s............................."), kProbeEnemies, "controller = { abilities = { shoot = true } }"});
  g.step(5);
  g.step(30, [&](int i) { g.button("action2", i % 10 < 2); });
  CHECK(has(events(g), "enemyKilled slime"));
  CHECK_NO_ERRORS(g);
}

// ---------------------------------------------------------------- bosses

TEST_CASE("platformer: bosses: boss wakes, changes phase at the hp threshold, and is defeated by stomps") {
  Grid grid = no_p(kFlat);
  grid[10] = "....................K...................";
  Game g = load_level({grid, kProbeEnemies + R"(
      -- test hook: hit the boss from above whenever it's vulnerable
      onTick(function()
        local b = level.bosses[1]
        if b and b.alive and b.awake and b.iframes <= 0 and time() > 0.5 then level:hitBoss(b, 1) end
      end))",
                       "boss_completes = false", 200, 100});
  g.step(300);
  const std::vector<std::string> ev = events(g);
  CHECK(any_starts(ev, "bossPhase"));
  CHECK(any_starts(ev, "bossDefeated"));
  std::set<int64_t> phases;
  for (const Json& p : probes(g))
    for (J b : J(&p)["bosses"].values()) phases.insert(b["phase"].i());
  CHECK(phases == std::set<int64_t>{1, 2});
  CHECK_NO_ERRORS(g);
}

// ---------------------------------------------------------------- world map, unlocks, save

TEST_CASE("platformer: world map: unlock rules follow progress; progress survives a reload (save round trip)") {
  Game g = start(map_pkg(R"(
      local W, P = kit.world, kit.progress
      local function st() local o = {} for _, l in W.levels() do table.insert(o, l.id .. "=" .. tostring(W.isUnlocked(l.id))) end return table.concat(o, " ") end
      print("A " .. st())
      P.completeLevel("1-1", { time = 42.5, coins = 10, gems = { [1] = true } })
      print("B " .. st())
      P.completeLevel("1-2", { time = 30, coins = 3 })
      print("C " .. st())
      P.completeLevel("1-2", { time = 35, coins = 5 })
      print("BEST " .. P.best("1-2") .. " " .. P.get().coins["1-2"])
  )"),
                 opts());
  const std::vector<std::string> l = g.logs();
  CHECK(has(l, "A 1-1=true 1-2=false 1-s=false 2-1=false"));
  CHECK(has(l, "B 1-1=true 1-2=true 1-s=true 2-1=false"));
  CHECK(has(l, "C 1-1=true 1-2=true 1-s=true 2-1=true"));  // "world" rule ignores secret levels
  CHECK(has(l, "BEST 30 5"));
  CHECK_NO_ERRORS(g);
  // reload with the same save data
  script::HostOptions o = opts();
  o.save = g.save();
  Game g2 = start(
      map_pkg(R"(print("R " .. tostring(kit.progress.isComplete("1-2")) .. " " .. kit.progress.best("1-1") .. " " .. kit.progress.totalGems()))"),
      o);
  CHECK(has(g2.logs(), "R true 42.5 1"));
  CHECK_NO_ERRORS(g2);
}

// ---------------------------------------------------------------- example game

TEST_CASE("platformer example: the kit reads content from data/ (no Luau mirror); JSON matches the kit schemas' required fields") {
  FileMap pkg = read_dir(kExample);
  CHECK(pkg.count("scripts/shared/content.luau") == 0);
  std::vector<Json> enemies, bosses;
  for (const std::string& p : paths_with(pkg, "data/enemies/")) enemies.push_back(parse_json(pkg[p]));
  for (const std::string& p : paths_with(pkg, "data/bosses/")) bosses.push_back(parse_json(pkg[p]));
  Json world = parse_json(pkg["data/world.json"]);
  auto required = [](const char* n) {
    Json s = read_json(std::string("kits/platformer/schemas/") + n + ".json");
    return J(&s)["required"].strs();
  };
  for (const Json& e : enemies)
    for (const std::string& k : required("enemy")) CHECK_MESSAGE(J(&e).has(k), J(&e)["id"].str() << "." << k);
  for (const Json& b : bosses)
    for (const std::string& k : required("boss")) CHECK_MESSAGE(J(&b).has(k), J(&b)["id"].str() << "." << k);
  for (const std::string& k : required("world")) CHECK_MESSAGE(J(&world).has(k), k);
  std::vector<std::string> level_ids;
  for (J w : J(&world)["worlds"].values())
    for (J l : w["levels"].values()) {
      CHECK_MESSAGE(pkg.count(l["scene"].str()) == 1, l["scene"].str());
      level_ids.push_back(l["id"].str());
    }
  std::string enemy_ids, boss_ids;
  for (const Json& e : enemies) enemy_ids += (enemy_ids.empty() ? "" : ", ") + J(&e)["id"].dump();
  for (const Json& b : bosses) boss_ids += (boss_ids.empty() ? "" : ", ") + J(&b)["id"].dump();
  pkg["scripts/client/zz_probe.luau"] = "\nlocal kit = require(\"@kit/platformer\")\nfor _, id in { " + enemy_ids +
                                        R"( } do print("ENEMY " .. id .. " " .. kit.content.get("enemies", id).behaviour) end
for _, id in { )" + boss_ids + R"( } do print("BOSS " .. id .. " " .. kit.content.get("bosses", id).hp) end
local ids = {} for _, l in kit.world.levels() do table.insert(ids, l.id) end
print("LEVELS " .. table.concat(ids, ",")))";
  Game g = start(pkg, opts());
  const std::vector<std::string> log = g.logs();
  for (const Json& e : enemies) CHECK(has(log, "ENEMY " + J(&e)["id"].str() + " " + J(&e)["behaviour"].str()));
  // TS `${b.hp}` and Luau `..` both print an integral hp without a decimal point
  for (const Json& b : bosses) CHECK(has(log, "BOSS " + J(&b)["id"].str() + " " + std::to_string(J(&b)["hp"].i())));
  CHECK(has(log, "LEVELS " + join(level_ids, ",")));
  CHECK_NO_ERRORS(g);
}

TEST_CASE("platformer example: scripted end-to-end run: world map -> every level (played, then finished) -> boss -> all cleared, zero script errors" *
          doctest::test_suite("slow")) {
  const std::string autoplay = R"(
local kit = require("@kit/platformer")
game.sceneLoaded:connect(function(path)
  print("SCENE " .. path)
  if path == "scenes/world.scene.json" then
    after(0.6, function()
      if currentScene() ~= path then return end -- real input already entered a level
      local wm = kit.worldmap.current
      print("MAP sel=" .. wm.sel.level.id .. " cleared=" .. kit.progress.completedCount())
      if kit.progress.completedCount() < #kit.world.levels() then wm:enter() else print("ALL CLEAR") end
    end)
  else
    after(5, function()
      if currentScene() ~= path then return end
      local lv = kit.level.current
      print("PLAYED " .. lv.id .. " x=" .. math.floor(lv.body.x) .. " coins=" .. lv.coins .. " deaths=" .. lv.deaths .. " enemies=" .. #lv.enemies)
      if #lv.bosses > 0 then
        local b = lv.bosses[1]
        lv.body.x, lv.body.y = b.x - 60, b.y
        every(0.2, function() if b.alive and b.awake then lv:hitBoss(b, 1) end end)
      else
        every(0.5, function() if currentScene() == path and not lv.done then lv:complete() end end)
      end
    end)
  end
end))";
  script::HostOptions o = opts();
  o.seed = 3;
  Game g = start_dir(kExample, {{"scripts/client/zz_autoplay.luau", autoplay}}, o);
  // play: run right, jump in rhythm, shoot/dash when unlocked
  auto cleared = [&] { return prog(g)["completed"].size(); };
  for (int i = 0; i < 60 * 70 && cleared() < 5; ++i) {
    g.axis("move_x", 1);
    g.button("jump", i % 50 < 18);
    g.button("action", i % 90 == 40);
    g.step();
  }
  const std::vector<std::string> played = g.logs_with("PLAYED");
  MESSAGE(join(played));
  CHECK(played.size() == 5);
  g.step(200);  // back on the map: everything cleared
  CHECK(has(g.logs(), "ALL CLEAR"));
  std::vector<std::string> done = prog(g)["completed"].keys();
  std::sort(done.begin(), done.end());  // TS Object.keys(...).sort()
  CHECK(done == std::vector<std::string>{"1-1", "1-2", "2-1", "2-2", "2-B"});
  // walked a good way into each level on real input
  for (const std::string& l : played) {
    CAPTURE(l);
    const size_t at = l.find("x=");
    REQUIRE(at != std::string::npos);
    CHECK(std::stod(l.substr(at + 2)) > 150);
  }
  CHECK_NO_ERRORS(g);
}

}  // TEST_SUITE
