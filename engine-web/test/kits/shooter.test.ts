// shooter kit (engine-web/kits/shooter): headless tests through real Luau + the example package + pacing sim.
import { resolve, join, relative } from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { Package } from "@dreamsy/format";
import { describe, expect, it } from "vitest";
import { Game, MemorySaveHost } from "../../core/index.js";
import { simulate } from "../../tools/playtest.js";

const EXAMPLE = resolve(__dirname, "../../../games/examples/kit-shooter");

const scene = JSON.stringify({ format: "0", root: "world", entities: { world: { type: "Node2D" } } });
function kitGame(script: string, files: Record<string, string> = {}) {
  return Package.fromFiles({
    "dreamsy.toml": `format = "0"\nname = "K"\ndimension = "2d"\norientation = "portrait"\nentry_scene = "scenes/main.scene.json"\nkits = ["shooter"]\n`,
    "scenes/main.scene.json": scene,
    "scripts/client/main.luau": script,
    ...files,
  });
}
async function run(script: string, opts: { steps?: number; save?: MemorySaveHost; files?: Record<string, string> } = {}) {
  const g = await Game.load(kitGame(script, opts.files), { save: opts.save, budgetMs: 5000 }); // pure-logic batches (thousands of sims in one callback) under parallel test load: the 250ms frame budget is wall-clock
  for (let i = 0; i < (opts.steps ?? 2); i++) g.step();
  const errs = g.errors.map((e) => `${e.script}:${e.line}: ${e.message}`);
  const logs = g.logs.map((l) => l.text).filter((l) => !l.startsWith("[validate]"));
  return { g, errs, logs };
}
const PRE = `
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
`;
const noFails = (r: { errs: string[]; logs: string[] }) => {
  if (r.errs.length || r.logs.some((l) => l.startsWith("FAIL"))) console.log(r.logs.join("\n"), r.errs);
  expect(r.errs).toEqual([]);
  expect(r.logs.filter((l) => l.startsWith("FAIL"))).toEqual([]);
  expect(r.logs.filter((l) => l.startsWith("ok ")).length).toBeGreaterThan(0);
};

describe("shooter kit: emitters + motion (pure, deterministic)", () => {
  it("patterns: ring / fan / aimed / spiral / wave / line angles and timing", async () => {
    noFails(await run(PRE + `
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
    `));
  });

  it("emitters are dt-independent and deterministic; duration/volleys stop them", async () => {
    noFails(await run(PRE + `
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
    `));
  });

  it("bullet motion curves: accel, speed keys, turn, wave, angle keys", async () => {
    noFails(await run(PRE + `
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
    `));
  });
});

describe("shooter kit: weapons, score, stage scripts", () => {
  it("weapon levels inherit, volleys per kind, upgrades clamp, dps", async () => {
    noFails(await run(PRE + `
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
    `));
  });

  it("score: combo chain, multiplier steps, decay, hit reset, graze, extends", async () => {
    noFails(await run(PRE + `
      local ext = 0
      local s = S.score.new({ comboWindow = 1, multEvery = 3, maxMult = 3, grazePoints = 5, extends = { 300, 2000 }, onExtend = function() ext += 1 end })
      eq("k1", s:kill(100), 100) eq("k2", s:kill(100), 100) eq("k3 x2", s:kill(100), 200) eq("mult", s.mult, 2)
      eq("extend at 300", ext, 1)
      for i = 1, 10 do s:kill(10) end eq("max mult", s.mult, 3) eq("chain", s.combo, 13) eq("best", s.bestCombo, 13)
      s:update(0.5) eq("still chained", s.combo, 13) s:update(0.6) eq("chain dropped", s.combo, 0) eq("mult reset", s.mult, 1)
      s:kill(1) s:kill(1) s:hit() eq("hit resets", s.combo, 0)
      local before = s.score eq("graze", s:graze(2), 10) eq("graze adds", s.score, before + 10) eq("grazes", s.grazes, 2)
    `));
  });

  it("stage timeline: expansion, fractions, waitClear holds, arena waves via procgen", async () => {
    noFails(await run(PRE + `
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
    `));
  });

  it("content validation errors name the bad reference", async () => {
    const r = await run(PRE + `
      local bad = table.clone(RAW) bad.ships = { { id = "x", weapon = "nope" } }
      local ok, err = pcall(S.content.normalize, bad) check("bad weapon", not ok and string.find(tostring(err), "nope") ~= nil, err)
      local bad2 = table.clone(RAW) bad2.stages = { { id = "z", events = { { t = 1, enemy = "ghost" } } } }
      ok, err = pcall(S.content.normalize, bad2) check("bad enemy", not ok and string.find(tostring(err), "ghost") ~= nil, err)
    `);
    noFails(r);
  });
});

