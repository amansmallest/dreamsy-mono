// platformer kit: headless core simulation tests (controller feel, tiles, enemies, bosses,
// checkpoints, world unlocks, save) + a scripted end-to-end run of games/examples/kit-platformer.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Package } from "@dreamsy/format";
import { describe, expect, it } from "vitest";
import { Game, MemoryLeaderboardHost, MemorySaveHost, type Entity } from "../../core/index.js";

const MANIFEST = (entry = "scenes/main.scene.json") =>
  `format = "0"\nname = "P"\ndimension = "2d"\norientation = "landscape"\nentry_scene = "${entry}"\nkits = ["platformer"]\n[style]\npreset = "pixel"\n`;

const TILESET = JSON.stringify({
  tiles: {
    "#": { color: "#888888", solid: true, tags: ["solid"] },
    "=": { color: "#aa7744", tags: ["oneway"] },
    H: { color: "#ccaa44", tags: ["ladder"] },
    "^": { color: "#ffffff", tags: ["hazard"] },
    S: { color: "#ff44aa", solid: true, tags: ["solid", "spring"] },
    B: { color: "#aa5500", solid: true, tags: ["breakable"] },
    o: { color: "#ffdd00", tags: ["coin"] },
    "*": { color: "#00ffff", tags: ["gem"] },
    P: { tags: ["player_start"] },
    C: { tags: ["checkpoint"] },
    G: { tags: ["goal"] },
    s: { tags: ["enemy", "slime"] },
    h: { tags: ["enemy", "hopper"] },
    f: { tags: ["enemy", "bat"] },
    t: { tags: ["enemy", "gunner"] },
    c: { tags: ["enemy", "dog"] },
    T: { tags: ["enemy", "cannon"] },
    K: { tags: ["boss", "king"] },
    M: { tags: ["platform", "move_x", "range_3"] },
    d: { tags: ["powerup", "double_jump"] },
    w: { tags: ["powerup", "wall_jump"] },
    D: { tags: ["powerup", "dash"] },
  },
});

const CONTENT = `
kit.setup({
  enemies = {
    slime = { behaviour = "patroller", size = { 12, 10 }, speed = 30 },
    hopper = { behaviour = "hopper", size = { 12, 12 }, hop = { interval = 0.5, height = 32, speed = 50 } },
    bat = { behaviour = "flyer", size = { 12, 10 }, speed = 40, fly = { pattern = "sine", amplitude = 16, period = 1, range = 32 } },
    gunner = { behaviour = "shooter", size = { 12, 14 }, shoot = { interval = 0.5, speed = 120, range = 400 } },
    dog = { behaviour = "chaser", size = { 14, 10 }, speed = 30, chase = { range = 200 } },
    cannon = { behaviour = "turret", size = { 14, 14 }, stompable = false, shoot = { interval = 0.5, aim = "fixed", angle = 180, speed = 100 } },
  },
  bosses = {
    king = { name = "King", hp = 3, size = { 24, 24 }, iframes = 0.3, phases = {
      { ["until"] = 0.5, steps = { { ["do"] = "walk", speed = 40, time = 0.5 }, { ["do"] = "wait", time = 0.2 } } },
      { ["until"] = 0, speed_mult = 2, steps = { { ["do"] = "jump", height = 30, toward = "player" }, { ["do"] = "shoot", count = 3, spread = 30, speed = 100 } } },
    } },
  },
})
`;

interface LevelOpts { grid: string[]; script?: string; levelOpts?: string; extra?: Record<string, string>; save?: MemorySaveHost; player?: [number, number] }

function levelPkg(o: LevelOpts) {
  const scene = {
    format: "0", root: "world",
    entities: {
      world: { type: "Node2D", children: ["cam", "map", "player", "label"] },
      cam: { type: "Camera2D", props: { zoom: 2, position: [320, 180] } },
      map: { type: "TileMap2D", props: { tile_size: 16, tileset: "data/tilesets/t.json", data: "file:data/levels/l.txt" } },
      player: { type: "Node2D", props: { position: o.player ?? [40, 40] }, tags: ["player"], children: ["player_sprite"] },
      player_sprite: { type: "Sprite2D", props: { size: [12, 14], modulate: "#ff8800" } },
      label: { type: "UIText", props: { text: "" } },
    },
  };
  return Package.fromFiles({
    "dreamsy.toml": MANIFEST(),
    "scenes/main.scene.json": JSON.stringify(scene),
    "data/tilesets/t.json": TILESET,
    "data/levels/l.txt": o.grid.join("\n") + "\n",
    "scripts/client/main.luau": `
local kit = require("@kit/platformer")
${CONTENT}
local level = kit.level.start({ map = entity("map"), player = entity("player"), id = "test", hud = false, ${o.levelOpts ?? ""} })
for _, ev in { "coin", "gem", "hurt", "death", "respawn", "checkpoint", "complete", "enemyKilled", "stomp", "powerup", "break", "spring", "bossDefeated", "bossPhase", "secret" } do
  level.events:on(ev, function(a) print("EV " .. ev .. " " .. tostring(if type(a) == "table" then (a.id or "") else a)) end)
end
${o.script ?? ""}
`,
    ...o.extra,
  });
}

