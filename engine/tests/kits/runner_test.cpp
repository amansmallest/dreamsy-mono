// runner kit: controls (swipes/taps/keys), segment validation + sequencing by difficulty tier,
// endless sim (jump/slide/lanes, power-ups), missions, daily challenge, characters, obby
// (checkpoints, timer, ghost, vanish, spinner, procgen stages), balance sim, and the example
// package end-to-end.
// Port of engine-web/test/kits/runner.test.ts (same numbers and thresholds).
#include <algorithm>

#include "kits/kit_test.h"

using namespace dreamsy;
using namespace dreamsy::test;

namespace {

const char* kExample = "games/examples/kit-runner";

struct RunnerOpts {
  int steps = 1;
  Json save = Json::object_value();         // initial save data (TS: a shared MemorySaveHost)
  std::function<double()> clock;            // clock.now()
  std::function<void(Game&, int)> drive;    // runs before tick i (set input there)
  double budget_ms = budget(250);
};

// TS runLuau(): a one-scene package whose only script is `src`. Returns the running game (its save
// data holds `out`; local_scores() holds the leaderboard submissions).
Game runner_game(const std::string& src, const RunnerOpts& o = {}) {
  FileMap files;
  files["dreamsy.toml"] = manifest("\"runner\"", "scenes/main.scene.json", "portrait", "clean");
  files["scenes/main.scene.json"] = empty_scene("root");
  files["scripts/client/main.luau"] = src;
  script::HostOptions opts;
  opts.seed = 1;
  opts.clock = o.clock;
  opts.save = o.save;
  opts.budget_ms = o.budget_ms;
  Game g = start(files, opts);
  g.step(o.steps, [&](int i) {
    if (o.drive) o.drive(g, i);
  });
  return g;
}

J out_of(const Game& g) { return J(&g.save())["out"]; }

const std::string kContent = R"(
local R = require("@kit/runner")
local core = require("@kit/core")
R.setup({ content = {
  segments = {
    s_open = { tier = 0, rows = { "C.C", ".C.", "C.C" } },
    s_low = { tier = 0, rows = { "J.J", "...", ".J." } },
    s_high = { tier = 1, rows = { "S.S", "CCC", "..." } },
    s_block = { tier = 1, rows = { "B..", "B..", ".B." } },
    s_mix = { tier = 2, rows = { "BJS", "...", "SBJ" } },
    s_wall = { tier = 3, rows = { "BB.", "...", ".BB", "M..", "B.B" } },
    s_power = { tier = 0, rows = { ".M.", "CCC", "CCC", "CCC", ".X.", "CCC", ".H." } },
  },
  missions = {
    m1 = { text = "Collect 20 coins in one run", stat = "coins", target = 20, scope = "run", reward = { { earn = "coins", amount = 100 } }, order = 1 },
    m2 = { text = "Jump 30 times total", stat = "jumps", target = 30, scope = "total", reward = { { earn = "coins", amount = 50 } }, order = 2 },
    m3 = { text = "Run 400 m", stat = "distance", target = 400, scope = "run", order = 3 },
    m4 = { text = "Run 2000 m", stat = "distance", target = 2000, scope = "run", order = 4 },
  },
  characters = {
    pip = { name = "Pip", cost = { coins = 0 }, order = 1 },
    zoom = { name = "Zoom", cost = { coins = 120 }, mods = { { stat = "magnetTime", add = 4 }, { stat = "jumpTime", pct = -0.1 } }, order = 2 },
  },
  stages = {
    test = { name = "Test", order = 1, width = 720, height = 1000, spawn = { x = 100, y = 900 }, parts = {
      { kind = "solid", x = 0, y = 900, w = 720, h = 40 },
      { kind = "checkpoint", x = 300, y = 820, w = 60, h = 80 },
      { kind = "goal", x = 600, y = 800, w = 80, h = 100 },
    } },
  },
} })
local out = {}
)";

// TS lua(): kContent + body, then save `out`; script errors fail the check.
Game lua(const std::string& body, const RunnerOpts& o = {}) {
  Game g = runner_game(kContent + "\n" + body + "\nsave.set(\"out\", out)", o);
  CHECK_NO_ERRORS(g);
  return g;
}

// TS examplePkg(edit): the example's files with scripts/shared/config.luau edited.
FileMap example_files(const std::function<std::string(std::string)>& edit) {
  FileMap files = read_dir(kExample);
  files["scripts/shared/config.luau"] = edit(files["scripts/shared/config.luau"]);
  return files;
}

