// tycoon kit: economy math, milestones, prestige, offline progress, save, the example package and
// the balance sim. Port of engine-web/test/kits/tycoon.test.ts (same numbers and thresholds).
#include "kits/kit_test.h"

using namespace dreamsy;
using namespace dreamsy::test;

namespace {

const char* kExample = "games/examples/kit-tycoon";

// small hand-made content used by most tests
const std::string kContent = R"({
  config = {
    currencies = { { id = "coins", start = 10 }, { id = "gems" }, { id = "stars" } },
    tap = { amount = 1, rate_fraction = 0.1 },
    offline = { cap_hours = 1, rate = 0.5, min_seconds = 60 },
    milestones = { { at = 25, mult = 2 }, { at = 50, mult = 2 } },
    prestige = { { id = "star", currency = "stars", threshold = 1e4, exponent = 0.5, scale = 1, bonus = 0.1 } },
    events = { first_delay = 10 },
  },
  generators = {
    lemon = { order = 1, cost = { base = 4, growth = 1.07 }, output = 1, cycle = 1 },
    stand = { order = 2, cost = { base = 60, growth = 1.15 }, output = 60, cycle = 3, manager = { cost = 1000 },
              unlock = { owned = { lemon = 5 } } },
    mine = { order = 3, currency = "gems", cost = { base = 100, growth = 1 }, output = 1, cycle = 10 },
  },
  upgrades = {
    juicer = { cost = { amount = 100 }, effect = { kind = "output", target = "lemon", value = 3 }, requires = { owned = { lemon = 10 } } },
    fast = { cost = { amount = 50 }, effect = { kind = "speed", value = 2 } },
    cheap = { cost = { amount = 2, currency = "stars" }, effect = { kind = "cost", value = 0.5 } },
  },
  achievements = { ten = { when = { owned = { lemon = 10 } }, reward = { mult = 1.5 } } },
  events = { rush = { effect = { kind = "output", value = 3 }, duration = 20, lifetime = 5, every = { 30, 30 } } },
})";

LuauOptions tycoon(LuauOptions o = {}) {
  o.kits = {"tycoon"};
  return o;
}

// TS lua(): the snippet runs with Tycoon, content and an `out` table it saves at the end.
// Returns the whole run (kept alive so the J view of `out` stays valid).
LuauRun lua(const std::string& body, LuauOptions o = {}) {
  LuauRun r = run_luau("local Tycoon = require(\"@kit/tycoon\")\nlocal content = " + kContent + "\nlocal out = {}\n" + body +
                           "\nsave.set(\"out\", out)",
                       tycoon(std::move(o)));
  CHECK_MESSAGE(r.errors.empty(), join(r.errors));
  return r;
}

}  // namespace

