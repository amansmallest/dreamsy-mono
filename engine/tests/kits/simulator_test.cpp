// simulator kit: collect/sell economy, gear tracks, zones, pets + eggs, rebirth, offline earnings,
// core quests, the data schemas, the example package (Pebble Pals) balance sim and a playthrough.
// Port of engine-web/test/kits/simulator.test.ts (same numbers and thresholds).
//
// Most tests run a Luau script that checks itself: check()/eq()/near() print "ok <name>" or
// "FAIL <name> <detail>", and no_fails() asserts there are no FAIL lines and no script errors.
#include <cstdio>
#include <set>

#include "kits/kit_test.h"

using namespace dreamsy;
using namespace dreamsy::test;

namespace {

const char* kExample = "games/examples/kit-simulator";

// A one-script package with the simulator kit (TS kitGame()).
FileMap kit_game(const std::string& script) {
  return {
      {"dreamsy.toml", manifest("\"simulator\"", "scenes/main.scene.json", "portrait")},
      {"scenes/main.scene.json", empty_scene("world")},
      {"scripts/client/main.luau", script},
  };
}

struct Run {
  Game g;
  std::vector<std::string> errs, logs;  // logs without "[validate]" lines
};

// TS run(): load (budget 5000 ms, as in TS: pure-logic batches in one callback), step `steps` times.
// `save` = initial save data, `clock` = clock.now().
Run run(const std::string& script, Json save = Json::object_value(), std::function<double()> clock = {}, int steps = 2) {
  script::HostOptions o;
  o.budget_ms = budget(5000);
  o.save = std::move(save);
  o.clock = std::move(clock);
  Run r{start(kit_game(script), o), {}, {}};
  r.g.step(steps);
  r.errs = r.g.errors();
  for (const std::string& l : r.g.logs())
    if (l.rfind("[validate]", 0) != 0) r.logs.push_back(l);
  return r;
}

// TS noFails(): no script errors, no FAIL line, at least one ok line.
void no_fails(const Run& r) {
  CHECK_MESSAGE(r.errs.empty(), join(r.errs));
  std::vector<std::string> fails;
  int oks = 0;
  for (const std::string& l : r.logs) {
    if (l.rfind("FAIL", 0) == 0) fails.push_back(l);
    if (l.rfind("ok ", 0) == 0) ++oks;
  }
  CHECK_MESSAGE(fails.empty(), join(fails));
  CHECK(oks > 0);
}

// Shared prelude: the check helpers and a small hand-made content set.
const std::string kPre = R"(
local fails = 0
local function check(name, c, extra) if c then print("ok " .. name) else fails += 1 print("FAIL " .. name .. " " .. tostring(extra)) end end
local function eq(name, a, b) check(name, a == b, tostring(a) .. " ~= " .. tostring(b)) end
local function near(name, a, b, tol) check(name, math.abs(a - b) <= (tol or 1e-6), tostring(a) .. " !~ " .. tostring(b)) end
local Sim = require("@kit/simulator")
local core = require("@kit/core")
local CONTENT = {
  config = { petSlots = 2, maxPets = 100000, offline = { rate = 0.5, capHours = 1, minSeconds = 60 },
             rebirth = { threshold = 1000, exponent = 0.5, scale = 1, bonus = 0.5, slotsPerRebirth = 1, maxSlots = 4 } },
  zones = {
    { id = "field", order = 1, name = "Field", nodes = { { id = "pebble", hp = 3, reward = 2, size = 1, weight = 1 } } },
    { id = "cave", order = 2, name = "Cave", unlock = { coins = 100 }, nodes = { { id = "ore", hp = 10, reward = 20, size = 2 } } },
    { id = "peak", order = 3, name = "Peak", unlock = { coins = 50, rebirths = 1 }, nodes = { { id = "gem", hp = 40, reward = 200, size = 2 } } },
  },
  tools = { { id = "stick", order = 1, cost = 0, power = 1, speed = 0 }, { id = "pick", order = 2, cost = 30, power = 3, speed = 2 },
            { id = "drill", order = 3, cost = 400, power = 10, speed = 4, zone = "cave" } },
  backpacks = { { id = "pouch", order = 1, cost = 0, capacity = 10 }, { id = "sack", order = 2, cost = 50, capacity = 40 } },
  pets = { { id = "mouse", rarity = "common", bonus = { power = 0.1 } }, { id = "fox", rarity = "rare", bonus = { coins = 0.5 } },
           { id = "dragon", rarity = "legendary", bonus = { power = 1, coins = 1 } } },
  eggs = { { id = "basic", cost = { coins = 10 }, pets = { mouse = 70, fox = 25, dragon = 5 } } },
}
)";