// JS String.replace with a string pattern: the first occurrence only.
std::string replace_first(std::string s, const std::string& from, const std::string& to) {
  size_t at = s.find(from);
  REQUIRE_MESSAGE(at != std::string::npos, "config.luau has no \"" << from << "\"");
  return s.replace(at, from.size(), to);
}

}  // namespace

TEST_SUITE("kit runner") {

TEST_CASE("runner: controls: swipes, taps, keys") {
  RunnerOpts o;
  o.steps = 8;
  o.drive = [](Game& g, int i) {
    if (i == 1) g.axis("move_x", -1);
    if (i == 2) g.axis("move_x", 0);
    if (i == 3) g.axis("move_x", 1);
    if (i == 4) {
      g.axis("move_x", 0);
      g->input().tap("jump");
    }
    if (i == 5) g->input().tap("action");
  };
  // TS reads the save data directly (no error check here either).
  Game g = runner_game(kContent + R"(
      local c = R.controls.new({ keys = false, pointer = false })
      local got = {}
      local function swipe(x0, y0, x1, y1)
        c:feed(x0, y0) c:feed((x0 + x1) / 2, (y0 + y1) / 2) c:feed(x1, y1) c:feed(nil)
        table.insert(got, c:poll() or "nil")
      end
      swipe(300, 600, 150, 610) swipe(300, 600, 460, 590) swipe(300, 600, 310, 480) swipe(300, 600, 290, 720)
      c:feed(300, 600) c:feed(305, 604) c:feed(nil) table.insert(got, c:poll() or "nil")   -- tap = jump
      c:feed(300, 600) c:feed(320, 610) table.insert(got, c:poll() or "nil")                -- still holding, small move: nothing
      out.got = table.concat(got, ",")
      -- keyboard edges
      local k = R.controls.new()
      local seq = {}
      onTick(function()
        local a = k:poll()
        if a then table.insert(seq, a) end
        out.keys = table.concat(seq, ",")
        save.set("out", out)
      end)
save.set("out", out))",
                       o);
  CHECK_NO_ERRORS(g);
  J out = out_of(g);
  CHECK(out["got"].str() == "left,right,jump,slide,jump,nil");
  CHECK(out["keys"].str() == "left,right,jump,slide");
}

TEST_CASE("runner: segments: validation rejects unpassable rows; sequencing follows the difficulty tier") {
  Game g = lua(R"(
      out.bad1 = R.track.validate({ id = "x", rows = { "BBB" } })
      out.bad2 = R.track.validate({ id = "y", rows = { "B.", "..." } })
      out.bad3 = R.track.validate({ id = "z", rows = { "BB." , ".BB" } })
      out.good = R.track.validate({ id = "g", rows = { "B..", ".B.", "..B" } })
      local seq = R.track.sequencer({ seed = 4 })
      local maxEarly, minLate, okRange = 0, 99, true
      for d = 0, 6000, 25 do
        local s, tier = seq:next(d)
        if d < 300 then maxEarly = math.max(maxEarly, s.tier) end
        if d > 3000 then minLate = math.min(minLate, s.tier) end
        if s.tier > tier or s.tier < tier - 2 then okRange = false end
      end
      out.maxEarly, out.minLate, out.okRange = maxEarly, minLate, okRange
      -- no immediate repeats
      local rep = 0
      for i = 2, #seq.log do if seq.log[i].at < 4500 and seq.log[i].id == seq.log[i - 1].id then rep += 1 end end -- tier 5 has a single eligible segment here
      out.rep = rep
      local a, b = R.track.sequencer({ seed = 9 }), R.track.sequencer({ seed = 9 })
      local same = true
      for d = 0, 2000, 40 do if a:next(d).id ~= b:next(d).id then same = false end end
      out.same = same
      local fixed = R.track.sequencer({ seed = 2, tier = 3 })
      local allHigh = true
      for i = 1, 30 do if fixed:next(i * 30).tier < 1 then allHigh = false end end
      out.fixed = allHigh
  )");
  J out = out_of(g);
  for (const char* k : {"bad1", "bad2", "bad3"}) {
    CAPTURE(k);
    CHECK(out[k].is_bool());
    CHECK_FALSE(out[k].b());
  }
  CHECK(out["good"].b());
  CHECK(out["maxEarly"].num() == 0);
  CHECK(out["minLate"].num() >= 1);
  CHECK(out["okRange"].b());
  CHECK(out["rep"].num() == 0);
  CHECK(out["same"].b());
  CHECK(out["fixed"].b());
}