const steps = (g: Game, n: number, each?: (i: number) => void) => { for (let i = 0; i < n; i++) { each?.(i); g.step(); } };
const pos = (g: Game, id = "player") => g.world.byId.get(id)!.get<number[]>("position");
const noErrors = (g: Game) => expect(g.errors.map((e) => `${e.script}:${e.line}: ${e.message}`)).toEqual([]);
const events = (g: Game) => g.logs.filter((l) => l.text.startsWith("EV ")).map((l) => l.text.slice(3));
/** platformer progress = the "platformer" section of the core save (key "core"). */
const prog = (save: MemorySaveHost) => (save.data as any).core?.d?.platformer;
const hold = (g: Game, axis: number, jump = false) => { g.input.setAxis("move_x", axis); g.input.setButton("jump", jump); };

// 40 cols × 12 rows, floor at row 11 (top y = 176). Player body 12×14 → standing center y = 169.
const FLAT = [
  "........................................",
  "........................................",
  "........................................",
  "........................................",
  "........................................",
  "........................................",
  "........................................",
  "........................................",
  "........................................",
  "........................................",
  "..P.....................................",
  "########################################",
];

describe("platformer kit: controller feel", () => {
  it("lands on the floor and jumps to the configured height (variable jump cuts it short)", async () => {
    const g = await Game.load(levelPkg({ grid: FLAT, levelOpts: `controller = { jump_height = 56, jump_time = 0.36 }` }));
    steps(g, 10);
    noErrors(g);
    expect(pos(g)[1]).toBeCloseTo(169, 1);
    // full jump: hold the button
    let minY = Infinity;
    steps(g, 60, (i) => { hold(g, 0, true); minY = Math.min(minY, pos(g)[1]!); });
    const full = 169 - minY;
    expect(full).toBeGreaterThan(56 * 0.95);
    expect(full).toBeLessThan(56 * 1.06);
    steps(g, 60, () => hold(g, 0, false));
    expect(pos(g)[1]).toBeCloseTo(169, 1);
    // short hop: release after 4 ticks
    minY = Infinity;
    steps(g, 60, (i) => { hold(g, 0, i < 4); g.step; minY = Math.min(minY, pos(g)[1]!); });
    const hop = 169 - minY;
    expect(hop).toBeLessThan(full * 0.5);
    expect(hop).toBeGreaterThan(4);
    noErrors(g);
  });
});

// floor cols 0..9 then a pit, wall on the far right for wall tests
const LEDGE = [
  "........................................",
  "........................................",
  "........................................",
  "........................................",
  "........................................",
  "........................................",
  "........................................",
  "........................................",
  "........................................",
  "........................................",
  "..P.....................................",
  "##########..........................####",
];

