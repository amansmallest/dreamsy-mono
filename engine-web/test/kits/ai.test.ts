// ai kit: behaviours simulated headless (AI.step pure agents + attach on real entities), A*, LOS.
import { describe, expect, it } from "vitest";
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
  const game = await Game.load(Package.fromFiles(files), { seed: opts.seed ?? 1, save: host });
  for (let i = 0; i < (opts.steps ?? 1); i++) game.step();
  const errors = game.errors.map((e) => `${e.script}:${e.line ?? "?"}: ${e.message}`);
  return { out: host.data.out as any, logs: game.logs.map((l) => l.text), errors, game };
}


const PRE = `local AI = require("@kit/ai")
local seed = 11
local function rnd() seed = (seed * 48271) % 2147483647 return seed / 2147483647 end
local function dist(a, b) return math.sqrt((a.x - b.x)^2 + (a.y - b.y)^2) end
-- run brain for n seconds at 60 Hz; returns actions list
local function sim(brain, agent, world, secs)
  world.rand = rnd
  local acts = {}
  for i = 1, math.floor(secs * 60) do
    for _, a in AI.step(brain, agent, world, 1/60) do table.insert(acts, a.name) end
  end
  return acts
end
local function count(list, name) local n = 0 for _, v in list do if v == name then n += 1 end end return n end
`;
const run = async (src: string) => {
  const r = await runLuau(PRE + src, { kits: ["ai"] });
  expect(r.errors).toEqual([]);
  return r.out;
};

// 20x12 room; wall column at x=10 from y=0..8 (gap at bottom rows 9-10)
const ROOM = [
  "####################",
  "#.........#........#",
  "#.........#........#",
  "#.........#........#",
  "#.........#........#",
  "#.........#........#",
  "#.........#........#",
  "#.........#........#",
  "#.........#........#",
  "#..................#",
  "#..................#",
  "####################",
].join("\\n");

