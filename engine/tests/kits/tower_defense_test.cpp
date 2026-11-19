// tower-defense kit: headless tests of the Luau sim (pathing, targeting, damage, waves, economy,
// upgrades, campaign), the example package (boots, taps build a tower, content read from data/**) and
// the balance sim. Port of engine-web/test/kits/tower-defense.test.ts (same numbers and thresholds),
// including the bits of kits/tower-defense/harness.ts it uses (runLuau, balance, validateContent).
#include <algorithm>
#include <cmath>
#include <regex>

#include "kits/kit_test.h"
#include "pkg/json.h"

using namespace dreamsy;
using namespace dreamsy::test;

namespace {

const char* kExample = "games/examples/kit-tower-defense";

// Small inline content for unit tests (tile units; map is a straight corridor along row 1, 10 tiles long).
const std::string kContent = R"(
local C = {
	enemies = {
		grunt = { hp = 100, speed = 1, bounty = 5 },
		tank = { hp = 300, speed = 0.5, armor = 10, resist = { fire = 0.5, magic = -0.5 }, bounty = 20, lives = 3 },
		bat = { hp = 50, speed = 2, flying = true, bounty = 4 },
		blob = { hp = 40, speed = 1, split = { into = "bit", count = 3 }, bounty = 2 },
		bit = { hp = 10, speed = 1, bounty = 1 },
		medic = { hp = 100, speed = 1, heal = { amount = 20, radius = 2, interval = 1 }, bounty = 5 },
		boss = { hp = 2000, speed = 0.4, boss = true, lives = 10, bounty = 100, immune = { "slow" } },
	},
	towers = {
		arrow = { cost = 50, range = 3, rate = 2, damage = 10, damage_type = "physical", air = true,
			upgrades = { { name = "u1", cost = 40, add = { damage = 5 } }, { name = "u2", cost = 60, add = { range = 1 } } },
			branches = {
				{ id = "a", name = "Sniper", tiers = { { cost = 100, mul = { damage = 3 }, set = { armor_pierce = 10 } }, { cost = 150, mul = { damage = 2 } } } },
				{ id = "b", name = "Rapid", tiers = { { cost = 90, mul = { rate = 2 } } } },
			} },
		bomb = { cost = 80, range = 3, rate = 1, damage = 40, damage_type = "explosive", splash = { radius = 1, falloff = 0.5 } },
		ice = { cost = 60, range = 3, rate = 1, damage = 1, damage_type = "magic", slow = { factor = 0.5, duration = 2 } },
		zap = { cost = 90, range = 3, rate = 1, damage = 30, damage_type = "lightning", chain = { count = 2, range = 2, falloff = 0.5 } },
		fire = { cost = 70, range = 3, rate = 1, damage = 1, damage_type = "fire", dot = { dps = 10, duration = 2 } },
		drum = { cost = 90, range = 2, rate = 0, damage = 0, aura = { range = 2, damage = 0.5, rate = 0.25 } },
		bank = { cost = 100, damage = 0, rate = 0, income = 30 },
	},
	waves = {
		w = { scaling = { hp = 0.1 }, waves = {
			{ groups = { { enemy = "grunt", count = 3, interval = 1 } }, bonus = 10 },
			{ groups = { { enemy = "grunt", count = 2, interval = 0.5, delay = 2 }, { enemy = "bat", count = 1 } }, bonus = 20 },
		}, endless = { pool = { "grunt", "bat" }, boss = "boss", boss_every = 3, hp_growth = 1.1, count_base = 4, count_growth = 1 } },
	},
	levels = {
		lane = { name = "Lane", map = { grid = "S.........E\n.oooooooooo", legend = { path = "#.", spawns = "S", exits = "E", build = "o" } },
			waves = "w", money = 500, lives = 20, interest = { rate = 0.1, cap = 15 }, sell_ratio = 0.5, between = 5, early_bonus = 2 },
		way = { name = "Way", paths = { { id = "p", points = { { 0, 0 }, { 4, 0 }, { 4, 3 } } } }, build_spots = { { 1, 1 } }, waves = "w" },
	},
	campaign = {
		start_towers = { "arrow" }, locked_branches = { "arrow.b" }, stars = { two = 0.5, three = 0.9 },
		levels = {
			{ level = "lane", unlock = { towers = { "bomb" }, branches = { "arrow.b" } } },
			{ level = "way", requires_stars = 2, unlock = { towers = { "ice" } } },
		},
		endless = { level = "lane", waves = "w" },
	},
}
)";

// The kit harness's runLuau: manifest kits = ["tower-defense"] and a 120 s CPU budget (harness.ts
// budgetMs default; the sims run whole levels in one call).
LuauOptions td(LuauOptions o = {}) {
  o.kits = {"tower-defense"};
  o.budget_ms = budget(120000);
  return o;
}