describe("platformer kit: coyote time + jump buffer", () => {
  // walk off the ledge, press jump `late` ticks after the feet leave it
  async function offLedge(late: number) {
    const g = await Game.load(levelPkg({ grid: LEDGE, levelOpts: `controller = { coyote_time = 0.1 }` }));
    steps(g, 5);
    let left = -1, t = 0;
    const ys: number[] = [];
    for (let i = 0; i < 120; i++) {
      const x = pos(g)[0]!;
      if (left < 0 && x - 6 > 160) left = i; // body fully past the ledge edge (x = 160)
      hold(g, 1, left >= 0 && i >= left + late && i < left + late + 20);
      g.step();
      if (left >= 0) ys.push(pos(g)[1]!);
      t++;
    }
    noErrors(g);
    return { g, ys };
  }

  it("jumping within coyote time after leaving a ledge still jumps", async () => {
    const { ys } = await offLedge(3);
    expect(Math.min(...ys)).toBeLessThan(169 - 30);
  });

  it("jumping after coyote time does nothing", async () => {
    const { ys } = await offLedge(12);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(169 - 0.01);
  });

  it("a jump pressed shortly before landing is buffered", async () => {
    // dry run: when does a fall from y=40 land?
    const NOP = FLAT.map((r) => r.replace("P", "."));
    const dry = await Game.load(levelPkg({ grid: NOP, player: [64, 40] }));
    let land = -1;
    for (let i = 0; i < 120 && land < 0; i++) { dry.step(); if (Math.abs(pos(dry)[1]! - 169) < 0.01) land = i; }
    expect(land).toBeGreaterThan(10);
    const run = async (early: number) => {
      const g = await Game.load(levelPkg({ grid: NOP, player: [64, 40] }));
      let minAfter = Infinity;
      for (let i = 0; i < land + 30; i++) {
        g.input.setButton("jump", i >= land - early && i < land - early + 20);
        g.step();
        if (i > land + 2) minAfter = Math.min(minAfter, pos(g)[1]!);
      }
      return minAfter;
    };
    expect(await run(5)).toBeLessThan(169 - 20); // 5 ticks = 83 ms < 120 ms buffer
    expect(await run(12)).toBeGreaterThan(169 - 1); // 200 ms early: dropped
  });
});

const WALLS = [
  "#......................................#",
  "#......................................#",
  "#......................................#",
  "#......................................#",
  "#..............#.......................#",
  "#..............#.......................#",
  "#..............#.......................#",
  "#..............#.......................#",
  "#..............#.......................#",
  "#..............#.......................#",
  "#.P............#.......................#",
  "########################################",
];