TEST_CASE("runner: endless sim: speed ramp, jump/slide/lanes vs obstacles, coins, magnet, shield, 2x") {
  Game g = lua(R"(
      local E = R.endless
      local function only(rows) return { { id = "t", tier = 0, rows = rows } } end
      local dt = 1 / 60
      local function runTo(sim, d, action)
        local first = true
        while sim.alive and sim.dist < d do sim:step(dt, if first then action else nil) first = false end
      end
      -- low bar in the middle lane: dies without jumping, survives with a well-timed jump
      local s1 = E.new({ seed = 1, segments = only({ ".J." }) })
      runTo(s1, 14) out.lowDie = s1.alive
      local s2 = E.new({ seed = 1, segments = only({ ".J." }) })
      runTo(s2, 11.2) runTo(s2, 14, "jump") out.lowJump = s2.alive
      local s3 = E.new({ seed = 1, segments = only({ ".S." }) })
      runTo(s3, 11.2) runTo(s3, 14, "slide") out.highSlide = s3.alive
      local s4 = E.new({ seed = 1, segments = only({ ".B." }) })
      runTo(s4, 11.2) runTo(s4, 14, "jump") out.blockJump = s4.alive
      local s5 = E.new({ seed = 1, segments = only({ ".B." }) })
      runTo(s5, 10) runTo(s5, 14, "left") out.blockLane = s5.alive out.lane = s5.lane
      -- coins + 2x + magnet + shield
      local s6 = E.new({ seed = 1, segments = only({ ".C.", ".X.", ".C.", ".C." }) })
      runTo(s6, 26) out.coins2x = s6.coins     -- 1 + 2 + 2
      local s7 = E.new({ seed = 1, segments = only({ ".M.", "C.C", "C.C", "C.C" }) })
      runTo(s7, 30) out.magnet = s7.coins        -- side lanes pulled in
      local s8 = E.new({ seed = 1, segments = only({ ".H.", "...", ".B." }) })
      runTo(s8, 30) out.shieldAlive = s8.alive out.shieldLeft = s8.power.shield
      -- speed ramp
      local s9 = E.new({ seed = 3, segments = only({ "C.." }) })
      out.v0 = s9:speedAt(0) out.v1 = s9:speedAt(800) out.v2 = s9:speedAt(5000)
      local s10 = E.new({ seed = 3, segments = only({ "C.." }), modifier = { params = { speedMult = 1.5 } } })
      out.vMod = s10:speedAt(0)
  )");
  J out = out_of(g);
  CHECK(out["lowDie"].is_bool());
  CHECK_FALSE(out["lowDie"].b());
  CHECK(out["lowJump"].b());
  CHECK(out["highSlide"].b());
  CHECK(out["blockJump"].is_bool());
  CHECK_FALSE(out["blockJump"].b());
  CHECK(out["blockLane"].b());
  CHECK(out["lane"].num() == 1);
  CHECK(out["coins2x"].num() == 5);
  CHECK(out["magnet"].num() >= 6);
  CHECK(out["shieldAlive"].b());
  CHECK(out["shieldLeft"].num() == 0);
  CHECK(out["v0"].num() == 10);
  CHECK(out["v1"].num() == 15);
  CHECK(out["v2"].num() == 23);
  CHECK(out["vMod"].num() == 15);
}