TEST_SUITE("kit tycoon") {

TEST_CASE("tycoon: number formatting: K/M/B/T then letters, durations") {
  LuauRun r = lua(R"(
    local F = Tycoon.format
    out.a = { F(0), F(7), F(12.345), F(999), F(1000), F(1234), F(12345), F(123456), F(1.5e6), F(2.25e9), F(3e12),
              F(1e15), F(1e18), F(4.56e17), F(1e93), F(-2500), F(1234, { notation = "scientific" }), F(1500, { trim = true }) }
    out.s = { Tycoon.suffix(5), Tycoon.suffix(6), Tycoon.suffix(30), Tycoon.suffix(5 + 26 * 26) }
    out.d = { Tycoon.duration(42), Tycoon.duration(185), Tycoon.duration(3725), Tycoon.duration(90000) }
  )");
  J o = r.out();
  CHECK(o["a"].dump() ==
        R"(["0","7","12.3","999","1.00K","1.23K","12.3K","123K","1.50M","2.25B","3.00T","1.00aa","1.00ab","456aa","1.00ba","-2.50K","1.23e3","1.5K"])");
  CHECK(o["s"].dump() == R"(["aa","ab","az","e2043"])");
  CHECK(o["d"].dump() == R"(["42s","3m 05s","1h 02m","1d 01h"])");
}

TEST_CASE("tycoon: generators: geometric cost curve, buy x1/x10/max (closed form = brute force), output") {
  LuauRun r = lua(R"(
    local t = Tycoon.new(content)
    out.c1 = t:costOf("lemon", 1)
    out.c10 = t:costOf("lemon", 10)
    local brute = 0
    for k = 0, 9 do brute += 4 * 1.07 ^ k end
    out.brute10 = brute
    t:add("coins", 1000 - 10)
    out.max = t:maxAffordable("lemon")
    out.maxCost = t:costOf("lemon", out.max)
    out.maxPlus = t:costOf("lemon", out.max + 1)
    out.buy10 = t:buy("lemon", 10)
    out.owned = t.owned.lemon
    out.left = t:get()
    out.buyMax = t:buy("lemon", "max")
    out.owned2 = t.owned.lemon
    out.after = t:get()
    out.locked = t:isUnlocked("stand")
    out.rate = t:rate("lemon")
    out.unlockedLater = t:isUnlocked("stand")
    out.noMoney = t:buy("lemon", 10)
    out.gemCost = t:costOf("mine", 3)
  )");
  J o = r.out();
  CHECK_CLOSE(o["c1"].num(), 4, 2);
  CHECK_CLOSE(o["c10"].num(), o["brute10"].num(), 6);
  CHECK(o["maxCost"].num() <= 1000);
  CHECK(o["maxPlus"].num() > 1000);
  CHECK(o["buy10"].b());
  CHECK(o["owned"].num() == 10);
  CHECK_CLOSE(o["left"].num(), 1000 - o["c10"].num(), 6);
  CHECK(o["buyMax"].b());
  double owned2 = o["owned2"].num();
  CHECK(o["after"].num() < o["c1"].num() * std::pow(1.07, owned2));
  CHECK(o["unlockedLater"].b());  // 5 lemons unlock the stand
  // achievement x1.5 at 10 lemons, milestone x2 at 25
  CHECK_CLOSE(o["rate"].num(), owned2 * 1 * 1.5 * (owned2 >= 25 ? 2 : 1), 6);
  CHECK_FALSE(o["noMoney"].b());
  CHECK(o["gemCost"].num() == 300);  // growth 1 -> linear
}

TEST_CASE("tycoon: milestones double output at owned counts and fire signals; upgrades + speed + managers") {
  LuauRun r = lua(R"(
    local t = Tycoon.new(content)
    local ms = {}
    t.on.milestone:connect(function(g, at, m) table.insert(ms, g .. "@" .. at .. "x" .. m) end)
    t:add("coins", 1e9)
    t:buy("lemon", 24)
    out.r24 = t:rate("lemon") / 24
    t:buy("lemon", 1)
    out.r25 = t:rate("lemon") / 25
    t:buy("lemon", 25)
    out.r50 = t:rate("lemon") / 50
    out.ms = ms
    out.next = t:nextMilestone("lemon")
    out.upAvail = t:upgradeAvailable("juicer")
    t:buyUpgrade("juicer")
    out.r50j = t:rate("lemon") / 50
    out.cyc = t:cycleTime("lemon")
    t:buyUpgrade("fast")
    out.cycFast = t:cycleTime("lemon")
    -- manual stand: runs only when tapped until a chef is hired
    t:buy("stand", 1)
    out.autoBefore = t:isAuto("stand")
    local before = t:get()
    t:step(3.1)
    out.idle = t.progress.stand
    out.ran = t:run("stand")
    before = t:get()
    t:step(1.6)
    out.standPaid = t.progress.stand == 0 and not t.running.stand
    out.hired = t:hireManager("stand")
    out.autoAfter = t:isAuto("stand")
  )");
  J o = r.out();
  CHECK_CLOSE(o["r24"].num(), 1.5, 2);
  CHECK_CLOSE(o["r25"].num(), 3, 2);
  CHECK_CLOSE(o["r50"].num(), 6, 2);
  CHECK(o["ms"].strs() == std::vector<std::string>{"lemon@25x2", "lemon@50x2"});
  CHECK(o["next"].is_null());
  CHECK(o["upAvail"].b());
  CHECK_CLOSE(o["r50j"].num(), 18, 2);
  CHECK(o["cyc"].num() == 1);
  CHECK(o["cycFast"].num() == 0.5);
  CHECK_FALSE(o["autoBefore"].b());
  CHECK(o["idle"].num() == 0);  // the manual stand doesn't run until tapped
  CHECK(o["ran"].b());
  CHECK(o["standPaid"].b());
  CHECK(o["hired"].b());
  CHECK(o["autoAfter"].b());
}

TEST_CASE("tycoon: taps scale with income; events spawn deterministically, boost output, expire") {
  LuauRun r = lua(R"(
    local t = Tycoon.new(content, { seed = 3 })
    out.tap0 = t:tap()
    t:add("coins", 1000)
    t:buy("lemon", 10)
    out.tap1 = t:tapValue()
    out.income = t:income()
    local spawned = {}
    t.on.eventSpawned:connect(function(id) table.insert(spawned, { id, t.t }) end)
    for i = 1, 11 do t:step(1) end
    out.spawned = spawned
    local r = t:rate("lemon")
    out.claimed = t:claimEvent()
    out.boosted = t:rate("lemon") / r
    for i = 1, 21 do t:step(1) end
    out.after = t:rate("lemon") / r
    -- next spawn at 10 + lifetime 5 + every 30 = 45
    local expired = {}
    t.on.eventExpired:connect(function(id) table.insert(expired, t.t) end)
    for i = 1, 60 do t:step(1) end
    out.expired = expired
  )");
  J o = r.out();
  CHECK(o["tap0"].num() == 1);
  CHECK_CLOSE(o["tap1"].num(), 1 + o["income"].num() * 0.1, 2);
  CHECK(o["spawned"][0].dump() == R"(["rush",10])");
  CHECK(o["claimed"].str() == "rush");
  CHECK_CLOSE(o["boosted"].num(), 3, 2);
  CHECK_CLOSE(o["after"].num(), 1, 2);
  CHECK(o["expired"].values().at(0).num() == 50);
}

TEST_CASE("tycoon: prestige gain = floor(scale*(allTime/threshold)^exp) - claimed; resets the run; keeps permanent upgrades + achievements") {
  LuauRun r = lua(R"(
    local t = Tycoon.new(content)
    out.can0 = t:canPrestige()
    t:add("coins", 1e6) -- allTime = 1e6 (start coins are not "earned") → total = sqrt(100) = 10
    out.gain = t:prestigeGain()
    out.needed = t:prestigeNeeded(nil, 11)
    t:buy("lemon", 10)
    t:hireManager("stand")
    local events = {}
    t.on.prestiged:connect(function(l, g) table.insert(events, l .. ":" .. g) end)
    out.did = t:doPrestige()
    out.events = table.clone(events)
    out.stars = t:get("stars")
    out.coins = t:get("coins")
    out.lemons = t.owned.lemon
    out.ach = t.ach.ten == true
    out.bonus = t:prestigeBonus()
    out.gainAfter = t:prestigeGain()
    out.cheap = t:buyUpgrade("cheap")
    out.starsLeft = t:get("stars")
    out.lemonCost = t:costOf("lemon", 1)
    t:add("coins", 3e6) -- allTime 4e6 → total 20 → +10
    out.gain2 = t:prestigeGain()
    t:doPrestige()
    out.keptCheap = t:hasUpgrade("cheap")
    out.claimed = t.prestige.star.claimed
    out.count = t.prestige.star.count
  )");
  J o = r.out();
  CHECK_FALSE(o["can0"].b());
  CHECK(o["gain"].num() == 10);
  CHECK_CLOSE(o["needed"].num(), 1e6 * std::pow(11.0 / 10, 2), 0);
  CHECK(o["did"].num() == 10);
  CHECK(o["events"].strs() == std::vector<std::string>{"star:10"});
  CHECK(o["stars"].num() == 10);
  CHECK(o["coins"].num() == 10);  // back to start
  CHECK(o["lemons"].num() == 0);
  CHECK(o["ach"].b());
  CHECK_CLOSE(o["bonus"].num(), 2, 2);  // 10 stars x 0.1
  CHECK(o["gainAfter"].num() == 0);
  CHECK(o["cheap"].b());
  CHECK(o["starsLeft"].num() == 8);
  CHECK_CLOSE(o["lemonCost"].num(), 2, 2);  // permanent cost x0.5
  CHECK(o["gain2"].num() == 10);
  CHECK(o["keptCheap"].b());
  CHECK(o["claimed"].num() == 20);
  CHECK(o["count"].num() == 2);
}

TEST_CASE("tycoon: offline progress credits automated production since the save timestamp, capped and scaled") {
  LuauOptions opts;
  opts.clock = [] { return 1234.0; };
  LuauRun r = lua(R"(
    local t = Tycoon.new(content, { now = 1000 })
    t:add("coins", 1000)
    t:buy("lemon", 10)
    t:buy("stand", 1) -- manual: no offline output
    local rate = t:rate("lemon")
    local d = t:serialize(5000)
    local t2 = Tycoon.new(content)
    t2:deserialize(d)
    local c0 = t2:get()
    out.short = t2:applyOffline(5030) -- < min_seconds
    local r = t2:applyOffline(5030 + 600)
    out.earned = r.earned.coins
    out.expect = rate * 600 * 0.5 -- the short call already moved savedAt to 5030
    out.delta = t2:get() - c0
    t2.savedAt = 0
    local r2 = t2:applyOffline(1e6)
    out.credited = r2.credited
    out.clock = Tycoon.wallClock()
  )",
                  opts);
  J o = r.out();
  CHECK(o["short"].is_null());
  CHECK_CLOSE(o["earned"].num(), o["expect"].num(), 6);
  CHECK_CLOSE(o["delta"].num(), o["expect"].num(), 6);
  CHECK(o["credited"].num() == 3600);  // cap_hours = 1
  CHECK(o["clock"].num() == 1234);     // engine clock.now()
}