describe("platformer kit: abilities", () => {
  it("double jump only after unlocking (powerup tile), saved to progress", async () => {
    const grid = [...FLAT];
    grid[10] = "..P.d...................................";
    const save = new MemorySaveHost();
    const g = await Game.load(levelPkg({ grid }), { save });
    const jumpTwice = () => {
      let minY = Infinity;
      steps(g, 60, (i) => { g.input.setButton("jump", i < 19 || (i >= 22 && i < 40)); minY = Math.min(minY, pos(g)[1]!); });
      steps(g, 40, () => g.input.setButton("jump", false));
      return 169 - minY;
    };
    steps(g, 5);
    const single = jumpTwice();
    steps(g, 40, () => hold(g, 1)); // walk over the powerup
    hold(g, 0);
    steps(g, 20);
    expect(events(g)).toContain("powerup double_jump");
    const double = jumpTwice();
    expect(single).toBeGreaterThan(50);
    expect(single).toBeLessThan(60);
    expect(double).toBeGreaterThan(single + 30);
    expect(prog(save).abilities.double_jump).toBe(true);
    noErrors(g);
  });

  it("wall slide caps fall speed; wall jump kicks away from the wall", async () => {
    const g = await Game.load(levelPkg({ grid: WALLS, levelOpts: `controller = { abilities = { wall_slide = true, wall_jump = true } }` }));
    steps(g, 5);
    // walk to the wall at x=240 (col 15), jump up along it, wait until falling
    steps(g, 100, () => hold(g, 1));
    expect(pos(g)[0]).toBeCloseTo(240 - 6, 1);
    steps(g, 30, (i) => hold(g, 1, i < 20));
    steps(g, 5, () => hold(g, 1, false));
    const y0 = pos(g)[1]!;
    steps(g, 10, () => hold(g, 1, false));
    const v = (pos(g)[1]! - y0) / (10 / 60);
    expect(pos(g)[0]).toBeCloseTo(240 - 6, 0);
    expect(v).toBeLessThanOrEqual(61);
    expect(v).toBeGreaterThan(0);
    // wall jump: press jump while holding into the wall
    const x0 = pos(g)[0]!, yj = pos(g)[1]!;
    steps(g, 12, (i) => hold(g, 1, i < 8));
    expect(pos(g)[0]).toBeLessThan(x0 - 10);
    expect(pos(g)[1]).toBeLessThan(yj - 10);
    noErrors(g);
  });

  it("wall jumps climb a 3-tile chimney", async () => {
    const grid = [
      "#.....#.................................",
      "#.....#.................................",
      "#.....#.................................",
      "#.....#.................................",
      "#.....#.................................",
      "#.....#.................................",
      "##.....#................................",
      "##...#..................................",
      "##...#..................................",
      "##...#..................................",
      "##...#..................................",
      "########################################",
    ];
    // chimney cols 2..4 between walls; open to the right at the top of rows 0-6 (col 6 wall top-left)
    const chim = grid.map((r, i) => (i < 7 ? "##...#" : "##...#") + r.slice(6));
    const g = await Game.load(levelPkg({ grid: chim, player: [56, 160], levelOpts: `controller = { abilities = { wall_slide = true, wall_jump = true } }` }));
    steps(g, 10);
    let minY = Infinity, dir = 1;
    for (let i = 0; i < 360; i++) {
      // bot: push toward a wall; when touching it in the air, jump away and switch direction
      const x = pos(g)[0]!;
      if (dir > 0 && x >= 80 - 6 - 0.5) { g.input.setButton("jump", true); dir = -1; }
      else if (dir < 0 && x <= 32 + 6 + 0.5) { g.input.setButton("jump", true); dir = 1; }
      else if (i % 30 === 0) g.input.setButton("jump", true);
      else g.input.setButton("jump", false);
      g.input.setAxis("move_x", dir);
      g.step();
      minY = Math.min(minY, pos(g)[1]!);
    }
    expect(minY).toBeLessThan(60); // climbed most of the 11-row chimney
    noErrors(g);
  });

  it("dash covers dash_speed × dash_time horizontally and refills on the ground", async () => {
    const g = await Game.load(levelPkg({ grid: FLAT, levelOpts: `controller = { abilities = { dash = true }, dash_speed = 300, dash_time = 0.2 }` }));
    steps(g, 5);
    const x0 = pos(g)[0]!;
    g.input.setButton("action", true); g.step(); g.input.setButton("action", false);
    steps(g, 11);
    const d = pos(g)[0]! - x0;
    expect(d).toBeGreaterThan(300 * 0.2 * 0.85);
    expect(d).toBeLessThan(300 * 0.2 * 1.15);
    expect(pos(g)[1]).toBeCloseTo(169, 1); // no gravity drop during the dash
    noErrors(g);
  });

  it("ladders: climb up with move_y, jump-through ladder top", async () => {
    const grid = [
      "........................................",
      "........................................",
      "........................................",
      "........................................",
      "....=====H==............................",
      ".........H..............................",
      ".........H..............................",
      ".........H..............................",
      ".........H..............................",
      ".........H..............................",
      "..P......H..............................",
      "########################################",
    ];
    const g = await Game.load(levelPkg({ grid }));
    steps(g, 5);
    // walk to the ladder (col 9 center = 152)
    for (let i = 0; i < 200 && Math.abs(pos(g)[0]! - 152) > 2; i++) { hold(g, pos(g)[0]! < 152 ? 0.5 : -0.5); g.step(); }
    hold(g, 0);
    steps(g, 90, () => g.input.setAxis("move_y", -1));
    g.input.setAxis("move_y", 0);
    steps(g, 30);
    // standing on the platform row 4 (top y = 64) → center 57
    expect(pos(g)[1]).toBeCloseTo(57, 0);
    noErrors(g);
  });
});

/** `PROBE <json>` lines printed by test scripts. */
const probes = (g: Game) => g.logs.filter((l) => l.text.startsWith("PROBE ")).map((l) => JSON.parse(l.text.slice(6)));
const PROBE_ENEMIES = `
onTick(function()
  local list = {}
  for _, en in level.enemies do table.insert(list, string.format('{"id":"%s","x":%.2f,"y":%.2f,"alive":%s,"dir":%d}', en.id, en.x, en.y, tostring(en.alive), en.dir)) end
  local bs = {}
  for _, b in level.bosses do table.insert(bs, string.format('{"x":%.2f,"y":%.2f,"hp":%d,"phase":%d,"alive":%s,"awake":%s}', b.x, b.y, b.hp, b.phase, tostring(b.alive), tostring(b.awake))) end
  print('PROBE {"t":' .. string.format("%.3f", time()) .. ',"health":' .. level.health .. ',"proj":' .. #level.projectiles .. ',"enemies":[' .. table.concat(list, ",") .. '],"bosses":[' .. table.concat(bs, ",") .. ']}')
end)`;