TEST_CASE("runner: missions (run + total scope), characters bought with coins, best distance, persistence") {
  Game a = lua(R"(
      out.slots = #R.missions()
      out.first = R.missions()[1].id
      local sim = R.newRun({ seed = 5 })
      local bot = {}
      while sim.alive and sim.dist < 450 do sim:step(1 / 60, R.endless.botAction(sim, bot, { reaction = 0.3, miss = 0 })) end
      out.live = #R.progress(sim:summary(), false) >= 0
      local sum = R.finish(sim)
      out.sumCoins = sum.coins
      out.completed = #sum.missions
      out.best = R.best()
      out.wallet = R.coins()
      out.chars = #R.characters()
      out.sel = R.characters()[1].selected
      core.wallet.add("coins", 200)
      out.buy = R.buyCharacter("zoom")
      out.select = R.selectCharacter("zoom")
      out.magnetTime = R.params().magnetTime
      out.missionsAfter = {}
      for _, m in R.missions() do table.insert(out.missionsAfter, m.id) end
      core.save.save()
  )");
  J ao = out_of(a);
  CHECK(ao["slots"].num() == 3);
  // TS reads MemoryLeaderboardHost.submitted ([board, order, value]); the C++ host keeps the same
  // submissions in local_scores() (ascending = order "asc").
  const auto& lb = a->local_scores();
  REQUIRE(lb.size() == 1);
  CHECK(lb[0].board == "distance");
  CHECK_FALSE(lb[0].ascending);  // "desc"
  CHECK(lb[0].value == ao["best"].num());
  CHECK(ao["first"].str() == "m1");
  CHECK(ao["best"].num() >= 400);
  CHECK(ao["completed"].num() >= 1);  // m3 (400 m)
  CHECK(ao["chars"].num() == 2);
  CHECK(ao["sel"].b());
  CHECK(ao["buy"].b());
  CHECK(ao["magnetTime"].num() == 12);
  std::vector<std::string> after = ao["missionsAfter"].strs();
  CHECK(std::find(after.begin(), after.end(), "m4") != after.end());

  RunnerOpts o;
  o.save = a.save();  // the same MemorySaveHost
  Game b = lua(R"(
      core.save.load()
      out.best = R.best()
      out.owned = R.characters()[2].owned
      out.selected = R.meta.data.character
      out.m = #R.missions()
  )",
               o);
  J bo = out_of(b);
  CHECK(bo["best"].num() == ao["best"].num());
  CHECK(bo["owned"].b());
  CHECK(bo["selected"].str() == "zoom");
  CHECK(bo["m"].num() > 0);
}

TEST_CASE("runner: daily challenge: seeded by clock day, modifier, reward once") {
  const double day = 20500.0 * 86400;
  const std::string d = std::to_string(static_cast<long long>(day));
  RunnerOpts o;
  o.clock = [day] { return day + 500; };
  Game g = lua(R"(
      local a, b, c = R.daily()" + d + R"( + 10), R.daily()" + d + R"( + 86000), R.daily()" + d + R"( + 86400 * 2)
      out.same = a.seed == b.seed and a.target == b.target
      out.diff = a.seed ~= c.seed
      out.mod = a.modifier ~= nil
      local d = R.daily()
      out.today = d.day
      local before = R.coins()
      out.r1 = R.meta.completeDaily(d.target + 10)
      out.r2 = R.meta.completeDaily(d.target + 50)
      out.gain = R.coins() - before
      out.done = R.daily().done
      local sim = R.newRun({ daily = true })
      out.dailySeed = sim.seq.rng ~= nil and sim.daily.seed == d.seed
  )",
               o);
  J out = out_of(g);
  CHECK(out["same"].b());
  CHECK(out["diff"].b());
  CHECK(out["mod"].b());
  CHECK(out["today"].num() == 20500);
  CHECK(out["r1"].b());
  CHECK(out["r2"].is_bool());
  CHECK_FALSE(out["r2"].b());
  CHECK(out["gain"].num() == 150);
  CHECK(out["done"].b());
  CHECK(out["dailySeed"].b());
}

