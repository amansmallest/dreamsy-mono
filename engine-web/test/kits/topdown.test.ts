// topdown kit: headless core simulation tests (movement, combat + i-frames, enemies, items gating,
// keys/doors, puzzles, room transitions, warps, NPCs/shops, bosses, save) + a scripted end-to-end run of
// games/examples/kit-topdown.
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { Package } from "@dreamsy/format";
import { describe, expect, it } from "vitest";
import { Game, MemorySaveHost } from "../../core/index.js";

const MANIFEST = (entry = "scenes/main.scene.json") =>
  `format = "0"\nname = "T"\ndimension = "2d"\norientation = "portrait"\nentry_scene = "${entry}"\nkits = ["topdown"]\n[style]\npreset = "pixel"\n`;

const TILESET = JSON.stringify({
  tiles: {
    _: { color: "#3a6a3a" },
    "#": { color: "#666677", solid: true, tags: ["solid"] },
    R: { color: "#887755", tags: ["rough"] },
    X: { color: "#776655", tags: ["cracked"] },
    L: { color: "#aa8833", tags: ["locked"] },
    "~": { color: "#112233", tags: ["gap"] },
    O: { color: "#cccccc", tags: ["hook"] },
    k: { color: "#ffee00", tags: ["key"] },
    $: { color: "#00ff88", tags: ["rupee"] },
    B: { color: "#8899aa", tags: ["block"] },
    p: { color: "#333355", tags: ["plate"] },
    G: { color: "#aa3333", tags: ["gate"] },
    w: { color: "#ff00ff", tags: ["warp", "to_other"] },
    P: { tags: ["player_start"] },
    s: { tags: ["enemy", "blob"] },
    c: { tags: ["enemy", "bull"] },
    a: { tags: ["enemy", "archer"] },
    n: { tags: ["enemy", "nest"] },
    K: { tags: ["boss", "golem"] },
    N: { tags: ["npc", "merchant"] },
    C: { tags: ["chest", "bombs"] },
    E: { tags: ["entry", "from_other"] },
  },
});

const CONTENT = `
kit.setup({
  items = {
    sword = { name = "Sword", kind = "sword", damage = 2 },
    boots = { name = "Boots", kind = "boots", passes = { "rough" }, speed_mult = 1.25, equip = false },
    bombs = { name = "Bombs", kind = "bomb", ammo = 5, max = 10, fuse = 1, radius = 24, breaks = { "cracked" } },
    hookshot = { name = "Hookshot", kind = "hookshot", range = 112, speed = 300 },
    bow = { name = "Bow", kind = "bow", ammo = 10, damage = 2 },
    rupee = { kind = "rupee", amount = 1 },
    heart = { kind = "heart", amount = 2 },
    key = { kind = "key" },
    heart_container = { kind = "heart_container" },
  },
  enemies = {
    blob = { behaviour = "wanderer", hp = 2, speed = 20, drops = {} },
    bull = { behaviour = "charger", hp = 4, speed = 20, aggro = 120, drops = {} },
    archer = { behaviour = "archer", hp = 2, shoot = { interval = 0.6, range = 200, keep = 0 }, drops = {} },
    nest = { behaviour = "spawner", hp = 3, spawn = { enemy = "blob", interval = 0.5, max = 2 }, drops = {} },
  },
  bosses = {
    golem = { name = "Golem", hp = 6, iframes = 0.2, phases = {
      { ["until"] = 0.5, steps = { { ["do"] = "wait", time = 0.3 }, { ["do"] = "shoot", pattern = "ring", count = 6 } } },
      { ["until"] = 0, steps = { { ["do"] = "chase", time = 0.5 }, { ["do"] = "summon", enemy = "blob", count = 1 } } },
    } },
  },
  npcs = { merchant = { name = "Moss", dialog = { "Hello!" }, gives = "boots", shop = { { item = "bombs", price = 5 } } } },
  warps = { to_other = { scene = "scenes/other.scene.json", entry = "from_other" } },
})
`;