TEST_CASE("tycoon: persist -> relaunch later (clock.now) credits offline progress through Tycoon.restore") {
  const double t0 = 1'800'000'000;
  double now = t0;
  LuauOptions opts;
  opts.clock = [&now] { return now; };
  LuauRun first = lua(R"(
    local t = Tycoon.restore(content, "k")
    t:add("coins", 1000)
    t:buy("lemon", 10)
    out.rate = t:rate("lemon")
    Tycoon.persist(t, "k")
  )",
                      opts);
  CHECK(J(&first.save)["k"]["savedAt"].num() == t0);
  const double rate = first.out()["rate"].num();
  // Each relaunch starts from a copy of the first run's save (TS: new MemorySaveHost({ ...save.data })).
  auto relaunch = [&] {
    LuauOptions o = opts;
    o.save = first.save;
    return lua(R"(
      local t, r = Tycoon.restore(content, "k")
      out.report = r
      out.coins = t:get()
      Tycoon.persist(t, "k")
    )",
               o);
  };
  now = t0 + 30;  // < min_seconds
  CHECK(relaunch().out()["report"].is_null());
  now = t0 + 600;
  LuauRun b = relaunch();
  CHECK(b.out()["report"]["seconds"].num() == 600);
  CHECK_CLOSE(b.out()["report"]["earned"]["coins"].num(), rate * 600 * 0.5, 6);
  now = t0 + 10 * 3600;
  LuauRun c = relaunch();
  CHECK(c.out()["report"]["credited"].num() == 3600);  // capped at cap_hours
  CHECK_CLOSE(c.out()["report"]["earned"]["coins"].num(), rate * 3600 * 0.5, 6);
}

