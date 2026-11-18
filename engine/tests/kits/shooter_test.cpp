// shooter kit: emitters, bullet motion, weapons, score, stage scripts, bosses, the runtime, the
// example package (Starling Drift) pacing sim and headless playthroughs.
// Port of engine-web/test/kits/shooter.test.ts (same numbers and thresholds).
//
// Most tests run a Luau script that checks itself: check()/eq()/near() print "ok <name>" or
// "FAIL <name> <detail>", and no_fails() asserts there are no FAIL lines and no script errors.
#include <algorithm>

#include "kits/kit_test.h"

using namespace dreamsy;
using namespace dreamsy::test;

namespace {

const char* kExample = "games/examples/kit-shooter";

// A one-script package with the shooter kit (TS kitGame()).
FileMap kit_game(const std::string& script) {
  return {
      {"dreamsy.toml", manifest("\"shooter\"", "scenes/main.scene.json", "portrait")},
      {"scenes/main.scene.json", empty_scene("world")},
      {"scripts/client/main.luau", script},
  };
}

struct Run {
  Game g;
  std::vector<std::string> errs, logs;  // logs without "[validate]" lines
};

// TS run(): load, step `steps` times. Budget 5000 ms as in TS (pure-logic batches: thousands of sims
// in one callback), scaled by budget() under the sanitizers.
Run run(const std::string& script, int steps = 2) {
  script::HostOptions o;
  o.budget_ms = budget(5000);
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
local S = require("@kit/shooter")
local core = require("@kit/core")
local combat = require("@kit/combat")
local RAW = {
  config = { lives = 2, bombs = 1, continues = 0, score = { comboWindow = 1, multEvery = 3, maxMult = 4, extends = { 1000 } },
             shop = { { id = "pow", name = "Power", cost = 10, effect = { power = 1 } }, { id = "life", name = "1UP", cost = 50, max = 1, effect = { life = 1 } } } },
  ships = { { id = "arrow", name = "Arrow", weapon = "blaster", speed = 400, hitbox = 6 }, { id = "moth", name = "Moth", weapon = "spread", cost = 100 } },
  weapons = {
    { id = "blaster", kind = "shot", levels = { { rate = 10, count = 1, damage = 1 }, { count = 2 }, { count = 3, damage = 2 } } },
    { id = "spread", kind = "spread", levels = { { rate = 6, count = 3, spread = 30 }, { count = 5, spread = 50 } } },
    { id = "beam", kind = "laser", levels = { { dps = 20, width = 20 } } },
    { id = "orbit", kind = "orbital", levels = { { orbs = 3, orbitRadius = 50, orbitSpeed = 90 } } },
    { id = "seeker", kind = "homing", levels = { { count = 2, spread = 40, rate = 3 } } },
  },
  emitters = {
    { id = "ring8", pattern = "ring", count = 8, rate = 2, speed = 150 },
    { id = "aim1", pattern = "aimed", rate = 1, speed = 200, delay = 0.5 },
  },
  enemies = {
    { id = "drone", hp = 2, score = 100, path = { kind = "straight", speed = 200 }, emitters = { "aim1" } },
    { id = "warden", boss = true, hp = 100, score = 5000, enter = { y = 200, speed = 400 }, phases = {
      { hp = 1.0, pattern = { { action = "fire", emitter = "ring8", ["for"] = 1, wait = 1 } } },
      { hp = 0.5, pattern = { { action = "summon", enemy = "drone", count = 2, wait = 1 }, { action = "fire", emitter = "aim1", ["for"] = 1, wait = 1 } } } } },
  },
  stages = {
    { id = "s1", name = "One", events = { { t = 0.5, enemy = "drone", xs = { 0.25, 0.75 }, count = 2, gap = 0.5 }, { t = 3, boss = "warden" } }, reward = { credits = 20 } },
    { id = "arena", mode = "arena", width = 900, height = 900, waves = { count = 3, budget = 3, enemies = { "drone" }, seed = 4 } },
  },
}
local C = S.content.load(RAW)
)";

bool any_contains(const std::vector<std::string>& lines, std::string_view needle) {
  for (const std::string& l : lines)
    if (contains(l, needle)) return true;
  return false;
}

// The timeline of the end-to-end playthrough (TS: Array.from(...) blocks).
std::vector<TimelineStep> play_timeline() {
  std::vector<TimelineStep> tl;
  TimelineStep s;
  s = {}; s.t = 1; s.tap = std::make_pair(360.0, 760.0); tl.push_back(s);  // Start (shmup)
  s = {}; s.t = 2; s.hold = {"left"}; tl.push_back(s);
  s = {}; s.t = 4; s.release = {"left"}; tl.push_back(s);
  s = {}; s.t = 4; s.hold = {"right"}; tl.push_back(s);
  s = {}; s.t = 6; s.release = {"right"}; tl.push_back(s);
  s = {}; s.t = 8; s.press = {"action2"}; tl.push_back(s);
  for (int i = 0; i < 40; ++i) {
    s = {}; s.t = 10 + i * 2; s.hold = {i % 2 ? "left" : "right"}; tl.push_back(s);
  }
  for (int i = 0; i < 40; ++i) {
    s = {}; s.t = 11 + i * 2; s.release = {"left", "right"}; tl.push_back(s);
  }
  return tl;
}

TimelineStep tap_at(double t, double x, double y) {
  TimelineStep s;
  s.t = t;
  s.tap = std::make_pair(x, y);
  return s;
}

}  // namespace