const FLOOR = (cols: number, rows: number) => Array.from({ length: rows }, () => "_".repeat(cols)).join("\n");

interface Opts { grid: string[]; script?: string; areaOpts?: string; save?: MemorySaveHost; room?: [number, number] }

function areaPkg(o: Opts) {
  const cols = o.grid[0]!.length, rows = o.grid.length;
  const scene = (root: string, mapData: string, extra = "") => ({
    format: "0", root,
    entities: {
      [root]: { type: "Node2D", children: [`${root}_cam`, `${root}_floor`, `${root}_obj`, `${root}_hero`] },
      [`${root}_cam`]: { type: "Camera2D", props: { zoom: 3, position: [80, 64] } },
      [`${root}_floor`]: { type: "TileMap2D", props: { tile_size: 16, tileset: "data/tilesets/t.json", data: FLOOR(cols, rows), collision: false }, tags: ["area_map"] },
      [`${root}_obj`]: { type: "TileMap2D", props: { tile_size: 16, tileset: "data/tilesets/t.json", data: mapData, collision: false }, tags: ["area_map"], scripts: ["scripts/client/main.luau"] },
      [`${root}_hero`]: { type: "Node2D", props: { position: [40, 40] }, tags: ["player"], children: [`${root}_hero_sprite`] },
      [`${root}_hero_sprite`]: { type: "Sprite2D", props: { size: [12, 14], modulate: "#40a0ff" } },
    },
    _extra: extra,
  });
  const main = scene("main", o.grid.join("\n"));
  const other = scene("other", ["__________", "____E_____", "__________"].join("\n"));
  delete (main as any)._extra; delete (other as any)._extra;
  const room = o.room ? `room = { ${o.room[0]}, ${o.room[1]} },` : "";
  return Package.fromFiles({
    "dreamsy.toml": MANIFEST(),
    "scenes/main.scene.json": JSON.stringify(main),
    "scenes/other.scene.json": JSON.stringify(other),
    "data/tilesets/t.json": TILESET,
    "scripts/shared/setup.luau": `local kit = require("@kit/topdown")\n${CONTENT}\nreturn kit`,
    "scripts/client/main.luau": `
local kit = require("../shared/setup")
local area = kit.area.start({ id = currentScene(), hud = false, start_items = { "sword" }, ${room} ${o.areaOpts ?? ""} })
for _, ev in { "hurt", "death", "enemyKilled", "item", "doorOpened", "broke", "roomEnter", "warp", "talk", "bought", "chest", "puzzleSolved", "bossDefeated", "bossPhase", "hooked", "hookLanded", "blockPushed", "roomCleared" } do
  area.events:on(ev, function(a) print("EV " .. ev .. " " .. tostring(if type(a) == "table" then (a.id or a.key or "") else a)) end)
end
${o.script ?? ""}
`,
  });
}

const steps = (g: Game, n: number, each?: (i: number) => void) => { for (let i = 0; i < n; i++) { each?.(i); g.step(); } };
const heroPos = (g: Game) => { const h = [...g.world.walk()].find((e) => e.tags.has("player"))!; return h.get<number[]>("position"); };
const noErrors = (g: Game) => expect(g.errors.map((e) => `${e.script}:${e.line}: ${e.message}`)).toEqual([]);
const events = (g: Game) => g.logs.filter((l) => l.text.startsWith("EV ")).map((l) => l.text.slice(3));
const logs = (g: Game) => g.logs.map((l) => l.text);
const move = (g: Game, x: number, y: number) => { g.input.setAxis("move_x", x); g.input.setAxis("move_y", y); };
const tap = (g: Game, b: string) => { g.input.tap(b); };
// player_offset {0,-4}: entity y = feet y - 4
const OPEN = [
  "##########",
  "#________#",
  "#_P______#",
  "#________#",
  "#________#",
  "#________#",
  "#________#",
  "##########",
];