describe("ai kit", () => {
  it("A* on grids (4/8-dir, no corner cutting, unreachable), graphs, line of sight", async () => {
    const out = await run(`
      local g = AI.grid("${ROOM}", { tileSize = 16 })
      local p = g:find(2, 2, 15, 2)
      local d = AI.grid("${ROOM}", { diagonal = true }):find(2, 2, 15, 2)
      local blocked = AI.grid("#####\\n#.#.#\\n#####"):find(1, 1, 3, 1)
      local near = AI.grid("#####\\n#.#.#\\n#####"):find(1, 1, 3, 1, { nearest = true })
      local corner = AI.grid("....\\n.#..\\n....", { diagonal = true }):find(0, 0, 2, 2)
      local ids, cost = AI.graphPath({ a = { x = 0, y = 0, links = { "b", "c" } }, b = { x = 10, y = 0, links = { "d" } }, c = { x = 0, y = 50, links = { "d" } }, d = { x = 20, y = 0, links = {} } }, "a", "d")
      local wcost = select(2, AI.graphPath({ a = { links = { b = 5, c = 1 } }, b = { links = { d = 1 } }, c = { links = { d = 1 } }, d = { links = {} } }, "a", "d"))
      save.set("out", {
        len = #p, passesGap = (function() for _, c in p do if c.x == 10 then return c.y >= 9 end end return false end)(),
        dlen = #d, blocked = blocked == nil, nearLen = #near,
        cornerOk = (function() for i = 2, #corner do local a, b = corner[i-1], corner[i] if a.x ~= b.x and a.y ~= b.y and (a.x == 1 and a.y == 0 or b.x == 1 and b.y == 1) then return false end end return true end)(),
        graph = table.concat(ids, ""), wcost = wcost,
        los1 = g:los(40, 40, 120, 40), los2 = g:los(40, 40, 220, 40), los3 = g:losCells(2, 9, 15, 9),
      })
    `);
    expect(out.len).toBe(28); // (2,2)->(9,9)? manhattan via the gap: 7 down + 13 right + 7 up = 27 steps
    expect(out.passesGap).toBe(true);
    expect(out.dlen).toBeLessThan(out.len);
    expect(out.blocked).toBe(true);
    expect(out.nearLen).toBe(1);
    expect(out.cornerOk).toBe(true);
    expect(out.graph).toBe("abd");
    expect(out.wcost).toBe(2);
    expect([out.los1, out.los2, out.los3]).toEqual([true, false, true]);
  });

  it("idle / wander / patrol (points + platformer turn-at-wall)", async () => {
    const out = await run(`
      local idle = { x = 50, y = 50 }
      sim(AI.brain("idle"), idle, {}, 2)
      local w = { x = 100, y = 100 }
      local maxD, moved = 0, 0
      local b = AI.brain({ behavior = "wander", radius = 40, speed = 50 })
      for i = 1, 600 do
        local px, py = w.x, w.y
        AI.step(b, w, { rand = rnd }, 1/60)
        moved += math.abs(w.x - px) + math.abs(w.y - py)
        maxD = math.max(maxD, dist(w, w.home))
      end
      local pa = { x = 0, y = 0 }
      local pb = AI.brain({ behavior = "patrol", points = { {100, 0}, {100, 100}, {0, 100} }, speed = 100, wait = 0 })
      local visited = {}
      for i = 1, 60 * 6 do
        AI.step(pb, pa, {}, 1/60)
        for k, pt in { {100,0}, {100,100}, {0,100} } do if math.abs(pa.x - pt[1]) < 5 and math.abs(pa.y - pt[2]) < 5 and visited[#visited] ~= k then table.insert(visited, k) end end
      end
      local g = AI.grid("${ROOM}")
      local plat = { x = 40, y = 40, radius = 6 }
      local xs = {}
      local plb = AI.brain({ behavior = "patrol", distance = 1000, speed = 80 })
      local minX, maxX = 1e9, -1e9
      for i = 1, 60 * 6 do AI.step(plb, plat, { grid = g, mode = "platformer" }, 1/60) minX = math.min(minX, plat.x) maxX = math.max(maxX, plat.x) end
      save.set("out", { idle = { idle.x, idle.y }, maxD = maxD, moved = moved, visited = table.concat(visited, ","), minX = minX, maxX = maxX })
    `);
    expect(out.idle).toEqual([50, 50]);
    expect(out.moved).toBeGreaterThan(50);
    expect(out.maxD).toBeLessThan(48);
    expect(out.visited.startsWith("1,2,3,1")).toBe(true);
    expect(out.maxX).toBeLessThan(160); // turned at the wall column (x = 160..176)
    expect(out.minX).toBeLessThan(30);  // and at the left wall
  });

  it("chase: aggro radius, pathfinds around walls, leash returns home; flee runs away", async () => {
    const out = await run(`
      local g = AI.grid("${ROOM}")
      local far = { x = 40, y = 40 }
      sim(AI.brain({ behavior = "chase", aggro = 50 }), far, { target = { x = 140, y = 40 } }, 2)
      local c = { x = 40, y = 40 }
      local target = { x = 260, y = 40 }   -- behind the wall: needs the gap at the bottom
      local acts = sim(AI.brain({ behavior = "chase", aggro = 400, speed = 90, forget = 99 }), c, { target = target, grid = g, sight = false }, 8)
      local l = { x = 40, y = 40 }
      local lb = AI.brain({ behavior = "chase", aggro = 1000, leash = 60, speed = 90 })
      sim(lb, l, { target = { x = 140, y = 150 } }, 1.5)
      local leashed = dist(l, l.home)
      sim(lb, l, { target = nil }, 2)
      local f = { x = 100, y = 100 }
      sim(AI.brain({ behavior = "flee", range = 200, speed = 60 }), f, { target = { x = 90, y = 100 } }, 1)
      save.set("out", { far = { far.x, far.y }, reach = dist(c, target), aggro = count(acts, "aggro"), leashed = leashed, back = dist(l, l.home), flee = f.x })
    `);
    expect(out.far).toEqual([40, 40]);
    expect(out.reach).toBeLessThan(12);
    expect(out.aggro).toBe(1);
    expect(out.leashed).toBeLessThan(80);
    expect(out.back).toBeLessThan(8);
    expect(out.flee).toBeGreaterThan(150);
  });

  it("keep_distance (ranged), charge, jump_at, swoop, turret (LOS), spawner (max)", async () => {
    const out = await run(`
      local g = AI.grid("${ROOM}")
      local r = { x = 80, y = 152 }
      local tgt = { x = 60, y = 152 }
      local racts = sim(AI.brain({ behavior = "keep_distance", min = 60, max = 100, speed = 80, fireEvery = 1 }), r, { target = tgt, grid = g }, 4)
      local rd = dist(r, tgt)
      local ch = { x = 40, y = 40 }
      local cb = AI.brain({ behavior = "charge", range = 150, windup = 0.5, speed = 300, duration = 0.3 })
      local seq, maxV = {}, 0
      for i = 1, 90 do
        for _, a in AI.step(cb, ch, { target = { x = 140, y = 40 }, rand = rnd }, 1/60) do table.insert(seq, a.name) end
        maxV = math.max(maxV, math.abs(ch.vx))
      end
      local j = { x = 40, y = 100, onFloor = true }
      local jacts = AI.step(AI.brain({ behavior = "jump_at", range = 200, jump = 300 }), j, { target = { x = 120, y = 100 }, mode = "platformer", rand = rnd }, 1/60)
      local s = { x = 100, y = 20 }
      local sb = AI.brain({ behavior = "swoop", hover = 60, every = 1.5, swoopSpeed = 250 })
      local minY, maxY, sw = 1e9, -1e9, 0
      for i = 1, 60 * 3 do
        for _, a in AI.step(sb, s, { target = { x = 100, y = 150 }, rand = rnd }, 1/60) do if a.name == "swoop" then sw += 1 end end
        if i < 80 then minY = math.min(minY, s.y) end
        maxY = math.max(maxY, s.y)
      end
      local t1 = { x = 40, y = 40 }
      local shotsSeen = count(sim(AI.brain({ behavior = "turret", range = 300, fireEvery = 0.5 }), t1, { target = { x = 120, y = 40 }, grid = g }, 2.1), "shoot")
      local shotsWall = count(sim(AI.brain({ behavior = "turret", range = 300, fireEvery = 0.5 }), { x = 40, y = 40 }, { target = { x = 260, y = 40 }, grid = g }, 2.1), "shoot")
      local alive = 0
      local spActs = sim(AI.brain({ behavior = "spawner", every = 0.5, max = 3, spawn = "bat" }), { x = 0, y = 0 }, { children = function() return alive end }, 0.1)
      local spawns = 0
      local sp = AI.brain({ behavior = "spawner", every = 0.5, max = 3, spawn = "bat" })
      local ag = { x = 0, y = 0 }
      for i = 1, 60 * 5 do for _, a in AI.step(sp, ag, { children = function() return alive end, rand = rnd }, 1/60) do if a.name == "spawn" then spawns += 1 alive += 1 end end end
      save.set("out", { rd = rd, rshots = count(racts, "shoot"), seq = table.concat(seq, ","), maxV = maxV, jump = jacts[1] and jacts[1].name, jvy = j.vy,
        hoverY = minY, diveY = maxY, swoops = sw, t1 = { t1.x, t1.y }, shotsSeen = shotsSeen, shotsWall = shotsWall, spawns = spawns })
    `);
    expect(out.rd).toBeGreaterThanOrEqual(55);
    expect(out.rd).toBeLessThanOrEqual(105);
    expect(out.rshots).toBeGreaterThanOrEqual(3);
    expect(out.seq.startsWith("telegraph,charge")).toBe(true);
    expect(out.maxV).toBe(300);
    expect(out.jump).toBe("jump");
    expect(out.jvy).toBeLessThan(-250);
    expect(out.hoverY).toBeLessThan(60);
    expect(out.diveY).toBeGreaterThan(130);
    expect(out.swoops).toBeGreaterThanOrEqual(1);
    expect(out.t1).toEqual([40, 40]);
    expect(out.shotsSeen).toBe(4);
    expect(out.shotsWall).toBe(0);
    expect(out.spawns).toBe(3);
  });

  it("boss phases by hp threshold + pattern sequences; FSM transitions; utility selection", async () => {
    const out = await run(`
      local boss = AI.brain({ behavior = "boss", phases = {
        { hp = 1.0, pattern = { { action = "ring", count = 8, wait = 0.5 }, { behavior = "chase", time = 1, aggro = 999 } } },
        { hp = 0.5, pattern = { { action = "summon", wait = 0.3 }, { action = "slam", wait = 0.3 } } },
      } })
      local b = { x = 0, y = 0, hp = 100, maxHp = 100 }
      local acts = sim(boss, b, { target = { x = 50, y = 0 } }, 2)
      b.hp = 40
      local acts2 = sim(boss, b, { target = { x = 50, y = 0 } }, 1.3)
      local fsm = AI.brain({ fsm = { start = "idle", states = { idle = { behavior = "idle" }, chase = { behavior = "chase", aggro = 100, speed = 60 } },
        transitions = { { from = "idle", to = "chase", when = "near:80" }, { from = "chase", to = "idle", when = "far:150" } } } })
      local a = { x = 0, y = 0 }
      sim(fsm, a, { target = { x = 200, y = 0 } }, 0.5)
      local s1 = fsm.state
      sim(fsm, a, { target = { x = 60, y = 0 } }, 0.2)
      local s2 = fsm.state
      sim(fsm, a, { target = { x = 400, y = 0 } }, 0.2)
      local s3 = fsm.state
      local u = AI.brain({ utility = { { behavior = "chase", aggro = 999, score = "target_near" }, { behavior = "flee", range = 999, score = "hp_low", weight = 2 } } })
      local ua = { x = 0, y = 0, hp = 100, maxHp = 100 }
      sim(u, ua, { target = { x = 100, y = 0 } }, 0.5)
      local x1 = ua.x
      ua.hp = 10
      sim(u, ua, { target = { x = 100, y = 0 } }, 1)
      save.set("out", { acts = table.concat(acts, ","), acts2 = table.concat(acts2, ","), s = { s1, s2, s3 }, chaseX = x1, fleeX = ua.x })
    `);
    expect(out.acts.startsWith("phase,ring,aggro")).toBe(true);
    expect(out.acts2).toBe("phase,summon,slam,summon,slam,summon");
    expect(out.s).toEqual(["idle", "chase", "idle"]);
    expect(out.chaseX).toBeGreaterThan(5);
    expect(out.fleeX).toBeLessThan(out.chaseX);
  });

  it("attach: a Body2D enemy chases the player entity around a TileMap2D wall; stops when destroyed", async () => {
    const tileset = JSON.stringify({ tiles: { "#": { color: "#333333", solid: true } } });
    const r = await runLuau(`
      local AI = require("@kit/ai")
      local map = entity("map")
      local hero = spawn("Body2D", { position = vec2(264, 40), body = "static", size = vec2(10, 10) })
      hero:addTag("player")
      local foe = spawn("Body2D", { position = vec2(40, 40), body = "dynamic", gravity_scale = 0, lock_rotation = true, size = vec2(10, 10) })
      local ctl = AI.attach(foe, { behavior = "chase", aggro = 400, speed = 120, forget = 99 }, { grid = map, solid = "#", sight = false })
      local n = 0
      onTick(function()
        n += 1
        if n == 400 then save.set("out", { d = (foe.position - hero.position):length() }) end
      end)
    `, { kits: ["ai"], steps: 401, files: { "data/tilesets/t.json": tileset, "scenes/main.scene.json": JSON.stringify({ format: "0", root: "root", entities: { root: { type: "Node2D", children: ["map"] }, map: { type: "TileMap2D", props: { tileset: "data/tilesets/t.json", data: ROOM.replace(/\\n/g, "\n") } } } }) } });
    expect(r.errors).toEqual([]);
    expect(r.out.d).toBeLessThan(20);
  });
});
