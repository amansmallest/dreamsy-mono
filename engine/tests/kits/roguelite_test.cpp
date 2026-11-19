// roguelite kit: run generation determinism per seed, relic synergy math, room flow, meta unlock
// persistence, daily seed, mid-run save/resume, balance sim, and the example package end-to-end
// (bot, several seeds).
// Port of engine-web/test/kits/roguelite.test.ts (same numbers and thresholds).
#include "kits/kit_test.h"

using namespace dreamsy;
using namespace dreamsy::test;

namespace {

const char* kExample = "games/examples/kit-roguelite";

// Small inline content: 2 classes, 2 biomes, relics with tags + a tiered synergy, events, actives, meta tree.
const std::string kContent = R"lua(
local R = require("@kit/roguelite")
R.setup({ content = {
  classes = {
    knight = { name = "Knight", stats = { hp = 40, damage = 4, fireRate = 1.2 }, relics = { "oath" } },
    witch = { name = "Witch", stats = { hp = 26, damage = 3, fireRate = 2 }, unlock = { skill = "unlock_witch", tree = "meta" }, active = "nova" },
  },
  biomes = {
    moss = { order = 1, name = "Moss", floors = 1, steps = 6, enemies = { "slime", "bat" }, elites = { "brute" }, arena = { kind = "open" } },
    ember = { order = 2, name = "Ember", floors = 2, steps = 7, enemies = { "slime", "imp" }, elites = { "brute" }, boss = "king", arena = { kind = "caves" } },
  },
  enemies = {
    slime = { hp = 5, cost = 1, contact = { amount = 1 } }, bat = { hp = 3, cost = 1, contact = { amount = 1 } },
    imp = { hp = 6, cost = 2, projectile = { amount = 1 }, params = { fireEvery = 1.5 } },
    brute = { hp = 14, cost = 4, contact = { amount = 2 } }, king = { hp = 120, cost = 0, boss = true, dps = 3 },
  },
  relics = {
    oath = { name = "Oath", rarity = "starter", mods = { { stat = "armor", add = 0 } } },
    ember_ring = { name = "Ember Ring", rarity = "common", tags = { "fire" }, stack = true, mods = { { stat = "damage", add = 1 } } },
    coal = { name = "Coal", rarity = "common", tags = { "fire" }, mods = { { stat = "damage", pct = 0.5 } } },
    kindle = { name = "Kindle", rarity = "uncommon", tags = { "fire" }, onHit = { name = "burn", chance = 0.2 } },
    leech = { name = "Leech", rarity = "uncommon", triggers = { { on = "kill", every = 2, effects = { { heal = 1 } } } } },
    purse = { name = "Purse", rarity = "common", mods = { { stat = "goldMult", pct = 0.5 } } },
    heart = { name = "Heart", rarity = "rare", mods = { { stat = "hp", add = 10 } } },
    lucky = { name = "Lucky", rarity = "rare", triggers = { { on = "roomClear", effects = { { gold = 5, raw = true } } } } },
  },
  synergies = {
    blaze = { name = "Blaze", tags = { fire = 0 }, tiers = { { count = 2, mods = { { stat = "damage", mul = 1.2 } } }, { count = 3, mods = { { stat = "fireRate", pct = 0.25 } } } } },
  },
  actives = { nova = { name = "Nova", charge = 2, effects = { { healPct = 0.1 } } }, bomb = { name = "Bomb", charge = 3 } },
  events = {
    shrine = { title = "Shrine", choices = { { text = "Pray (-5 HP)", cost = { hp = 5 }, effects = { { relic = "random" } } }, { text = "Leave" } } },
    fountain = { title = "Fountain", choices = { { text = "Drink", effects = { { healPct = 0.5 } } } } },
  },
  meta = {
    unlock_witch = { name = "Witch", cost = { embers = 30 } },
    vigor = { name = "Vigor", cost = { embers = 10 }, maxRank = 3, mods = { { stat = "hp", add = 5 } } },
  },
}, config = { heat = { { name = "Warm", mods = { { stat = "enemyHp", pct = 0.25 } } }, { name = "Hot", mods = { { stat = "enemyDamage", pct = 0.5 } } } } } })
local out = {}
)lua";