describe("topdown kit: movement", () => {
  it("moves at speed in 8 directions (diagonals normalized) and collides with walls", async () => {
    const g = await Game.load(areaPkg({ grid: OPEN }));
    steps(g, 2);
    const [x0, y0] = heroPos(g);
    steps(g, 30, () => move(g, 1, 0));
    expect(heroPos(g)[0]! - x0!).toBeCloseTo(40, 0); // 80 px/s × 0.5 s
    const [x1, y1] = heroPos(g);
    steps(g, 15, () => move(g, -1, 1));
    const d = Math.hypot(heroPos(g)[0]! - x1!, heroPos(g)[1]! - y1!);
    expect(d).toBeCloseTo(20, 0);
    steps(g, 200, () => move(g, 1, 0));
    // wall at col 9 → x = 144 - 5 (hitbox half-width)
    expect(heroPos(g)[0]).toBeCloseTo(139, 1);
    expect(y0).toBeDefined();
    noErrors(g);
  });
});

describe("topdown kit: combat", () => {
  it("sword kills an enemy; contact hurts once per i-frame window with knockback", async () => {
    const grid = [...OPEN];
    grid[2] = "#_P_s____#";
    const g = await Game.load(areaPkg({ grid, areaOpts: "player = { hearts = 3 }", script: `for _, e in area.enemies do e.def.speed = 0 end` }));
    steps(g, 2);
    // walk up to it, face right and swing
    steps(g, 60, (i) => { move(g, i < 12 ? 1 : 0, 0); if (i % 12 === 0 && i >= 12) tap(g, "action"); });
    expect(events(g)).toContain("enemyKilled blob");
    // second blob: walk into it
    const g2 = await Game.load(areaPkg({ grid, script: `for _, e in area.enemies do e.def.speed = 0 end` }));
    steps(g2, 2);
    const hx = heroPos(g2)[0]!;
    steps(g2, 40, () => move(g2, 1, 0));
    const hurts = events(g2).filter((e) => e.startsWith("hurt"));
    expect(hurts.length).toBe(1);
    expect(hurts[0]).toBe("hurt 1");
    noErrors(g); noErrors(g2);
    expect(hx).toBeGreaterThan(0);
  });

  it("charger charges when aligned; archer shoots; spawner spawns", async () => {
    const grid = [...OPEN];
    grid[2] = "#_P_____c#";
    const g = await Game.load(areaPkg({ grid }));
    steps(g, 120);
    expect(events(g).filter((e) => e.startsWith("hurt")).length).toBeGreaterThan(0);
    const grid2 = [...OPEN];
    grid2[2] = "#_P_____a#";
    const g2 = await Game.load(areaPkg({ grid: grid2, script: `area.events:on("enemy_shoot", function() print("SHOT") end)` }));
    steps(g2, 120);
    expect(logs(g2)).toContain("SHOT");
    const grid3 = [...OPEN];
    grid3[5] = "#______n_#";
    const g3 = await Game.load(areaPkg({ grid: grid3, script: `onTick(function() if time() > 2 and time() < 2.02 then print("COUNT " .. #area.enemies) end end)` }));
    steps(g3, 130);
    expect(logs(g3)).toContain("COUNT 3");
    noErrors(g); noErrors(g2); noErrors(g3);
  });
});