// TS lua(): the snippet runs with TD, C and an `out` table it saves at the end.
LuauRun lua(const std::string& body) {
  LuauRun r = run_luau("local TD = require(\"@kit/tower-defense\")\n" + kContent + "\nlocal out = {}\n" + body +
                           "\nsave.set(\"out\", out)",
                       td());
  CHECK_MESSAGE(r.errors.empty(), join(r.errors));
  return r;
}

// The example package as a run_luau base. Its scenes attach the game's client scripts, which run_luau
// drops (only the test script runs); the C++ validator rejects a scene whose script is missing
// (engine-web loaded it anyway), so the scenes go too: these runs only read data/** and kit modules.
FileMap example_base() {
  FileMap files = read_dir(kExample);
  for (auto it = files.begin(); it != files.end();) it = it->first.rfind("scenes/", 0) == 0 ? files.erase(it) : std::next(it);
  return files;
}

// ---- harness.ts validateContent(): data/** files against kits/tower-defense/schemas/*.json

struct SchemaOf {
  const char* pattern;  // regex over the package path
  const char* schema;   // kits/tower-defense/schemas/<schema>.schema.json
};
const SchemaOf kSchemaOf[] = {
    {R"(^data/enemies/[^/]+\.json$)", "enemy"},
    {R"(^data/towers/[^/]+\.json$)", "tower"},
    {R"(^data/waves/[^/]+\.json$)", "waves"},
    {R"(^data/levels/[^/]+\.json$)", "level"},
    {R"(^data/campaign\.json$)", "campaign"},
};

// Issues as "file: path: message" (empty = valid).
std::vector<std::string> validate_content(const FileMap& pkg) {
  std::vector<std::string> out;
  std::map<std::string, Json> cache;  // schema name -> schema
  for (const std::string& path : paths_with(pkg, "data/")) {
    const SchemaOf* hit = nullptr;
    for (const SchemaOf& s : kSchemaOf)
      if (std::regex_search(path, std::regex(s.pattern))) hit = &s;
    if (!hit) continue;
    auto doc = pkg::JsonDoc::parse(pkg.at(path));
    if (!doc.ok()) {
      out.push_back(path + ": invalid JSON (" + doc.error() + ")");
      continue;
    }
    if (!cache.count(hit->schema))
      cache[hit->schema] = read_json(std::string("kits/tower-defense/schemas/") + hit->schema + ".schema.json");
    Json value = Json::from_yyjson(doc.value().root());
    for (const std::string& issue : schema_check(value, cache[hit->schema])) out.push_back(path + ": " + issue);
  }
  return out;
}

// The first entity of `type` whose `text` matches `pattern` (null id when none).
world::EntityId find_text(const Game& g, std::string_view type, const std::string& pattern) {
  for (world::EntityId e : g.of_type(type))
    if (matches(g.host->world().str(*g.host->world().get(e), "text"), pattern)) return e;
  return {};
}

}  // namespace