LuauOptions roguelite(LuauOptions o = {}) {
  o.kits = {"roguelite"};
  // Same as the TS test: pure-logic batches (thousands of sims in one callback); the frame budget
  // is wall-clock.
  o.budget_ms = budget(5000);
  return o;
}

// TS lua(): kContent + body, then save `out`; script errors fail the check.
LuauRun lua(const std::string& body, LuauOptions o = {}) {
  LuauRun r = run_luau(kContent + "\n" + body + "\nsave.set(\"out\", out)", roguelite(std::move(o)));
  CHECK_MESSAGE(r.errors.empty(), join(r.errors));
  return r;
}

// TS examplePkg(edit, replaceMain): the example's files with scripts/shared/config.luau edited and
// optionally scripts/client/game.luau replaced.
FileMap example_files(const std::function<std::string(std::string)>& edit, const std::string* main = nullptr) {
  FileMap files = read_dir(kExample);
  files["scripts/shared/config.luau"] = edit(files["scripts/shared/config.luau"]);
  if (main) files["scripts/client/game.luau"] = *main;
  return files;
}

// JS String.replace with a string pattern: the first occurrence only.
std::string replace_first(std::string s, const std::string& from, const std::string& to) {
  size_t at = s.find(from);
  REQUIRE_MESSAGE(at != std::string::npos, "config.luau has no \"" << from << "\"");
  return s.replace(at, from.size(), to);
}

}  // namespace

