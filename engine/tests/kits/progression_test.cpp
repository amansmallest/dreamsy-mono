// progression kit: curves, levelers, stats, skill trees, prestige, daily streaks, milestones,
// difficulty and the balance helpers, headless through real Luau. Port of
// engine-web/test/kits/progression.test.ts (same scripts, same checks).
#include <algorithm>

#include "kits/kit_test.h"

using namespace dreamsy;
using namespace dreamsy::test;

namespace {

// A package with the core, progression and juice kits whose only script is `script`.
FileMap kit_game(const std::string& script) {
  return {
      {"dreamsy.toml", manifest(R"("core", "progression", "juice")", "scenes/main.scene.json", "portrait")},
      {"scenes/main.scene.json", empty_scene()},
      {"scripts/client/main.luau", script},
  };
}

// assert helpers available inside scripts: check(name, cond) prints "ok name" / "FAIL name ..."
const std::string kPre = R"(
local fails = 0
local function check(name, c, extra) if c then print("ok " .. name) else fails += 1 print("FAIL " .. name .. " " .. tostring(extra)) end end
local function eq(name, a, b) check(name, a == b, tostring(a) .. " ~= " .. tostring(b)) end
)";

// TS run() + noFails(): two ticks, no script errors, no "FAIL" line and at least one "ok" line.
void run_no_fails(const std::string& body) {
  script::HostOptions opts;
  opts.budget_ms = budget(250);
  Game g = start(kit_game(kPre + body), opts);
  g.step(2);
  CHECK_NO_ERRORS(g);
  std::vector<std::string> fails = g.logs_with("FAIL");
  CHECK_MESSAGE(fails.empty(), "FAIL" << join(fails, "\nFAIL"));
  CHECK(!g.logs_with("ok ").empty());
}

}  // namespace

