// racing kit: headless tests through real Luau + the example package (Sprout Speedway) end to end.
// Port of engine-web/test/kits/racing.test.ts (same numbers and thresholds).
//
// The racing kit simulates its cars in Luau (kits/racing/car.luau: its own integrator, grip and wall
// collision against the track grid); no engine physics bodies are involved, so the numbers match
// engine-web exactly and no Box2D-vs-Rapier tolerances are needed.
//
// Not portable: engine-web's MemoryLeaderboardHost also recorded a ghost replay with each submission
// (`r.ghost.frames.length > 10`); the C++ engine's leaderboard keeps board/value/order only
// (Host::local_scores()), so that part of the cup test is not asserted.
#include <algorithm>

#include "kits/kit_test.h"

using namespace dreamsy;
using namespace dreamsy::test;

namespace {

const char* kExample = "games/examples/kit-racing";

FileMap kit_game(const std::string& script, const FileMap& extra = {}) {
  FileMap files = {
      {"dreamsy.toml", manifest("\"racing\"")},
      {"scenes/main.scene.json", empty_scene("world")},
      {"scripts/client/main.luau", script},
  };
  for (const auto& [p, d] : extra) files[p] = d;
  return files;
}

struct Run {
  Game g;
  std::vector<std::string> errs, logs;
};

// TS run(): pure-logic batches (thousands of sims in one callback): TS raised the budget to 5000 ms.
Run run(const std::string& script, int steps = 2) {
  script::HostOptions opts;
  opts.budget_ms = budget(5000);
  Run r{start(kit_game(script), opts), {}, {}};
  r.g.step(steps);
  r.errs = r.g.errors();
  for (const std::string& l : r.g.logs())
    if (l.rfind("[validate]", 0) != 0) r.logs.push_back(l);
  return r;
}

const std::string kPre = R"lua(
local fails = 0
local function check(name, c, extra) if c then print("ok " .. name) else fails += 1 print("FAIL " .. name .. " " .. tostring(extra)) end end
local function eq(name, a, b) check(name, a == b, tostring(a) .. " ~= " .. tostring(b)) end
local function near(name, a, b, tol) check(name, math.abs(a - b) <= tol, tostring(a) .. " !~ " .. tostring(b)) end
local Racing = require("@kit/racing")
-- a tall portrait loop (cells): 10 x 22 grid, road half-width 1.5 tiles
local OVAL = { name = "oval", tileSize = 64, width = 1.5, laps = 2, checkpoints = 4,
  line = { {3,3}, {7,3}, {8,4}, {8,18}, {7,19}, {3,19}, {2,18}, {2,4} } }
)lua";

std::vector<std::string> logged(const std::vector<std::string>& logs, const std::string& prefix) {
  std::vector<std::string> out;
  for (const std::string& l : logs)
    if (l.rfind(prefix, 0) == 0) out.push_back(l.substr(prefix.size()));
  return out;
}

// TS noFails(): no script errors, no "FAIL" line, at least one "ok" line.
void no_fails(const Run& r) {
  CHECK_MESSAGE(r.errs.empty(), join(r.errs));
  std::vector<std::string> fails = logged(r.logs, "FAIL");
  CHECK_MESSAGE(fails.empty(), join(fails));
  CHECK(logged(r.logs, "ok ").size() > 0);
}

}  // namespace