TEST_CASE("tycoon: bindSave stores the state as a core.save section") {
  LuauOptions opts;
  opts.clock = [] { return 5000.0; };
  LuauRun r = lua(R"(
    local core = require("@kit/core")
    local t = Tycoon.bindSave(Tycoon.new(content))
    t:add("coins", 500) t:buy("lemon", 7)
    core.save.save()
    local t2 = Tycoon.bindSave(Tycoon.new(content))
    out.loaded = core.save.load()
    out.lemons = t2.owned.lemon
  )",
                  opts);
  CHECK(r.out()["loaded"].b());
  CHECK(r.out()["lemons"].num() == 7);
}

TEST_CASE("tycoon: serialize -> save.set -> relaunch -> restore round-trips the whole state") {
  FileMap files = {
      {"dreamsy.toml", manifest("\"tycoon\"", "scenes/m.scene.json", "portrait", "clean")},
      {"scenes/m.scene.json", empty_scene("w")},
      {"scripts/shared/content.luau", "return " + kContent},
  };
  FileMap first = files;
  first["scripts/client/a.luau"] = R"(
    local Tycoon = require("@kit/tycoon")
    local t = Tycoon.restore(require("../shared/content"), "k")
    t:add("coins", 5e6)
    t:buy("lemon", 30) t:buyUpgrade("juicer") t:buyUpgrade("fast")
    t:tap() t:step(12.5)
    t:doPrestige() t:add("coins", 2000) t:buy("lemon", 5) t:buy("stand", 2) t:run("stand") t:step(0.5)
    t:claimEvent()
    Tycoon.persist(t, "k", 777)
    save.set("before", t:serialize(777))
  )";
  // relaunch 30 s later (< offline.min_seconds): nothing is credited, so the state must round-trip exactly
  script::HostOptions o1;
  o1.clock = [] { return 777.0; };
  Game g1 = start(first, o1);
  g1.step();
  CHECK_NO_ERRORS(g1);
  FileMap second = files;
  second["scripts/client/a.luau"] = R"(
    local Tycoon = require("@kit/tycoon")
    local t = Tycoon.restore(require("../shared/content"), "k")
    save.set("after", t:serialize(777))
  )";
  script::HostOptions o2;
  o2.clock = [] { return 807.0; };
  o2.save = g1.save();
  Game g2 = start(second, o2);
  g2.step();
  CHECK_NO_ERRORS(g2);
  J before(&g1.save());
  CHECK(J(&g2.save())["after"].dump() == before["before"].dump());
  CHECK(before["before"]["prestige"]["star"]["count"].num() == 1);
  CHECK(before["k"].dump().size() < 64 * 1024);
}