TEST_CASE("runner: obby: checkpoint, timer, finish, ghost record/playback, vanish, spinner, procgen stages") {
  Game g = lua(R"(
      local O = R.obby
      local o = R.obbyRun("test")
      local t = 0
      while not o.finished and t < 600 do o:step(1 / 60, 1, false, false) t += 1 end
      out.finished = o.finished
      out.cp = o.checkpoint
      out.time = o.time
      out.deaths = o.deaths
      out.best = R.finishStage("test", o)
      local ghost = o:ghostString()
      out.ghostLen = #ghost
      local o2 = R.obbyRun("test")
      local gx, gy = o2:ghostAt(0.5)
      out.ghostX = gx
      out.realX = nil
      -- second slower run is not a best
      local o3 = R.obbyRun("test")
      for i = 1, 30 do o3:step(1 / 60, 0, false, false) end
      while not o3.finished do o3:step(1 / 60, 1, false, false) end
      out.best2 = R.finishStage("test", o3)
      out.rec = R.stageRecord("test").best
      -- death on spikes -> respawn at checkpoint
      local st = { width = 720, height = 1000, spawn = { x = 100, y = 900 }, parts = {
        { kind = "solid", x = 0, y = 900, w = 720, h = 40 }, { kind = "checkpoint", x = 200, y = 820, w = 40, h = 80 },
        { kind = "spike", x = 400, y = 880, w = 40, h = 20 } } }
      local o4 = O.new(st)
      local died = false
      for i = 1, 200 do o4:step(1 / 60, 1, false, false) for _, e in o4.events do if e.name == "death" then died = true end end end
      for i = 1, 40 do o4:step(1 / 60, 0, false, false) end
      out.spikeDied = died
      out.respawnX = math.floor(o4.x)
      -- vanishing tile: stand on it, it disappears, you fall
      local st2 = { width = 720, height = 2000, spawn = { x = 100, y = 500 }, parts = { { kind = "vanish", x = 0, y = 500, w = 300, h = 30, on = 0.5, off = 1 } } }
      local o5 = O.new(st2)
      for i = 1, 30 do o5:step(1 / 60, 0, false, false) end
      out.vanishStand = o5.ground ~= nil
      for i = 1, 40 do o5:step(1 / 60, 0, false, false) end
      out.vanishFell = o5.ground == nil and o5.y > 500
      -- spinner kills when the arm sweeps through the player
      local st3 = { width = 720, height = 1000, spawn = { x = 360, y = 900 }, parts = { { kind = "solid", x = 0, y = 900, w = 720, h = 40 }, { kind = "spinner", x = 360, y = 870, r = 120, speed = 180 } } }
      local o6 = O.new(st3)
      for i = 1, 90 do o6:step(1 / 60, 0, false, false) end
      out.spinDeaths = o6.deaths
      -- jump
      local o7 = O.new(st)
      o7:step(1 / 60, 0, true, true)
      for i = 1, 10 do o7:step(1 / 60, 0, false, true) end
      out.jumped = o7.y < 880
      -- procgen: deterministic, within the jump envelope
      local okAll = true
      local probs = {}
      for seed = 1, 40 do
        for d = 1, 10, 3 do
          local s = O.generate({ seed = seed, difficulty = d, platforms = 16 })
          local ok, p = O.check(s)
          if not ok then okAll = false table.insert(probs, seed .. ":" .. d .. ":" .. p[1]) end
        end
      end
      out.envelope = okAll
      out.probs = table.concat(probs, " ")
      local g1, g2 = O.generate({ seed = 7, difficulty = 5 }), O.generate({ seed = 7, difficulty = 5 })
      out.genSame = #g1.parts == #g2.parts and g1.parts[5].x == g2.parts[5].x and g1.parts[9].y == g2.parts[9].y
      local kinds = {}
      for _, p in O.generate({ seed = 3, difficulty = 9, platforms = 30 }).parts do kinds[p.kind] = true end
      out.kinds = kinds
      -- bot climbs an easy generated stage
      local easy = O.new(O.generate({ seed = 11, difficulty = 1, platforms = 8 }))
      local bot = {}
      for i = 1, 60 * 60 do
        if easy.finished then break end
        local ax, j, h = O.botInput(easy, bot)
        easy:step(1 / 60, ax, j, h)
      end
      out.botFinished = easy.finished
      out.botCp = easy.checkpoint
  )");
  J out = out_of(g);
  CHECK(out["finished"].b());
  // TS: submitted.map([board, order]) == [["stage_test","asc"],["stage_test","asc"]] (C++:
  // local_scores()). TS submissions also carry ghost frames; the C++ engine records none (not
  // asserted by the TS test either).
  const auto& sub = g->local_scores();
  REQUIRE(sub.size() == 2);
  for (const auto& s : sub) {
    CHECK(s.board == "stage_test");
    CHECK(s.ascending);
  }
  CHECK(out["cp"].num() == 1);
  CHECK(out["time"].num() > 1);
  CHECK(out["best"].b());
  CHECK(out["ghostLen"].num() > 40);
  CHECK(out["ghostX"].num() > 100);
  CHECK(out["best2"].is_bool());
  CHECK_FALSE(out["best2"].b());
  CHECK_CLOSE(out["rec"].num(), out["time"].num(), 1);
  CHECK(out["spikeDied"].b());
  CHECK(std::fabs(out["respawnX"].num() - 220) < 3);
  CHECK(out["vanishStand"].b());
  CHECK(out["vanishFell"].b());
  CHECK(out["spinDeaths"].num() > 0);
  CHECK(out["jumped"].b());
  CHECK(out["probs"].str() == "");
  CHECK(out["envelope"].b());
  CHECK(out["genSame"].b());
  J k = out["kinds"];
  CHECK((k["move"].truthy() && k["vanish"].truthy() && k["conveyor"].truthy() && k["spinner"].truthy() &&
         k["spike"].truthy() && k["checkpoint"].truthy() && k["goal"].truthy()));
  CHECK(out["botFinished"].b());
}

