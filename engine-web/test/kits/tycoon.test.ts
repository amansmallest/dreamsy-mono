// tycoon kit: headless core tests (economy math, milestones, prestige, offline, save) + example package + balance sim.
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { Package } from "@dreamsy/format";
import { beforeAll, describe, expect, it } from "vitest";
import { Game, MemorySaveHost } from "../../core/index.js";
import { balance, runLuau } from "../../../kits/tycoon/harness.js";

const EXAMPLE = resolve(__dirname, "../../../games/examples/kit-tycoon");

// small hand-made content used by most tests
const CONTENT = `{
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
}`;

async function lua(body: string, opts: Parameters<typeof runLuau>[2] = {}) {
  const r = await runLuau(`local Tycoon = require("@kit/tycoon")\nlocal content = ${CONTENT}\nlocal out = {}\n${body}\nsave.set("out", out)`, undefined, opts);
  expect(r.errors).toEqual([]);
  return r.out as Record<string, any>;
}

describe("tycoon: number formatting", () => {
  it("K/M/B/T then letters, durations", async () => {
    const o = await lua(`
      local F = Tycoon.format
      out.a = { F(0), F(7), F(12.345), F(999), F(1000), F(1234), F(12345), F(123456), F(1.5e6), F(2.25e9), F(3e12),
                F(1e15), F(1e18), F(4.56e17), F(1e93), F(-2500), F(1234, { notation = "scientific" }), F(1500, { trim = true }) }
      out.s = { Tycoon.suffix(5), Tycoon.suffix(6), Tycoon.suffix(30), Tycoon.suffix(5 + 26 * 26) }
      out.d = { Tycoon.duration(42), Tycoon.duration(185), Tycoon.duration(3725), Tycoon.duration(90000) }
    `);
    expect(o.a).toEqual(["0", "7", "12.3", "999", "1.00K", "1.23K", "12.3K", "123K", "1.50M", "2.25B", "3.00T",
      "1.00aa", "1.00ab", "456aa", "1.00ba", "-2.50K", "1.23e3", "1.5K"]);
    expect(o.s).toEqual(["aa", "ab", "az", "e2043"]);
    expect(o.d).toEqual(["42s", "3m 05s", "1h 02m", "1d 01h"]);
  });
});

describe("tycoon: generators", () => {
  it("geometric cost curve, buy ×1/×10/max (closed form = brute force), output", async () => {
    const o = await lua(`
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
    `);
    expect(o.c1).toBeCloseTo(4);
    expect(o.c10).toBeCloseTo(o.brute10, 6);
    expect(o.maxCost).toBeLessThanOrEqual(1000);
    expect(o.maxPlus).toBeGreaterThan(1000);
    expect(o.buy10).toBe(true);
    expect(o.owned).toBe(10);
    expect(o.left).toBeCloseTo(1000 - o.c10, 6);
    expect(o.buyMax).toBe(true);
    expect(o.after).toBeLessThan(o.c1 * 1.07 ** o.owned2);
    expect(o.unlockedLater).toBe(true); // 5 lemons unlock the stand
    expect(o.rate).toBeCloseTo(o.owned2 * 1 * 1.5 * (o.owned2 >= 25 ? 2 : 1), 6); // achievement ×1.5 at 10 lemons
    expect(o.noMoney).toBe(false);
    expect(o.gemCost).toBe(300); // growth 1 → linear
  });

  it("milestones double output at owned counts and fire signals; upgrades + speed + managers", async () => {
    const o = await lua(`
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
    `);
    expect(o.r24).toBeCloseTo(1.5);
    expect(o.r25).toBeCloseTo(3);
    expect(o.r50).toBeCloseTo(6);
    expect(Object.values(o.ms)).toEqual(["lemon@25x2", "lemon@50x2"]);
    expect(o.next).toBeUndefined();
    expect(o.upAvail).toBe(true);
    expect(o.r50j).toBeCloseTo(18);
    expect(o.cyc).toBe(1);
    expect(o.cycFast).toBe(0.5);
    expect(o.autoBefore).toBe(false);
    expect(o.idle).toBe(0); // the manual stand doesn't run until tapped
    expect(o.ran).toBe(true);
    expect(o.standPaid).toBe(true);
    expect(o.hired).toBe(true);
    expect(o.autoAfter).toBe(true);
  });

  it("taps scale with income; events spawn deterministically, boost output, expire", async () => {
    const o = await lua(`
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
    `);
    expect(o.tap0).toBe(1);
    expect(o.tap1).toBeCloseTo(1 + o.income * 0.1);
    expect(o.spawned[0] ?? o.spawned[1]).toEqual(["rush", 10]);
    expect(o.claimed).toBe("rush");
    expect(o.boosted).toBeCloseTo(3);
    expect(o.after).toBeCloseTo(1);
    expect(Object.values(o.expired)[0]).toBe(50);
  });
});