TEST_CASE("tycoon: content errors are clear") {
  LuauRun r = run_luau(R"(require("@kit/tycoon").new({ generators = { a = { output = 1 } } }))", tycoon());
  CHECK(matches(join(r.errors), R"(generator a needs cost = \{ base)"));
  LuauRun r2 = run_luau(
      R"(require("@kit/tycoon").new({ generators = { a = { output = 1, cost = { base = 1 } } }, upgrades = { u = { cost = { amount = 1 }, effect = { kind = "output", target = "zz", value = 2 } } } }))",
      tycoon());
  CHECK(matches(join(r2.errors), R"(upgrade u: effect target 'zz' is not a generator)"));
}

TEST_CASE("tycoon example (Crumbtown Bakery): 8 generators, 15 upgrades, 1 prestige layer; Tycoon.new() reads them from data/") {
  FileMap pkg = read_dir(kExample);
  CHECK(paths_with(pkg, "data/generators/").size() == 8);
  CHECK(paths_with(pkg, "data/upgrades/").size() == 15);
  Json tycoon_json = parse_json(pkg["data/tycoon.json"]);
  CHECK(J(&tycoon_json)["prestige"].size() == 1);
  LuauOptions o = tycoon();
  o.base = pkg;
  LuauRun r = run_luau(R"(
      local c = require("@kit/tycoon").new().content
      save.set("out", { gens = c.genOrder, upgrades = #c.upgradeOrder, ach = #c.achievementOrder, events = #c.eventOrder,
        layers = c.layerOrder, main = c.main, first = c.generators[c.genOrder[1]].name }))",
                       o);
  CHECK_MESSAGE(r.errors.empty(), join(r.errors));
  J out = r.out();
  CHECK(out["gens"].size() == 8);
  CHECK(out["gens"][0].str() == "muffin_tin");
  CHECK(out["upgrades"].num() == 15);
  CHECK(out["ach"].num() == static_cast<double>(paths_with(pkg, "data/achievements/").size()));
  CHECK(out["events"].num() == static_cast<double>(paths_with(pkg, "data/events/").size()));
  CHECK(out["layers"].size() == 1);
}

TEST_CASE("tycoon example: data reader: id must match the file name") {
  LuauOptions o = tycoon();
  o.files = {{"data/generators/a.json", R"({"id":"b","cost":{"base":1},"output":1})"}};
  LuauRun r = run_luau(R"(require("@kit/tycoon").new())", o);
  CHECK(matches(join(r.errors), R"(data/generators/a\.json: id "b" must match the file name)"));
}