describe("platformer kit: level features", () => {
  it("one-way platforms: land from above, jump through from below, drop with down+jump", async () => {
    const grid = FLAT.map((r) => r.replace("P", "."));
    grid[8] = "....======..............................";
    const g = await Game.load(levelPkg({ grid, player: [88, 160] }));
    steps(g, 10);
    expect(pos(g)[1]).toBeCloseTo(169, 1);
    steps(g, 40, (i) => hold(g, 0, i < 20)); // jump through the platform (top y = 128)
    steps(g, 40, () => hold(g, 0, false));
    expect(pos(g)[1]).toBeCloseTo(128 - 7, 1);
    // drop through
    g.input.setAxis("move_y", 1); g.input.setButton("jump", true); g.step(); g.input.setButton("jump", false);
    steps(g, 40);
    g.input.setAxis("move_y", 0);
    expect(pos(g)[1]).toBeCloseTo(169, 1);
    noErrors(g);
  });

  it("springs bounce, breakable blocks break when bonked from below", async () => {
    const grid = FLAT.map((r) => r.replace("P", "."));
    grid[11] = "####S###################################";
    grid[7] = "..........B.............................";
    const g = await Game.load(levelPkg({ grid, player: [72, 100] }));
    let minY = Infinity;
    steps(g, 80, () => { minY = Math.min(minY, pos(g)[1]!); });
    expect(events(g)).toContain("spring nil");
    expect(minY).toBeLessThan(169 - 100); // spring_height 120 from where it lands
    // walk under the brick (col 10 → x 168) and jump
    const g2 = await Game.load(levelPkg({ grid, player: [168, 160] }));
    steps(g2, 10);
    steps(g2, 30, (i) => hold(g2, 0, i < 20));
    expect(events(g2).some((e) => e.startsWith("break"))).toBe(true);
    noErrors(g); noErrors(g2);
  });

  it("hazards kill, the player respawns at the last checkpoint with full health", async () => {
    const grid = [...FLAT];
    grid[10] = "..P...C.........^.......................";
    const g = await Game.load(levelPkg({ grid, levelOpts: "respawn_delay = 0.5" }));
    for (let i = 0; i < 200 && !events(g).includes("death hurt"); i++) { hold(g, 1); g.step(); }
    hold(g, 0);
    steps(g, 60);
    const ev = events(g);
    expect(ev).toContain("checkpoint ");
    expect(ev).toContain("death hurt");
    expect(ev).toContain("respawn nil");
    steps(g, 5);
    // respawned at the checkpoint (col 6 → x 104), not the start
    expect(pos(g)[0]).toBeLessThan(200);
    expect(pos(g)[0]).toBeGreaterThan(90);
    noErrors(g);
  });

  it("falling out of the level kills; coins + gems count; goal completes and saves stats", async () => {
    const grid = [...FLAT];
    grid[10] = "..P.oo*oo..........G....................";
    const save = new MemorySaveHost();
    const lb = new MemoryLeaderboardHost();
    const g = await Game.load(levelPkg({ grid, levelOpts: "complete_delay = 0.2, on_complete = function(st) print('DONE ' .. st.coins .. ' ' .. st.gemsFound) end" }), { save, leaderboard: lb });
    steps(g, 200, () => hold(g, 1));
    const ev = events(g);
    expect(ev.filter((e) => e.startsWith("coin")).length).toBe(4);
    expect(ev).toContain("gem 1");
    expect(ev.some((e) => e.startsWith("complete"))).toBe(true);
    expect(g.logs.some((l) => l.text === "DONE 4 1")).toBe(true);
    const p = prog(save);
    expect(p.completed.test).toBe(true);
    expect(p.coins.test).toBe(4);
    expect(p.gems.test["1"]).toBe(true);
    expect(p.best.test).toBeGreaterThan(0.5);
    // platform leaderboard: level start → complete timed by the engine, with a ghost of the player
    expect(lb.submitted.map((r) => [r.board, r.order])).toEqual([["level_test", "asc"]]);
    expect(lb.submitted[0]!.value).toBeCloseTo(p.best.test, 1);
    expect(lb.submitted[0]!.ghost!.frames.length).toBeGreaterThan(3);
    noErrors(g);
  });

  it("moving platforms carry the player", async () => {
    const grid = FLAT.map((r) => r.replace("P", "."));
    grid[8] = "....MM..................................";
    const g = await Game.load(levelPkg({ grid, player: [80, 100] }));
    steps(g, 30);
    const y = pos(g)[1]!;
    expect(y).toBeLessThan(130); // standing on the platform (row 8 → top 128)
    const x0 = pos(g)[0]!;
    steps(g, 40);
    expect(Math.abs(pos(g)[0]! - x0)).toBeGreaterThan(10);
    expect(pos(g)[1]).toBeCloseTo(y, 0);
    noErrors(g);
  });
});