describe("topdown kit: ai enemies", () => {
  it("behaviour \"ai\" drives an @kit/ai brain with the kit's grid collision (turret shoots, chase hurts)", async () => {
    const grid = [...OPEN];
    grid[2] = "#_P_____s#";
    const g = await Game.load(areaPkg({ grid, script: `
      kit.content.register("enemies", "blob", { behaviour = "ai", hp = 2, ai = { behavior = "turret", fireEvery = 0.5, firstShot = 0.2, range = 200 } })
      area.events:on("enemy_shoot", function() print("SHOT") end)
      area:addEnemy("blob", area:roomCell(0, 0, 5, 5))` }));
    steps(g, 90);
    expect(logs(g)).toContain("SHOT");
    noErrors(g);
    const g2 = await Game.load(areaPkg({ grid: OPEN, script: `
      kit.content.register("enemies", "hunter", { behaviour = "ai", hp = 2, ai = { behavior = "chase", speed = 60, aggro = 200 } })
      area:addEnemy("hunter", area:roomCell(0, 0, 7, 5))` }));
    steps(g2, 120);
    expect(events(g2).some((e) => e.startsWith("hurt"))).toBe(true);
    noErrors(g2);
  });
});

describe("topdown kit: items gate areas", () => {
  it("rough ground blocks until boots; bombs break cracked walls; hookshot crosses a gap", async () => {
    const grid = [...OPEN];
    grid[2] = "#_P_R____#";
    const g = await Game.load(areaPkg({ grid }));
    steps(g, 60, () => move(g, 1, 0));
    expect(heroPos(g)[0]).toBeLessThan(64);
    const g2 = await Game.load(areaPkg({ grid, script: `area:give("boots")` }));
    steps(g2, 60, () => move(g2, 1, 0));
    expect(heroPos(g2)[0]).toBeGreaterThan(90);

    const gridX = [...OPEN];
    gridX[2] = "#_P_X____#";
    const g3 = await Game.load(areaPkg({ grid: gridX, script: `area:give("bombs")` }));
    steps(g3, 20, () => move(g3, 1, 0));
    move(g3, 0, 0);
    tap(g3, "action2");
    steps(g3, 80);
    expect(events(g3)).toContain("broke cracked");
    steps(g3, 60, () => move(g3, 1, 0));
    expect(heroPos(g3)[0]).toBeGreaterThan(90);

    const gridH = [...OPEN];
    gridH[2] = "#_P~~~_O_#";
    const g4 = await Game.load(areaPkg({ grid: gridH, script: `area:give("hookshot")` }));
    steps(g4, 30, () => move(g4, 1, 0));
    expect(heroPos(g4)[0]).toBeLessThan(48);
    move(g4, 0, 0);
    tap(g4, "action2");
    steps(g4, 60);
    expect(events(g4)).toContain("hookLanded nil");
    expect(heroPos(g4)[0]).toBeCloseTo(104, 0); // pulled across the gap, next to the post (col 6)
    noErrors(g); noErrors(g2); noErrors(g3); noErrors(g4);
  });
});

