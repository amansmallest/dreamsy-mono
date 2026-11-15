// tower-defense kit: headless tests of the Luau sim (pathing, targeting, damage, waves, economy, upgrades,
// campaign), the example package (boots, taps build a tower, content read from data/**) and the balance sim.
import { resolve } from "node:path";
import { Package } from "@dreamsy/format";
import { beforeAll, describe, expect, it } from "vitest";
import { Game, MemorySaveHost } from "../../core/index.js";
import { balance, runLuau, validateContent } from "../../kits/tower-defense/harness.js";

const EXAMPLE = resolve(__dirname, "../../../games/examples/kit-tower-defense");

// Small inline content for unit tests (tile units; map is a straight corridor along row 1, 10 tiles long).
const CONTENT = `
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
		lane = { name = "Lane", map = { grid = "S.........E\\n.oooooooooo", legend = { path = "#.", spawns = "S", exits = "E", build = "o" } },
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
`;

async function lua(body: string) {
  const r = await runLuau(`local TD = require("@kit/tower-defense")\n${CONTENT}\nlocal out = {}\n${body}\nsave.set("out", out)`);
  expect(r.errors).toEqual([]);
  return r.out as any;
}

describe("tower-defense: paths", () => {
  it("traces a grid path from spawn to exit, extends through map edges, measures length", async () => {
    const o = await lua(`
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
    `);
    expect(o.ids).toEqual(["S"]);
    expect(o.first).toEqual([-0.5, 0.5]); // walks in from the left edge
    expect(o.last).toEqual([10.5, 0.5]); // and stops at the exit tile's center
    expect(o.len).toBeCloseTo(11, 6);
    expect(o.at).toEqual([5, 0.5]);
    expect(o.build).toBe(10);
    expect(o.wlen).toBe(7);
    expect(o.wat).toEqual([4, 1]);
  });

  it("finds multiple spawns + shortest routes and rejects a spawn with no exit", async () => {
    const o = await lua(`
      local grid = "S#####.\\n.o..o#.\\nT####E."
      local lay = TD.Path.fromGrid(grid, { path = "#", spawns = "ST", exits = "E", build = "o" })
      out.ids = lay.pathIds
      out.s = lay.paths.S.length
      out.t = lay.paths.T.length
      out.pts = #lay.paths.S.points
      local ok, err = pcall(TD.Path.fromGrid, "S#..E", nil)
      out.err = tostring(err)
    `);
    expect(o.ids).toEqual(["S", "T"]);
    expect(o.s).toBeCloseTo(8, 6); // (-0.5,.5)→(5.5,.5)→(5.5,2.5): in from the left edge, ends on E
    expect(o.t).toBeCloseTo(6, 6); // (-0.5,2.5)→(5.5,2.5)
    expect(o.err).toMatch(/no walkable route/);
  });
});

describe("tower-defense: targeting + damage", () => {
  it("first / last / strong / close pick the right enemy", async () => {
    const o = await lua(`
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
    `);
    expect(o).toMatchObject({ first: 2, last: 0, strong: 1, close: 1, cycle: "first" });
  });

  it("applies armor (flat, min 20%), resistances, weaknesses, armor pierce and magic/true bypass", async () => {
    const o = await lua(`
      local sim = TD.Sim.new(C, "lane")
      local e = sim:spawnEnemy("tank", "S")
      out.phys = sim:damage(e, 30, "physical")       -- 30 - 10
      out.small = sim:damage(e, 5, "physical")       -- min 20% = 1
      out.fire = sim:damage(e, 30, "fire")           -- (30-10) * 0.5
      out.magic = sim:damage(e, 30, "magic")         -- no armor, -50% res → 45
      out.tru = sim:damage(e, 30, "true")
      local t = sim:build("arrow", 5, 1)
      t.up = { common = 2, branch = "a", tier = 1 }
      t.base = TD.Content.towerStats(t.def, t.up)
      t.stats = t.base
      out.pierce = sim:damage(e, 30, "physical", t) -- armor pierced
      sim.hooks.damage = function(s, tw, en, d, kind) return d * 2 end
      out.hook = sim:damage(e, 10, "true")
    `);
    expect(o).toMatchObject({ phys: 20, small: 1, fire: 10, magic: 45, tru: 30, pierce: 30, hook: 20 });
  });

  it("splash, slow, chain, DOT, aura, flying, split and heal behave", async () => {
    const o = await lua(`
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
      -- chain: 3 grunts in a row 1 apart → 30, 15, 7.5
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
    `);
    expect(o.splash[1]).toBe(60); // "first" targets g2 (further along): 100 - 40
    expect(o.splash[0]).toBeCloseTo(70, 5); // g1 0.5 tiles away: 40 * (1 - 0.5 * 0.5)
    expect(o.slow).toBe(0.5);
    expect(o.slowMove).toBeCloseTo(0.5, 1);
    expect(o.bossSlow).toBe(1); // immune
    expect(o.chain).toEqual([70, 85, 92.5]);
    expect(o.dot).toBeGreaterThan(17); // ~20 over 2s
    expect(o.dot).toBeLessThanOrEqual(20.01);
    expect(o.aura).toEqual([15, 2.5, true]);
    expect(o.batTarget).toBe(true);
    expect(o.batPath).toBeCloseTo(11, 5); // flies the straight line
    expect(o.bits).toBe(3);
    expect(o.heal).toBe(70);
  });
});