describe("platformer kit: enemies", () => {
  const enemyGrid = (row10: string) => {
    const grid = FLAT.map((r) => r.replace("P", "."));
    grid[10] = row10;
    return grid;
  };

  it("patroller walks and turns at walls and ledges", async () => {
    const grid = enemyGrid("...........s.........#..................");
    grid[11] = "#################.......################";
    const g = await Game.load(levelPkg({ grid, player: [600, 160], script: PROBE_ENEMIES }));
    steps(g, 600);
    const xs = probes(g).map((p) => p.enemies[0].x);
    // ledge at x=272 (col 17): never walks past it
    expect(Math.max(...xs)).toBeLessThan(272);
    expect(Math.min(...xs)).toBeLessThan(170);
    const dirs = new Set(probes(g).map((p) => p.enemies[0].dir));
    expect(dirs.size).toBe(2);
    noErrors(g);
  });

  it("hopper hops, flyer bobs without falling, chaser chases the player", async () => {
    const g = await Game.load(levelPkg({ grid: enemyGrid("....h.......f.........c.................").map((r, i) => (i === 6 ? r : r)), player: [500, 160], script: PROBE_ENEMIES }));
    steps(g, 240);
    const ps = probes(g);
    const hopY = ps.map((p) => p.enemies.find((e: any) => e.id === "hopper").y);
    expect(Math.min(...hopY)).toBeLessThan(170 - 20);
    const bat = ps.map((p) => p.enemies.find((e: any) => e.id === "bat"));
    const batY = bat.map((b: any) => b.y);
    expect(Math.max(...batY) - Math.min(...batY)).toBeGreaterThan(16);
    expect(Math.max(...batY)).toBeLessThan(176);
    const dog = ps.map((p) => p.enemies.find((e: any) => e.id === "dog"));
    expect(dog[dog.length - 1].x).toBeGreaterThan(dog[0].x + 50); // ran toward the player at x=500
    noErrors(g);
  });

  it("shooter + turret fire projectiles that hurt the player", async () => {
    const g = await Game.load(levelPkg({ grid: enemyGrid("..P......t..............................") , script: PROBE_ENEMIES, levelOpts: "health = 5" }));
    steps(g, 240);
    const ps = probes(g);
    expect(Math.max(...ps.map((p) => p.proj))).toBeGreaterThan(0);
    expect(events(g).some((e) => e.startsWith("hurt"))).toBe(true);
    const g2 = await Game.load(levelPkg({ grid: enemyGrid("..P...........T........................."), script: PROBE_ENEMIES, levelOpts: "health = 5" }));
    steps(g2, 240);
    expect(events(g2).some((e) => e.startsWith("hurt"))).toBe(true);
    noErrors(g); noErrors(g2);
  });

  it("stomping kills; walking into an enemy hurts with knockback + i-frames", async () => {
    const g = await Game.load(levelPkg({ grid: enemyGrid("..........s............................."), player: [160, 60], script: PROBE_ENEMIES }));
    steps(g, 60);
    expect(events(g)).toContain("stomp slime");
    expect(events(g)).toContain("enemyKilled slime");
    const g2 = await Game.load(levelPkg({ grid: enemyGrid("..P.......s.............................") , script: PROBE_ENEMIES }));
    steps(g2, 120, () => hold(g2, 1));
    const hurts = events(g2).filter((e) => e.startsWith("hurt"));
    expect(hurts.length).toBe(1); // i-frames: one hit, not one per tick
    expect(probes(g2).at(-1).health).toBe(2);
    noErrors(g); noErrors(g2);
  });

  it("player shots kill shootable enemies", async () => {
    const g = await Game.load(levelPkg({ grid: enemyGrid("..P.......s............................."), script: PROBE_ENEMIES, levelOpts: "controller = { abilities = { shoot = true } }" }));
    steps(g, 5);
    steps(g, 30, (i) => g.input.setButton("action2", i % 10 < 2));
    expect(events(g)).toContain("enemyKilled slime");
    noErrors(g);
  });
});