TEST_CASE("runner: balance: bot survival distance falls as the tier rises" * doctest::test_suite("slow")) {
  RunnerOpts o;
  o.steps = 600;
  Game g = runner_game(kContent + R"(
      local job = R.balanceJob({ runs = 8, maxDist = 1500 })
      local ticks = 0
      onTick(function() if not job.done then ticks += 1 if job:step(4000) then out.b = job.result out.ticks = ticks save.set("out", out) end end end))",
                       o);
  CHECK_NO_ERRORS(g);
  J out = out_of(g);
  J b = out["b"];
  for (const std::string& k : b.keys())
    MESSAGE("runner balance tier " << k << ": mean " << std::lround(b[k]["mean"].num()) << " p10 " << b[k]["p10"].num()
                                   << " p50 " << b[k]["p50"].num() << " p90 " << b[k]["p90"].num());
  MESSAGE("ticks " << out["ticks"].num());
  CHECK(b.keys().size() >= 4);
  CHECK(b["0"]["mean"].num() > b["3"]["mean"].num());
}

}  // TEST_SUITE

TEST_SUITE("kit runner") {

TEST_CASE("runner example: endless: bot runs several seeds with zero script errors; missions/best persist" *
          doctest::test_suite("slow")) {
  for (int seed : {1, 2, 3}) {
    CAPTURE(seed);
    FileMap files = example_files([&](std::string c) {
      return replace_first(replace_first(c, "bot = false", "bot = true"), "seed = nil", "seed = " + std::to_string(seed));
    });
    script::HostOptions opts;
    opts.seed = static_cast<uint32_t>(seed);
    opts.budget_ms = budget(250);
    Game g = start(files, opts);
    g.step(60 * 120);
    CHECK_NO_ERRORS(g);
    std::vector<std::string> runs;
    for (const std::string& l : g.logs())
      if (l.rfind("run over", 0) == 0) runs.push_back(l);
    MESSAGE("runner example seed " << seed << ": " << (runs.empty() ? "(still running)" : join(runs, " | ")));
  }
}

TEST_CASE("runner example: obby: bot climbs stages (scene changes) with zero script errors" *
          doctest::test_suite("slow")) {
  FileMap files = example_files([](std::string c) {
    return replace_first(replace_first(c, "bot = false", "bot = true"), "botMode = \"endless\"", "botMode = \"obby\"");
  });
  script::HostOptions opts;
  opts.seed = 1;
  opts.budget_ms = budget(250);
  Game g = start(files, opts);
  g.step(60 * 40);
  CHECK_NO_ERRORS(g);
  std::vector<std::string> fin = g.logs_with("stage ");
  MESSAGE("obby example: " << join(fin, " | "));
  CHECK(fin.size() >= 1);
}

TEST_CASE("runner example: example content: every segment valid; balance per tier" * doctest::test_suite("slow")) {
  FileMap files = example_files([](std::string c) { return c; });
  files["scripts/client/run.luau"] = R"(
local R = require("@kit/runner")
require("../shared/game").init()
local job = R.balanceJob({ runs = 16, maxDist = 3000 })
local out = { stages = #R.stages() }
for _, st in R.stages() do local ok = R.obby.check(st) if st.generated and not ok then out.badStage = st.id end end
onTick(function() if not job.done and job:step(5000) then out.b = job.result save.set("out", out) end end))";
  // TS deletes obby.luau; the C++ package validator rejects a scene attaching a missing script, so
  // stub it instead (the obby scene never loads in this test).
  files["scripts/client/obby.luau"] = "-- disabled for this test\n";
  script::HostOptions opts;
  opts.seed = 1;
  opts.budget_ms = budget(250);
  Game g = start(files, opts);
  g.step_until([&] { return J(&g.save())["out"]["b"].exists(); }, 2000);
  CHECK_NO_ERRORS(g);
  J out = out_of(g);
  CHECK(out["stages"].num() == 6);
  CHECK_FALSE(out["badStage"].exists());
  J b = out["b"];
  for (const std::string& t : b.keys())
    MESSAGE("runner balance (bot reaction 0.25 s, 2% miss) tier " << t << ": mean " << std::lround(b[t]["mean"].num())
                                                                  << " m  p10 " << b[t]["p10"].num() << "  p50 "
                                                                  << b[t]["p50"].num() << "  p90 " << b[t]["p90"].num());
  CHECK(b["0"]["mean"].num() > b["5"]["mean"].num());
}

}  // TEST_SUITE
