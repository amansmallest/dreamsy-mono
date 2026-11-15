// survival kit (engine-web/kits/survival): headless tests through real Luau + the example package + balance sim.
import { resolve, join, relative } from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { Package } from "@dreamsy/format";
import { describe, expect, it } from "vitest";
import { Game, MemorySaveHost } from "../../core/index.js";
import { simulate } from "../../tools/playtest.js";

const EXAMPLE = resolve(__dirname, "../../../games/examples/kit-survival");

const scene = JSON.stringify({ format: "0", root: "world", entities: { world: { type: "Node2D" } } });
function kitGame(script: string, files: Record<string, string> = {}) {
  return Package.fromFiles({
    "dreamsy.toml": `format = "0"\nname = "K"\ndimension = "2d"\norientation = "portrait"\nentry_scene = "scenes/main.scene.json"\nkits = ["survival"]\n`,
    "scenes/main.scene.json": scene,
    "scripts/client/main.luau": script,
    ...files,
  });
}
async function run(script: string, opts: { steps?: number; save?: MemorySaveHost } = {}) {
  const g = await Game.load(kitGame(script), { save: opts.save, budgetMs: 4000 });
  for (let i = 0; i < (opts.steps ?? 2); i++) g.step();
  const errs = g.errors.map((e) => `${e.script}:${e.line}: ${e.message}`);
  const logs = g.logs.map((l) => l.text).filter((l) => !l.startsWith("[validate]"));
  return { g, errs, logs };
}
const PRE = `
local fails = 0
local function check(name, c, extra) if c then print("ok " .. name) else fails += 1 print("FAIL " .. name .. " " .. tostring(extra)) end end
local function eq(name, a, b) check(name, a == b, tostring(a) .. " ~= " .. tostring(b)) end
local S = require("@kit/survival")
local core = require("@kit/core")
local RAW = {
  config = {
    world = { w = 32, h = 32, tile = 48, seed = 11, scale = 0.09, island = 0.4 },
    biomes = {
      { id = "water", char = "~", maxE = 0.3, walkable = false, temp = 12 },
      { id = "forest", char = "f", minM = 0.58, temp = 16, nodes = { tree = 0.16, iron = 0.03, bush = 0.03 } },
      { id = "meadow", char = "g", temp = 22, nodes = { tree = 0.05, rock = 0.04, bush = 0.04, puddle = 0.03 } },
    },
    day = { length = 200, night = 0.35, start = 0.05, nightTemp = -12 },
    death = { drop = "half", keepTools = true, respawn = "bed" },
    start = { items = { berries = 2 } },
    milestones = { { id = "pick", item = "stone_pick" }, { id = "bench", structure = "workbench" }, { id = "fire", structure = "campfire" }, { id = "iron", item = "iron_pick" } },
  },
  nodes = {
    { id = "tree", tile = "T", hp = 3, tool = "axe", tier = 0, drops = { { item = "wood", count = { 2, 3 } } }, respawn = 120 },
    { id = "rock", tile = "R", hp = 4, tool = "pick", tier = 1, drops = { { item = "stone", count = 2 } } },
    { id = "iron", tile = "I", hp = 6, tool = "pick", tier = 2, drops = { { item = "ore", count = { 1, 2 } } } },
    { id = "bush", tile = "B", hp = 1, drops = { { item = "berries", count = 2 } }, respawn = 60 },
    { id = "puddle", tile = "P", hp = 1, solid = false, drops = { { item = "water", count = 1 } }, respawn = 30 },
  },
  items = {
    { id = "wood" }, { id = "stone" }, { id = "ore" }, { id = "iron_bar" },
    { id = "berries", data = { food = { hunger = 15 } } }, { id = "water", data = { food = { thirst = 30 } } },
    { id = "stone_axe", stack = 1, data = { tool = { kind = "axe", tier = 1, power = 2 } } },
    { id = "stone_pick", stack = 1, data = { tool = { kind = "pick", tier = 1, power = 2 } } },
    { id = "iron_pick", stack = 1, data = { tool = { kind = "pick", tier = 2, power = 3 } } },
    { id = "workbench_kit", data = { place = "workbench" } }, { id = "campfire_kit", data = { place = "campfire" } },
    { id = "wall_kit", data = { place = "wall" } }, { id = "door_kit", data = { place = "door" } }, { id = "bed_kit", data = { place = "bed" } },
  },
  recipes = {
    { id = "stone_pick", needs = { wood = 3 } },
    { id = "stone_axe", needs = { wood = 2, stone = 1 } },
    { id = "workbench_kit", needs = { wood = 5 } },
    { id = "campfire_kit", needs = { wood = 3, stone = 2 } },
    { id = "wall_kit", needs = { wood = 2 }, station = "workbench" },
    { id = "door_kit", needs = { wood = 3 }, station = "workbench" },
    { id = "bed_kit", needs = { wood = 4, berries = 2 }, station = "workbench" },
    { id = "iron_bar", needs = { ore = 2 }, station = "campfire" },
    { id = "iron_pick", needs = { iron_bar = 2, wood = 2 }, station = "workbench" },
  },
  structures = {
    { id = "workbench", tile = "K", kind = "station", radius = 2 },
    { id = "campfire", tile = "F", kind = "fire", warmth = 15, radius = 3 },
    { id = "wall", tile = "W", kind = "wall", hp = 20 },
    { id = "door", tile = "D", kind = "door", adjacent = "wall" },
    { id = "bed", tile = "Z", kind = "bed", limit = 1 },
  },
  enemies = { { id = "shade", cost = 1, behavior = "chase" }, { id = "brute", cost = 3, minLevel = 2, behavior = "chase" } },
  nights = { { night = 1, budget = 3, enemies = { "shade" } }, { night = 2, budget = 5 }, { night = 3, budget = 8, boss = "brute" } },
  pois = { { id = "ruins", tile = "X", count = 2, minDist = 6, loot = { { item = "ore", count = 2 } } } },
}
local C = S.content.normalize(RAW)
local function findNode(s, kind)
  for _, n in s.world.nodes do if n.id == kind and n.hp > 0 then return n end end
end
local function freeCell(s, avoid)
  local p = s.player
  for r = 1, 10 do for dy = -r, r do for dx = -r, r do
    local x, y = p.x + dx, p.y + dy
    if s:passable(x, y) and not s:structureAt(x, y) and not s:poiAt(x, y) and not s.world.nodeAt[s:idx(x, y)] and not (avoid and avoid(x, y)) then return x, y end
  end end end
end
`;
const noFails = (r: { errs: string[]; logs: string[] }) => {
  if (r.errs.length || r.logs.some((l) => l.startsWith("FAIL"))) console.log(r.logs.join("\n"), r.errs);
  expect(r.errs).toEqual([]);
  expect(r.logs.filter((l) => l.startsWith("FAIL"))).toEqual([]);
  expect(r.logs.filter((l) => l.startsWith("ok ")).length).toBeGreaterThan(0);
};