TEST_SUITE("kit roguelite") {

TEST_CASE("roguelite: run generation is deterministic per seed and follows the floor rules") {
  LuauRun r = lua(R"(
      local function sig(seed)
        local run = R.Run.new({ class = "knight", seed = seed, sim = true })
        local parts = {}
        for f = 1, run:totalFloors() do
          local plan = run:planFloor(f)
          local row = { plan.biome }
          for s, st in plan.steps do
            local ks = {}
            for _, c in st.choices do table.insert(ks, c.type .. ":" .. table.concat(c.enemies or {}, "+") .. ":" .. c.seed) end
            table.insert(row, table.concat(ks, ","))
          end
          table.insert(parts, table.concat(row, "|"))
        end
        return table.concat(parts, "\n"), run
      end
      local a = sig(42)
      local b = sig(42)
      local c = sig(43)
      out.same = a == b
      out.diff = a ~= c
      -- rules over many seeds
      local bad = {}
      for seed = 1, 60 do
        local run = R.Run.new({ class = "knight", seed = seed, sim = true })
        for f = 1, run:totalFloors() do
          local plan = run:planFloor(f)
          local first = plan.steps[1].choices
          if #first ~= 1 or first[1].type ~= "combat" then table.insert(bad, "first " .. seed) end
          local last = plan.steps[#plan.steps].choices[1]
          if f == 3 and last.type ~= "boss" then table.insert(bad, "boss " .. seed) end
          if f == 1 and last.type ~= "elite" then table.insert(bad, "gate " .. seed) end
          local shops = 0
          for s, st in plan.steps do
            for _, ch in st.choices do
              if ch.type == "shop" and s < #plan.steps - 1 then shops += 1 end
              if ch.type == "elite" and s < 3 then table.insert(bad, "early elite " .. seed) end
              if (ch.type == "combat" or ch.type == "elite") and #ch.enemies == 0 then table.insert(bad, "empty " .. seed) end
            end
          end
          if shops > 1 then table.insert(bad, "shops " .. seed) end
          if plan.boss then
            local pre = plan.steps[#plan.steps - 1].choices
            local hasRest = false
            for _, ch in pre do if ch.type == "rest" then hasRest = true end end
            if not hasRest then table.insert(bad, "rest " .. seed) end
          end
        end
      end
      out.bad = table.concat(bad, ";")
      -- arenas: deterministic + spawns
      local run = R.Run.new({ class = "knight", seed = 9, sim = true })
      local room = run:planFloor(2).steps[1].choices[1]
      local l1, l2 = R.arena(room), R.arena(room)
      out.arenaSame = l1.grid:toString() == l2.grid:toString()
      out.spawns = #l1.spawns == #room.enemies
  )");
  J out = r.out();
  CHECK(out["same"].b());
  CHECK(out["diff"].b());
  CHECK(out["bad"].str() == "");
  CHECK(out["arenaSame"].b());
  CHECK(out["spawns"].b());
}

TEST_CASE("roguelite: relic synergy + stacking math") {
  LuauRun r = lua(R"(
      local run = R.Run.new({ class = "knight", seed = 1, sim = true })
      out.base = run:statsNow().damage                     -- 4
      run:addRelic("ember_ring") run:addRelic("ember_ring") -- +1 x2 (stackable), 2 fire tags -> blaze tier 1 (x1.2)
      out.two = run:statsNow().damage                      -- (4+2)*1.2 = 7.2
      run:addRelic("coal")                                  -- +50%, 3 fire -> tier 2 (+25% fireRate)
      local st = run:statsNow()
      out.three = st.damage                                 -- (4+2)*1.5*1.2 = 10.8
      out.rate = st.fireRate                                -- 1.2*1.25 = 1.5
      out.syn = #run:synergies()
      out.tier = run:synergies()[1].tier
      out.hp0 = run.hp
      run:addRelic("heart")
      out.hp1 = run.hp                                      -- +10 hp heals the gained max
      run:addRelic("kindle")
      out.statuses = #run:hitStatuses()
      -- heat mods + meta mods
      local hot = R.Run.new({ class = "knight", seed = 1, heat = 1, sim = true, metaMods = { { stat = "hp", add = 5 } } })
      out.heatHp = hot:statsNow().enemyHp
      out.metaHp = hot:maxHp()
      -- triggers: every = 2
      run:addRelic("leech")
      run.hp = 10
      run:onKill("slime") run:onKill("slime") run:onKill("slime") run:onKill("slime")
      out.leechHp = run.hp
  )");
  J out = r.out();
  CHECK(out["base"].num() == 4);
  CHECK_CLOSE(out["two"].num(), 7.2, 5);
  CHECK_CLOSE(out["three"].num(), 10.8, 5);
  CHECK_CLOSE(out["rate"].num(), 1.5, 5);
  CHECK(out["syn"].num() == 1);
  CHECK(out["tier"].num() == 2);
  CHECK(out["hp1"].num() - out["hp0"].num() == 10);
  CHECK(out["statuses"].num() == 1);
  CHECK_CLOSE(out["heatHp"].num(), 1.25, 5);
  CHECK(out["metaHp"].num() == 45);
  CHECK(out["leechHp"].num() == 12);
}

TEST_CASE("roguelite: room flow: doors -> rooms -> rewards -> floors -> boss -> won; shop/rest/event") {
  LuauRun r = lua(R"(
      local run = R.Run.new({ class = "knight", seed = 5, sim = true })
      run.gold = 500
      local log = {}
      local guard = 0
      local seen = {}
      while run.state ~= "won" and run.state ~= "dead" and guard < 200 do
        guard += 1
        if run.state == "choose" then
          local ch = run:choices()
          local pick = 1
          for i, c in ch do if not seen[c.type] then pick = i end end
          run:enter(pick)
          seen[run.room.type] = true
        elseif run.state == "room" then
          local t = run.room.type
          table.insert(log, t)
          if t == "shop" then
            out.stock = #run.room.stock
            local g = run.gold
            run:buy(1)
            out.paid = g - run.gold
            out.rebuy = select(2, run:buy(1))
            run:clear()
          elseif t == "rest" then run.hp = 5 run:rest("heal") out.rested = run.hp
          elseif t == "event" then out.event = run:eventDef().title run:choose(#run:eventDef().choices)
          else run:clear() end
        elseif run.state == "reward" then
          out.offered = #run.pending
          run:takeRelic(1)
        end
      end
      out.state = run.state
      out.floor = run.floor
      out.seen = seen
      out.rooms = run.stats.rooms
      out.relics = #run.relics
      out.bosses = run.stats.bosses
  )");
  J out = r.out();
  CHECK(out["state"].str() == "won");
  CHECK(out["floor"].num() == 3);
  CHECK(out["rooms"].num() == 20);
  CHECK(out["bosses"].num() == 1);
  CHECK(out["offered"].num() == 3);
  CHECK(out["relics"].num() > 2);
  CHECK((out["seen"]["boss"].truthy() && out["seen"]["elite"].truthy() && out["seen"]["combat"].truthy()));
  if (out["seen"]["shop"].truthy()) {
    CHECK(out["stock"].num() >= 3);
    CHECK(out["paid"].num() > 0);
    CHECK(out["rebuy"].str() == "sold");
  }
  if (out["seen"]["rest"].truthy()) CHECK(out["rested"].num() > 5);
}

TEST_CASE("roguelite: meta unlocks persist across saves; heat unlocks after a win; mid-run resume") {
  LuauRun a = lua(R"(
      core = require("@kit/core")
      out.witchBefore = R.unlocked("witch")
      core.wallet.add("embers", 50)
      local t = R.metaTree()
      out.buy = t:unlock("unlock_witch")
      out.vigor = t:unlock("vigor")
      out.witchAfter = R.unlocked("witch")
      out.embers = core.wallet.get("embers")
      out.heat0 = R.maxHeat("knight")
      local run = R.newRun({ class = "knight", seed = 77 })
      out.metaHp = run:maxHp()
      -- win the run quickly
      while run.state ~= "won" do
        if run.state == "choose" then run:enter(1)
        elseif run.state == "room" then
          local t = run.room.type
          if t == "shop" then run:clear() elseif t == "rest" then run:rest("heal") elseif t == "event" then run:choose(#run:eventDef().choices) else run:clear() end
        elseif run.state == "reward" then run:takeRelic(1) end
      end
      local sum = R.finish(run)
      out.won = sum.won
      out.earned = sum.metaEarned
      out.heat1 = R.maxHeat("knight")
      out.unlockedHeat = sum.unlockedHeat
      -- start another run, play 3 rooms, save mid-run
      local r2 = R.newRun({ class = "witch", seed = 1234, heat = 0 })
      r2:enter(1) r2:clear()
      r2:enter(1)
      out.midStep = r2.step
      out.midRoom = r2.room.type
      out.midGold = r2.gold
      R.save()
  )");
  J ao = a.out();
  CHECK(ao["witchBefore"].is_bool());
  CHECK_FALSE(ao["witchBefore"].b());
  CHECK(ao["buy"].b());
  CHECK(ao["witchAfter"].b());
  CHECK(ao["embers"].num() == 10);
  CHECK(ao["heat0"].num() == 0);
  CHECK(ao["metaHp"].num() == 45);
  CHECK(ao["won"].b());
  CHECK(ao["earned"].num() > 40);
  CHECK(ao["heat1"].num() == 1);
  CHECK(ao["unlockedHeat"].num() == 1);

  LuauOptions o;
  o.save = a.save;  // the same MemorySaveHost
  LuauRun b = lua(R"(
      core = require("@kit/core")
      core.save.load()
      out.witch = R.unlocked("witch")
      out.vigor = R.metaTree():rank("vigor")
      out.heat = R.maxHeat("knight")
      out.has = R.hasSavedRun()
      local run = R.resume()
      out.step = run.step
      out.room = run.room and run.room.type
      out.gold = run.gold
      out.class = run.classId
      out.wins = R.meta.data.wins
  )",
                  o);
  J bo = b.out();
  CHECK(bo["witch"].b());
  CHECK(bo["vigor"].num() == 1);
  CHECK(bo["heat"].num() == 1);
  CHECK(bo["has"].b());
  CHECK(bo["step"].num() == ao["midStep"].num());
  CHECK(bo["room"].str() == ao["midRoom"].str());
  CHECK(bo["gold"].num() == ao["midGold"].num());
  CHECK(bo["class"].str() == "witch");
  CHECK(bo["wins"].num() == 1);
}

TEST_CASE("roguelite: daily seed: same for a calendar day, changes the next day, one record per day") {
  const double day = 20000.0 * 86400;
  const std::string d = std::to_string(static_cast<long long>(day));
  LuauOptions o;
  o.clock = [day] { return day + 3600; };
  LuauRun r = lua(R"(
      local a = R.daily()" + d + R"( + 100)
      local b = R.daily()" + d + R"( + 80000)
      local c = R.daily()" + d + R"( + 86400 + 5)
      out.same = a.seed == b.seed and a.class == b.class
      out.diff = a.seed ~= c.seed
      out.day = a.day
      -- clock.now() default source
      local d = R.daily()
      out.clockDay = d.day
      local run = R.newRun({ daily = true })
      out.dailySeed = run.seed == d.seed
      run:die()
      R.finish(run)
      out.played = R.daily().played
  )",
                  o);
  J out = r.out();
  CHECK(out["same"].b());
  CHECK(out["diff"].b());
  CHECK(out["day"].num() == 20000);
  CHECK(out["clockDay"].num() == 20000);
  CHECK(out["dailySeed"].b());
  CHECK(out["played"].b());
}

TEST_CASE("roguelite: balance sim: deterministic, heat makes it harder" * doctest::test_suite("slow")) {
  LuauOptions o;
  o.steps = 60;
  LuauRun r = lua(R"(
      local ja, jb = R.sim.job({ runs = 30, seed = 3, heats = { 0, 2 } }), R.sim.job({ runs = 30, seed = 3, heats = { 0 } })
      onTick(function()
        ja:step(8) jb:step(8)
        if ja.done and jb.done and not out.a then
          local a, b = ja.result, jb.result
          out.a = a
          out.same = a.knight["0"].winRate == b.knight["0"].winRate and a.knight["0"].avgFloor == b.knight["0"].avgFloor
          save.set("out", out)
        end
      end)
  )",
                  o);
  J out = r.out();
  CHECK(out["same"].b());
  for (const char* cls : {"knight", "witch"}) {
    CAPTURE(cls);
    J r0 = out["a"][cls]["0"], r2 = out["a"][cls]["2"];
    CHECK(r0["avgMinutes"].num() > 0);
    CHECK(r2["winRate"].num() <= r0["winRate"].num());
  }
}

}  // TEST_SUITE

TEST_SUITE("kit roguelite") {

TEST_CASE("roguelite example: bot plays several seeds end-to-end with zero script errors" * doctest::test_suite("slow")) {
  for (int seed : {1, 2, 3, 4}) {
    CAPTURE(seed);
    FileMap files = example_files([&](std::string c) {
      return replace_first(replace_first(c, "bot = false", "bot = true"), "seed = nil", "seed = " + std::to_string(seed));
    });
    script::HostOptions opts;
    opts.seed = static_cast<uint32_t>(seed);
    opts.budget_ms = budget(250);
    Game g = start(files, opts);
    g.step(60 * 90);
    CHECK_NO_ERRORS(g);
    CHECK(g.logs_with("room ").size() >= 4);
  }
}

TEST_CASE("roguelite example: balance sim over the example content (win rate per class/heat, floor, run length)" *
          doctest::test_suite("slow")) {
  const std::string main = R"(
local core = require("@kit/core")
local R = require("@kit/roguelite")
core.setup({ save = { key = "t" } })
R.setup()
local jobs = {}
for _, cls in { "warden", "tinker" } do
  for _, heat in { 0, 1, 2, 3 } do table.insert(jobs, { cls = cls, heat = heat, meta = false }) end
  table.insert(jobs, { cls = cls, heat = 0, meta = true })
end
local full = {}
for _, d in core.content.all("meta") do for _ = 1, d.maxRank or 1 do for _, m in d.mods or {} do table.insert(full, m) end end end
local out = {}
local k = 0
local cur = nil
onTick(function()
  if cur == nil then
    k += 1
    local j = jobs[k]
    if not j then return end
    cur = { j = j, job = R.sim.job({ classes = { j.cls }, heats = { j.heat }, runs = 100, seed = 7, metaMods = if j.meta then full else nil }) }
  end
  if cur.job:step(10) then
    local j = cur.j
    out[j.cls .. "/h" .. j.heat .. (if j.meta then "+meta" else "")] = cur.job.result[j.cls][tostring(j.heat)]
    save.set("out", out)
    cur = nil
  end
end)
)";
  FileMap files = example_files([](std::string c) { return c; }, &main);
  script::HostOptions opts;
  opts.seed = 1;
  opts.budget_ms = budget(250);
  Game g = start(files, opts);
  g.step(200);
  CHECK_NO_ERRORS(g);
  J out = J(&g.save())["out"];
  for (const std::string& k : out.keys())
    MESSAGE("roguelite balance " << k << ": win " << std::lround(out[k]["winRate"].num() * 100) << "% floor "
                                 << out[k]["avgFloor"].num() << " " << out[k]["avgMinutes"].num() << " min");
  REQUIRE(out["warden/h0"].exists());
  CHECK(out["warden/h0"]["winRate"].num() < out["warden/h0+meta"]["winRate"].num() + 1e-9);
  CHECK(out["warden/h3"]["winRate"].num() <= out["warden/h0"]["winRate"].num());
}

}  // TEST_SUITE