describe("tower-defense: waves + economy", () => {
  it("spawns on schedule, scales hp, pays bounties/bonus/interest/early-call, auto-starts after the countdown", async () => {
    const o = await lua(`
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
    `);
    expect(o.sched).toEqual([[0, "bat", 1.1], [2, "grunt", 1.1], [2.5, "grunt", 1.1]]);
    expect(o.state).toBe("running");
    expect(o.spawns.slice(0, 2)).toEqual([1, 31]);
    expect(o.spawns[2]).toBeGreaterThanOrEqual(60); // t = 2 s (float sum of ticks may land on 60 or 61)
    expect(o.spawns[2]).toBeLessThanOrEqual(61);
    expect(o.bounty).toBe(15);
    expect(o.cleared).toEqual([[1, 10]]);
    expect(o.countdown).toBeCloseTo(5 - 1 / 30, 5);
    expect(o.early).toBe(9 + 15);
    expect(o.wave).toBe(2);
    expect(o.final).toBe("won");
    expect(o.stars).toBe(3);
  });

  it("auto-starts the next wave after `between` seconds; leaks cost lives; losing ends the level", async () => {
    const o = await lua(`
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
    `);
    // wave 1 spawns 0..2 s, grunts leak at ~12-14 s, countdown 5 s → wave 2 at ~19 s
    expect(o.waves[0]).toBeGreaterThanOrEqual(18);
    expect(o.waves[0]).toBeLessThanOrEqual(20);
    expect(o.leaked).toBe(6);
    expect(o.lives).toBe(14);
    expect(o.state).toBe("lost");
    expect(o.lost).toBe(true);
  });

  it("build / sell refunds / canBuild reasons / speed-up", async () => {
    const o = await lua(`
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
    `);
    expect(o).toMatchObject({ tile: "tile", locked: "locked", occupied: "occupied", sellValue: 45, refund: 45, money: "money", ticks: 45 });
  });
});

describe("tower-defense: upgrade trees", () => {
  it("common tiers first, then one branch; locked branches blocked; stats follow the tree", async () => {
    const o = await lua(`
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
    `);
    expect(o.o0).toBe("common1");
    expect(o.o2).toBe("brancha1,branchb1L");
    expect(o.choose).toBe("choose");
    expect(o.lockedB).toBe("locked");
    expect(o.okA).toBe(true);
    expect(o.o3).toBe("brancha2");
    expect(o.max).toBe("max");
    expect(o.stats).toEqual([90, 4, 10]); // (10+5)*3*2, 3+1
    expect(o.spent).toBe(50 + 40 + 60 + 100 + 150);
    expect(o.rapid).toBe(4);
  });
});