// "Xm Ys" -> seconds (TS: /maxGap (\d+)m (\d+)s/), 0 when the pattern isn't there.
double max_gap_seconds(const std::string& line) {
  size_t at = line.find("maxGap ");
  if (at == std::string::npos) return 0;
  int m = 0, s = 0;
  if (std::sscanf(line.c_str() + at, "maxGap %dm %ds", &m, &s) != 2) return 0;
  return m * 60.0 + s;
}

}  // namespace

TEST_SUITE("kit simulator") {

// ---------------------------------------------------------------- economy

TEST_CASE("simulator: economy: collect / capacity / sell") {
  no_fails(run(kPre + R"(
      local s = Sim.new(CONTENT)
      eq("start coins", s:coins(), 0) eq("cap", s:capacity(), 10) eq("power", s:power(), 1)
      local n = s:spawnNode()
      local r1 = s:hit(n) local r2 = s:hit(n)
      check("not broken yet", not r2.broken) eq("hp", n.hp, 1)
      local r3 = s:hit(n)
      check("broken", r3.broken) eq("value", r3.value, 2) eq("load", s.load, 1)
      for i = 1, 30 do local m = s:spawnNode() while not s:isFull() and m.hp > 0 do s:hit(m) end end
      eq("full at capacity", s.load, 10) check("isFull", s:isFull())
      local blocked = s:hit(s:spawnNode())
      check("full blocks hits", blocked.full and blocked.damage == 0)
      eq("sell value", s:sellValue(), 20)
      eq("sell pays", s:sell(), 20) eq("coins", s:coins(), 20) eq("bag empty", s.load, 0) eq("run coins", s.runCoins, 20)
      eq("wallet is core.wallet", core.wallet.get("coins"), 20)
      -- partial fit: 2-unit node into 1 free unit gives half value
      s.zones.cave = true s:travel("cave") s.load = 9
      local ore = s:spawnNode() ore.hp = 1
      local r = s:hit(ore) eq("partial units", r.units, 1) eq("partial value", r.value, 10)
  )"));
}

TEST_CASE("simulator: economy: gear tracks: order, costs, zone requirement, equip") {
  no_fails(run(kPre + R"(
      local s = Sim.new(CONTENT)
      local ok, why = s:canBuy("tools", "drill") eq("order", why, "order")
      ok, why = s:canBuy("tools", "pick") eq("coins", why, "coins")
      s:earn(29) check("29 not enough", not s:buy("tools", "pick"))
      s:earn(1) check("buy pick", s:buy("tools", "pick")) eq("paid", s:coins(), 0) eq("equipped newest", s.tool, "pick")
      eq("power", s:power(), 3) eq("speed", s:speed(), 2)
      s:earn(1000) ok, why = s:canBuy("tools", "drill") eq("zone gate", why, "zone")
      check("unlock cave", s:unlockZone("cave")) eq("cave paid", s:coins(), 900) eq("traveled", s.zone, "cave")
      check("buy drill", s:buy("tools", "drill")) eq("next none", s:next("tools"), nil)
      check("equip old", s:equipGear("tools", "stick")) eq("power old", s:power(), 1)
      local g = s:gear("backpacks") eq("gear rows", #g, 2) eq("pouch equipped", g[1].state, "equipped") eq("sack next", g[2].state, "next")
  )"));
}

TEST_CASE("simulator: economy: zones: order, coin + rebirth gates, conditions via core") {
  no_fails(run(kPre + R"(
      local s = Sim.new(CONTENT)
      Sim.bind()
      local ok, why = s:canUnlock("peak") eq("peak order", why, "order")
      s:earn(100) s:unlockZone("cave")
      ok, why = s:canUnlock("peak") eq("peak needs rebirth", why, "rebirths")
      check("core zone condition", core.check({ zone = "cave" })) check("not peak", not core.check({ zone = "peak" }))
      s.runCoins = 1000 s:earn(10)
      eq("rebirth gain", s:rebirthGain(), 1) eq("rebirth", s:rebirth(), 1)
      eq("reset coins", s:coins(), 0) eq("zone reset", s.zone, "field") check("cave relocked", not s.zones.cave)
      s:earn(150) s:unlockZone("cave") check("peak open after rebirth", s:unlockZone("peak"))
      check("rebirths condition", core.check({ rebirths = 1 })) check("prestige condition", core.check({ prestige = 1, layer = "rebirth" }))
      local zl = s:zoneList() eq("zone list states", zl[3].state, "current")
  )"));
}

TEST_CASE("simulator: economy: pets: odds sum to 1 and match the hatch distribution; equip slots + bonuses") {
  no_fails(run(kPre + R"(
      local seed = 1
      local s = Sim.new(CONTENT, { rand = function() seed = (seed * 1103515245 + 12345) % 2147483648 return seed / 2147483648 end, autoEquip = false })
      local odds = s:eggOdds("basic")
      local sum = 0 for _, o in odds do sum += o.chance end
      near("odds sum", sum, 1) eq("sorted", odds[1].pet, "mouse") eq("pct text", odds[3].percent, "5.0%")
      local N = 20000
      s:earn(10 * N)
      for i = 1, N do assert(s:hatch("basic")) end
      eq("coins spent", s:coins(), 0)
      for _, o in odds do
        local got = s.pets[o.pet] / N
        local sd = math.sqrt(o.chance * (1 - o.chance) / N)
        check("dist " .. o.pet, math.abs(got - o.chance) < 4 * sd, got .. " vs " .. o.chance)
      end
      eq("hatched stat", s.stats.hatched, N)
      check("no coins no hatch", s:hatch("basic") == nil)
      s.pets = { mouse = 3, dragon = 1 }
      eq("slots", s:slots(), 2)
      check("equip", s:equip("mouse")) check("equip 2", s:equip("mouse")) check("slots full", not s:equip("dragon"))
      near("power bonus", s:power(), 1.2) s:equipBest()
      eq("best has dragon", s.equipped.dragon, 1) eq("best + mouse", s.equipped.mouse, 1)
      near("coin mult", s:coinMultiplier(), 2) near("power", s:power(), 2.1)
      check("release", s:release("dragon")) eq("unequipped on release", s.equipped.dragon, nil)
  )"));
}

TEST_CASE("simulator: economy: rebirth math: gain, multiplier, slots, keeps pets") {
  no_fails(run(kPre + R"(
      local s = Sim.new(CONTENT)
      s.pets = { fox = 1 } s:equipBest()
      eq("no gain below threshold", s:rebirthGain(), 0) eq("can't", s:rebirth(), 0)
      s.runCoins = 9000
      eq("gain sqrt", s:rebirthGain(), 3) near("next at", s:rebirthNext(), 16000)
      eq("rebirth", s:rebirth(), 3) eq("run reset", s.runCoins, 0)
      near("mult", s:rebirthMultiplier(), 2.5) near("coin mult with fox", s:coinMultiplier(), 1.5 * 2.5)
      eq("slots +1", s:slots(), 3) eq("pets kept", s.pets.fox, 1) eq("count", s.layer.count, 1)
      s.runCoins = 1e9 s:rebirth() s:rebirth() s.runCoins = 1e9 s:rebirth() s.runCoins = 1e9 s:rebirth()
      eq("slots capped", s:slots(), 4)
      -- sell uses the multiplier
      s.carried = 10 eq("sell x mult", s:sellValue(), math.floor(10 * s:coinMultiplier()))
  )"));
}

TEST_CASE("simulator: economy: offline earnings use clock.now, capped + rate; save/restore round trip") {
  double now = 1'800'000'000;
  auto clock = [&now] { return now; };
  const std::string script = kPre + R"(
      local s, off = Sim.start({ content = CONTENT, core = { save = { key = "t", version = 1 } } })
      if save.get("phase") == nil then
        s:earn(30) s:buy("tools", "pick") s:earn(5) s.pets = { fox = 1 } s:equipBest()
        s:touch()
        local rate = s:incomeRate(0)
        -- field: pebble hp 3, power 3 -> 1 hit at 2 hits/s = 0.5s per node, reward 2 -> 4/s x 1.5 (fox)
        near("income", rate, 6)
        eq("no offline when fresh", s:offline(), nil)
        core.save.save()
        save.set("phase", 1)
      else
        check("offline report", off ~= nil)
        eq("offline secs capped", off.seconds, 3600)
        eq("offline coins", off.coins, math.floor(6 * 3600 * 0.5))
        eq("coins restored + offline", s:coins(), 5 + off.coins)
        eq("tool restored", s.tool, "pick") eq("pets restored", s.pets.fox, 1)
      end
  )";
  // The second run relaunches with the first run's save data (TS: a shared MemorySaveHost).
  Run a = run(script, Json::object_value(), clock);
  no_fails(a);
  now += 5 * 3600;
  Run b = run(script, a.g.save(), clock);
  no_fails(b);
}

TEST_CASE("simulator: economy: core quests count simulator events") {
  no_fails(run(kPre + R"(
      local s = Sim.new(CONTENT)
      Sim.bind()
      core.content.register("quests", { id = "first", autoStart = true, steps = { { id = "a", objectives = { { id = "o", event = "sim_collected", count = 3 } } } },
        rewards = { { earn = "coins", amount = 50 }, { pet = "fox" } } })
      core.quests.evaluate()
      for i = 1, 3 do local n = s:spawnNode() while n.hp > 0 do s:hit(n) end end
      eq("quest done", core.quests.status("first"), "done") eq("reward coins", s:coins(), 50) eq("reward pet", s.pets.fox, 1)
  )"));
}

// ---------------------------------------------------------------- schemas

TEST_CASE("simulator: schemas: every example data file has the schema's required keys and no unknown keys") {
  auto check_file = [](const std::string& file, const std::string& schema_name) {
    Json sch_json = read_json("kits/simulator/schemas/" + schema_name + ".json");
    J sch(&sch_json);
    CHECK(matches(sch["$schema"].str(), R"(json-schema)"));
    Json obj_json = read_json(file);
    J obj(&obj_json);
    for (const std::string& k : sch["required"].strs()) CHECK_MESSAGE(obj.has(k), file << " needs " << k);
    for (const std::string& k : obj.keys()) CHECK_MESSAGE(sch["properties"].has(k), file << ": unknown key " << k);
  };
  const std::string example = kExample;
  check_file(example + "/data/simulator.json", "simulator");
  const std::vector<std::pair<std::string, std::string>> areas = {
      {"zones", "zone"}, {"tools", "tool"}, {"backpacks", "backpack"}, {"pets", "pet"}, {"eggs", "egg"}};
  for (const auto& [area, sch] : areas) {
    FileMap files = read_dir(example + "/data/" + area);
    CHECK(files.size() > 0);
    for (const auto& [name, text] : files) check_file(example + "/data/" + area + "/" + name, sch);
  }
}

// ---------------------------------------------------------------- example package

TEST_CASE("simulator: example (Pebble Pals): balance sim: zones unlock in order, first rebirth in range, no dead stretch > 5 min") {
  FileMap files = read_dir(kExample);
  for (auto it = files.begin(); it != files.end();) {
    bool game_script = it->first.rfind("scripts/client/", 0) == 0 || it->first.rfind("scripts/server/", 0) == 0;
    it = game_script ? files.erase(it) : std::next(it);
  }
  files["scenes/main.scene.json"] = empty_scene("world");
  files["scripts/client/bal.luau"] = R"(
      local Sim = require("@kit/simulator")
      local C = Sim.content.load()
      local r = Sim.balance.run(C, { hours = 2 })
      local z = {} for _, e in r.zones do table.insert(z, e.id .. "@" .. Sim.balance.fmt(e.t)) end
      print("zones " .. table.concat(z, ", "))
      print("firstRebirth " .. (if r.firstRebirth then Sim.balance.fmt(r.firstRebirth) else "none") .. " rebirths " .. #r.rebirths)
      print("gear " .. #r.gear .. " eggs " .. r.eggs .. " maxGap " .. Sim.balance.fmt(r.gaps.max) .. " at " .. Sim.balance.fmt(r.gaps.at) .. " median " .. Sim.balance.fmt(r.gaps.median))
      print("final mult " .. string.format("%.2f", r.final.mult) .. " pets " .. r.final.pets)
      save.set("rep", { ok = r.ok, stalls = #r.stalls, zones = #r.zones, first = r.firstRebirth or -1, maxGap = r.gaps.max, zt = (function() local t = {} for _, e in r.zones do table.insert(t, e.t) end return t end)() })
  )";
  script::HostOptions o;
  o.budget_ms = budget(250);  // TS default; scaled for the sanitizer build
  Game g = start(files, o);
  g.step();
  CHECK_NO_ERRORS(g);
  MESSAGE(g.log_text());
  std::vector<std::string> zones = g.logs_with("zones ");
  REQUIRE(zones.size() == 1);
  // distinct zone ids in "id@time, id@time, ..."
  std::set<std::string> ids;
  std::string rest = zones[0];
  while (!rest.empty()) {
    size_t comma = rest.find(", ");
    std::string part = rest.substr(0, comma);
    ids.insert(part.substr(0, part.find('@')));
    rest = comma == std::string::npos ? "" : rest.substr(comma + 2);
  }
  CHECK(ids.size() == 4);
  std::vector<std::string> first = g.logs_with("firstRebirth ");
  REQUIRE(first.size() == 1);
  CHECK_FALSE(contains(first[0], "none"));
  std::vector<std::string> gear = g.logs_with("gear ");
  REQUIRE(gear.size() == 1);
  CHECK(max_gap_seconds(gear[0]) <= 5 * 60);
}

TEST_CASE("simulator: example (Pebble Pals): plays end-to-end headless with zero script errors (tap, sell, shop, eggs, pets, zones)") {
  std::vector<TimelineStep> tl;
  auto tap = [&tl](double t, double x, double y) {
    TimelineStep s;
    s.t = t;
    s.tap = std::make_pair(x, y);
    tl.push_back(s);
  };
  for (int i = 0; i < 60; ++i) tap(1 + i * 0.25, 140 + (i % 3) * 220, 420 + ((i % 6) / 3) * 220);
  tap(17, 110, 1150);  // sell
  tap(18, 290, 1150);  // shop
  tap(19, 360, 1200);  // close
  tap(20, 430, 1150);  // pets
  tap(21, 360, 1200);
  tap(22, 570, 1150);  // more
  tap(23, 360, 1200);
  PlaytestReport r = simulate(read_dir(kExample), tl, 40);
  CHECK_MESSAGE(r.errors.empty(), join(r.errors));
}

}  // TEST_SUITE