TEST_CASE("tycoon example: boots headless and plays by taps without script errors") {
  script::HostOptions opts;
  opts.seed = 1;
  Game g = start_dir(kExample, {}, opts);
  auto run = [&](int n) { g.step(n); };
  run(5);
  for (int i = 0; i < 40; ++i) {
    g.tap(360, 270);  // cupcake
    run(3);
  }
  g.tap(578, 424 + 80); run(5);  // buy muffin tin
  g.tap(578, 424 + 80); run(5);
  g.tap(68, 424 + 80); run(60);  // icon: manual bake
  g.tap(620, 230); run(2);       // buy mode -> x10
  g.tap(620, 230); run(2);       // -> max
  g.tap(578, 424 + 80); run(5);
  // scroll the list by dragging (TS sets input.pointer each tick, then clears it)
  for (int y = 1000; y > 600; y -= 40) {
    g->input().hold_pointer({360.0f, static_cast<float>(y)}, 1);
    run(1);
  }
  run(30);
  g.tap(535, 1135); run(10);  // ▼ MORE page button
  g.tap(185, 1135); run(10);  // ▲ UP
  for (int x : {8 + 178 + 85, 8 + 2 * 178 + 85, 8 + 3 * 178 + 85, 93}) {
    g.tap(x, 1220);
    run(20);
  }
  run(400);
  CHECK_NO_ERRORS(g);
  bool muffin = false;
  for (const std::string& s : g.hud_texts()) muffin = muffin || contains(s, "Muffin Tin");
  CHECK(muffin);
  J saved = J(&g.save())["bakery"];
  REQUIRE(saved.exists());
  CHECK(saved["owned"]["muffin_tin"].num() > 0);
  CHECK(saved["stats"]["taps"].num() >= 40);
}

// The greedy-player pacing simulation (kits/tycoon/harness.ts balance()). Slow under the debug
// sanitizers, so it carries the "slow" suite too (see tests/kits/README.md).
TEST_CASE("tycoon example: balance sim: first prestige in 15-45 min, all content within 2 h, no long stalls" *
          doctest::test_suite("slow")) {
  LuauOptions o = tycoon();
  o.base = read_dir(kExample);
  // the sim runs in slices across ticks (each script call has a CPU budget)
  o.until = [](const Json& save) { return save.find("out") != nullptr; };
  LuauRun r = run_luau(R"(local B = require("@kit/tycoon/balance")
local run = B.runner(nil, { hours = 2, dt = 1 })
local done = false
onTick(function()
	if done then return end
	local t0 = os.clock()
	while os.clock() - t0 < 0.05 do
		if run.advance(5) then
			done = true
			save.set("out", run.report())
			return
		end
	end
end))",
                       o);
  REQUIRE_MESSAGE(r.errors.empty(), join(r.errors));
  J rep = r.out();
  REQUIRE(rep.exists());
  MESSAGE("kit-tycoon balance: firstPrestige " << rep["firstPrestige"].num() / 60 << "m, all generators "
                                               << rep["allGeneratorsAt"].num() / 60 << "m, all upgrades "
                                               << rep["allUpgradesAt"].num() / 60 << "m, purchases " << rep["purchases"].num()
                                               << ", gaps max " << rep["gaps"]["max"].num() << "s");
  REQUIRE(rep["firstPrestige"].exists());
  CHECK(rep["firstPrestige"].num() > 15 * 60);
  CHECK(rep["firstPrestige"].num() < 45 * 60);
  CHECK(rep["allGeneratorsAt"].exists());
  CHECK(rep["allUpgradesAt"].num() < 2 * 3600);  // NaN (never) fails too
  CHECK(rep["stalls"].size() == 0);
  CHECK(rep["gaps"]["max"].num() < 180);
}

TEST_CASE("tycoon example: schemas exist for every content kind") {
  for (const char* s : {"tycoon", "generator", "upgrade", "achievement", "event"}) {
    CAPTURE(s);
    Json j = read_json(std::string("kits/tycoon/schemas/") + s + ".json");
    CHECK(matches(J(&j)["$schema"].str(), "json-schema"));
  }
}

}  // TEST_SUITE