TEST_SUITE("kit shooter") {

// ---------------------------------------------------------------- emitters + motion

TEST_CASE("shooter: emitters + motion: patterns: ring / fan / aimed / spiral / wave / line angles and timing") {
  no_fails(run(kPre + R"(
      local E = S.emitter
      local ring = E.volley(E.resolve({ pattern = "ring", count = 4, angle = 0 }), 0, 0, 1)
      eq("ring n", #ring, 4) near("ring 2", ring[2].angle, 90) near("ring 4", ring[4].angle, 270)
      local fan = E.volley(E.resolve({ pattern = "fan", count = 5, spread = 60, angle = 90 }), 0, 0, 1)
      near("fan first", fan[1].angle, 60) near("fan mid", fan[3].angle, 90) near("fan last", fan[5].angle, 120)
      local aimed = E.volley(E.resolve({ pattern = "aimed" }), 0, 100, 0)
      near("aimed right", aimed[1].angle, 0)
      local aimed3 = E.volley(E.resolve({ pattern = "aimed", count = 3, spread = 20 }), 0, 0, -50)
      near("aimed up spread", aimed3[1].angle, -100) near("aimed mid", aimed3[2].angle, -90)
      local sp = E.resolve({ pattern = "spiral", count = 2, spin = 90, rate = 10, angle = 0 })
      local v5 = E.volley(sp, 5, 0, 1)
      near("spiral t", v5[1].t, 0.5) near("spiral arm1", v5[1].angle, 45) near("spiral arm2", v5[2].angle, 225)
      local wv = E.resolve({ pattern = "wave", count = 1, waveAmp = 30, waveFreq = 1, rate = 4, angle = 90 })
      near("wave quarter", E.volley(wv, 1, 0, 1)[1].angle, 120) near("wave half", E.volley(wv, 2, 0, 1)[1].angle, 90, 1e-6)
      local ln = E.volley(E.resolve({ pattern = "line", count = 3, speed = 100, speedStep = 50 }), 0, 0, 1)
      eq("line speeds", ln[3].speed, 200) near("line same angle", ln[1].angle, ln[3].angle)
      -- burst timing
      local bd = E.resolve({ pattern = "aimed", rate = 1, burst = 3, burstGap = 0.1, delay = 0.2 })
      near("burst v0", E.volleyTime(bd, 0), 0.2) near("burst v2", E.volleyTime(bd, 2), 0.4) near("burst v3", E.volleyTime(bd, 3), 1.2)
      local ok = pcall(E.resolve, { pattern = "nope" }) check("unknown pattern errors", not ok)
  )"));
}

TEST_CASE("shooter: emitters + motion: emitters are dt-independent and deterministic; duration/volleys stop them") {
  no_fails(run(kPre + R"(
      local E = S.emitter
      local def = { pattern = "spiral", count = 3, spin = 77, rate = 9, speed = 180 }
      local a = E.preview(def, 3, { x = 10, y = 20 })
      local em = E.new(def) local b = {}
      local acc = 0
      for i = 1, 37 do for _, s in em:update(3 / 37, { x = 10, y = 20 }) do table.insert(b, s) end end
      eq("same count any dt", #a, #b)
      local same = true
      for i = 1, #a do if math.abs(a[i].angle - b[i].angle) > 1e-9 or a[i].x ~= b[i].x then same = false end end
      check("same shots any dt", same)
      local c = E.preview(def, 3, { x = 10, y = 20 })
      eq("repeatable", c[#c].angle, a[#a].angle)
      eq("count = volleys*arms", #a, 3 * (math.floor(3 * 9) + 1))
      eq("duration stops", #E.preview({ pattern = "ring", count = 6, rate = 2, duration = 1 }, 5), 18)
      eq("volleys stops", #E.preview({ pattern = "aimed", rate = 10, volleys = 4 }, 5), 4)
      -- big step reports age so late shots can be pre-advanced
      local e2 = E.new({ pattern = "aimed", rate = 10 })
      local shots = e2:update(0.35, { x = 0, y = 0 })
      eq("4 volleys in 0.35s", #shots, 4) near("oldest age", shots[1].age, 0.35) near("newest age", shots[4].age, 0.05)
  )"));
}

TEST_CASE("shooter: emitters + motion: bullet motion curves: accel, speed keys, turn, wave, angle keys") {
  no_fails(run(kPre + R"(
      local M = S.motion
      local sp, a = M.at({ accel = 100, maxSpeed = 250 }, 1, 90, 100) eq("accel", sp, 200)
      sp = M.at({ accel = 100, maxSpeed = 250 }, 3, 90, 100) eq("max", sp, 250)
      sp = M.at({ speedCurve = { { 0, 1 }, { 1, 0 }, { 2, 2 } } }, 0.5, 0, 100) near("curve mid", sp, 50)
      sp = M.at({ speedCurve = { { 0, 1 }, { 1, 0 }, { 2, 2 } } }, 9, 0, 100) near("curve held", sp, 200)
      sp, a = M.at({ turn = 45, turnAfter = 1 }, 3, 0, 100) near("turn", a, 90)
      sp, a = M.at({ waveAmp = 20, waveFreq = 1 }, 0.25, 90, 100) near("wave", a, 110)
      sp, a = M.at({ angleCurve = { { 0, 0 }, { 2, 180 } } }, 1, 0, 100) near("angle keys", a, 90)
      local x, y = M.position({}, 1, 0, 0, 90, 120) near("straight y", y, 120, 1e-6) near("straight x", x, 0, 1e-6)
      check("dynamic", M.dynamic({ turn = 10 }) and not M.dynamic({ radius = 4 }))
      -- enemy paths
      local px, py = M.path({ kind = "stop", speed = 100, stopY = 200, hold = 2 }, 3, 50, 0) eq("stop holds", py, 200)
      px, py = M.path({ kind = "stop", speed = 100, stopY = 200, hold = 2, exitSpeed = 100 }, 5, 50, 0) eq("stop exits", py, 300)
      px, py = M.path({ kind = "sine", speed = 100, amp = 50, freq = 0.25 }, 1, 100, 0) near("sine x", px, 150) near("sine y", py, 100)
      px, py = M.path({ kind = "swoop", speed = 100, turn = 90, angle = 0 }, 1, 0, 0) near("swoop quarter circle x", px, 100 / math.rad(90)) near("swoop y", py, 100 / math.rad(90))
  )"));
}

// ---------------------------------------------------------------- weapons, score, stage scripts

TEST_CASE("shooter: weapons, score, stage scripts: weapon levels inherit, volleys per kind, upgrades clamp, dps") {
  no_fails(run(kPre + R"(
      local W = S.weapons
      local bl = C.weapons.blaster
      local s3 = W.stats(bl, 3) eq("inherits rate", s3.rate, 10) eq("L3 count", s3.count, 3) eq("L3 damage", s3.damage, 2)
      local v = W.volley(bl, 2, 100, 500, -90) eq("parallel 2", #v, 2) near("parallel offset", v[1].x - v[2].x, 14 * (if v[1].x > v[2].x then 1 else -1))
      local sv = W.volley(C.weapons.spread, 2, 0, 0, -90) eq("spread 5", #sv, 5) near("spread edge", sv[1].angle, -115)
      local hv = W.volley(C.weapons.seeker, 1, 0, 0, -90) check("homing shots", hv[1].homing > 0)
      eq("laser no shots", #W.volley(C.weapons.beam, 1, 0, 0, -90), 0)
      local bm = W.beam(C.weapons.beam, 1, 0, 0, -90) eq("beam dps", bm.dps, 20)
      local orbs = W.orbs(C.weapons.orbit, 1, 1, 0, 0) eq("3 orbs", #orbs, 3) near("orb radius", math.sqrt(orbs[1].x ^ 2 + orbs[1].y ^ 2), 50, 1e-6)
      local w = W.new(bl, 1)
      check("upgrade", w:upgrade()) eq("lvl2", w.level, 2) w:upgrade(5) eq("clamped", w.level, 3) check("max", w:isMax())
      check("no change at max", not w:upgrade())
      local n = 0 for i = 1, 60 do n += #w:update(1 / 60, true, 0, 0, -90).shots end
      eq("rate 10 x3 for 1s", n, 30)
      local idle = W.new(bl, 1) local out = idle:update(1 / 60, false, 0, 0, -90) eq("no fire", #out.shots, 0)
      check("dps grows", W.dps(bl, 3) > W.dps(bl, 1))
  )"));
}

TEST_CASE("shooter: weapons, score, stage scripts: score: combo chain, multiplier steps, decay, hit reset, graze, extends") {
  no_fails(run(kPre + R"(
      local ext = 0
      local s = S.score.new({ comboWindow = 1, multEvery = 3, maxMult = 3, grazePoints = 5, extends = { 300, 2000 }, onExtend = function() ext += 1 end })
      eq("k1", s:kill(100), 100) eq("k2", s:kill(100), 100) eq("k3 x2", s:kill(100), 200) eq("mult", s.mult, 2)
      eq("extend at 300", ext, 1)
      for i = 1, 10 do s:kill(10) end eq("max mult", s.mult, 3) eq("chain", s.combo, 13) eq("best", s.bestCombo, 13)
      s:update(0.5) eq("still chained", s.combo, 13) s:update(0.6) eq("chain dropped", s.combo, 0) eq("mult reset", s.mult, 1)
      s:kill(1) s:kill(1) s:hit() eq("hit resets", s.combo, 0)
      local before = s.score eq("graze", s:graze(2), 10) eq("graze adds", s.score, before + 10) eq("grazes", s.grazes, 2)
  )"));
}

TEST_CASE("shooter: weapons, score, stage scripts: stage timeline: expansion, fractions, waitClear holds, arena waves via procgen") {
  no_fails(run(kPre + R"(
      local procgen = require("@kit/procgen")
      local tl = S.stage.timeline(C.stages.s1, C.enemies, procgen)
      eq("entries", #tl, 5) eq("first x", tl[1].x, 180) near("gap", tl[3].t, 1.0) eq("boss last", tl[5].kind, "boss")
      local r = S.stage.new(C.stages.s1, C.enemies, procgen)
      local due = r:update(0.6, 0) eq("2 due at 0.6", #due, 2)
      due = r:update(2.5, 2) eq("rest of drones", #due, 2)
      due = r:update(1, 4) eq("boss waits for clear", #due, 0) check("holding", r.holding)
      due = r:update(0.1, 0) eq("boss released", #due, 1) eq("boss kind", due[1].kind, "boss")
      check("finished when clear", r:finished(0)) check("not while alive", not r:finished(1))
      local a = S.stage.timeline(C.stages.arena, C.enemies, procgen)
      local waves = 0 for _, e in a do if e.kind == "text" then waves += 1 end end
      eq("3 waves", waves, 3)
      local a2 = S.stage.timeline(C.stages.arena, C.enemies, procgen)
      eq("arena deterministic", a2[#a2].x, a[#a].x)
      local inside = true for _, e in a do if e.kind == "enemy" and (e.x < 0 or e.x > 900 or e.y < 0 or e.y > 900) then inside = false end end
      check("spawns inside arena", inside)
  )"));
}

TEST_CASE("shooter: weapons, score, stage scripts: content validation errors name the bad reference") {
  no_fails(run(kPre + R"(
      local bad = table.clone(RAW) bad.ships = { { id = "x", weapon = "nope" } }
      local ok, err = pcall(S.content.normalize, bad) check("bad weapon", not ok and string.find(tostring(err), "nope") ~= nil, err)
      local bad2 = table.clone(RAW) bad2.stages = { { id = "z", events = { { t = 1, enemy = "ghost" } } } }
      ok, err = pcall(S.content.normalize, bad2) check("bad enemy", not ok and string.find(tostring(err), "ghost") ~= nil, err)
  )"));
}

// ---------------------------------------------------------------- bosses

TEST_CASE("shooter: bosses (ai phases + emitters): enters, fires its phase emitters, switches phase at hp thresholds, summons") {
  no_fails(run(kPre + R"(
      local ai = require("@kit/ai")
      local b = S.boss.new(C.enemies.warden, C.emitters, ai, { x = 360, y = -100 })
      local shots = 0
      local frames = 0
      while b.entering and frames < 600 do local o = b:update(1 / 60, { x = 360, y = 900 }) shots += #o.shots frames += 1 end
      near("entry time", frames / 60, 0.75, 0.05)
      check("entered", not b.entering) eq("no shots while entering", shots, 0)
      local phase1 = 0
      for i = 1, 120 do local o = b:update(1 / 60, { x = 360, y = 900 }, 100) phase1 += #o.shots end
      eq("phase 1", b.phase, 1) check("ring volleys", phase1 >= 8 and phase1 % 8 == 0, phase1)
      local changed, summons, shots2 = nil, 0, 0
      for i = 1, 180 do local o = b:update(1 / 60, { x = 360, y = 900 }, 40) if o.phase then changed = o.phase end summons += #o.summons shots2 += #o.shots end
      eq("phase 2 at 40%", changed, 2) eq("phase index", b.phase, 2) check("summons", summons >= 2, summons) check("aimed in p2", shots2 > 0)
      -- determinism
      local function trace()
        local bb = S.boss.new(C.enemies.warden, C.emitters, ai, { x = 360, y = -100 })
        local out = {}
        for i = 1, 300 do for _, s in bb:update(1 / 60, { x = 300, y = 900 }, if i > 200 then 30 else 100).shots do table.insert(out, string.format("%.3f", s.angle)) end end
        return table.concat(out, ",")
      end
      eq("boss deterministic", trace(), trace())
  )"));
}

// ---------------------------------------------------------------- runtime

TEST_CASE("shooter: runtime (collisions, i-frames, upgrades, clear): player bullets kill enemies, enemy bullets respect i-frames, power-up, bomb, stage clear" *
          doctest::test_suite("slow")) {
  Run r = run(kPre + R"(
      S.setup({ content = RAW })
      local run = S.newRun({ ship = "arrow" })
      local kills, deaths, clear = 0, 0, nil
      S.events:on("kill", function() kills += 1 end)
      S.events:on("death", function() deaths += 1 end)
      local ctl = S.play(run, "s1", { onClear = function(res) clear = res end })
      check("player fighter", ctl.fighter ~= nil and ctl.fighter.team == "player")
      -- i-frames at spawn: a direct hit is blocked
      local info = combat.damage(ctl.fighter, { amount = 1, source = "enemy" })
      eq("spawn i-frames", info.blocked, "iframes")
      ctl.fighter.iframeT = 0
      local info2 = combat.damage(ctl.fighter, { amount = 1, source = "enemy" })
      check("hit lands", info2.killed) eq("lives down", run.lives, 1)
      local info3 = combat.damage(ctl.fighter, { amount = 1, source = "enemy" })
      eq("dead not hit again", info3.blocked, "dead")
      -- power pickup
      ctl:spawnPickup("power", ctl.player.position.x, ctl.player.position.y)
      every(0.5, function() print("tick lives=" .. run.lives .. " kills=" .. kills .. " lvl=" .. run.weapon.level .. " enemies=" .. #ctl.enemies .. " boss=" .. tostring(ctl.boss ~= nil) .. " t=" .. string.format("%.1f", ctl.t)) end)
      after(1.5, function()
        eq("power up collected", run.weapon.level, 2)
        check("respawned", not ctl.fighter.dead)
        run.bombs = 1
        check("bomb", ctl:bomb()) eq("bomb used", run.bombs, 0) check("no bomb left", not ctl:bomb())
      end)
      after(4, function() check("boss spawned", ctl.boss ~= nil or clear ~= nil) if ctl.boss then ctl.fighter.iframeT = 999 combat.damage(ctl.boss.f, { amount = 60, source = ctl.fighter }) end end)
      after(6, function() if ctl.boss then combat.damage(ctl.boss.f, { amount = 60, source = ctl.fighter }) end end)
      after(11, function()
        check("enemies killed", kills >= 1, kills)
        check("cleared", clear ~= nil and clear.cleared)
        check("credits", core.wallet.get("credits") >= 20, core.wallet.get("credits"))
        check("score", run.score.score > 5000, run.score.score)
        eq("stage advanced", run.stageIndex, 2)
        check("best saved", S.meta().best.s1 ~= nil)
        -- shop
        core.wallet.add("credits", 100)
        local lvl = run.weapon.level
        check("buy power", S.buy(run, "pow")) eq("power +1", run.weapon.level, math.min(3, lvl + 1))
        check("buy life", S.buy(run, "life")) local ok, why = S.canBuy(run, "life") eq("life max 1", why, "max")
        core.wallet.add("credits", 200)
        eq("ship locked->buyable", S.shipState(C, "moth"), "buyable") check("unlock", S.unlockShip(C, "moth")) eq("owned", S.shipState(C, "moth"), "owned")
        print("DONE")
      end)
  )",
              60 * 12);
  no_fails(r);
  CHECK(std::find(r.logs.begin(), r.logs.end(), "DONE") != r.logs.end());
}

// ---------------------------------------------------------------- example package

TEST_CASE("shooter: example (Starling Drift): pacing sim: stage lengths, boss TTK, campaign time") {
  FileMap files = read_dir(kExample);
  for (auto it = files.begin(); it != files.end();) {
    bool game_script = it->first.rfind("scripts/client/", 0) == 0 || it->first.rfind("scripts/server/", 0) == 0;
    it = game_script ? files.erase(it) : std::next(it);
  }
  files["scripts/client/play.luau"] = "";
  files["scripts/client/title.luau"] = R"(
      local S = require("@kit/shooter")
      local procgen = require("@kit/procgen")
      local C = S.content.load()
      local r = S.balance.campaign(C, { procgen = procgen, target = { 300, 7200 } })
      for _, row in r.rows do
        print(string.format("stage %s mode=%s L%d enemies=%d hp=%d script=%s est=%s boss=%s ttk=%s peak=%.0f/s credits=%d", row.id, row.mode, row.level, row.enemies, row.enemyHp,
          S.balance.fmt(row.scriptLength), S.balance.fmt(row.est), tostring(row.boss), if row.bossTTK then S.balance.fmt(row.bossTTK) else "-", row.peakBullets, row.credits))
      end
      print("campaign one-clear " .. S.balance.fmt(r.total) .. " with retries+shop " .. S.balance.fmt(r.withRetries) .. " credits " .. r.creditsEarned .. " shop " .. r.shopSpend)
      for _, n in r.notes do print("note " .. n) end
      save.set("rep", { notes = #r.notes, total = r.total, rows = #r.rows })
  )";
  script::HostOptions o;
  o.budget_ms = budget(250);  // TS default; scaled for the sanitizer build
  Game g = start(files, o);
  g.step();
  CHECK_NO_ERRORS(g);
  MESSAGE(g.log_text());
  CHECK(g.logs_with("stage ").size() == 3);
  CHECK(g.logs_with("note ").size() == 0);
}

TEST_CASE("shooter: example (Starling Drift): plays end-to-end headless with zero script errors (title, stage 1, arena)" *
          doctest::test_suite("slow")) {
  FileMap pkg = read_dir(kExample);
  PlaytestReport r = simulate(pkg, play_timeline(), 90);
  CHECK_MESSAGE(r.errors.empty(), join(r.errors));

  // invincible playtest: the bot can't dodge, so check the whole stage flow (script -> boss phases -> clear -> save)
  FileMap files = pkg;
  std::string cfg = files["data/shooter.json"];
  // cfg.invincible = true (JSON object: add the key after the opening brace)
  size_t brace = cfg.find('{');
  REQUIRE(brace != std::string::npos);
  cfg.insert(brace + 1, "\"invincible\": true,");
  parse_json(cfg);  // still valid JSON
  files["data/shooter.json"] = cfg;
  files["scripts/client/zz_probe.luau"] = R"(local S = require("@kit/shooter")
      every(10, function() local c = S.current() if c then print(string.format("probe t=%.0f stage=%s enemies=%d boss=%s phase=%s score=%d lvl=%d over=%s held=%s idx=%d/%d", c.t, c.stageId, #c.enemies, tostring(c.boss and c.boss.f.hp), tostring(c.boss and c.boss.b.phase), c.run.score.score, c.run.weapon.level, tostring(c.over), tostring(c.runner.holding), c.runner.index, #c.runner.entries)) end end))";
  PlaytestReport god = simulate(files, {tap_at(1, 360, 760), tap_at(100, 360, 835), tap_at(102, 360, 1027)}, 150);
  CHECK_MESSAGE(god.errors.empty(), join(god.errors));
  std::string saved = J(&god.save).dump();
  CHECK(contains(saved, "nebula_run"));
  CHECK_MESSAGE(any_contains(god.logs, "stage=ice_belt"), join(god.logs));  // results -> hangar shop -> stage 2

  TimelineStep up, release;
  up.t = 2;
  up.hold = {"up"};
  release.t = 4;
  release.release = {"up"};
  PlaytestReport arena = simulate(pkg, {tap_at(1, 360, 880), up, release}, 40);
  CHECK_MESSAGE(arena.errors.empty(), join(arena.errors));
}

}  // TEST_SUITE