describe("tower-defense: campaign, endless, save", () => {
  it("unlocks levels/towers/branches by clears + stars and round-trips through save", async () => {
    const o = await lua(`
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
    `);
    expect(o.start).toEqual(["arrow"]);
    expect(o.l2).toBe(false);
    expect(o.newTowers).toEqual(["bomb"]);
    expect(o.newBranches).toEqual(["arrow.b"]);
    expect(o.l2b).toBe(false);
    expect(o.l2c).toBe(true);
    expect(Object.keys(o.opts ?? {})).toHaveLength(0); // nothing locked any more
    expect(o.endless).toBe(false);
    expect(o.endless2).toBe(true);
    expect(o.reload).toEqual([3, 2, 5]);
    expect(o.endlessBest).toEqual([11, 11]);
    expect(o.saved).toBe(3);
  });

  it("endless generates growing waves with a boss every N; snapshot/restore between waves", async () => {
    const o = await lua(`
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
    `);
    expect(o.counts.slice(0, 2)).toEqual([3, 3]); // scripted waves (3 grunts; 2 grunts + bat)
    expect(o.counts[2]).toBe(4); // endless k=1: count_base 4; boss_every counts endless waves (k=3 → n=5)
    expect(o.bosses).toEqual([0, 0, 0, 0, 0, 0].map((_, i) => (i === 4 ? 1 : 0)));
    expect(o.hp[1]).toBeGreaterThan(o.hp[0]);
    expect(o.restored).toEqual([true, 1, "strong", 90]);
    expect(o.busy).toBe(true);
  });
});