TEST_SUITE("kit tower-defense") {

// ---------------------------------------------------------------- paths

TEST_CASE("tower-defense: paths: traces a grid path from spawn to exit, extends through map edges, measures length") {
  LuauRun r = lua(R"(
      local lay = TD.Content.layout(TD.content(C), "lane")
      local p = lay.paths.S
      out.ids = lay.pathIds
      out.len = p.length
      out.first = { p.points[1].x, p.points[1].y }
      out.last = { p.points[#p.points].x, p.points[#p.points].y }
      out.build = #lay.build
      local x, y = p:at(5.5)
      out.at = { x, y }
      local w = TD.Content.layout(TD.content(C), "way").paths.p
      out.wlen = w.length
      local wx, wy = w:at(5)
      out.wat = { wx, wy }
  )");
  J o = r.out();
  CHECK(o["ids"].dump() == R"(["S"])");
  CHECK(o["first"].dump() == "[-0.5,0.5]");  // walks in from the left edge
  CHECK(o["last"].dump() == "[10.5,0.5]");   // and stops at the exit tile's center
  CHECK_CLOSE(o["len"].num(), 11, 6);
  CHECK(o["at"].dump() == "[5,0.5]");
  CHECK(o["build"].num() == 10);
  CHECK(o["wlen"].num() == 7);
  CHECK(o["wat"].dump() == "[4,1]");
}

TEST_CASE("tower-defense: paths: finds multiple spawns + shortest routes and rejects a spawn with no exit") {
  LuauRun r = lua(R"(
      local grid = "S#####.\n.o..o#.\nT####E."
      local lay = TD.Path.fromGrid(grid, { path = "#", spawns = "ST", exits = "E", build = "o" })
      out.ids = lay.pathIds
      out.s = lay.paths.S.length
      out.t = lay.paths.T.length
      out.pts = #lay.paths.S.points
      local ok, err = pcall(TD.Path.fromGrid, "S#..E", nil)
      out.err = tostring(err)
  )");
  J o = r.out();
  CHECK(o["ids"].dump() == R"(["S","T"])");
  CHECK_CLOSE(o["s"].num(), 8, 6);  // (-0.5,.5)->(5.5,.5)->(5.5,2.5): in from the left edge, ends on E
  CHECK_CLOSE(o["t"].num(), 6, 6);  // (-0.5,2.5)->(5.5,2.5)
  CHECK(matches(o["err"].str(), "no walkable route"));
}

// ---------------------------------------------------------------- targeting + damage

TEST_CASE("tower-defense: targeting + damage: first / last / strong / close pick the right enemy") {
  LuauRun r = lua(R"(
      local sim = TD.Sim.new(C, "lane")
      local t = sim:build("arrow", 5, 1)
      local a = sim:spawnEnemy("grunt", "S", { dist = 3.5 })  -- x 3
      local b = sim:spawnEnemy("tank", "S", { dist = 6 })   -- x 5.5 (closest to tower at 5.5)
      local c = sim:spawnEnemy("grunt", "S", { dist = 8 })  -- x 7.5, furthest along
      c.hp = 50
      for _, m in { "first", "last", "strong", "close" } do
        sim:setTargeting(t, m)
        out[m] = sim:pickTarget(t).uid - a.uid
      end
      out.cycle = sim:cycleTargeting(t)
  )");
  J o = r.out();
  CHECK(o["first"].num() == 2);
  CHECK(o["last"].num() == 0);
  CHECK(o["strong"].num() == 1);
  CHECK(o["close"].num() == 1);
  CHECK(o["cycle"].str() == "first");
}

TEST_CASE("tower-defense: targeting + damage: applies armor (flat, min 20%), resistances, weaknesses, armor pierce and magic/true bypass") {
  LuauRun r = lua(R"(
      local sim = TD.Sim.new(C, "lane")
      local e = sim:spawnEnemy("tank", "S")
      out.phys = sim:damage(e, 30, "physical")       -- 30 - 10
      out.small = sim:damage(e, 5, "physical")       -- min 20% = 1
      out.fire = sim:damage(e, 30, "fire")           -- (30-10) * 0.5
      out.magic = sim:damage(e, 30, "magic")         -- no armor, -50% res -> 45
      out.tru = sim:damage(e, 30, "true")
      local t = sim:build("arrow", 5, 1)
      t.up = { common = 2, branch = "a", tier = 1 }
      t.base = TD.Content.towerStats(t.def, t.up)
      t.stats = t.base
      out.pierce = sim:damage(e, 30, "physical", t) -- armor pierced
      sim.hooks.damage = function(s, tw, en, d, kind) return d * 2 end
      out.hook = sim:damage(e, 10, "true")
  )");
  J o = r.out();
  CHECK(o["phys"].num() == 20);
  CHECK(o["small"].num() == 1);
  CHECK(o["fire"].num() == 10);
  CHECK(o["magic"].num() == 45);
  CHECK(o["tru"].num() == 30);
  CHECK(o["pierce"].num() == 30);
  CHECK(o["hook"].num() == 20);
}

TEST_CASE("tower-defense: targeting + damage: splash, slow, chain, DOT, aura, flying, split and heal behave") {
  LuauRun r = lua(R"(
      local sim = TD.Sim.new(C, "lane")
      -- splash: two grunts 0.5 apart, bomb hits the first
      local bomb = sim:build("bomb", 3, 1)
      local g1 = sim:spawnEnemy("grunt", "S", { dist = 4 })
      local g2 = sim:spawnEnemy("grunt", "S", { dist = 4.5 })
      sim:tick(1/30)
      out.splash = { g1.hp, g2.hp }
      sim:sell(bomb)
      for _, e in sim:enemyList() do e.alive = false sim.enemies[e.uid] = nil end
      -- slow
      local ice = sim:build("ice", 3, 1)
      local s1 = sim:spawnEnemy("grunt", "S", { dist = 3 })
      sim:tick(1/30)
      out.slow = s1.slow
      local d0 = s1.dist sim:tick(1) out.slowMove = s1.dist - d0
      local b1 = sim:spawnEnemy("boss", "S", { dist = 3 })
      sim:tick(1/30) sim:tick(1)
      out.bossSlow = b1.slow
      sim:sell(ice)
      for _, e in sim:enemyList() do e.alive = false sim.enemies[e.uid] = nil end
      -- chain: 3 grunts in a row 1 apart -> 30, 15, 7.5
      local zap = sim:build("zap", 5, 1)
      local c1 = sim:spawnEnemy("grunt", "S", { dist = 6 })
      local c2 = sim:spawnEnemy("grunt", "S", { dist = 7 })
      local c3 = sim:spawnEnemy("grunt", "S", { dist = 8 })
      sim:tick(1/30)
      out.chain = { c3.hp, c2.hp, c1.hp }
      sim:sell(zap)
      for _, e in sim:enemyList() do e.alive = false sim.enemies[e.uid] = nil end
      -- dot: 1 hit + 10 dps for 2s
      local fire = sim:build("fire", 2, 1)
      local f1 = sim:spawnEnemy("boss", "S", { dist = 1.5 })
      f1.def = table.clone(f1.def) f1.def.speed = 0
      sim:tick(1/30)
      local hp1 = f1.hp
      sim:sell(fire)
      for i = 1, 90 do sim:tick(1/30) end
      out.dot = hp1 - f1.hp
      for _, e in sim:enemyList() do e.alive = false sim.enemies[e.uid] = nil end
      -- aura: drum next to arrow
      local ar = sim:build("arrow", 6, 1)
      sim:build("drum", 7, 1)
      sim:tick(1/30)
      out.aura = { ar.stats.damage, ar.stats.rate, ar.stats.buffed }
      -- flying: ground-only bomb can't hit bats
      local bat = sim:spawnEnemy("bat", "S", { dist = 1 })
      local b2 = sim:build("bomb", 4, 1)
      out.batTarget = sim:pickTarget(b2, b2.base) == nil
      out.batArrow = sim:pickTarget(ar, ar.stats) == bat or sim:pickTarget(ar, ar.stats) ~= nil
      out.batPath = bat.path.length
      for _, e in sim:enemyList() do e.alive = false sim.enemies[e.uid] = nil end
      -- split
      local blob = sim:spawnEnemy("blob", "S", { dist = 2 })
      sim:damage(blob, 999, "true")
      local bits = 0
      for _, e in sim.enemies do if e.id == "bit" then bits += 1 end end
      out.bits = bits
      for _, e in sim:enemyList() do e.alive = false sim.enemies[e.uid] = nil end
      -- heal
      local med = sim:spawnEnemy("medic", "S", { dist = 0 })
      local hurt = sim:spawnEnemy("grunt", "S", { dist = 0.5 })
      med.def = table.clone(med.def) med.def.speed = 0
      hurt.def = table.clone(hurt.def) hurt.def.speed = 0
      hurt.hp = 50
      for _, t in sim:towerList() do sim:sell(t) end
      for i = 1, 31 do sim:tick(1/30) end
      out.heal = hurt.hp
  )");
  J o = r.out();
  CHECK(o["splash"][1].num() == 60);       // "first" targets g2 (further along): 100 - 40
  CHECK_CLOSE(o["splash"][0].num(), 70, 5);  // g1 0.5 tiles away: 40 * (1 - 0.5 * 0.5)
  CHECK(o["slow"].num() == 0.5);
  CHECK_CLOSE(o["slowMove"].num(), 0.5, 1);
  CHECK(o["bossSlow"].num() == 1);  // immune
  CHECK(o["chain"].dump() == "[70,85,92.5]");
  CHECK(o["dot"].num() > 17);  // ~20 over 2s
  CHECK(o["dot"].num() <= 20.01);
  CHECK(o["aura"].dump() == "[15,2.5,true]");
  CHECK(o["batTarget"].b());
  CHECK_CLOSE(o["batPath"].num(), 11, 5);  // flies the straight line
  CHECK(o["bits"].num() == 3);
  CHECK(o["heal"].num() == 70);
}

// ---------------------------------------------------------------- waves + economy

TEST_CASE("tower-defense: waves + economy: spawns on schedule, scales hp, pays bounties/bonus/interest/early-call, auto-starts after the countdown") {
  LuauRun r = lua(R"(
      local sim = TD.Sim.new(C, "lane", { towers = { "arrow" } })
      out.sched = {}
      for _, s in TD.Content.waveSchedule(sim.C, sim.waveSet, 2, sim.layout.pathIds, false) do
        table.insert(out.sched, { s.t, s.enemy, s.hpMult })
      end
      local spawns = {}
      sim:on("enemySpawned", function(e) table.insert(spawns, math.floor(sim.time * 30 + 0.5)) end)
      local cleared = {}
      sim:on("waveCleared", function(w, b) table.insert(cleared, { w, b }) end)
      sim:startWave()
      out.state = sim.state
      for i = 1, 75 do sim:tick(1/30) end
      out.spawns = table.clone(spawns)
      -- kill everything: bounty 5 each
      local m0 = sim.money
      for _, e in sim:enemyList() do sim:damage(e, 999, "true") end
      out.bounty = sim.money - m0 - 10  -- minus wave bonus
      out.cleared = table.clone(cleared)
      sim:tick(1/30)
      out.countdown = sim.countdown
      -- call early with ~4.97 s left: early bonus floor(2*4.97)=9, then interest 10% capped 15
      local m1 = sim.money
      sim:startWave()
      out.early = sim.money - m1
      out.wave = sim.wave
      -- second wave: auto flow to the end
      local guard = 0
      while sim.state ~= "won" and guard < 3000 do
        for _, e in sim:enemyList() do sim:damage(e, 999, "true") end
        sim:tick(1/30) guard += 1
      end
      out.final = sim.state
      out.stars = sim:result().stars
  )");
  J o = r.out();
  CHECK(o["sched"].dump() == R"([[0,"bat",1.1],[2,"grunt",1.1],[2.5,"grunt",1.1]])");
  CHECK(o["state"].str() == "running");
  CHECK(o["spawns"][0].num() == 1);
  CHECK(o["spawns"][1].num() == 31);
  CHECK(o["spawns"][2].num() >= 60);  // t = 2 s (float sum of ticks may land on 60 or 61)
  CHECK(o["spawns"][2].num() <= 61);
  CHECK(o["bounty"].num() == 15);
  CHECK(o["cleared"].dump() == "[[1,10]]");
  CHECK_CLOSE(o["countdown"].num(), 5 - 1.0 / 30, 5);
  CHECK(o["early"].num() == 9 + 15);
  CHECK(o["wave"].num() == 2);
  CHECK(o["final"].str() == "won");
  CHECK(o["stars"].num() == 3);
}

TEST_CASE("tower-defense: waves + economy: auto-starts the next wave after `between` seconds; leaks cost lives; losing ends the level") {
  LuauRun r = lua(R"(
      local sim = TD.Sim.new(C, "lane")
      sim:startWave()
      local lost = nil
      sim:on("levelLost", function(r) lost = r end)
      local waves = {}
      sim:on("waveStarted", function(n) table.insert(waves, math.floor(sim.time + 0.5)) end)
      for i = 1, 30 * 40 do sim:tick(1/30) end
      out.waves = waves
      out.lives = sim.lives
      out.leaked = sim.stats.leaked
      local sim2 = TD.Sim.new(C, "lane")
      sim2:on("levelLost", function(r) lost = r end)
      sim2.lives = 3
      sim2:spawnEnemy("tank", "S", { dist = 11.99 }) -- leaks 3 lives next tick
      sim2:tick(1/30)
      out.state = sim2.state
      out.lost = lost and lost.lost
  )");
  J o = r.out();
  // wave 1 spawns 0..2 s, grunts leak at ~12-14 s, countdown 5 s -> wave 2 at ~19 s
  CHECK(o["waves"][0].num() >= 18);
  CHECK(o["waves"][0].num() <= 20);
  CHECK(o["leaked"].num() == 6);
  CHECK(o["lives"].num() == 14);
  CHECK(o["state"].str() == "lost");
  CHECK(o["lost"].b());
}

TEST_CASE("tower-defense: waves + economy: build / sell refunds / canBuild reasons / speed-up") {
  LuauRun r = lua(R"(
      local sim = TD.Sim.new(C, "lane", { towers = { "arrow" } })
      out.tile = select(2, sim:canBuild("arrow", 0, 0))
      out.locked = select(2, sim:canBuild("bomb", 1, 1))
      local t = sim:build("arrow", 1, 1)
      out.occupied = select(2, sim:canBuild("arrow", 1, 1))
      sim:upgrade(t)
      out.sellValue = sim:sellValue(t) -- (50+40) * 0.5
      local m = sim.money
      sim:sell(t)
      out.refund = sim.money - m
      sim.money = 10
      out.money = select(2, sim:canBuild("arrow", 2, 1))
      sim:setSpeed(3)
      out.ticks = sim:step(0.5)
  )");
  J o = r.out();
  CHECK(o["tile"].str() == "tile");
  CHECK(o["locked"].str() == "locked");
  CHECK(o["occupied"].str() == "occupied");
  CHECK(o["sellValue"].num() == 45);
  CHECK(o["refund"].num() == 45);
  CHECK(o["money"].str() == "money");
  CHECK(o["ticks"].num() == 45);
}

// ---------------------------------------------------------------- upgrade trees

TEST_CASE("tower-defense: upgrade trees: common tiers first, then one branch; locked branches blocked; stats follow the tree") {
  LuauRun r = lua(R"(
      local sim = TD.Sim.new(C, "lane", { lockedBranches = { "arrow.b" } })
      local t = sim:build("arrow", 1, 1)
      local function names() local n = {} for _, x in sim:upgradeOptions(t) do table.insert(n, x.kind .. (x.branch or "") .. x.tier .. (if x.locked then "L" else "")) end return table.concat(n, ",") end
      out.o0 = names()
      out.ch = select(2, sim:upgrade(t, "a"))
      sim:upgrade(t) sim:upgrade(t)
      out.o2 = names()
      out.choose = select(2, sim:upgrade(t))
      out.lockedB = select(2, sim:upgrade(t, "b"))
      out.okA = sim:upgrade(t, "a")
      out.o3 = names()
      sim:upgrade(t, "a")
      out.max = select(2, sim:upgrade(t, "a"))
      out.stats = { t.base.damage, t.base.range, t.base.armor_pierce }
      out.spent = t.spent
      local def = sim.C.towers.arrow
      out.rapid = TD.Content.towerStats(def, { common = 2, branch = "b", tier = 1 }).rate
  )");
  J o = r.out();
  CHECK(o["o0"].str() == "common1");
  CHECK(o["o2"].str() == "brancha1,branchb1L");
  CHECK(o["choose"].str() == "choose");
  CHECK(o["lockedB"].str() == "locked");
  CHECK(o["okA"].b());
  CHECK(o["o3"].str() == "brancha2");
  CHECK(o["max"].str() == "max");
  CHECK(o["stats"].dump() == "[90,4,10]");  // (10+5)*3*2, 3+1
  CHECK(o["spent"].num() == 50 + 40 + 60 + 100 + 150);
  CHECK(o["rapid"].num() == 4);
}

// ---------------------------------------------------------------- campaign, endless, save

TEST_CASE("tower-defense: campaign, endless, save: unlocks levels/towers/branches by clears + stars and round-trips through save") {
  LuauRun r = lua(R"(
      local camp = TD.Campaign.new(C)
      out.start = camp:unlockedTowers()
      out.l2 = camp:isUnlocked("way")
      local r = camp:complete({ level = "lane", won = true, stars = 1, lives = 5 })
      out.newTowers = r.unlocked.towers
      out.newBranches = r.unlocked.branches
      out.l2b = camp:isUnlocked("way") -- needs 2 stars
      camp:complete({ level = "lane", won = true, stars = 3, lives = 19 })
      out.l2c = camp:isUnlocked("way")
      out.opts = camp:simOptions("way").lockedBranches
      out.endless = camp:endlessUnlocked()
      camp:complete({ level = "way", won = true, stars = 2, lives = 10 })
      out.endless2 = camp:endlessUnlocked()
      camp:save()
      local back = TD.Campaign.load(C)
      out.reload = { back:stars("lane"), back:stars("way"), back:totalStars() }
      local e = back:complete({ level = "lane", endless = true, lost = true, wave = 12 })
      out.endlessBest = { e.wavesSurvived, back:endlessBest() }
      out.saved = save.get("td_progress").levels.lane.stars
  )");
  J o = r.out();
  CHECK(o["start"].dump() == R"(["arrow"])");
  CHECK(o["l2"].is_bool());
  CHECK_FALSE(o["l2"].b());
  CHECK(o["newTowers"].dump() == R"(["bomb"])");
  CHECK(o["newBranches"].dump() == R"(["arrow.b"])");
  CHECK(o["l2b"].is_bool());
  CHECK_FALSE(o["l2b"].b());
  CHECK(o["l2c"].b());
  CHECK(o["opts"].size() == 0);  // nothing locked any more
  CHECK(o["endless"].is_bool());
  CHECK_FALSE(o["endless"].b());
  CHECK(o["endless2"].b());
  CHECK(o["reload"].dump() == "[3,2,5]");
  CHECK(o["endlessBest"].dump() == "[11,11]");
  CHECK(o["saved"].num() == 3);
}

TEST_CASE("tower-defense: campaign, endless, save: endless generates growing waves with a boss every N; snapshot/restore between waves") {
  LuauRun r = lua(R"(
      local sim = TD.Sim.new(C, "lane", { endless = true })
      local counts, bosses = {}, {}
      for n = 1, 6 do
        local s = TD.Content.waveSchedule(sim.C, sim.waveSet, n, sim.layout.pathIds, true)
        table.insert(counts, #s)
        local b = 0 for _, x in s do if x.enemy == "boss" then b += 1 end end
        table.insert(bosses, b)
      end
      out.counts = counts
      out.bosses = bosses
      local h3 = TD.Content.waveSchedule(sim.C, sim.waveSet, 3, sim.layout.pathIds, true)[1].hpMult
      local h4 = TD.Content.waveSchedule(sim.C, sim.waveSet, 4, sim.layout.pathIds, true)[1].hpMult
      out.hp = { h3, h4 }
      local t = sim:build("arrow", 3, 1)
      sim:upgrade(t)
      sim:setTargeting(t, "strong")
      out.mid = sim:snapshot() ~= nil
      local snap = sim:snapshot()
      local r = TD.Sim.restore(C, snap)
      local t2 = r:towerAtCell(3, 1)
      out.restored = { r.money == sim.money, t2.up.common, t2.targeting, t2.spent }
      sim:startWave() sim:tick(1/30)
      out.busy = sim:snapshot() == nil
  )");
  J o = r.out();
  CHECK(o["counts"][0].num() == 3);  // scripted waves (3 grunts; 2 grunts + bat)
  CHECK(o["counts"][1].num() == 3);
  CHECK(o["counts"][2].num() == 4);  // endless k=1: count_base 4; boss_every counts endless waves (k=3 -> n=5)
  CHECK(o["bosses"].dump() == "[0,0,0,0,1,0]");
  CHECK(o["hp"][1].num() > o["hp"][0].num());
  CHECK(o["restored"].dump() == R"([true,1,"strong",90])");
  CHECK(o["busy"].b());
}

// ---------------------------------------------------------------- example package

TEST_CASE("tower-defense example: TD.content() reads data/**/*.json through the engine data reader") {
  LuauOptions opts = td();
  opts.base = example_base();
  LuauRun r = run_luau(R"(
      local TD = require("@kit/tower-defense")
      local C = TD.content()
      local n = function(t) local k = 0 for _ in t do k += 1 end return k end
      save.set("out", { enemies = n(C.enemies), towers = n(C.towers), waves = n(C.waves), levels = n(C.levels),
        campaign = #C.campaign.levels, cached = TD.content() == C, grid = #TD.Path.rows(C.levels.meadow.map.grid),
        thorn = C.towers.thorn.cost, paths = TD.Content.layout(C, "meadow").pathIds })
  )",
                       opts);
  CHECK_MESSAGE(r.errors.empty(), join(r.errors));
  J out = r.out();
  CHECK(out["enemies"].num() == 8);
  CHECK(out["towers"].num() == 5);
  CHECK(out["waves"].num() == 4);
  CHECK(out["levels"].num() == 3);
  CHECK(out["campaign"].num() == 3);
  CHECK(out["cached"].b());
  CHECK(out["grid"].num() == 15);
  CHECK(out["thorn"].num() == 50);
  CHECK(out["paths"].size() > 0);
}

TEST_CASE("tower-defense example: content validates against the kit schemas (and the validator catches mistakes)") {
  FileMap pkg = read_dir(kExample);
  std::vector<std::string> ok = validate_content(pkg);
  CHECK_MESSAGE(ok.empty(), join(ok));
  pkg["data/towers/oops.json"] = R"({"cost":"cheap","rnage":2,"targeting":"random","branches":[{},{},{}]})";
  std::string issues = join(validate_content(pkg));
  CAPTURE(issues);
  // The messages are schema_check's wording (kit_test.cpp); the TS harness words them
  // `expected number`, `unknown key "rnage"`, `targeting: must be one of`, `at most 2 items`.
  CHECK(matches(issues, R"(oops\.json: \$\.cost: expected "number")"));
  CHECK(matches(issues, R"(\$\.rnage: unknown key)"));
  CHECK(matches(issues, R"(\$\.targeting: "random" not in)"));
  CHECK(matches(issues, R"(\$\.branches: more than 2 items)"));
}

TEST_CASE("tower-defense example: runs on the engine's native @kit resolver (no flattening)") {
  script::HostOptions opts;
  opts.seed = 5;
  opts.budget_ms = budget(250);
  Game g = start_dir(kExample, {}, opts);
  g.step(30);
  world::EntityId btn = find_text(g, "UIButton", "Mossy Meadow");
  REQUIRE(g->world().alive(btn));
  g->press(btn);
  g.step(30);
  CHECK(g.alive("meadow_map"));
  CHECK_NO_ERRORS(g);
}

TEST_CASE("tower-defense example: has the promised content: 3 levels, 5 towers x 2 branches, 6+ enemy types + a boss") {
  FileMap pkg = read_dir(kExample);
  std::vector<std::string> towers = paths_with(pkg, "data/towers/");
  CHECK(towers.size() == 5);
  for (const std::string& p : towers) {
    CAPTURE(p);
    Json t = parse_json(pkg[p]);
    CHECK(J(&t)["branches"].size() == 2);
  }
  std::vector<std::string> enemies = paths_with(pkg, "data/enemies/");
  CHECK(enemies.size() >= 7);
  int bosses = 0;
  for (const std::string& p : enemies) {
    Json e = parse_json(pkg[p]);
    if (J(&e)["boss"].truthy()) ++bosses;
  }
  CHECK(bosses == 1);
  Json campaign = parse_json(pkg["data/campaign.json"]);
  CHECK(J(&campaign)["levels"].size() == 3);
}

TEST_CASE("tower-defense example: boots headless, taps build + upgrade a tower and plays a wave without script errors") {
  script::HostOptions opts;
  opts.seed = 3;
  opts.budget_ms = budget(2000);
  Game g = start_dir(kExample, {}, opts);
  g.step(10);
  // title: first level button
  world::EntityId btn = find_text(g, "UIButton", "Mossy Meadow");
  REQUIRE(g->world().alive(btn));
  g->press(btn);
  g.step(5);
  CHECK(g.alive("meadow_map"));
  // map at (8,112), 64px tiles: plot (4,1) -> world center (8+4.5*64, 112+1.5*64)
  auto at = [](double c, double r) { return std::pair<double, double>{8 + (c + 0.5) * 64, 112 + (r + 0.5) * 64}; };
  auto tap = [&](std::pair<double, double> p) { g.tap(p.first, p.second); };
  tap(at(4, 1));
  g.step(15);
  // radial menu labels: Text2D at z_index 2
  auto items = [&] {
    std::vector<std::string> out;
    for (world::EntityId e : g.of_type("Text2D")) {
      const world::Entity& ent = *g->world().get(e);
      if (g->world().num(ent, "z_index") == 2) out.push_back(g->world().str(ent, "text"));
    }
    return out;
  };
  auto has = [](const std::vector<std::string>& v, const std::string& s) {
    return std::find(v.begin(), v.end(), s) != v.end();
  };
  CHECK(has(items(), "50"));  // build menu: thorn 50, acorn 80
  CHECK(has(items(), "80"));
  // radial items: first slot (top) is the cheapest tower -> tap twice (preview, confirm)
  auto slot = [](int i, int n, double cx, double cy) {
    const double R = 1.15;
    double mx = std::min(std::max(cx, R + 0.5), 11 - R - 0.5);
    double my = std::min(std::max(cy, R + 0.5), 15 - R - 0.5);
    double a = -M_PI / 2 + i * (2 * M_PI / n);
    return std::pair<double, double>{8 + (mx + std::cos(a) * R) * 64, 112 + (my + std::sin(a) * R) * 64};
  };
  tap(slot(0, 2, 4.5, 1.5));
  g.step(5);
  CHECK(has(items(), "OK?"));
  tap(slot(0, 2, 4.5, 1.5));
  g.step(5);
  // TS hud(): every UIText's text (visible or not)
  auto hud = [&] {
    std::vector<std::string> out;
    for (world::EntityId e : g.of_type("UIText")) out.push_back(g->world().str(*g->world().get(e), "text"));
    return out;
  };
  CHECK(has(hud(), "150"));  // 200 - 50
  // tap the tower -> tower menu, upgrade (2 taps on slot 0 of 3: upgrade, targeting, sell)
  tap(at(4, 1));
  g.step(15);
  tap(slot(0, 3, 4.5, 1.5));
  g.step(3);
  tap(slot(0, 3, 4.5, 1.5));
  g.step(5);
  CHECK(has(hud(), "105"));  // 150 - 45
  // start the wave, let it run 20 s at 3x
  world::EntityId next = find_text(g, "UIButton", "START");
  REQUIRE(g->world().alive(next));
  g->press(next);
  world::EntityId speed = find_text(g, "UIButton", "^1x$");
  REQUIRE(g->world().alive(speed));
  g->press(speed);
  g->press(speed);
  CHECK(g->time_scale() == 3);  // sim speed drives the time scale (visuals fast-forward too)
  g.step(60 * 20);
  CHECK_NO_ERRORS(g);
  bool enemies_or_kills = false;
  for (const std::string& t : hud()) enemies_or_kills = enemies_or_kills || matches(t, R"(^\d+/8$)");
  CHECK(enemies_or_kills);
}

// harness.ts balance(): the reference build auto-placed on every campaign level (Luau sim, one call).
TEST_CASE("tower-defense example: balance sim: every campaign level is winnable by the reference build" *
          doctest::test_suite("slow")) {
  LuauOptions opts = td();
  opts.base = example_base();
  LuauRun r = run_luau(
      "local TD = require(\"@kit/tower-defense\")\n"
      "save.set(\"out\", TD.Balance.campaign(TD.content(), { endlessWaves = 30 }))",
      opts);
  REQUIRE_MESSAGE(r.errors.empty(), join(r.errors));
  J rep = r.out();
  REQUIRE(rep.exists());
  std::string summary;
  for (const J& l : rep["levels"].values())
    summary += l["level"].str() + ": won=" + (l["won"].b() ? "true" : "false") + " lives " + l["lives"].dump() + "/" +
               l["maxLives"].dump() + " stars " + l["stars"].dump() + " (" + l["seconds"].dump() + "s sim, spent " +
               l["spent"].dump() + ")\n";
  MESSAGE(summary << "endless: " << rep["endless"]["wavesSurvived"].dump() << " waves\nproblems: "
                  << join(rep["problems"].strs(), "; "));
  CHECK(rep["levels"].size() == 3);
  for (const J& l : rep["levels"].values()) CHECK(l["won"].b());
  CHECK(rep["levels"][0]["stars"].num() == 3);  // first level is the gentle one
  CHECK(rep["endless"]["wavesSurvived"].num() >= 5);
}

}  // TEST_SUITE