describe("topdown kit: keys, doors, chests, save", () => {
  it("locked door needs a key; picking up the key opens it; state survives a reload", async () => {
    const grid = [...OPEN];
    grid[2] = "#_P__L___#";
    grid[5] = "#_k______#";
    const save = new MemorySaveHost();
    const g = await Game.load(areaPkg({ grid }), { save });
    steps(g, 60, () => move(g, 1, 0));
    expect(heroPos(g)[0]).toBeLessThan(80);
    expect(events(g)).not.toContain("doorOpened locked");
    // fetch the key (col 2, row 5)
    steps(g, 60, () => move(g, -1, 1));
    expect(events(g)).toContain("item key");
    steps(g, 36, () => move(g, 0, -1));
    steps(g, 90, () => move(g, 1, 0));
    expect(events(g)).toContain("doorOpened locked");
    expect(heroPos(g)[0]).toBeGreaterThan(100);
    noErrors(g);
    const p = (save.data as any).core.d.topdown;
    expect(Object.keys(p.done).some((k) => k.endsWith(":5:2"))).toBe(true);
    // reload: door stays open, key stays taken, keys spent
    const g2 = await Game.load(areaPkg({ grid }), { save });
    steps(g2, 90, () => move(g2, 1, 0));
    expect(heroPos(g2)[0]).toBeGreaterThan(100);
    expect(events(g2)).not.toContain("item key");
    noErrors(g2);
  });

  it("chests give items; NPC dialog gives items; shops sell for rupees", async () => {
    const grid = [...OPEN];
    grid[2] = "#_P_C____#";
    grid[4] = "#_N______#";
    grid[5] = "#_$$$$$$_#";
    const save = new MemorySaveHost();
    const g = await Game.load(areaPkg({ grid }), { save });
    steps(g, 10, () => move(g, 1, 0));
    move(g, 0, 0);
    tap(g, "action");
    steps(g, 5);
    expect(events(g)).toContain("chest bombs");
    // talk to the NPC below-left: face down from (2,3)
    steps(g, 10, () => move(g, -1, 0.0));
    steps(g, 12, () => move(g, 0, 1));
    move(g, 0, 0);
    tap(g, "action");
    steps(g, 3);
    expect(events(g)).toContain("talk merchant");
    expect(g.dialogs.current).toBeTruthy();
    // advance dialog: confirm until the shop choice; pick option 1 (bombs, 5 rupees) — but we have 0 rupees
    for (let i = 0; i < 20 && g.dialogs.current?.kind !== "choice"; i++) { g.dialogTap(-1); steps(g, 8); }
    expect(events(g)).toContain("item boots");
    g.dialogTap(0);
    steps(g, 5);
    expect(events(g)).not.toContain("bought bombs");
    noErrors(g);
  });
});

describe("topdown kit: puzzles, rooms, warps", () => {
  it("pushing a block onto a plate opens the gate", async () => {
    const grid = [
      "##########",
      "#________#",
      "#_P_B_p__#",
      "#________#",
      "######G###",
      "#________#",
      "#________#",
      "##########",
    ];
    const g = await Game.load(areaPkg({ grid }));
    steps(g, 120, () => move(g, 1, 0));
    expect(events(g).filter((e) => e.startsWith("blockPushed")).length).toBeGreaterThanOrEqual(2);
    expect(events(g)).toContain("puzzleSolved 0,0");
    noErrors(g);
  });

  it("walking off a room slides the camera into the next room; enemies spawn per room; minimap marks visits", async () => {
    const grid = [
      "####################",
      "#__________________#",
      "#_P________________#",
      "#__________________#",
      "#____________s_____#",
      "#__________________#",
      "#__________________#",
      "####################",
    ];
    const save = new MemorySaveHost();
    const g = await Game.load(areaPkg({ grid, room: [10, 8], script: `onTick(function() print("ROOM " .. area.room.key .. " " .. #area.room.live) end)` }), { save });
    steps(g, 5);
    expect(logs(g)).toContain("ROOM 0,0 0");
    steps(g, 150, () => move(g, 1, 0));
    const ev = events(g);
    expect(ev).toContain("roomEnter 1,0");
    expect(logs(g)).toContain("ROOM 1,0 1");
    const cam = g.world.byId.get("main_cam")!.get<number[]>("position");
    expect(cam[0]).toBeGreaterThan(160); // camera now on room 1 (x 160..320)
    expect((save.data as any).core.d.topdown.visited["scenes/main.scene.json"]).toEqual({ "0,0": true, "1,0": true });
    noErrors(g);
  });

  it("warps load the target scene at its entry point", async () => {
    const grid = [...OPEN];
    grid[2] = "#_P__w___#";
    const g = await Game.load(areaPkg({ grid }));
    for (let i = 0; i < 60 && g.scenePath === "scenes/main.scene.json"; i++) { move(g, 1, 0); g.step(); }
    expect(events(g)).toContain("warp to_other");
    expect(g.scenePath).toBe("scenes/other.scene.json");
    move(g, 0, 0);
    steps(g, 2);
    const p = heroPos(g);
    expect(p[0]).toBeCloseTo(72, 0); // entry E at col 4, row 1 → (72, 24) feet, entity y −4
    expect(p[1]).toBeCloseTo(20, 0);
    noErrors(g);
  });
});