TEST_SUITE("kit progression") {

TEST_CASE("progression: curves: linear / quadratic / exponential / power / table / custom; levelAt + progress") {
  run_no_fails(R"(
      local prog = require("@kit/progression")
      local lin = prog.curve({ kind = "linear", base = 100, maxLevel = 10 })
      eq("lin total 3", lin:total(3), 200) eq("lin toNext", lin:toNext(5), 100) eq("lin levelAt", lin:levelAt(250), 3)
      eq("lin max", lin:levelAt(1e9), 10) eq("lin toNext max", lin:toNext(10), math.huge)
      local q = prog.curve({ kind = "quadratic", base = 50, linear = 50 })
      eq("quad total 3", q:total(3), 50 * 4 + 100) eq("quad levelAt exact", q:levelAt(300), 3) eq("quad below", q:levelAt(299), 2)
      local e = prog.curve({ kind = "exponential", base = 100, growth = 2 })
      eq("exp toNext 1", e:toNext(1), 100) eq("exp toNext 3", e:toNext(3), 400) eq("exp total 4", e:total(4), 700)
      local p = prog.curve({ kind = "power", base = 10, exponent = 2 })
      eq("power", p:total(4), 90)
      local t = prog.curve({ kind = "table", table = { 0, 10, 30, 70 } })
      eq("table max", t.maxLevel, 4) eq("table levelAt", t:levelAt(35), 3)
      local c = prog.curve({ kind = "custom", fn = function(L) return (L - 1) * 7 end, maxLevel = 5 })
      eq("custom", c:levelAt(14), 3)
      local L, into, need, frac = q:progress(400)
      eq("progress level", L, 3) eq("into", into, 100) eq("need", need, 50 * 9 + 150 - 300) check("frac", math.abs(frac - 100 / 300) < 1e-9)
      check("bad kind errors", not pcall(function() prog.curve({ kind = "zzz" }) end))
      check("monotonic", (function() for L = 2, 99 do if e:total(L) <= e:total(L - 1) and L < 40 then return false end end return true end)())
    )");
}

TEST_CASE("progression: leveler + stats + modifiers + core binding (xp effect, level condition, save)") {
  run_no_fails(R"(
      local core = require("@kit/core")
      local prog = require("@kit/progression")
      local ups = {}
      local lv = prog.leveler({ curve = { kind = "linear", base = 100, maxLevel = 5 }, onLevelUp = function(L, g) table.insert(ups, L .. "+" .. g) end })
      eq("gain 2 levels", lv:add(250), 2) eq("level", lv.level, 3)
      lv:add(1000) eq("capped", lv.level, 5) check("isMax", lv:isMax()) eq("xp capped", lv.xp, 400)
      eq("ups", table.concat(ups, ","), "3+2,5+2")
      local events = 0 core.events.on("level_up", function() events += 1 end)
      local hero = prog.leveler({ name = "hero", curve = { kind = "quadratic", base = 10 } })
      core.apply({ { xp = 40, track = "hero" } })
      eq("xp effect", hero.level, 3) eq("level_up event", events, 1)
      check("level cond", core.check({ level = 3, track = "hero" }) and not core.check({ level = 4, track = "hero" }))
      eq("linear stat", prog.stats.linear(20, 5, 3), 30)
      eq("compound", math.floor(prog.stats.compound(100, 0.1, 3) + 0.5), 121)
      eq("percent", prog.stats.percent(100, 0.1, 3), 120)
      check("diminishing", math.abs(prog.stats.diminishing(50, 0.5, 50) - 0.25) < 1e-9)
      local b = prog.stats.block({ hp = { base = 20, per = 5 }, atk = { base = 4, growth = 0.5 }, crit = 0.05, spd = { base = 1, per = 1, max = 3 } }, 5)
      eq("block hp", b.hp, 40) eq("block atk floor", b.atk, 20) eq("block const", b.crit, 0.05) eq("block max", b.spd, 3)
      local s = prog.stats.apply({ atk = 10, hp = 50 }, { { stat = "atk", add = 5 }, { stat = "atk", pct = 0.2 }, { stat = "hp", mul = 2 }, { stat = "def", add = 3 } })
      eq("mods atk", s.atk, 18) eq("mods hp", s.hp, 100) eq("mods new stat", s.def, 3)
      core.save.save()
      hero:add(1000)
      core.save.load()
      eq("leveler restored by save", hero.level, 3)
    )");
}

TEST_CASE("progression: skill tree: prerequisites (all/any/rank), costs in points + currency, ranks, mods, respec, conditions") {
  run_no_fails(R"(
      local core = require("@kit/core")
      local prog = require("@kit/progression")
      core.wallet.define("gold", { start = 100 })
      core.flags.set("chapter", 1)
      local t = prog.tree({ points = 3, defs = {
        { id = "strike", cost = 1, maxRank = 3, mods = { { stat = "atk", add = 2 } } },
        { id = "guard", cost = 1 },
        { id = "cleave", cost = { points = 1, gold = 60 }, requires = { { id = "strike", rank = 2 } } },
        { id = "fortress", cost = 2, requiresAny = { "guard", "cleave" } },
        { id = "ultimate", cost = { { points = 1 }, { points = 2 } }, maxRank = 2, requires = { "fortress" }, condition = { flag = "chapter", gte = 2 }, effects = { { add = "ult" } } },
      } })
      local ok, why, d = t:canUnlock("cleave")
      check("cleave needs strike 2", not ok and why == "requires" and d == "strike")
      check("strike 1", t:unlock("strike")) check("strike 2", t:unlock("strike"))
      eq("points left", t.points, 1)
      check("cleave ok", t:canUnlock("cleave"))
      check("cleave unlock pays gold", t:unlock("cleave")) eq("gold paid", core.wallet.get("gold"), 40)
      local ok2, why2 = t:canUnlock("fortress") eq("fortress needs points", why2, "points")
      t:addPoints(5)
      check("fortress via any", t:unlock("fortress"))
      local ok3, why3 = t:canUnlock("ultimate") eq("condition gate", why3, "condition")
      core.flags.set("chapter", 2)
      check("ult r1", t:unlock("ultimate")) check("ult r2 costs 2", t:unlock("ultimate") and t.points == 0)
      local _, why4 = t:canUnlock("ultimate") eq("max", why4, "max")
      eq("rank effects applied each rank", core.flags.get("ult"), 2)
      check("skill cond", core.check({ skill = "ultimate", rank = 2 }))
      eq("mods per rank", #t:mods(), 2)
      local st = {} for _, row in t:list() do st[row.id] = row.state end
      eq("list guard unaffordable", st.guard, "unaffordable") eq("list strike owned", st.strike, "owned") eq("locked", prog.get("skills"):list()[1].state, "owned") eq("list ult max", st.ultimate, "max")
      t:respec()
      eq("respec points", t.points, 8) eq("respec gold", core.wallet.get("gold"), 100) eq("respec ranks", t:rank("strike"), 0)
      check("unknown prereq errors", not pcall(function() prog.skills.new({ defs = { { id = "a", requires = { "zz" } } } }) end))
      local ser = t:serialize() t:unlock("guard") t:deserialize(ser) eq("tree roundtrip", t:rank("guard"), 0)
    )");
}

TEST_CASE("progression: prestige math, daily streak timing, milestones, difficulty, balance sims") {
  run_no_fails(R"(
      local core = require("@kit/core")
      local prog = require("@kit/progression")
      local p = prog.layer({ threshold = 1e6, exponent = 0.5, bonusPer = 0.1 })
      eq("below threshold", p:pending(5e5), 0)
      eq("at 4M", p:pending(4e6), 2)
      eq("at 1e8", p:pending(1e8), 10)
      eq("nextAt", math.floor(p:nextAt(4e6) + 0.5), 9e6)
      local resets = 0
      eq("prestige", p:prestige(9e6, function() resets += 1 end), 3)
      eq("count", p.count, 1) eq("reset fn", resets, 1)
      check("multiplier", math.abs(p:multiplier() - 1.3) < 1e-9)
      eq("nothing below", p:prestige(1, function() resets += 1 end), 0) eq("no reset", resets, 1)
      local c = prog.prestige.new({ threshold = 100, exponent = 1, cumulative = true })
      c:prestige(300) eq("cumulative pending", c:pending(500), 2)
      check("prestige cond", core.check({ prestige = 1 }))

      local DAY = 86400
      local d = prog.streak({ rewards = { { { earn = "gold", amount = 10 } }, { { earn = "gold", amount = 20 } }, { { earn = "gems", amount = 1 } } } })
      local s = d:status(DAY * 10 + 5)
      check("first claim", s.canClaim and s.streak == 1 and s.index == 1)
      d:claim(DAY * 10 + 5)
      eq("reward applied", core.wallet.get("gold"), 10)
      local s2 = d:status(DAY * 10 + 3600)
      check("same day blocked", not s2.canClaim and s2.nextIn == DAY - 3600)
      eq("claim again nil", d:claim(DAY * 10 + 7200), nil)
      d:claim(DAY * 11 + 1) eq("streak 2", d.streak, 2)
      d:claim(DAY * 12 + 1) eq("streak 3", d.streak, 3) eq("gems", core.wallet.get("gems"), 1)
      local _, idx = d:claim(DAY * 13 + 1) eq("cycles", idx, 1)
      d:claim(DAY * 16) eq("missed days reset", d.streak, 1)
      local g = prog.daily.new({ rewards = { 1, 2 }, grace = 1, cycle = false })
      g:claim(0) g:claim(DAY * 2) eq("grace keeps streak", g.streak, 2)
      local _, last = g:claim(DAY * 3) eq("no cycle clamps", last, 2)

      local m = prog.milestoneSet({ { id = "a", at = 100, reward = { { set = "m_a" } } }, { id = "b", at = 500 } })
      eq("none", #m:check(50), 0)
      local nx, frac = m:next(50) check("next a", nx.id == "a" and frac == 0.5)
      eq("reach both", #m:check(600), 2) eq("once", #m:check(700), 0)
      check("reward", core.flags.get("m_a") == true) check("milestone cond", core.check({ milestone = "b" }))

      local diff = prog.difficulty.new({ tiers = { { at = 0, params = { speed = 100, enemy = "slime" } }, { at = 10, params = { speed = 200, enemy = "bat" } } }, beyond = { speed = 10 } })
      eq("lerp", diff:at(5).speed, 150) eq("lower tier string", diff:at(5).enemy, "slime") eq("tier 2", diff:at(10).enemy, "bat")
      eq("beyond", diff:at(12).speed, 220) eq("ramp", prog.difficulty.ramp(5, 0, 10, 10), 5)

      local rows = prog.balance.timeToLevel({ kind = "linear", base = 60, maxLevel = 4 }, 2)
      eq("ttl rows", #rows, 3) eq("ttl total", rows[3].total, 90)
      local tl, endT = prog.balance.idle({ start = 10, items = { { id = "farm", cost = 10, growth = 2, max = 3 } }, income = function(owned) return (owned.farm or 0) * 1 end })
      eq("idle buys", #tl, 3) eq("idle first at 0", tl[1].time, 0) eq("idle second", tl[2].time, 20) eq("idle third", tl[3].time, 40)
      local tt = prog.balance.simulate({ state = { x = 0 }, step = function(s, dt) s.x += dt end, done = function(s) return s.x >= 5 end })
      eq("simulate", tt, 5) eq("format", prog.balance.format(3725), "1h 02m")
      core.save.save() p.count = 99 core.save.load() eq("prestige saved", p.count, 1)
    )");
}

TEST_CASE("progression: works standalone without the core kit") {
  script::HostOptions opts;
  opts.budget_ms = budget(250);
  Game g = start({
      {"dreamsy.toml", manifest(R"("progression")")},
      {"scenes/main.scene.json", empty_scene()},
      {"scripts/client/main.luau",
       R"(local prog = require("@kit/progression") local t = prog.tree({ points = 1, defs = { { id = "a", cost = 1 } } }) print("standalone " .. tostring(t:unlock("a")) .. " " .. prog.leveler({ curve = { kind = "linear", base = 10 } }):add(25)))"},
  }, opts);
  g.step(2);
  CHECK_NO_ERRORS(g);
  const std::vector<std::string> logs = g.logs();
  CHECK(std::find(logs.begin(), logs.end(), "standalone true 2") != logs.end());
}

}  // TEST_SUITE