describe("tycoon: prestige", () => {
  it("gain = floor(scale·(allTime/threshold)^exp) − claimed; resets the run; keeps permanent upgrades + achievements", async () => {
    const o = await lua(`
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
    `);
    expect(o.can0).toBe(false);
    expect(o.gain).toBe(10);
    expect(o.needed).toBeCloseTo(1e6 * (11 / 10) ** 2, 0);
    expect(o.did).toBe(10);
    expect(Object.values(o.events)).toEqual(["star:10"]);
    expect(o.stars).toBe(10);
    expect(o.coins).toBe(10); // back to start
    expect(o.lemons).toBe(0);
    expect(o.ach).toBe(true);
    expect(o.bonus).toBeCloseTo(2); // 10 stars × 0.1
    expect(o.gainAfter).toBe(0);
    expect(o.cheap).toBe(true);
    expect(o.starsLeft).toBe(8);
    expect(o.lemonCost).toBeCloseTo(2); // permanent cost ×0.5
    expect(o.gain2).toBe(10);
    expect(o.keptCheap).toBe(true);
    expect(o.claimed).toBe(20);
    expect(o.count).toBe(2);
  });
});

describe("tycoon: offline progress + save", () => {
  it("credits automated production since the save timestamp, capped and scaled", async () => {
    const o = await lua(`
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
    `, { clock: () => 1234 });
    expect(o.short).toBeUndefined();
    expect(o.earned).toBeCloseTo(o.expect, 6);
    expect(o.delta).toBeCloseTo(o.expect, 6);
    expect(o.credited).toBe(3600); // cap_hours = 1
    expect(o.clock).toBe(1234); // engine clock.now()
  });

  it("persist → relaunch later (clock.now) credits offline progress through Tycoon.restore", async () => {
    const T0 = 1_800_000_000;
    let now = T0;
    const save = new MemorySaveHost();
    const clock = () => now;
    const first = await lua(`
      local t = Tycoon.restore(content, "k")
      t:add("coins", 1000)
      t:buy("lemon", 10)
      out.rate = t:rate("lemon")
      Tycoon.persist(t, "k")
    `, { clock, save });
    expect((save.data.k as any).savedAt).toBe(T0);
    const relaunch = async () => (await lua(`
      local t, r = Tycoon.restore(content, "k")
      out.report = r
      out.coins = t:get()
      Tycoon.persist(t, "k")
    `, { clock, save: new MemorySaveHost({ ...save.data }) }));
    now = T0 + 30; // < min_seconds
    expect((await relaunch()).report).toBeUndefined();
    now = T0 + 600;
    const b = await relaunch();
    expect(b.report.seconds).toBe(600);
    expect(b.report.earned.coins).toBeCloseTo(first.rate * 600 * 0.5, 6);
    now = T0 + 10 * 3600;
    const c = await relaunch();
    expect(c.report.credited).toBe(3600); // capped at cap_hours
    expect(c.report.earned.coins).toBeCloseTo(first.rate * 3600 * 0.5, 6);
  });

  it("bindSave stores the state as a core.save section", async () => {
    const o = await lua(`
      local core = require("@kit/core")
      local t = Tycoon.bindSave(Tycoon.new(content))
      t:add("coins", 500) t:buy("lemon", 7)
      core.save.save()
      local t2 = Tycoon.bindSave(Tycoon.new(content))
      out.loaded = core.save.load()
      out.lemons = t2.owned.lemon
    `, { clock: () => 5000 });
    expect(o.loaded).toBe(true);
    expect(o.lemons).toBe(7);
  });

  it("serialize → save.set → relaunch → restore round-trips the whole state", async () => {
    const host = new MemorySaveHost();
    const files = {
      "dreamsy.toml": `format = "0"\nname = "rt"\ndimension = "2d"\norientation = "portrait"\nentry_scene = "scenes/m.scene.json"\nkits = ["tycoon"]\n[style]\npreset = "clean"\n`,
      "scenes/m.scene.json": JSON.stringify({ format: "0", root: "w", entities: { w: { type: "Node2D" } } }),
      "scripts/shared/content.luau": `return ${CONTENT}`,
    };
    const first = Package.fromFiles({ ...files, "scripts/client/a.luau": `
      local Tycoon = require("@kit/tycoon")
      local t = Tycoon.restore(require("../shared/content"), "k")
      t:add("coins", 5e6)
      t:buy("lemon", 30) t:buyUpgrade("juicer") t:buyUpgrade("fast")
      t:tap() t:step(12.5)
      t:doPrestige() t:add("coins", 2000) t:buy("lemon", 5) t:buy("stand", 2) t:run("stand") t:step(0.5)
      t:claimEvent()
      Tycoon.persist(t, "k", 777)
      save.set("before", t:serialize(777))
    ` });
    // relaunch 30 s later (< offline.min_seconds): nothing is credited, so the state must round-trip exactly
    const g1 = await Game.load(first, { save: host, clock: () => 777 });
    g1.step();
    expect(g1.errors).toEqual([]);
    const second = Package.fromFiles({ ...files, "scripts/client/a.luau": `
      local Tycoon = require("@kit/tycoon")
      local t = Tycoon.restore(require("../shared/content"), "k")
      save.set("after", t:serialize(777))
    ` });
    const h2 = new MemorySaveHost(host.data);
    const g3 = await Game.load(second, { save: h2, clock: () => 807 });
    g3.step();
    expect(h2.data.after).toEqual(host.data.before);
    expect((host.data.before as any).prestige.star.count).toBe(1);
    expect(JSON.stringify(host.data.k).length).toBeLessThan(64 * 1024);
  });

  it("content errors are clear", async () => {
    const r = await runLuau(`require("@kit/tycoon").new({ generators = { a = { output = 1 } } })`);
    expect(r.errors.join("\n")).toMatch(/generator a needs cost = \{ base/);
    const r2 = await runLuau(`require("@kit/tycoon").new({ generators = { a = { output = 1, cost = { base = 1 } } }, upgrades = { u = { cost = { amount = 1 }, effect = { kind = "output", target = "zz", value = 2 } } } })`);
    expect(r2.errors.join("\n")).toMatch(/upgrade u: effect target 'zz' is not a generator/);
  });
});

describe("tycoon: example package (Crumbtown Bakery)", () => {
  let pkg: Package;
  beforeAll(async () => { pkg = await Package.fromDir(EXAMPLE); });

  it("has 8 generators, 15 upgrades, 1 prestige layer; Tycoon.new() reads them from data/", async () => {
    expect(pkg.paths("data/generators/").length).toBe(8);
    expect(pkg.paths("data/upgrades/").length).toBe(15);
    expect(JSON.parse(pkg.text("data/tycoon.json")!).prestige.length).toBe(1);
    const r = await runLuau(`
      local c = require("@kit/tycoon").new().content
      save.set("out", { gens = c.genOrder, upgrades = #c.upgradeOrder, ach = #c.achievementOrder, events = #c.eventOrder,
        layers = c.layerOrder, main = c.main, first = c.generators[c.genOrder[1]].name })`, pkg);
    expect(r.errors).toEqual([]);
    expect(r.out.gens.length).toBe(8);
    expect(r.out.gens[0]).toBe("muffin_tin");
    expect(r.out.upgrades).toBe(15);
    expect(r.out.ach).toBe(pkg.paths("data/achievements/").length);
    expect(r.out.events).toBe(pkg.paths("data/events/").length);
    expect(r.out.layers.length).toBe(1);
  });

  it("data reader: id must match the file name", async () => {
    const r = await runLuau(`require("@kit/tycoon").new()`, undefined, {
      files: { "data/generators/a.json": JSON.stringify({ id: "b", cost: { base: 1 }, output: 1 }) },
    });
    expect(r.errors.join("\n")).toMatch(/data\/generators\/a\.json: id "b" must match the file name/);
  });

  it("boots headless and plays by taps without script errors", async () => {
    const host = new MemorySaveHost();
    const g = await Game.load(pkg, { seed: 1, save: host });
    const tap = (x: number, y: number) => g.tapScreen(x, y);
    const run = (n: number) => { for (let i = 0; i < n; i++) g.step(); };
    run(5);
    for (let i = 0; i < 40; i++) { tap(360, 270); run(3); } // cupcake
    tap(578, 424 + 80); run(5); // buy muffin tin
    tap(578, 424 + 80); run(5);
    tap(68, 424 + 80); run(60); // icon: manual bake
    tap(620, 230); run(2); // buy mode → ×10
    tap(620, 230); run(2); // → max
    tap(578, 424 + 80); run(5);
    // scroll the list by dragging
    for (let y = 1000; y > 600; y -= 40) { g.input.pointer = [360, y]; run(1); }
    g.input.pointer = null; run(30);
    tap(535, 1135); run(10); // ▼ MORE page button
    tap(185, 1135); run(10); // ▲ UP
    for (const x of [8 + 178 + 85, 8 + 2 * 178 + 85, 8 + 3 * 178 + 85, 93]) { tap(x, 1220); run(20); }
    run(400);
    expect(g.errors.map((e) => `${e.script}:${e.line}: ${e.message}`)).toEqual([]);
    const texts = [...g.world.walk()].filter((e) => e.type === "UIText" && g.effectiveVisible(e)).map((e) => String(e.get("text")));
    expect(texts.some((s) => /Muffin Tin/.test(s))).toBe(true);
    expect(host.data.bakery).toBeDefined();
    const saved = host.data.bakery as any;
    expect(saved.owned.muffin_tin).toBeGreaterThan(0);
    expect(saved.stats.taps).toBeGreaterThanOrEqual(40);
  });

  it("balance sim: first prestige in 15–45 min, all content within 2 h, no long stalls", async () => {
    const r = await balance(pkg, { hours: 2 });
    const min = (s: number | null) => (s == null ? null : +(s / 60).toFixed(1));
    console.log(`kit-tycoon balance: firstPrestige ${min(r.firstPrestige)}m, prestiges ${r.prestiges.map((p) => `${min(p.t)}m:+${p.gain}`).join(" ")}, ` +
      `all generators ${min(r.allGeneratorsAt)}m, all upgrades ${min(r.allUpgradesAt)}m, purchases ${r.purchases}, ` +
      `gaps median ${r.gaps.median}s p90 ${r.gaps.p90}s max ${r.gaps.max}s, stalls ${r.stalls.length}\n  first buys: ` +
      Object.entries(r.firstBuy).sort((a, b) => a[1] - b[1]).map(([k, v]) => `${k} ${min(v)}m`).join(", "));
    expect(r.firstPrestige).not.toBeNull();
    expect(r.firstPrestige!).toBeGreaterThan(15 * 60);
    expect(r.firstPrestige!).toBeLessThan(45 * 60);
    expect(r.allGeneratorsAt).not.toBeNull();
    expect(r.allUpgradesAt!).toBeLessThan(2 * 3600);
    expect(r.stalls).toEqual([]);
    expect(r.gaps.max).toBeLessThan(180);
  });

  it("schemas exist for every content kind", () => {
    for (const s of ["tycoon", "generator", "upgrade", "achievement", "event"]) {
      const j = JSON.parse(readFileSync(resolve(__dirname, `../../../kits/tycoon/schemas/${s}.json`), "utf8"));
      expect(j.$schema).toMatch(/json-schema/);
    }
  });
});
