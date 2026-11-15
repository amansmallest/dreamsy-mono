// procgen kit: determinism per seed, guaranteed connectivity over 200 seeds, puzzle solvability, loot distribution.
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Package } from "@dreamsy/format";
import { Game, MemorySaveHost } from "../../core/index.js";

// Run a Luau client script headless in a fresh package with the given kits; returns save.get("out").
async function runLuau(src: string, opts: { kits?: string[]; steps?: number; files?: Record<string, string>; seed?: number } = {}) {
  const kits = opts.kits ?? ["procgen", "ai", "combat"];
  const files: Record<string, string> = {
    "dreamsy.toml": `format = "0"\nname = "kit test"\ndimension = "2d"\norientation = "portrait"\nentry_scene = "scenes/main.scene.json"\nkits = [${kits.map((k) => `"${k}"`).join(", ")}]\n[style]\npreset = "clean"\n`,
    "scenes/main.scene.json": JSON.stringify({ format: "0", root: "root", entities: { root: { type: "Node2D" } } }),
    ...opts.files,
    "scripts/client/main.luau": src,
  };
  const host = new MemorySaveHost();
  const game = await Game.load(Package.fromFiles(files), { seed: opts.seed ?? 1, save: host, budgetMs: 5000 }); // generous: tests run under load
  for (let i = 0; i < (opts.steps ?? 1); i++) game.step();
  const errors = game.errors.map((e) => `${e.script}:${e.line ?? "?"}: ${e.message}`);
  return { out: host.data.out as any, logs: game.logs.map((l) => l.text), errors, game };
}


// Scripts get a 250 ms budget per callback: heavy loops use forTicks(n, perTick, fn, done) to spread work over frames.
const run = async (src: string, steps = 1) => {
  const r = await runLuau(`local P = require("@kit/procgen")\nlocal function h(s) return P.RNG.hash(s) end
local function forTicks(n, per, fn, done)
  local i = 0
  local conn
  onTick(function()
    if i >= n then return end
    for _ = 1, per do i += 1 if i <= n then fn(i) end end
    if i >= n then done() end
  end)
end
${src}`, { kits: ["procgen"], steps });
  expect(r.errors).toEqual([]);
  return r.out;
};

const TEMPLATES = `{
  start_a = "###########\\n#.........#\\n#.........#\\n#....S....#\\n#.........#\\n#.........#\\n###########",
  room_a  = "###########\\n#..?...?..#\\n#.##...##.#\\n#....E....#\\n#.##...##.#\\n#..?...?..#\\n###########",
  room_b  = "###########\\n#.........#\\n#..#####..#\\n#..#.E.#..#\\n#..#...#..#\\n#.........#\\n###########",
  room_c  = "###########\\n#?.?.?.?.?#\\n#.E.....E.#\\n#?.?.?.?.?#\\n#.........#\\n#?.?.?.?.?#\\n###########",
  key_a   = "###########\\n#.........#\\n#..T...T..#\\n#.........#\\n#.........#\\n#.........#\\n###########",
  exit_boss = "###########\\n#.........#\\n#....B....#\\n#.........#\\n#.........#\\n#.........#\\n###########",
}`;