describe("platformer kit: bosses", () => {
  it("boss wakes, changes phase at the hp threshold, and is defeated by stomps", async () => {
    const grid = FLAT.map((r) => r.replace("P", "."));
    grid[10] = "....................K...................";
    const g = await Game.load(levelPkg({ grid, player: [200, 100], script: PROBE_ENEMIES + `
      -- test hook: hit the boss from above whenever it's vulnerable
      onTick(function()
        local b = level.bosses[1]
        if b and b.alive and b.awake and b.iframes <= 0 and time() > 0.5 then level:hitBoss(b, 1) end
      end)`, levelOpts: "boss_completes = false" }));
    steps(g, 300);
    const ev = events(g);
    expect(ev.some((e) => e.startsWith("bossPhase"))).toBe(true);
    expect(ev.some((e) => e.startsWith("bossDefeated"))).toBe(true);
    const phases = new Set(probes(g).flatMap((p) => p.bosses.map((b: any) => b.phase)));
    expect([...phases].sort()).toEqual([1, 2]);
    noErrors(g);
  });
});

describe("platformer kit: world map, unlocks, save", () => {
  const WORLD = `kit.setup({ world = { map_scene = "scenes/map.scene.json", worlds = {
    { id = "w1", name = "Meadow", levels = {
      { id = "1-1", name = "First Steps", scene = "scenes/main.scene.json", gems = 1 },
      { id = "1-2", name = "Second", scene = "scenes/main.scene.json" },
      { id = "1-s", name = "Secret", scene = "scenes/main.scene.json", secret = true, unlock = { gems = 1 } },
    } },
    { id = "w2", name = "Caves", levels = {
      { id = "2-1", name = "Dark", scene = "scenes/main.scene.json", unlock = { world = "w1" } },
    } },
  } } })`;
  const mapPkg = (script: string) => {
    const map = { format: "0", root: "m", entities: { m: { type: "Node2D", children: ["mcam"] }, mcam: { type: "Camera2D", props: { zoom: 1 } } } };
    const lvl = { format: "0", root: "w", entities: { w: { type: "Node2D", children: ["lbl"] }, lbl: { type: "UIText", props: { text: "" } } } };
    return Package.fromFiles({
      "dreamsy.toml": MANIFEST("scenes/map.scene.json"),
      "scenes/map.scene.json": JSON.stringify(map),
      "scenes/main.scene.json": JSON.stringify(lvl),
      "scripts/shared/setup.luau": `local kit = require("@kit/platformer")\n${WORLD}\nreturn kit`,
      "scripts/client/session.luau": `local kit = require("../shared/setup")\n${script}`,
    });
  };

  it("unlock rules follow progress; progress survives a reload (save round trip)", async () => {
    const save = new MemorySaveHost();
    const g = await Game.load(mapPkg(`
      local W, P = kit.world, kit.progress
      local function st() local o = {} for _, l in W.levels() do table.insert(o, l.id .. "=" .. tostring(W.isUnlocked(l.id))) end return table.concat(o, " ") end
      print("A " .. st())
      P.completeLevel("1-1", { time = 42.5, coins = 10, gems = { [1] = true } })
      print("B " .. st())
      P.completeLevel("1-2", { time = 30, coins = 3 })
      print("C " .. st())
      P.completeLevel("1-2", { time = 35, coins = 5 })
      print("BEST " .. P.best("1-2") .. " " .. P.get().coins["1-2"])
    `), { save });
    const l = g.logs.map((x) => x.text);
    expect(l).toContain("A 1-1=true 1-2=false 1-s=false 2-1=false");
    expect(l).toContain("B 1-1=true 1-2=true 1-s=true 2-1=false");
    expect(l).toContain("C 1-1=true 1-2=true 1-s=true 2-1=true"); // "world" rule ignores secret levels
    expect(l).toContain("BEST 30 5");
    noErrors(g);
    // reload with the same save host
    const g2 = await Game.load(mapPkg(`print("R " .. tostring(kit.progress.isComplete("1-2")) .. " " .. kit.progress.best("1-1") .. " " .. kit.progress.totalGems())`), { save });
    expect(g2.logs.map((x) => x.text)).toContain("R true 42.5 1");
    noErrors(g2);
  });
});