TEST_SUITE("kit racing") {

TEST_CASE("racing: sim: track: rasterize, closest/pointAt, surfaces, walls, gates") {
  no_fails(run(kPre + R"lua(
      local tr = Racing.track.new(OVAL)
      check("rows", tr.rowCount >= 22, tr.rowCount) check("cols", tr.cols >= 10, tr.cols)
      eq("gates", #tr.gates, 4)
      local x, y = tr:pointAt(100)
      local seg, s, lat = tr:closest(x, y)
      near("closest s", s, 100, 0.5) near("lat 0", lat, 0, 0.5)
      eq("road at line", tr:tileAt(x, y) == "=" or tr:tileAt(x, y) == "F", true)
      check("wall at edge", tr:solidAt(5, 5))
      check("offroad off the line", tr:surface(x, y + 2.5 * 64).offroad or tr:surface(x, y - 2.5 * 64).offroad)
      local nx, ny, d = tr:collide(10, 200, 18)
      check("collide pushes right", nx and nx > 0.9, nx)
  )lua"));
}

TEST_CASE("racing: sim: car physics numbers: accel, top speed, braking, offroad, nitro, grip") {
  Run r = run(kPre + R"lua(
      local st = Racing.car.stats({ maxSpeed = 500, accel = 400, brake = 1000 })
      local c = Racing.car.new(st, 0, 0, 0)
      local dt, t = 1/60, 0
      while c:speed() < 0.9 * 500 and t < 10 do c:step(dt, { throttle = 1 }) t += dt end
      print("t90 " .. string.format("%.2f", t))
      check("0-90% in 1.5..3s", t > 1.5 and t < 3, t)
      for i = 1, 600 do c:step(dt, { throttle = 1 }) end
      near("top speed", c:speed(), 500, 2)
      check("moved up (heading 0 = -y)", c.y < -1000, c.y)
      local y0 = c.y
      while c:speed() > 1 do c:step(dt, { brake = 1 }) end
      local dist = y0 - c.y
      print("brake " .. string.format("%.1f", dist))
      near("braking distance v^2/2b", dist, 500 * 500 / 2000, 15)
      -- offroad: fake track surface
      local fake = { surface = function() return { offroad = true } end, collide = function() return nil end }
      local c2 = Racing.car.new(st, 0, 0, 0)
      for i = 1, 600 do c2:step(dt, { throttle = 1 }, fake) end
      near("offroad top = 50%", c2:speed(), 250, 3)
      local c3 = Racing.car.new(st, 0, 0, 0, { nitro = 1 })
      for i = 1, 600 do c3:step(dt, { throttle = 1 }) end
      local before = c3:speed()
      for i = 1, 60 do c3:step(dt, { throttle = 1, nitro = true }) end
      check("nitro faster", c3:speed() > before * 1.15, c3:speed())
      check("nitro drains", c3.nitro < 0.6, c3.nitro)
      -- grip: lateral velocity decays, drift keeps more of it
      local function slide(steer)
        local k = Racing.car.new(st, 0, 0, 0)
        for i = 1, 300 do k:step(dt, { throttle = 1 }) end
        local seen = false
        for i = 1, 30 do k:step(dt, { throttle = 1, steer = steer }) seen = seen or k.drifting end
        local rx, ry = Racing.util.right(k.a)
        return math.abs(k.vx * rx + k.vy * ry), seen
      end
      local gripLat = slide(0.5)
      local driftLat, drifting = slide(1)
      check("drift slides more", driftLat > gripLat * 2, driftLat .. " vs " .. gripLat)
      check("drifting flag", drifting)
      -- wall bounce
      local tr = Racing.track.new(OVAL)
      local w = Racing.car.new(st, 120, 600, -math.pi / 2)
      w.vx = -400
      local hits, maxVx = 0, -1e9
      for i = 1, 60 do local ev = w:step(dt, {}, tr) maxVx = math.max(maxVx, w.vx) if ev then for _, e in ev do if e.name == "wall" then hits += 1 end end end end
      check("wall hit event", hits >= 1) check("bounced", maxVx > 100, maxVx) check("stays out of wall", not tr:solidAt(w.x, w.y))
  )lua");
  no_fails(r);
  MESSAGE("[racing] physics: t90 " << join(logged(r.logs, "t90 ")) << ", brake " << join(logged(r.logs, "brake ")));
}

TEST_CASE("racing: sim: laps + checkpoints: ordered gates count, shortcuts don't, splits + best") {
  no_fails(run(kPre + R"lua(
      local tr = Racing.track.new(OVAL)
      local race = Racing.race.new(tr, { laps = 2, countdown = 0 })
      local x, y, a = tr:gridSlot(1)
      local c = Racing.car.new(Racing.car.stats({}), x, y, a)
      local r = race:add("p", c, { player = true })
      -- teleport along the line in small steps = a clean lap
      local function drive(from, to, step)
        local s = from
        while s <= to do
          local px, py, tx, ty = tr:pointAt(s)
          c.x, c.y, c.vx, c.vy = px, py, tx * step * 60, ty * step * 60
          c.a = Racing.util.heading(tx, ty)
          race:step(1/60, { p = {} })
          s += step
        end
      end
      local s0 = tr.startS0
      drive(s0 - 60, s0 + tr.length + 20, 20)
      eq("one lap", r.lap, 1)
      eq("splits recorded", #r.bestSplits, 3)
      check("best set", r.best ~= nil)
      -- shortcut: jump from just after the line straight to before the line (skip checkpoints)
      local px, py = tr:pointAt(s0 + 40) c.x, c.y, c.vx, c.vy = px, py, 0, 0 race:step(1/60, { p = {} })
      px, py = tr:pointAt(s0 - 30) c.x, c.y = px, py race:step(1/60, { p = {} })
      drive(s0 - 20, s0 + 30, 10)
      eq("shortcut lap not counted", r.lap, 1)
      check("missed event", (r.missed or 0) >= 1, r.missed)
      check("rank progress clamped", race:rankProg(r) < 2 * tr.length, race:rankProg(r))
      -- finish the race properly
      drive(s0 + 30, s0 + 2 * tr.length + 10, 20)
      eq("two laps", r.lap, 2) check("finished", r.finished) eq("place", r.place, 1) check("done", race.done)
  )lua"));
}

TEST_CASE("racing: sim: AI completes laps (oval), rubber band stays within bounds, positions") {
  Run r = run(kPre + R"lua(
      local D = Racing.driver
      local lo, hi = 9, 0
      for gap = -3000, 3000, 50 do local m = D.rubber(gap) lo = math.min(lo, m) hi = math.max(hi, m) end
      near("rubber min", lo, 0.92, 1e-9) near("rubber max", hi, 1.08, 1e-9)
      check("ahead slows", D.rubber(500) < 1) check("behind speeds", D.rubber(-500) > 1) eq("even", D.rubber(0), 1)
      local tr = Racing.track.new(OVAL)
      local race = Racing.race.new(tr, { laps = 2, countdown = 0 })
      for i, p in { "easy", "normal", "hard", "expert" } do
        local x, y, a = tr:gridSlot(i)
        race:add(p, Racing.car.new(Racing.car.stats({}), x, y, a), { driver = D.new({ preset = p, seed = i }) })
      end
      local t = 0
      while not race.done and t < 200 do race:step(1/30) t += 1/30 end
      check("race done", race.done, t)
      for _, res in race:results() do print("ai " .. res.id .. " " .. res.place .. " " .. Racing.time(res.time) .. " best " .. Racing.time(res.best)) end
      local b = Racing.balance.report(tr, Racing.car.stats({}), { laps = 2 })
      for _, k in { "reference", "easy", "normal", "hard", "expert" } do
        check("bal finished " .. k, b[k].finished)
        print("bal " .. k .. " " .. string.format("%.2f", b[k].best or -1) .. " ratio " .. tostring(b[k].ratio and string.format("%.3f", b[k].ratio)) .. " walls " .. b[k].walls)
      end
      check("easy slower than hard", b.easy.best > b.hard.best)
      -- elimination: last place is knocked out each time the leader completes a lap
      local el = Racing.race.new(tr, { laps = 4, countdown = 0, mode = "elimination" })
      for i, p in { "easy", "normal", "hard", "expert" } do
        local x, y, a = tr:gridSlot(i)
        el:add(p, Racing.car.new(Racing.car.stats({}), x, y, a), { driver = D.new({ preset = p, seed = i }) })
      end
      local outs = 0
      t = 0
      while not el.done and t < 300 do for _, e in el:step(1/30) do if e.name == "eliminated" then outs += 1 end end t += 1/30 end
      eq("3 eliminated", outs, 3) check("elim done", el.done)
      local winner = el:results()[1]
      check("winner not out", not winner.out, winner.id) print("elim winner " .. winner.id)
  )lua");
  std::vector<std::string> lines = logged(r.logs, "ai ");
  for (const std::string& l : logged(r.logs, "bal ")) lines.push_back(l);
  MESSAGE(join(lines));
  no_fails(r);
}

TEST_CASE("racing: sim: cup points + standings, ghost record/replay/save, garage upgrades") {
  no_fails(run(kPre + R"lua(
      local cup = Racing.cup.new({ id = "c", tracks = { "a", "b", "c" } }, { "p", "x", "y", "z" })
      eq("first track", cup:track(), "a")
      cup:record({ "x", "p", "y", "z" }) cup:record({ "p", "x", "z", "y" }) cup:record({ "p", "y", "x", "z" })
      check("done", cup:isDone())
      local st = cup:standings()
      eq("leader", st[1].id, "p") eq("leader pts", st[1].points, 7 + 10 + 10) eq("2nd", st[2].id, "x") eq("2nd pts", 10 + 7 + 5, st[2].points)
      -- ghost
      local rec = Racing.ghost.recorder(0.1)
      local fake = { x = 0, y = 0, a = 0 }
      for i = 0, 100 do fake.x = i * 5 fake.y = -i * 2 fake.a = i * 0.01 rec:add(i / 60, fake) end
      local g = rec:finish(100 / 60)
      local gx, gy = Racing.ghost.at(g, 0.55)
      near("ghost x interp", gx, 0.55 * 60 * 5, 1.5) near("ghost y interp", gy, -0.55 * 60 * 2, 1.5)
      check("ghost past end nil", Racing.ghost.at(g, 99) == nil)
      check("submit first", Racing.ghost.submit("oval", g))
      local slower = rec:finish(5)
      check("slower rejected", not Racing.ghost.submit("oval", slower))
      eq("best kept", Racing.ghost.best("oval").t, g.t)
      check("ghost compact", #save.get("racing_ghost_oval").d <= 3 * 18, #g.d)
      -- garage
      local core = require("@kit/core")
      core.wallet.define("coins", { start = 1000 })
      local gar = Racing.garage.new({ cars = { bug = { name = "Bug", stats = { maxSpeed = 500 } }, gt = { name = "GT", price = 800, stats = { maxSpeed = 620 }, unlock = { flag = "cup_won" } } } })
      eq("starter owned", gar:owns("bug"), true)
      local ok, why = gar:canBuy("gt") eq("locked", why, "locked")
      core.flags.set("cup_won", true)
      check("buy gt", gar:buy("gt")) eq("paid", core.wallet.get("coins"), 200)
      eq("engine cost L0", gar:upgradeCost("gt", "engine"), 150)
      core.wallet.add("coins", 10000)
      check("upgrade", gar:upgrade("gt", "engine")) eq("engine cost L1", gar:upgradeCost("gt", "engine"), 240)
      near("stats +4%", gar:stats("gt").maxSpeed, 620 * 1.04, 1e-6)
      for i = 1, 4 do gar:upgrade("gt", "engine") end
      eq("max", gar:upgradeCost("gt", "engine"), nil)
      local _, w2 = gar:upgrade("gt", "engine") eq("max reason", w2, "max")
      near("stats +20%", gar:stats("gt").maxSpeed, 620 * 1.2, 1e-6)
      check("select", gar:select("gt")) eq("selected", gar.selected, "gt")
      check("rating 0..1", gar:rating("gt").speed > 0 and gar:rating("gt").speed <= 1)
  )lua"));
}

// ---------------------------------------------------------------- example (Sprout Speedway)

TEST_CASE("racing example: content files match the kit schemas (keys + required)") {
  FileMap pkg = read_dir(kExample);
  const std::pair<const char*, const char*> kinds[] = {{"tracks", "track"}, {"cars", "car"}, {"cups", "cup"}};
  for (const auto& [kind, sc] : kinds) {
    Json schema = read_json(std::string("kits/racing/schemas/") + sc + ".schema.json");
    std::vector<std::string> props = J(&schema)["properties"].keys();
    std::vector<std::string> files = paths_with(pkg, std::string("data/") + kind + "/");
    CHECK(!files.empty());
    for (const std::string& f : files) {
      Json d = parse_json(pkg[f]);
      for (const std::string& k : J(&d).keys())
        CHECK_MESSAGE(std::find(props.begin(), props.end(), k) != props.end(), f << ": " << k);
      for (const std::string& r : J(&schema)["required"].strs()) CHECK_MESSAGE(J(&d).has(r), f << " requires " << r);
    }
  }
}

TEST_CASE("racing example: every example track: AI presets finish, balance vs reference bot" * doctest::test_suite("slow")) {
  script::HostOptions opts;
  opts.budget_ms = budget(20000);  // TS budgetMs: 20000 (three balance reports in one call)
  Game g = start_dir(kExample,
                     {{"scripts/client/__t.luau", R"lua(
      local Racing = require("@kit/racing")
      local C = Racing.content.load()
      local cars = C.cars
      for _, id in { "pea_patch", "teapot_turns", "greenhouse" } do
        local tr = Racing.track.new(C.tracks[id])
        local st = Racing.car.stats(cars.beetle_buggy)
        local b = Racing.balance.report(tr, st, { laps = 2 })
        local line = id
        for _, k in { "reference", "easy", "normal", "hard", "expert" } do
          local r = b[k]
          line ..= string.format(" %s=%s%s/w%d/m%d", k, if r.best then string.format("%.2f", r.best) else "DNF", if r.ratio then string.format("(x%.3f)", r.ratio) else "", r.walls, r.missed)
          if not r.finished or r.missed > 0 then print("FAIL " .. id .. " " .. k) end
        end
        print("BAL " .. line)
      end
    )lua"},
                      {"scenes/menu.scene.json", empty_scene("w")}},
                     opts);
  g.step();
  std::vector<std::string> logs = g.logs();
  MESSAGE(join(logged(logs, "BAL")));
  CHECK_NO_ERRORS(g);
  CHECK_MESSAGE(logged(logs, "FAIL").empty(), join(logged(logs, "FAIL")));
  CHECK(logged(logs, "BAL").size() == 3);
}

TEST_CASE("racing example: menu + garage boot clean; a full autopilot cup (3 races) and a time trial run with zero script errors" *
          doctest::test_suite("slow")) {
  // the menu: a tap on the bottom button (start() fails the test if the package doesn't load = TS loadError)
  PlaytestReport menu = simulate(read_dir(kExample), {TimelineStep{.t = 1, .tap = std::pair<double, double>{360, 1140}}}, 3);
  CHECK_MESSAGE(menu.errors.empty(), join(menu.errors));

  const std::string driver = R"lua(
      local G = require("../shared/game")
      local core = require("@kit/core")
      local last = nil
      loadScene("scenes/race.scene.json", { mode = "cup", autopilot = true })
      every(0.5, function()
        if not G.cup then return end
        if last == nil then last = G.cup.race end
        if G.cup.race ~= last then
          last = G.cup.race
          print("RACE_DONE " .. math.floor(time()) .. " pts " .. (G.cup.table.you or 0) .. " coins " .. core.wallet.get("coins"))
          if G.cup.race <= 3 then after(1, function() loadScene("scenes/race.scene.json", { mode = "cup", autopilot = true }) end)
          else after(1, function() loadScene("scenes/race.scene.json", { mode = "time_trial", track = "pea_patch", autopilot = true }) end) end
        end
      end)
  )lua";
  script::HostOptions opts;
  opts.budget_ms = budget(2000);
  Game g = start_dir(kExample, {{"scripts/client/__drive.luau", driver}}, opts);
  auto done = [&] {
    int n = 0;
    for (const auto& l : g->logs()) n += l.text.rfind("RACE_DONE", 0) == 0;
    return n;
  };
  g.step_until([&] { return done() >= 3; }, 60 * 60 * 8);
  g.step(60 * 80);  // time trial (3 laps) after the cup
  MESSAGE(join(g.logs_with("RACE_DONE")));
  CHECK_NO_ERRORS(g);
  CHECK(done() == 3);
  std::string save = g.save().stringify();
  CHECK(contains(save, "racing_ghost_pea_patch"));  // the autopilot time trial recorded + saved its best-lap ghost
  CHECK(contains(save, "garage"));
  // platform leaderboard: every finished race (3 cup races + the time trial) submitted a time on its track board.
  // NOT PORTABLE: TS also checks each submission carried a ghost replay (> 10 frames); the C++
  // leaderboard records board / value / order only.
  const auto& scores = g->local_scores();
  REQUIRE(scores.size() == 4);
  for (const auto& s : scores) {
    CAPTURE(s.board);
    CHECK(matches(s.board, "^track_[a-z_]+$"));
    CHECK(s.ascending);  // order "asc"
    CHECK(s.value > 5);
  }
  CHECK(scores[3].board == "track_pea_patch");
}

}  // TEST_SUITE
