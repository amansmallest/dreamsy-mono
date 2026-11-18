// simulator kit (engine-web/kits/simulator): headless tests through real Luau + the example package + balance sim.
import { resolve } from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { Package } from "@dreamsy/format";
import { describe, expect, it } from "vitest";
import { Game, MemorySaveHost } from "../../core/index.js";
import { simulate } from "../../tools/playtest.js";

const EXAMPLE = resolve(__dirname, "../../../games/examples/kit-simulator");

const scene = JSON.stringify({ format: "0", root: "world", entities: { world: { type: "Node2D" } } });
function kitGame(script: string, files: Record<string, string> = {}) {
  return Package.fromFiles({
    "dreamsy.toml": `format = "0"\nname = "K"\ndimension = "2d"\norientation = "portrait"\nentry_scene = "scenes/main.scene.json"\nkits = ["simulator"]\n`,
    "scenes/main.scene.json": scene,
    "scripts/client/main.luau": script,
    ...files,
  });
}
async function run(script: string, opts: { steps?: number; save?: MemorySaveHost; files?: Record<string, string>; clock?: () => number } = {}) {
  const g = await Game.load(kitGame(script, opts.files), { save: opts.save, clock: opts.clock, budgetMs: 5000 }); // pure-logic batches (thousands of sims in one callback) under parallel test load: the 250ms frame budget is wall-clock
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
`;
const noFails = (r: { errs: string[]; logs: string[] }) => {
  expect(r.errs).toEqual([]);
  expect(r.logs.filter((l) => l.startsWith("FAIL"))).toEqual([]);
  expect(r.logs.filter((l) => l.startsWith("ok ")).length).toBeGreaterThan(0);
};

describe("simulator kit: economy", () => {
  it("collect / capacity / sell", async () => {
    noFails(await run(PRE + `
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
    `));
  });

  it("gear tracks: order, costs, zone requirement, equip", async () => {
    noFails(await run(PRE + `
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
    `));
  });

  it("zones: order, coin + rebirth gates, conditions via core", async () => {
    noFails(await run(PRE + `
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
    `));
  });

  it("pets: odds sum to 1 and match the hatch distribution; equip slots + bonuses", async () => {
    const r = await run(PRE + `
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
    `);
    noFails(r);
  });

  it("rebirth math: gain, multiplier, slots, keeps pets", async () => {
    noFails(await run(PRE + `
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
    `));
  });

  it("offline earnings use clock.now, capped + rate; save/restore round trip", async () => {
    const save = new MemorySaveHost();
    let now = 1_800_000_000;
    const clock = () => now;
    const SCRIPT = PRE + `
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
    `;
    const a = await run(SCRIPT, { save, clock });
    noFails(a);
    now += 5 * 3600;
    const b = await run(SCRIPT, { save, clock });
    noFails(b);
  });

  it("core quests count simulator events", async () => {
    noFails(await run(PRE + `
      local s = Sim.new(CONTENT)
      Sim.bind()
      core.content.register("quests", { id = "first", autoStart = true, steps = { { id = "a", objectives = { { id = "o", event = "sim_collected", count = 3 } } } },
        rewards = { { earn = "coins", amount = 50 }, { pet = "fox" } } })
      core.quests.evaluate()
      for i = 1, 3 do local n = s:spawnNode() while n.hp > 0 do s:hit(n) end end
      eq("quest done", core.quests.status("first"), "done") eq("reward coins", s:coins(), 50) eq("reward pet", s.pets.fox, 1)
    `));
  });
});

describe("simulator kit: schemas", () => {
  it("every example data file has the schema's required keys and no unknown keys", () => {
    const areas: Record<string, string> = { zones: "zone", tools: "tool", backpacks: "backpack", pets: "pet", eggs: "egg" };
    const check = (file: string, schemaName: string) => {
      const sch = JSON.parse(readFileSync(resolve(__dirname, `../../../kits/simulator/schemas/${schemaName}.json`), "utf8"));
      expect(sch.$schema).toMatch(/json-schema/);
      const obj = JSON.parse(readFileSync(file, "utf8"));
      for (const k of sch.required ?? []) expect(obj, `${file} needs ${k}`).toHaveProperty(k);
      for (const k of Object.keys(obj)) expect(Object.keys(sch.properties), `${file}: unknown key ${k}`).toContain(k);
    };
    check(join(EXAMPLE, "data/simulator.json"), "simulator");
    for (const [area, sch] of Object.entries(areas)) {
      const files = readdirSync(join(EXAMPLE, "data", area));
      expect(files.length).toBeGreaterThan(0);
      for (const f of files) check(join(EXAMPLE, "data", area, f), sch);
    }
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

describe("simulator kit: example (Pebble Pals)", () => {
  it("balance sim: zones unlock in order, first rebirth in range, no dead stretch > 5 min", async () => {
    const pkg = loadDir(EXAMPLE);
    const files: Record<string, Uint8Array | string> = {};
    for (const p of pkg.paths()) files[p] = pkg.bytes(p)!;
    for (const p of Object.keys(files)) if (/^scripts\/(client|server)\//.test(p)) delete files[p];
    files["scenes/main.scene.json"] = scene;
    files["scripts/client/bal.luau"] = `
      local Sim = require("@kit/simulator")
      local C = Sim.content.load()
      local r = Sim.balance.run(C, { hours = 2 })
      local z = {} for _, e in r.zones do table.insert(z, e.id .. "@" .. Sim.balance.fmt(e.t)) end
      print("zones " .. table.concat(z, ", "))
      print("firstRebirth " .. (if r.firstRebirth then Sim.balance.fmt(r.firstRebirth) else "none") .. " rebirths " .. #r.rebirths)
      print("gear " .. #r.gear .. " eggs " .. r.eggs .. " maxGap " .. Sim.balance.fmt(r.gaps.max) .. " at " .. Sim.balance.fmt(r.gaps.at) .. " median " .. Sim.balance.fmt(r.gaps.median))
      print("final mult " .. string.format("%.2f", r.final.mult) .. " pets " .. r.final.pets)
      save.set("rep", { ok = r.ok, stalls = #r.stalls, zones = #r.zones, first = r.firstRebirth or -1, maxGap = r.gaps.max, zt = (function() local t = {} for _, e in r.zones do table.insert(t, e.t) end return t end)() })
    `;
    const save = new MemorySaveHost();
    const g = await Game.load(Package.fromFiles(files), { save });
    g.step();
    const logs = g.logs.map((l) => l.text);
    console.log(logs.join("\n"));
    expect(g.errors).toEqual([]);
    const line = logs.find((l) => l.startsWith("zones "))!;
    expect(new Set(line.slice(6).split(", ").map((x) => x.split("@")[0])).size).toBe(4);
    const first = logs.find((l) => l.startsWith("firstRebirth "))!;
    expect(first).not.toContain("none");
    const gap = logs.find((l) => l.startsWith("gear "))!;
    const m = /maxGap (\d+)m (\d+)s/.exec(gap);
    const maxGap = m ? Number(m[1]) * 60 + Number(m[2]) : 0;
    expect(maxGap).toBeLessThanOrEqual(5 * 60);
  });

  it("plays end-to-end headless with zero script errors (tap, sell, shop, eggs, pets, zones)", async () => {
    const pkg = loadDir(EXAMPLE);
    const r = await simulate(pkg, [
        ...Array.from({ length: 60 }, (_, i) => ({ t: 1 + i * 0.25, tap: [140 + (i % 3) * 220, 420 + Math.floor((i % 6) / 3) * 220] as [number, number] })),
        { t: 17, tap: [110, 1150] }, // sell
        { t: 18, tap: [290, 1150] }, // shop
        { t: 19, tap: [360, 1200] }, // close
        { t: 20, tap: [430, 1150] }, // pets
        { t: 21, tap: [360, 1200] },
        { t: 22, tap: [570, 1150] }, // more
        { t: 23, tap: [360, 1200] },
      ], 40);
    if (r.errors.length) console.log(r.errors);
    expect(r.loadError).toBeUndefined();
    expect(r.errors).toEqual([]);
  });
});