describe("shooter kit: bosses (ai phases + emitters)", () => {
  it("enters, fires its phase emitters, switches phase at hp thresholds, summons", async () => {
    noFails(await run(PRE + `
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
    `));
  });
});

describe("shooter kit: runtime (collisions, i-frames, upgrades, clear)", () => {
  it("player bullets kill enemies, enemy bullets respect i-frames, power-up, bomb, stage clear", async () => {
    const r = await run(PRE + `
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
    `, { steps: 60 * 12 });
    noFails(r);
    expect(r.logs).toContain("DONE");
  });
});

// ---------- example package ----------
function loadDir(dir: string) {
  const files: Record<string, Uint8Array> = {};
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else files[relative(dir, p).split("\\").join("/")] = readFileSync(p);
    }
  };
  walk(dir);
  return Package.fromFiles(files);
}

describe("shooter kit: example (Starling Drift)", () => {
  it("pacing sim: stage lengths, boss TTK, campaign time", async () => {
    const pkg = loadDir(EXAMPLE);
    const files: Record<string, Uint8Array | string> = {};
    for (const p of pkg.paths()) files[p] = pkg.bytes(p)!;
    for (const p of Object.keys(files)) if (/^scripts\/(client|server)\//.test(p)) delete files[p];
    files["scripts/client/play.luau"] = "";
    files["scripts/client/title.luau"] = `
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
    `;
    const save = new MemorySaveHost();
    const g = await Game.load(Package.fromFiles(files), { save });
    g.step();
    const logs = g.logs.map((l) => l.text);
    console.log(logs.filter((l) => !l.startsWith("[validate]")).join("\n"));
    expect(g.errors).toEqual([]);
    expect(logs.filter((l) => l.startsWith("stage ")).length).toBe(3);
    expect(logs.filter((l) => l.startsWith("note ")).length).toBe(0);
  });

  it("plays end-to-end headless with zero script errors (title, stage 1, arena)", async () => {
    const pkg = loadDir(EXAMPLE);
    const timeline = [
      { t: 1, tap: [360, 760] as [number, number] }, // Start (shmup)
      { t: 2, hold: ["left" as const] }, { t: 4, release: ["left" as const] }, { t: 4, hold: ["right" as const] }, { t: 6, release: ["right" as const] },
      { t: 8, press: ["action2" as const] },
      ...Array.from({ length: 40 }, (_, i) => ({ t: 10 + i * 2, hold: [(i % 2 ? "left" : "right") as "left" | "right"] })),
      ...Array.from({ length: 40 }, (_, i) => ({ t: 11 + i * 2, release: ["left" as const, "right" as const] })),
    ];
    const r = await simulate(pkg, timeline, 90);
    if (r.errors.length) console.log(r.errors);
    console.log(r.logs.slice(-15).join("\n"), r.toasts, r.audio, r.save);
    expect(r.loadError).toBeUndefined();
    expect(r.errors).toEqual([]);
    // invincible playtest: the bot can't dodge, so check the whole stage flow (script → boss phases → clear → save)
    const files: Record<string, Uint8Array | string> = {};
    for (const p of pkg.paths()) files[p] = pkg.bytes(p)!;
    const cfg = JSON.parse(pkg.text("data/shooter.json")!);
    cfg.invincible = true;
    files["data/shooter.json"] = JSON.stringify(cfg);
    files["scripts/client/zz_probe.luau"] = `local S = require("@kit/shooter")
      every(10, function() local c = S.current() if c then print(string.format("probe t=%.0f stage=%s enemies=%d boss=%s phase=%s score=%d lvl=%d over=%s held=%s idx=%d/%d", c.t, c.stageId, #c.enemies, tostring(c.boss and c.boss.f.hp), tostring(c.boss and c.boss.b.phase), c.run.score.score, c.run.weapon.level, tostring(c.over), tostring(c.runner.holding), c.runner.index, #c.runner.entries)) end end)`;
    const god = await simulate(Package.fromFiles(files), [{ t: 1, tap: [360, 760] }, { t: 100, tap: [360, 835] }, { t: 102, tap: [360, 1027] }], 150);
    console.log(god.loadError, god.logs.filter((l) => l.includes("probe")).slice(-30).join("\n"), god.toasts, god.audio, JSON.stringify(god.save).slice(0, 400));
    expect(god.errors).toEqual([]);
    const saved = JSON.stringify(god.save);
    expect(saved).toContain("nebula_run");
    expect(god.logs.some((l) => l.includes("stage=ice_belt"))).toBe(true); // results → hangar shop → stage 2
    const arena = await simulate(pkg, [{ t: 1, tap: [360, 880] }, { t: 2, hold: ["up"] }, { t: 4, release: ["up"] }], 40);
    if (arena.errors.length) console.log(arena.errors);
    console.log(arena.logs.filter((l) => l.startsWith("[game]")).join("\n"));
    expect(arena.errors).toEqual([]);
  });
});