describe("topdown kit: bosses", () => {
  it("boss runs its phase patterns and is defeated by the sword; drops are given", async () => {
    const grid = [...OPEN];
    grid[4] = "#_____K__#";
    const g = await Game.load(areaPkg({ grid, areaOpts: "player = { hearts = 20 }", script: `
      onTick(function()
        local b = area.bosses[1]
        if b and b.alive and time() > 0.5 then area:damageBoss(b, 1) end
      end)` }));
    steps(g, 400);
    const ev = events(g);
    expect(ev.some((e) => e.startsWith("bossPhase"))).toBe(true);
    expect(ev).toContain("bossDefeated golem");
    noErrors(g);
  });
});

describe("topdown kit: example game (games/examples/kit-topdown)", () => {
  const DIR = resolve(__dirname, "../../../games/examples/kit-topdown");

  it("kit.setup() reads data/*.json (no Luau mirror); JSON has the kit schemas' required fields", async () => {
    const pkg = await Package.fromDir(DIR);
    expect(pkg.has("scripts/shared/content.luau")).toBe(false);
    const schema = (n: string) => JSON.parse(readFileSync(resolve(__dirname, `../../kits/topdown/schemas/${n}.json`), "utf8"));
    const ids: string[] = [];
    for (const [dir, s] of [["items", "item"], ["enemies", "enemy"], ["bosses", "boss"], ["npcs", "npc"]] as const) {
      for (const p of pkg.paths(`data/${dir}/`)) {
        const v = JSON.parse(pkg.text(p)!);
        for (const k of schema(s).required) expect(v, `${p}.${k}`).toHaveProperty(k);
        ids.push(`${dir}/${v.id}`);
      }
    }
    const warps = JSON.parse(pkg.text("data/warps.json")!);
    for (const [id, w] of Object.entries<any>(warps)) { expect(pkg.has(w.scene)).toBe(true); ids.push(`warps/${id}`); }
    const probe = `
local kit = require("@kit/topdown")
for _, kind in kit.content.KINDS do for id in kit.content.all(kind) do print("HAS " .. kind .. "/" .. id) end end`;
    const g = await Game.load(pkg.with("scripts/client/zz_probe.luau", probe));
    const has = logs(g).filter((l) => l.startsWith("HAS ")).map((l) => l.slice(4));
    expect(has.sort()).toEqual(ids.sort());
    noErrors(g);
  });

  it("scripted end-to-end run: elder → grotto → bombs → key → hookshot → boss key → boss → home, zero script errors", async () => {
    const autoplay = `
local kit = require("@kit/topdown")
local P = kit.progress
local co
local function wait(t) local u = time() + t while time() < u do coroutine.yield() end end
local function waitScene(s) while currentScene() ~= s or kit.area.current == nil or kit.area.current.loadedFor ~= s do coroutine.yield() end wait(0.1) end
local held = nil
local function A() return kit.area.current end
local function hold(x, y, t) held = { x = x, y = y } wait(t) held = nil end
local function at(rx, ry, c, r, face) local x, y = A():roomCell(rx, ry, c, r) A():teleport(x, y, face) A().hero.iframes = 1e6 wait(0.1) end
local function interact() A():interact() wait(0.2) while ui.dialogOpen() do coroutine.yield() end wait(0.2) end
local function use() A():useItem() end
kit.area.events = kit.area.events
game.sceneLoaded:connect(function(path)
  local a = kit.area.current
  if a then
    a.loadedFor = path
    a.o.input = function(inp) if held then inp.x, inp.y = held.x, held.y end return inp end
    a.events:on("item", function(id) print("ITEM " .. id) end)
    a.events:on("doorOpened", function(tag) print("DOOR " .. tag) end)
    a.events:on("broke", function(tag) print("BROKE " .. tag) end)
    a.events:on("puzzleSolved", function() print("PUZZLE") end)
    a.events:on("hookLanded", function() print("HOOKED") end)
    a.events:on("bossDefeated", function(b) print("BOSS " .. b.id) end)
  end
end)
co = coroutine.create(function()
  waitScene("scenes/overworld.scene.json")
  at(0, 0, 3, 5, "up") interact()                               -- Granny Wick gives the sword
  at(1, 1, 7, 5, "up") hold(0, -1, 0.5)                         -- into the grotto
  waitScene("scenes/grotto.scene.json")
  at(0, 1, 4, 5, "down") hold(0, 1, 2.2)                        -- block onto the plate → gate opens
  at(0, 1, 7, 2, "up") interact()                               -- chest: bombs
  at(0, 1, 7, 10, "down") use() wait(1.8)                       -- bomb the cracked wall
  at(0, 1, 7, 11, "down") hold(0, 1, 1.2)                       -- walk through into the key room
  at(0, 2, 7, 7, "up") interact()                               -- chest: small key
  at(1, 1, 12, 6, "right") hold(1, 0, 0.6)                      -- unlock the east door
  at(2, 1, 11, 10, "up") interact()                             -- chest: hookshot
  at(2, 1, 3, 6, "up") use() wait(1.0)                          -- hook across the pit
  hold(1, 0, 0.4) hold(0, -1, 0.1)
  at(2, 0, 7, 6, "up") interact()                               -- chest: boss key
  at(1, 1, 7, 2, "up") hold(0, -1, 1.5)                         -- boss door, walk in
  local b = A().bosses[1]
  while b and b.alive do A():damageBoss(b, 2) wait(0.7) end
  wait(1.5)
  for _, p in A().pickups do A():teleport(p.x, p.y) end
  wait(0.5)
  at(1, 0, 7, 2, "up") hold(0, -1, 0.3)                         -- stairs home
  waitScene("scenes/overworld.scene.json")
  print("HOME hearts=" .. P.get().hearts .. " cleared=" .. tostring(P.flag("grotto_cleared")))
  at(0, 0, 3, 5, "up") interact()
  print("ALL DONE")
end)
onTick(function()
  if co and coroutine.status(co) == "suspended" then
    local ok, err = coroutine.resume(co)
    if not ok then print("AUTOPLAY ERROR " .. tostring(err)) co = nil end
  end
end)`;
    const pkg = (await Package.fromDir(DIR)).with("scripts/client/zz_autoplay.luau", autoplay);
    const save = new MemorySaveHost();
    const g = await Game.load(pkg, { seed: 5, save });
    for (let i = 0; i < 60 * 120 && !logs(g).includes("ALL DONE"); i++) {
      if (g.dialogs.current && i % 6 === 0) g.dialogTap(-1);
      g.step();
    }
    const l = logs(g).filter((x) => /^(ITEM|DOOR|BROKE|PUZZLE|HOOKED|BOSS|HOME|ALL|AUTOPLAY)/.test(x));
    console.log(l.join("\n"));
    expect(l).toContain("ALL DONE");
    for (const want of ["ITEM sword", "PUZZLE", "ITEM bombs", "BROKE cracked", "ITEM small_key", "DOOR locked", "ITEM hookshot", "HOOKED", "ITEM boss_key", "DOOR boss_locked", "BOSS mire_warden", "ITEM heart_container"]) expect(l).toContain(want);
    expect(l).toContain("HOME hearts=4 cleared=true");
    const d = (save.data as any).core.d;
    const bag = Object.fromEntries(d.inventories.bag.filter(Array.isArray));
    expect(bag).toMatchObject({ sword: 1, bombs: 1, hookshot: 1 });
    expect(d.topdown.bosses.mire_warden).toBe(true);
    expect(d.flags.grotto_cleared).toBe(true);
    noErrors(g);
  });
});