describe("procgen kit", () => {
  it("rng: deterministic per seed, ranges, weighted pick distribution, shuffle, fork", async () => {
    const out = await run(`
      local a, b, c = P.rng(42), P.rng(42), P.rng(43)
      local same, diff = true, false
      for i = 1, 100 do local x, y, z = a:next(), b:next(), c:next() if x ~= y then same = false end if x ~= z then diff = true end end
      local r = P.rng("hello")
      local lo, hi = 99, -99
      for i = 1, 2000 do local v = r:int(-3, 3) lo = math.min(lo, v) hi = math.max(hi, v) end
      local counts = { a = 0, b = 0, c = 0 }
      for i = 1, 20000 do local k = r:weighted({ a = 1, b = 3, c = 6 }) counts[k] += 1 end
      local s = r:shuffle({ 1, 2, 3, 4, 5, 6, 7, 8 })
      table.sort(s)
      local f1, f2 = P.rng(5):fork("enemies"):next(), P.rng(5):fork("enemies"):next()
      local nv = {}
      for i = 0, 50 do table.insert(nv, P.noise.simplex2(i * 0.37, i * 0.11, 3)) end
      local nmin, nmax = math.min(table.unpack(nv)), math.max(table.unpack(nv))
      save.set("out", { same = same, diff = diff, lo = lo, hi = hi, counts = counts, sorted = table.concat(s, ","), fork = f1 == f2,
        noiseDet = P.noise.value2(1.5, 2.5, 9) == P.noise.value2(1.5, 2.5, 9), nmin = nmin, nmax = nmax, fbm = P.noise.fbm2(3.3, 4.4, { seed = 1 }) })
    `);
    expect(out.same).toBe(true);
    expect(out.diff).toBe(true);
    expect([out.lo, out.hi]).toEqual([-3, 3]);
    expect(out.counts.a / 20000).toBeCloseTo(0.1, 1);
    expect(out.counts.b / 20000).toBeCloseTo(0.3, 1);
    expect(out.counts.c / 20000).toBeCloseTo(0.6, 1);
    expect(out.sorted).toBe("1,2,3,4,5,6,7,8");
    expect(out.fork).toBe(true);
    expect(out.noiseDet).toBe(true);
    expect(out.nmin).toBeGreaterThanOrEqual(-1);
    expect(out.nmax).toBeLessThanOrEqual(1);
    expect(Math.abs(out.fbm)).toBeLessThanOrEqual(1);
  });

  it("dungeon / caves / terrain: deterministic per seed and connected over 200 seeds", async () => {
    const out = await run(`
      local det = P.toTileMap(P.dungeon({ seed = 77 })) == P.toTileMap(P.dungeon({ seed = 77 }))
        and P.toTileMap(P.caves({ seed = 77 })) == P.toTileMap(P.caves({ seed = 77 }))
        and P.toTileMap(P.terrain({ seed = 77 })) == P.toTileMap(P.terrain({ seed = 77 }))
      local differ = P.toTileMap(P.dungeon({ seed = 1 })) ~= P.toTileMap(P.dungeon({ seed = 2 }))
      local bad = {}
      local distinct = {}
      local t0 = os.clock()
      forTicks(200, 2, function(seed)
        local d = P.dungeon({ seed = seed, w = 44, h = 44, rooms = 9 })
        local rep = P.validate(d.grid, { from = d.start, targets = { d.exit } })
        local spawnsOk = true
        for _, s in d.spawns do if d.grid:get(s.x, s.y) ~= "." then spawnsOk = false end end
        if not rep.ok or not spawnsOk or #d.rooms < 4 then table.insert(bad, "dungeon " .. seed) end
        distinct[h(P.toTileMap(d))] = true
        local c = P.caves({ seed = seed, w = 40, h = 40 })
        if not P.validate(c.grid, { from = c.start, targets = { c.exit } }).ok then table.insert(bad, "caves " .. seed) end
        if seed <= 60 then
          local t = P.terrain({ seed = seed, w = 48, h = 48 })
          local walk = function(ch) local b = t.biomes[ch] return b ~= nil and b.walkable ~= false end
          if not P.validate(t.grid, { pass = walk, from = t.start }).ok then table.insert(bad, "terrain " .. seed) end
        end
      end, function()
        local nd = 0 for _ in distinct do nd += 1 end
        save.set("out", { det = det, differ = differ, bad = table.concat(bad, ","), distinct = nd, ms = (os.clock() - t0) * 1000 })
      end)
    `, 110);
    expect(out.det).toBe(true);
    expect(out.differ).toBe(true);
    expect(out.bad).toBe("");
    expect(out.distinct).toBe(200);
  });

  it("room-template stitching: 200 seeds, key reachable before the locked door, exit reachable through it, markers reported", async () => {
    const out = await run(`
      local T = ${TEMPLATES}
      local bad, markersTotal, bosses = {}, 0, 0
      local a = P.toTileMap(P.rooms({ templates = T, seed = 9 }))
      local b = P.toTileMap(P.rooms({ templates = T, seed = 9 }))
      local spawns = P.spawnList(P.rooms({ templates = T, seed = 9 }), { markers = { E = "enemy", T = "chest", B = "boss" }, tileSize = 16 })
      forTicks(200, 10, function(seed)
        local lv = P.rooms({ templates = T, seed = seed, rooms = 6, branches = 2 })
        local g = lv.grid
        local noDoor = function(c) return c ~= nil and c ~= "#" and c ~= "+" end
        local open = function(c) return c ~= nil and c ~= "#" end
        local pre = P.validate(g, { pass = noDoor, from = lv.start, targets = { lv.key }, requireAll = false })
        local exitBlocked = not P.validate(g, { pass = noDoor, from = lv.start, targets = { lv.exit }, requireAll = false }).ok
        local full = P.validate(g, { pass = open, from = lv.start, targets = { lv.exit } })
        if not (pre.ok and full.ok and exitBlocked) then table.insert(bad, seed) end
        markersTotal += #lv.markers
        for _, m in lv.markers do if m.char == "B" then bosses += 1 end end
      end, function()
        save.set("out", { bad = table.concat(bad, ","), det = a == b, markers = markersTotal, bosses = bosses, spawn1 = spawns[1] })
      end)
    `, 30);
    expect(out.bad).toBe("");
    expect(out.det).toBe(true);
    expect(out.markers).toBeGreaterThan(200 * 4);
    expect(out.bosses).toBe(200);
    expect(out.spawn1.x % 16).toBe(8);
  });

  it("platformer chunks: difficulty ramp, deterministic, reachable", async () => {
    const out = await run(`
      local chunks = {
        { id = "start", grid = "........\\n........\\n........\\n########", tags = { "start" } },
        { id = "flat", grid = "........\\n........\\n........\\n########", difficulty = 1 },
        { id = "gap", grid = "........\\n........\\n........\\n###..###", difficulty = 3 },
        { id = "step", grid = "........\\n........\\n....####\\n########", difficulty = 4 },
        { id = "spikes", grid = "........\\n........\\n...##...\\n##^^^^##", difficulty = 6 },
        { id = "pit", grid = "........\\n...##...\\n........\\n##....##", difficulty = 8 },
        { id = "goal", grid = "........\\n........\\n........\\n########", tags = { "end" } },
      }
      local bad = {}
      local mono = true
      for seed = 1, 100 do
        local s = P.chunks.sequence({ chunks = chunks, seed = seed, length = 8, from = 1, to = 8 })
        local r = P.chunks.reachable(s.grid, { jump = 3, run = 4 })
        if not r.ok then table.insert(bad, seed) end
        if s.difficulties[2] > s.difficulties[#s.difficulties - 1] then mono = false end
      end
      local a = P.chunks.sequence({ chunks = chunks, seed = 5 })
      local b = P.chunks.sequence({ chunks = chunks, seed = 5 })
      save.set("out", { bad = table.concat(bad, ","), mono = mono, det = P.toTileMap(a) == P.toTileMap(b), first = a.sequence[1], last = a.sequence[#a.sequence], height = a.height })
    `);
    expect(out.bad).toBe("");
    expect(out.mono).toBe(true);
    expect(out.det).toBe(true);
    expect(out.first).toBe("start");
    expect(out.last).toBe("goal");
  });

  it("loot tables: weights/rarity tier distribution, counts, nested tables, pity", async () => {
    const out = await run(`
      local tables = {
        gems = { entries = { { item = "ruby", weight = 1 }, { item = "opal", weight = 1 } } },
        chest = { id = "chest", rolls = 1, rarities = { common = 70, rare = 25, legendary = 5 },
          entries = { { item = "coin", rarity = "common", count = { 1, 5 } }, { item = "potion", rarity = "common" },
                      { item = "sword", rarity = "rare" }, { item = "crown", rarity = "legendary" } },
          guaranteed = { { table = "gems" } }, pity = { rarity = "legendary", after = 20 } },
      }
      local rng = P.rng(1)
      local n = { coin = 0, potion = 0, sword = 0, crown = 0, gem = 0 }
      local maxCoin, minCoin = 0, 99
      for i = 1, 20000 do
        for _, d in P.loot.roll(tables.chest, rng, { tables = tables }) do
          if d.item == "ruby" or d.item == "opal" then n.gem += 1 else n[d.item] += 1 end
          if d.item == "coin" then maxCoin = math.max(maxCoin, d.count) minCoin = math.min(minCoin, d.count) end
        end
      end
      -- pity: never more than 20 rolls without a legendary
      local state, gap, worst = {}, 0, 0
      local r2 = P.rng(2)
      for i = 1, 5000 do
        local got = false
        for _, d in P.loot.roll(tables.chest, r2, { tables = tables, state = state }) do if d.item == "crown" then got = true end end
        if got then gap = 0 else gap += 1 end
        worst = math.max(worst, gap)
      end
      local odds = P.loot.odds(tables.chest)
      save.set("out", { n = n, maxCoin = maxCoin, minCoin = minCoin, worst = worst, odds = odds })
    `);
    const N = 20000;
    expect(out.n.gem).toBe(N);
    expect(out.n.coin / N).toBeCloseTo(0.35, 1);
    expect(out.n.potion / N).toBeCloseTo(0.35, 1);
    expect(out.n.sword / N).toBeCloseTo(0.25, 1);
    expect(Math.abs(out.n.crown / N - 0.05)).toBeLessThan(0.01);
    expect([out.minCoin, out.maxCoin]).toEqual([1, 5]);
    expect(out.worst).toBeLessThan(20);
    expect(out.odds.crown).toBeCloseTo(0.05, 5);
  });

  it("waves / encounters by budget; names; text templates", async () => {
    const out = await run(`
      local enemies = { { id = "rat", cost = 1 }, { id = "orc", cost = 3, minLevel = 3 }, { id = "ogre", cost = 6, minLevel = 5 } }
      local ws = P.waves.waves(enemies, { seed = 4, count = 8, budget = 4, growth = 1.4, boss = { id = "dragon", every = 4 } })
      local ok = true
      for _, w in ws do if w.cost > w.budget then ok = false end end
      local enc = P.waves.encounter(enemies, 10, 3, { level = 1 })
      local onlyRats = true
      for _, id in enc.ids do if id ~= "rat" then onlyRats = false end end
      local m = P.names.markov({ "aldric", "borin", "calen", "dorian", "elric", "fenwick", "garrick", "halden", "isolde", "jorund" })
      local n1, n2 = m.make(P.rng(3)), m.make(P.rng(3))
      save.set("out", { ok = ok, w1 = #ws[1].ids, w8 = #ws[8].ids, bossAt4 = ws[4].ids[#ws[4].ids], enc = #enc.ids, onlyRats = onlyRats,
        names = n1 == n2, nameLen = #n1, text = P.names.fill("The {adj} {noun}", { adj = { "Grim" }, noun = { "Keep" } }, 1) })
    `);
    expect(out.ok).toBe(true);
    expect(out.w8).toBeGreaterThan(out.w1);
    expect(out.bossAt4).toBe("dragon");
    expect(out.enc).toBe(10);
    expect(out.onlyRats).toBe(true);
    expect(out.names).toBe(true);
    expect(out.nameLen).toBeGreaterThanOrEqual(4);
    expect(out.text).toBe("The Grim Keep");
  });

  it("puzzles: sokoban / sliding / lights-out are solvable at the requested difficulty (verified independently in TS)", async () => {
    const out = await run(`
      local soko, slide, lights = {}, {}, {}
      for seed = 1, 6 do
        local s = P.puzzle.sokoban({ seed = seed, w = 8, h = 8, boxes = 2, minPushes = 6, maxPushes = 18 })
        table.insert(soko, s and { text = s.text, pushes = s.pushes, moves = s.moves } or false)
        local t = P.puzzle.sliding({ seed = seed, n = 3, minMoves = 12, maxMoves = 18 })
        table.insert(slide, t and { board = t.board, moves = t.moves, path = t.path } or false)
        local l = P.puzzle.lightsOut({ seed = seed, w = 5, minPresses = 5, maxPresses = 9 })
        table.insert(lights, l and { text = l.text, presses = l.presses, solution = l.solution } or false)
      end
      local unsolvable = P.puzzle.solveSokoban("#####\\n#.@$#\\n#####")
      local parity = P.puzzle.solveSliding({ 2, 1, 3, 4, 5, 6, 7, 8, 0 }, 3)
      save.set("out", { soko = soko, slide = slide, lights = lights, dead = unsolvable.solvable, parity = parity.solvable })
    `);
    // sokoban: replay the solution
    for (const s of out.soko) {
      expect(s).toBeTruthy();
      expect(s.pushes).toBeGreaterThanOrEqual(6);
      expect(s.pushes).toBeLessThanOrEqual(18);
      const rows: string[] = s.text.split("\n");
      const W = Math.max(...rows.map((r) => r.length));
      const cell = (x: number, y: number) => rows[y]?.[x] ?? "#";
      let px = 0, py = 0;
      const boxes = new Set<string>(), goals = new Set<string>();
      rows.forEach((r, y) => [...r].forEach((c, x) => {
        if ("@+".includes(c)) { px = x; py = y; }
        if ("$*".includes(c)) boxes.add(`${x},${y}`);
        if (".+*".includes(c)) goals.add(`${x},${y}`);
      }));
      const D: Record<string, [number, number]> = { u: [0, -1], d: [0, 1], l: [-1, 0], r: [1, 0] };
      let pushes = 0;
      for (const ch of s.moves as string) {
        const [dx, dy] = D[ch.toLowerCase()]!;
        const nx = px + dx, ny = py + dy;
        expect(cell(nx, ny)).not.toBe("#");
        if (boxes.has(`${nx},${ny}`)) {
          expect(ch).toBe(ch.toUpperCase());
          const bx = nx + dx, by = ny + dy;
          expect(cell(bx, by)).not.toBe("#");
          expect(boxes.has(`${bx},${by}`)).toBe(false);
          boxes.delete(`${nx},${ny}`); boxes.add(`${bx},${by}`); pushes++;
        } else expect(ch).toBe(ch.toLowerCase());
        px = nx; py = ny;
      }
      expect(W).toBe(8);
      expect(pushes).toBe(s.pushes);
      expect([...boxes].every((b) => goals.has(b))).toBe(true);
    }
    for (const t of out.slide) {
      expect(t).toBeTruthy();
      expect(t.moves).toBeGreaterThanOrEqual(12);
      expect(t.moves).toBeLessThanOrEqual(18);
      const b: number[] = [...t.board];
      for (const ti of t.path as number[]) { const z = b.indexOf(0); b[z] = b[ti - 1]!; b[ti - 1] = 0; }
      expect(b).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 0]);
    }
    for (const l of out.lights) {
      expect(l).toBeTruthy();
      expect(l.presses).toBeGreaterThanOrEqual(5);
      expect(l.presses).toBeLessThanOrEqual(9);
      const lit = (l.text as string).split("\n").join("").split("").map((c) => c === "o");
      for (const i of l.solution as number[]) {
        const k = i - 1, x = k % 5, y = Math.floor(k / 5);
        for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < 5 && ny < 5) lit[ny * 5 + nx] = !lit[ny * 5 + nx];
        }
      }
      expect(lit.every((v) => !v)).toBe(true);
    }
    expect(out.dead).toBe(false);
    expect(out.parity).toBe(false);
  });
});