describe("tower-defense: example package", () => {
  let pkg: Package;
  beforeAll(async () => { pkg = await Package.fromDir(EXAMPLE); });

  it("TD.content() reads data/**/*.json through the engine data reader", async () => {
    const { out, errors } = await runLuau(`
      local TD = require("@kit/tower-defense")
      local C = TD.content()
      local n = function(t) local k = 0 for _ in t do k += 1 end return k end
      save.set("out", { enemies = n(C.enemies), towers = n(C.towers), waves = n(C.waves), levels = n(C.levels),
        campaign = #C.campaign.levels, cached = TD.content() == C, grid = #TD.Path.rows(C.levels.meadow.map.grid),
        thorn = C.towers.thorn.cost, paths = TD.Content.layout(C, "meadow").pathIds })
    `, pkg);
    expect(errors).toEqual([]);
    expect(out).toMatchObject({ enemies: 8, towers: 5, waves: 4, levels: 3, campaign: 3, cached: true, grid: 15, thorn: 50 });
    expect(out.paths.length).toBeGreaterThan(0);
  });

  it("content validates against the kit schemas (and the validator catches mistakes)", () => {
    expect(validateContent(pkg)).toEqual([]);
    const bad = pkg.with("data/towers/oops.json", JSON.stringify({ cost: "cheap", rnage: 2, targeting: "random", branches: [{}, {}, {}] }));
    const issues = validateContent(bad).join("\n");
    expect(issues).toMatch(/oops.json: \$.cost: expected number/);
    expect(issues).toMatch(/unknown key "rnage"/);
    expect(issues).toMatch(/targeting: must be one of/);
    expect(issues).toMatch(/at most 2 items/);
  });

  it("runs on the engine's native @kit resolver (no flattening)", async () => {
    const game = await Game.load(pkg, { seed: 5 });
    for (let i = 0; i < 30; i++) game.step();
    const btn = [...game.world.walk()].find((e) => e.type === "UIButton" && /Mossy Meadow/.test(String(e.get("text"))))!;
    game.press(btn.id);
    for (let i = 0; i < 30; i++) game.step();
    expect(game.world.byId.has("meadow_map")).toBe(true);
    expect(game.errors.map((e) => `${e.script}:${e.line}: ${e.message}`)).toEqual([]);
  });

  it("has the promised content: 3 levels, 5 towers × 2 branches, 6+ enemy types + a boss", () => {
    const towers = pkg.paths("data/towers/").map((p) => JSON.parse(pkg.text(p)!));
    expect(towers).toHaveLength(5);
    for (const t of towers) expect(t.branches).toHaveLength(2);
    const enemies = pkg.paths("data/enemies/").map((p) => JSON.parse(pkg.text(p)!));
    expect(enemies.length).toBeGreaterThanOrEqual(7);
    expect(enemies.filter((e) => e.boss)).toHaveLength(1);
    expect(JSON.parse(pkg.text("data/campaign.json")!).levels).toHaveLength(3);
  });

  it("boots headless, taps build + upgrade a tower and plays a wave without script errors", async () => {
    const host = new MemorySaveHost();
    const game = await Game.load(pkg, { seed: 3, save: host, budgetMs: 2000 });
    const run = (n: number) => { for (let i = 0; i < n; i++) game.step(); };
    run(10);
    // title: first level button
    const btn = [...game.world.walk()].find((e) => e.type === "UIButton" && /Mossy Meadow/.test(String(e.get("text"))));
    expect(btn).toBeTruthy();
    game.press(btn!.id);
    run(5);
    expect(game.world.byId.has("meadow_map")).toBe(true);
    // map at (8,112), 64px tiles: plot (4,1) → world center (8+4.5*64, 112+1.5*64)
    const at = (c: number, r: number): [number, number] => [8 + (c + 0.5) * 64, 112 + (r + 0.5) * 64];
    game.tapScreen(...at(4, 1));
    run(15);
    const items = () => [...game.world.walk()].filter((e) => e.type === "Text2D" && e.get("z_index") === 2).map((e) => String(e.get("text")));
    expect(items()).toEqual(expect.arrayContaining(["50", "80"])); // build menu: thorn 50, acorn 80
    // radial items: first slot (top) is the cheapest tower → tap twice (preview, confirm)
    const slot = (i: number, n: number, cx: number, cy: number) => {
      const R = 1.15, mx = Math.min(Math.max(cx, R + 0.5), 11 - R - 0.5), my = Math.min(Math.max(cy, R + 0.5), 15 - R - 0.5);
      const a = -Math.PI / 2 + i * (2 * Math.PI / n);
      return [8 + (mx + Math.cos(a) * R) * 64, 112 + (my + Math.sin(a) * R) * 64] as [number, number];
    };
    game.tapScreen(...slot(0, 2, 4.5, 1.5));
    run(5);
    expect(items()).toContain("OK?");
    game.tapScreen(...slot(0, 2, 4.5, 1.5));
    run(5);
    const hud = () => [...game.world.walk()].filter((e) => e.type === "UIText").map((e) => String(e.get("text")));
    expect(hud()).toContain("150"); // 200 - 50
    // tap the tower → tower menu, upgrade (2 taps on slot 0 of 3: upgrade, targeting, sell)
    game.tapScreen(...at(4, 1));
    run(15);
    game.tapScreen(...slot(0, 3, 4.5, 1.5));
    run(3);
    game.tapScreen(...slot(0, 3, 4.5, 1.5));
    run(5);
    expect(hud()).toContain("105"); // 150 - 45
    // start the wave, let it run 20 s at 3x
    const next = [...game.world.walk()].find((e) => e.type === "UIButton" && /START/.test(String(e.get("text"))))!;
    game.press(next.id);
    const speed = [...game.world.walk()].find((e) => e.type === "UIButton" && String(e.get("text")) === "1x")!;
    game.press(speed.id); game.press(speed.id);
    expect(game.timeScale).toBe(3); // sim speed drives game.timeScale (visuals fast-forward too)
    run(60 * 20);
    expect(game.errors.map((e) => `${e.script}:${e.line}: ${e.message}`)).toEqual([]);
    const enemiesOrKills = hud().some((t) => /^\d+\/8$/.test(t));
    expect(enemiesOrKills).toBe(true);
  });

  it("balance sim: every campaign level is winnable by the reference build", async () => {
    const r = await balance(pkg, { endlessWaves: 30 });
    console.log(r.levels.map((l) => `${l.level}: won=${l.won} lives ${l.lives}/${l.maxLives} stars ${l.stars} (${l.seconds}s sim, spent ${l.spent})`).join("\n") + `\nendless: ${r.endless?.wavesSurvived} waves\nproblems: ${r.problems.join("; ") || "none"}`);
    expect(r.levels).toHaveLength(3);
    for (const l of r.levels) expect(l.won).toBe(true);
    expect(r.levels[0]!.stars).toBe(3); // first level is the gentle one
    expect(r.endless!.wavesSurvived).toBeGreaterThanOrEqual(5);
  });
});