describe("survival kit: rules", () => {
  it("gathering: tool kinds + tiers, power sets hits, drops, respawn", async () => {
    noFails(await run(PRE + `
      local s = S.new(C, { seed = 11 })
      local tree = findNode(s, "tree")
      check("has tree", tree ~= nil)
      local r = s:gather(tree.x, tree.y)
      check("hands chop tier-0 tree", r.ok and r.broken) eq("hand hits", r.hits, 3)
      local w = s.bag:count("wood") check("wood 2..3", w >= 2 and w <= 3, w)
      check("depleted", s:nodeAt(tree.x, tree.y) == nil)
      s:tick(121) check("respawned", s:nodeAt(tree.x, tree.y) ~= nil)
      local rock = findNode(s, "rock")
      local ok, why = s:canGather(rock.x, rock.y) eq("rock needs pick", why, "tool")
      s.bag:add("stone_pick", 1)
      eq("pick hits", s:hitsFor("rock"), 2)
      r = s:gather(rock.x, rock.y) check("rock with pick", r.ok and r.broken) eq("stone", s.bag:count("stone"), 2)
      local iron = findNode(s, "iron")
      ok, why = s:canGather(iron.x, iron.y) eq("iron needs tier 2", why, "tier")
      s.bag:add("iron_pick", 1)
      local _, t = s:bestTool("pick") eq("best tool tier", t.tier, 2)
      eq("iron hits", s:hitsFor("iron"), 2)
      r = s:gather(iron.x, iron.y) check("iron ok", r.ok and r.broken)
      s.bag:add("stone_axe", 1) eq("axe halves tree hits", s:hitsFor("tree"), 2)
    `));
  });

  it("recipe tree: analysis, raw costs, stations, missing items", async () => {
    noFails(await run(PRE + `
      local a = S.recipes.analyze(C)
      check("tree ok", a.ok, table.concat(a.problems, "; "))
      eq("pick depth", a.recipeDepth.stone_pick, 1)
      check("iron pick deepest", a.recipeDepth.iron_pick == a.maxDepth, a.recipeDepth.iron_pick)
      check("axe after pick", a.recipeDepth.stone_axe > a.recipeDepth.stone_pick)
      local raw = S.recipes.raw(C, "iron_pick")
      eq("raw ore", raw.ore, 4) eq("raw wood", raw.wood, 2)
      -- broken content is reported
      local bad = S.content.normalize({ config = RAW.config, nodes = RAW.nodes, structures = RAW.structures,
        recipes = { { id = "gold_pick", needs = { gold = 1 } }, { id = "stone_pick", needs = { wood = 3 } } } })
      local ba = S.recipes.analyze(bad)
      check("unknown item reported", not ba.ok and string.find(table.concat(ba.problems, ";"), "unknown item gold") ~= nil)
      local s = S.new(C, { seed = 11 })
      local ok, why, missing = s:canCraft("stone_pick") eq("missing", why, "items") eq("missing wood", missing[1].need, 3)
      s.bag:add("wood", 20) s.bag:add("stone", 4)
      check("craft pick", s:craft("stone_pick")) eq("pick owned", s.bag:count("stone_pick"), 1) eq("wood used", s.bag:count("wood"), 17)
      ok, why = s:canCraft("wall_kit") eq("needs station", why, "station")
      s:craft("workbench_kit")
      local x, y = freeCell(s)
      check("place bench", s:place("workbench", x, y) ~= nil)
      s:setPlayer(x + 1, y)
      check("craft wall at bench", s:craft("wall_kit"))
      s:setPlayer(x + 5, y + 5) ok, why = s:canCraft("wall_kit") eq("too far", why, "station")
      local list = s:recipeList() eq("list size", #list, #C.recipes) eq("list order first", list[1].id, "stone_pick")
    `));
  });

  it("placement rules: terrain, occupied, player, adjacency, limit, item, reach", async () => {
    noFails(await run(PRE + `
      local s = S.new(C, { seed = 11 })
      local wx, wy
      for y = 0, s.world.h - 1 do for x = 0, s.world.w - 1 do if wx == nil and s:biomeAt(x, y).walkable == false then wx, wy = x, y end end end
      local _, why = s:canPlace("wall", wx, wy, { free = true }) eq("water", why, "terrain")
      _, why = s:canPlace("wall", -1, 0, { free = true }) eq("bounds", why, "bounds")
      local n = findNode(s, "tree") _, why = s:canPlace("wall", n.x, n.y, { free = true }) eq("node", why, "occupied")
      _, why = s:canPlace("wall", s.player.x, s.player.y, { free = true }) eq("player", why, "player")
      local x, y = freeCell(s)
      _, why = s:canPlace("wall", x, y) eq("needs item", why, "item")
      s.bag:add("wall_kit", 2)
      check("place wall", s:place("wall", x, y) ~= nil) eq("item used", s.bag:count("wall_kit"), 1)
      _, why = s:canPlace("wall", x, y, { free = true }) eq("occupied by wall", why, "occupied")
      check("wall blocks", not s:passable(x, y))
      local fx, fy = freeCell(s, function(cx, cy) return math.abs(cx - x) + math.abs(cy - y) <= 1 end)
      _, why = s:canPlace("door", fx, fy, { free = true }) eq("door needs wall", why, "adjacent")
      local dx, dy
      for _, d in { {1,0},{-1,0},{0,1},{0,-1} } do
        if dx == nil and s:canPlace("door", x + d[1], y + d[2], { free = true }) then dx, dy = x + d[1], y + d[2] end
      end
      check("door next to wall", dx ~= nil and s:place("door", dx, dy, { free = true }) ~= nil)
      check("door: player passes, enemies don't", s:passable(dx, dy) and not s:passable(dx, dy, true))
      local bx, by = freeCell(s)
      s:place("bed", bx, by, { free = true })
      local b2x, b2y = freeCell(s)
      _, why = s:canPlace("bed", b2x, b2y, { free = true }) eq("limit", why, "limit")
      _, why = s:canPlace("wall", s.player.x + 9, s.player.y, { free = true, reach = 2 })
      check("reach (or terrain)", why == "reach" or why == "terrain" or why == "occupied" or why == "bounds", why)
      check("remove refunds", s:removeStructure(x, y) ~= nil and s.bag:count("wall_kit") == 2)
      local st = s:place("wall", x, y, { free = true })
      check("damage", not s:damageStructure(x, y, 5)) check("destroy", s:damageStructure(x, y, 50)) check("gone", s:structureAt(x, y) == nil)
    `));
  });

  it("needs decay, starvation damage, food, temperature + campfire, death/respawn rules", async () => {
    noFails(await run(PRE + `
      local s = S.new(C, { seed = 11 })
      s:tick(60)
      check("hunger -2/min", math.abs(s.needs.hunger - 98) < 0.01, s.needs.hunger)
      check("thirst -3/min", math.abs(s.needs.thirst - 97) < 0.01, s.needs.thirst)
      s.needs.hunger = 10 check("eat", s:consume("berries")) eq("hunger +15", s.needs.hunger, 25)
      check("inedible", not s:consume("wood"))
      -- temperature at night
      local day = s:temperatureAt(s.player.x, s.player.y)
      s.time = s.cfg.day.length * 0.8 check("night", s:isNight())
      local night = s:temperatureAt(s.player.x, s.player.y)
      eq("night is colder", day - night, 12)
      local fx, fy = freeCell(s)
      s:place("campfire", fx, fy, { free = true })
      eq("fire warms", s:temperatureAt(s.player.x, s.player.y), night + 15)
      -- starvation -> death -> bed respawn, half drop, tools kept
      s:removeStructure(fx, fy)
      local bx, by = freeCell(s) s:place("bed", bx, by, { free = true })
      s.bag:add("wood", 10) s.bag:add("stone_pick", 1)
      s.needs.hunger, s.needs.thirst, s.needs.health = 0, 0, 1
      local died = nil
      core.events.on("player_died", function(d) died = d end)
      s:tick(10)
      check("died", died ~= nil) eq("cause", died and died.cause, "hunger")
      eq("respawn at bed", s.player.x .. "," .. s.player.y, bx .. "," .. by)
      eq("half wood dropped", s.bag:count("wood"), 5) eq("tool kept", s.bag:count("stone_pick"), 1)
      check("health restored", s.needs.health >= 60) eq("deaths", s.stats.deaths, 1)
      local st = s.stashes[1]
      s:setPlayer(st.x, st.y) check("stash recovered", s:collectStash(st.x, st.y) ~= nil) eq("wood back", s.bag:count("wood"), 10)
    `));
  });

  it("night waves: night start/dawn events, budgets grow, spawns away from base on enemy-walkable cells", async () => {
    noFails(await run(PRE + `
      local s = S.new(C, { seed = 11 })
      local nights, dawns = {}, 0
      core.events.on("night_started", function(d) table.insert(nights, d) end)
      core.events.on("dawn", function() dawns += 1 end)
      for i = 1, 3 * 200 do s:tick(1) end
      eq("3 nights", #nights, 3) check("dawns", dawns >= 2, dawns)
      local w1, w3 = nights[1].wave, nights[3].wave
      check("night 1 shades only", #w1.ids >= 1 and table.find(w1.ids, "brute") == nil)
      check("night 3 bigger", #w3.ids > #w1.ids, #w3.ids .. " vs " .. #w1.ids)
      check("boss night 3", table.find(w3.ids, "brute") ~= nil)
      local base = s:base()
      local okAll = true
      for _, sp in w3.spawns do
        local d = math.max(math.abs(sp.x - base.x), math.abs(sp.y - base.y))
        if d < 7 or not s:passable(sp.x, sp.y, true) then okAll = false end
      end
      check("spawn ring", okAll and #w3.spawns == #w3.ids)
      eq("deterministic", #s:nightWave(3).ids, #w3.ids)
      eq("night 5 scaled", s:nightDef(5).budget, math.floor(8 * 1.3 ^ 2 + 0.5))
      eq("survived", s.stats.nightsSurvived, dawns)
    `));
  });

  it("procgen world: connected for many seeds, nodes + POIs reachable, deterministic", async () => {
    noFails(await run(PRE + `
      for seed = 1, 12 do
        local w = S.world.generate(C, seed)
        check("seed " .. seed .. " connected", w.report.ok, table.concat(w.report.problems, "; "))
        check("seed " .. seed .. " has nodes", w.report.nodes > 20, w.report.nodes)
        check("seed " .. seed .. " pois", w.report.pois == 2, w.report.pois)
      end
      local a, b = S.world.generate(C, 5), S.world.generate(C, 5)
      eq("deterministic", a.grid:toString(), b.grid:toString()) eq("same nodes", #a.nodes, #b.nodes)
      local s = S.new(C, { seed = 5 })
      local p = s.world.pois[1]
      local loot = s:discover(p.x, p.y) check("poi loot", loot and loot[1].item == "ore")
      check("poi once", s:discover(p.x, p.y) == nil)
      eq("tile string rows", #string.split(s:tileString(), "\\n"), 32)
    `));
  });

  it("save: serialize/deserialize roundtrip through core.save", async () => {
    const save = new MemorySaveHost();
    noFails(await run(PRE + `
      core.setup({ items = RAW.items, save = { key = "surv_test", version = 1 } })
      local s = S.new(C, { seed = 11 })
      S.bind(s)
      local t = findNode(s, "tree") s:gather(t.x, t.y)
      local x, y = freeCell(s) s:place("campfire", x, y, { free = true })
      s:tick(50) s.needs.hunger = 42
      core.save.save()
      local s2 = S.new(C, { seed = 11 })
      S.bind(s2)
      core.save.load()
      eq("structure restored", s2:structureAt(x, y) and s2:structureAt(x, y).id, "campfire")
      check("node depleted restored", s2:nodeAt(t.x, t.y) == nil)
      eq("needs restored", s2.needs.hunger, 42)
      check("time restored", math.abs(s2.time - s.time) < 0.001)
      check("condition built", core.check({ built = "campfire" }))
    `, { save }));
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

describe("survival kit: example (Ember Isle)", () => {
  it("content is valid, world connected, balance sim reaches every milestone in pace", async () => {
    const pkg = loadDir(EXAMPLE);
    const files: Record<string, Uint8Array | string> = {};
    for (const p of pkg.paths()) files[p] = pkg.bytes(p)!;
    for (const p of Object.keys(files)) if (/^scripts\/(client|server)\//.test(p)) delete files[p];
    files["scenes/main.scene.json"] = scene;
    files["scripts/client/bal.luau"] = `
      local S = require("@kit/survival")
      local C = S.content.load()
      local a = S.recipes.analyze(C)
      print("recipes " .. #C.recipes .. " depth " .. a.maxDepth .. " problems " .. #a.problems .. " " .. table.concat(a.problems, "; "))
      local okSeeds = 0
      for seed = 1, 8 do if S.world.generate(C, seed).report.ok then okSeeds += 1 end end
      print("seeds ok " .. okSeeds)
      local r = S.balance.run(C, {})
      local parts = {}
      for _, m in r.milestones do table.insert(parts, m.id .. "@" .. S.balance.fmt(m.t)) end
      print("milestones " .. table.concat(parts, ", "))
      for _, l in r.log do print("  " .. l) end
      print("missing " .. table.concat(r.missing, ",") .. " deaths " .. r.deaths .. " nights " .. r.nights .. " end " .. S.balance.fmt(r.time))
      save.set("rep", { ok = r.ok, n = #r.milestones, last = (r.milestones[#r.milestones] or { t = 0 }).t, problems = #a.problems, seeds = okSeeds, recipes = #C.recipes, deaths = r.deaths })
    `;
    const save = new MemorySaveHost();
    const g = await Game.load(Package.fromFiles(files), { save, budgetMs: 20000 });
    g.step();
    const logs = g.logs.map((l) => l.text);
    console.log(logs.join("\n"));
    expect(g.errors).toEqual([]);
    const rep = save.data["rep"] as { ok: boolean; n: number; last: number; problems: number; seeds: number; recipes: number; deaths: number };
    expect(rep.problems).toBe(0);
    expect(rep.recipes).toBe(15);
    expect(rep.seeds).toBe(8);
    expect(rep.ok).toBe(true);
    // the example is a ~20-30 min slice: last milestone (night 3 survived) between 10 and 40 min of bot time
    expect(rep.last).toBeGreaterThan(10 * 60);
    expect(rep.last).toBeLessThan(40 * 60);
  });

  it("plays end-to-end headless with zero script errors (move, gather, craft, build, nights)", async () => {
    const pkg = loadDir(EXAMPLE);
    const timeline = [
      { t: 0.5, hold: ["right" as const] }, { t: 1.5, release: ["right" as const] },
      ...Array.from({ length: 30 }, (_, i) => ({ t: 2 + i * 0.5, press: ["action" as const] })),
      { t: 18, hold: ["up" as const] }, { t: 19, release: ["up" as const] },
      ...Array.from({ length: 20 }, (_, i) => ({ t: 19.5 + i * 0.5, press: ["action" as const] })),
      { t: 31, tap: [360, 1180] as [number, number] }, // craft button
      { t: 32, tap: [360, 400] as [number, number] },
      { t: 33, tap: [360, 1180] as [number, number] },
      { t: 34, tap: [120, 1080] as [number, number] }, // hotbar slot
      { t: 35, tap: [400, 600] as [number, number] }, // place attempt
      { t: 40, hold: ["left" as const] }, { t: 42, release: ["left" as const] },
      ...Array.from({ length: 40 }, (_, i) => ({ t: 45 + i * 2, press: ["action" as const] })),
    ];
    const r = await simulate(pkg, timeline, 260, { budgetMs: 2000 });
    if (r.errors.length) console.log(r.errors);
    console.log(r.logs.slice(-15).join("\n"), r.toasts.slice(-10));
    expect(r.loadError).toBeUndefined();
    expect(r.errors).toEqual([]);
    expect(r.logs.some((l) => l.includes("night 1 wave"))).toBe(true);
  });
});