describe("platformer kit: example game (games/examples/kit-platformer)", () => {
  const DIR = resolve(__dirname, "../../../games/examples/kit-platformer");

  it("the kit reads content from data/ (no Luau mirror); JSON matches the kit schemas' required fields", async () => {
    const pkg = await Package.fromDir(DIR);
    expect(pkg.has("scripts/shared/content.luau")).toBe(false);
    const enemies = pkg.paths("data/enemies/").map((p) => JSON.parse(pkg.text(p)!));
    const bosses = pkg.paths("data/bosses/").map((p) => JSON.parse(pkg.text(p)!));
    const world = JSON.parse(pkg.text("data/world.json")!);
    const schema = (n: string) => JSON.parse(readFileSync(resolve(__dirname, `../../kits/platformer/schemas/${n}.json`), "utf8"));
    for (const e of enemies) for (const k of schema("enemy").required) expect(e, `${e.id}.${k}`).toHaveProperty(k);
    for (const b of bosses) for (const k of schema("boss").required) expect(b, `${b.id}.${k}`).toHaveProperty(k);
    for (const k of schema("world").required) expect(world).toHaveProperty(k);
    for (const l of world.worlds.flatMap((w: any) => w.levels)) expect(pkg.has(l.scene)).toBe(true);
    const probe = `
local kit = require("@kit/platformer")
for _, id in { ${enemies.map((e) => JSON.stringify(e.id)).join(", ")} } do print("ENEMY " .. id .. " " .. kit.content.get("enemies", id).behaviour) end
for _, id in { ${bosses.map((b) => JSON.stringify(b.id)).join(", ")} } do print("BOSS " .. id .. " " .. kit.content.get("bosses", id).hp) end
local ids = {} for _, l in kit.world.levels() do table.insert(ids, l.id) end
print("LEVELS " .. table.concat(ids, ","))`;
    const g = await Game.load(pkg.with("scripts/client/zz_probe.luau", probe));
    const log = g.logs.map((l) => l.text);
    for (const e of enemies) expect(log).toContain(`ENEMY ${e.id} ${e.behaviour}`);
    for (const b of bosses) expect(log).toContain(`BOSS ${b.id} ${b.hp}`);
    expect(log).toContain("LEVELS " + world.worlds.flatMap((w: any) => w.levels.map((l: any) => l.id)).join(","));
    noErrors(g);
  });

  it("scripted end-to-end run: world map → every level (played, then finished) → boss → all cleared, zero script errors", async () => {
    const autoplay = `
local kit = require("@kit/platformer")
game.sceneLoaded:connect(function(path)
  print("SCENE " .. path)
  if path == "scenes/world.scene.json" then
    after(0.6, function()
      if currentScene() ~= path then return end -- real input already entered a level
      local wm = kit.worldmap.current
      print("MAP sel=" .. wm.sel.level.id .. " cleared=" .. kit.progress.completedCount())
      if kit.progress.completedCount() < #kit.world.levels() then wm:enter() else print("ALL CLEAR") end
    end)
  else
    after(5, function()
      if currentScene() ~= path then return end
      local lv = kit.level.current
      print("PLAYED " .. lv.id .. " x=" .. math.floor(lv.body.x) .. " coins=" .. lv.coins .. " deaths=" .. lv.deaths .. " enemies=" .. #lv.enemies)
      if #lv.bosses > 0 then
        local b = lv.bosses[1]
        lv.body.x, lv.body.y = b.x - 60, b.y
        every(0.2, function() if b.alive and b.awake then lv:hitBoss(b, 1) end end)
      else
        every(0.5, function() if currentScene() == path and not lv.done then lv:complete() end end)
      end
    end)
  end
end)`;
    const pkg = (await Package.fromDir(DIR)).with("scripts/client/zz_autoplay.luau", autoplay);
    const save = new MemorySaveHost();
    const g = await Game.load(pkg, { seed: 3, save });
    // play: run right, jump in rhythm, shoot/dash when unlocked
    const cleared = () => Object.keys(prog(save)?.completed ?? {}).length;
    for (let i = 0; i < 60 * 70 && cleared() < 5; i++) {
      g.input.setAxis("move_x", 1);
      g.input.setButton("jump", i % 50 < 18);
      g.input.setButton("action", i % 90 === 40);
      g.step();
    }
    const log = g.logs.map((l) => l.text);
    const played = log.filter((l) => l.startsWith("PLAYED"));
    console.log(played.join("\n"));
    expect(played.length).toBe(5);
    steps(g, 200); // back on the map: everything cleared
    expect(g.logs.map((l) => l.text)).toContain("ALL CLEAR");
    const p = prog(save);
    expect(Object.keys(p.completed).sort()).toEqual(["1-1", "1-2", "2-1", "2-2", "2-B"]);
    // walked a good way into each level on real input
    for (const l of played) expect(Number(/x=(\d+)/.exec(l)![1])).toBeGreaterThan(150);
    noErrors(g);
  });
});