// End-to-end: games/examples/kit-roguelike-demo (combat + ai + procgen) plays itself (config.bot) over several seeds.
const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../games/examples/kit-roguelike-demo");

async function botPackage(): Promise<Package> {
  const pkg = await Package.fromDir(DIR);
  const files: Record<string, Uint8Array | string> = {};
  for (const p of pkg.paths()) files[p] = pkg.bytes(p)!;
  files["scripts/shared/config.luau"] = pkg.text("scripts/shared/config.luau")!.replace("bot = false", "bot = true");
  return Package.fromFiles(files);
}

describe("kit-roguelike-demo", () => {
  it("content comes from data/ through the engine reader (procgen.content), no generated module", async () => {
    expect(existsSync(resolve(DIR, "scripts/shared/content.luau"))).toBe(false);
    const pkg = await Package.fromDir(DIR);
    const files: Record<string, Uint8Array | string> = {};
    for (const p of pkg.paths()) if (p.startsWith("data/")) files[p] = pkg.bytes(p)!;
    const r = await runLuau(`local P = require("@kit/procgen")
      local c = P.content()
      local n = function(t) local k = 0 for _ in t do k += 1 end return k end
      save.set("out", { enemies = n(c.enemies), loot = n(c.loot), rooms = n(c.rooms), start = c.rooms.start_hall, ogre = c.enemies.ogre.id })`, { files: files as Record<string, string> });
    expect(r.errors).toEqual([]);
    expect(r.out.rooms).toBe(7);
    expect(r.out.loot).toBe(4);
    expect(r.out.enemies).toBeGreaterThan(0);
    expect(r.out.ogre).toBe("ogre");
    expect(r.out.start).not.toMatch(/\n$/);
  });

  for (const seed of [1, 2, 3, 4, 5]) {
    it(`bot run, engine seed ${seed}: zero script errors, floors descend, combat + loot happen`, async () => {
      const game = await Game.load(await botPackage(), { seed, save: new MemorySaveHost() });
      for (let i = 0; i < 60 * 120; i++) game.step();
      const logs = game.logs.map((l) => l.text);
      const errors = game.errors.map((e) => `${e.script}:${e.line ?? "?"}: ${e.message}`);
      const floors = logs.filter((l) => l.startsWith("floor "));
      const maxFloor = Math.max(...floors.map((l) => Number(l.split(" ")[1])));
      const audio = (game as any).audioEvents ?? [];
      console.log(`seed ${seed}: max floor ${maxFloor}, ${floors.length} floors built, deaths ${logs.filter((l) => l.startsWith("died")).length}`, logs.filter((l) => l.startsWith("died")).slice(0, 3));
      expect(errors).toEqual([]);
      expect(game.logs.filter((l) => l.level === "warn" || l.level === "error").map((l) => l.text)).toEqual([]);
      expect(maxFloor).toBeGreaterThanOrEqual(3); // stairs work, floors 1-3 (rooms, dungeon, caves + boss)
      void audio;
    }, 120000);
  }
});
