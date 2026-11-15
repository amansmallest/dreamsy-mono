// TileMap2D (tiles, physics, tileTouched, setTile) and scenes (loadScene, params, session scripts).
import { fileURLToPath } from "node:url";
import { Package } from "@dreamsy/format";
import { describe, expect, it } from "vitest";
import { Game, type Entity } from "../core/index.js";

const MANIFEST = (entry = "scenes/main.scene.json") =>
  `format = "0"\nname = "T"\ndimension = "2d"\nentry_scene = "${entry}"\n[style]\npreset = "pixel"\n`;

const TILESET = JSON.stringify({
  tiles: {
    "#": { color: "#888888", solid: true },
    B: { color: "#aa5500", solid: true, tags: ["breakable"] },
    "^": { color: "#ffffff", tags: ["spike"] },
  },
});

// 20 cols × 8 rows, tile 16: floor on row 7, breakable bricks under x≈ 160..208, spike at col 15 row 6
const GRID = [
  "....................",
  "....................",
  "....................",
  "....................",
  "....................",
  "....................",
  "...............^....",
  "##########BBB#######",
].join("\n");

function tilePkg(script: string, opts: { player?: [number, number]; extra?: Record<string, string> } = {}) {
  const scene = {
    format: "0", root: "world",
    entities: {
      world: { type: "Node2D", children: ["map", "player", "label"] },
      map: { type: "TileMap2D", props: { tile_size: 16, tileset: "data/tilesets/t.json", data: "file:data/levels/l.txt" }, scripts: ["scripts/client/main.luau"] },
      player: { type: "Body2D", props: { position: opts.player ?? [40, 90], size: [12, 14], body: "dynamic", lock_rotation: true, friction: 0 }, tags: ["player"] },
      label: { type: "UIText", props: { text: "" } },
    },
  };
  return Package.fromFiles({
    "dreamsy.toml": MANIFEST(),
    "scenes/main.scene.json": JSON.stringify(scene),
    "data/tilesets/t.json": TILESET,
    "data/levels/l.txt": GRID + "\n",
    "scripts/client/main.luau": script,
    ...opts.extra,
  });
}

const steps = (g: Game, n: number, each?: (i: number) => void) => { for (let i = 0; i < n; i++) { each?.(i); g.step(); } };
const pos = (e: Entity) => e.get<number[]>("position");
const label = (g: Game) => g.world.byId.get("label")!.get<string>("text");
const noErrors = (g: Game) => expect(g.errors.map((e) => `${e.script}:${e.line}: ${e.message}`)).toEqual([]);

describe("TileMap2D", () => {
  it("player lands on solid tiles and walks across them without snagging", async () => {
    const g = await Game.load(tilePkg(""));
    const p = g.world.byId.get("player")!;
    steps(g, 90);
    // floor top = row 7 * 16 = 112; half height 7
    expect(pos(p)[1]).toBeCloseTo(105, 0);
    const ys: number[] = [];
    steps(g, 60, () => { g.input.setAxis("move_x", 1); });
    // walk right across the "#"→"B" seam region, setting velocity like a platformer would
    for (let i = 0; i < 60; i++) {
      (g as any).setProp(p, "velocity", [100, (g as any).physics.getVelocity(p)[1]]);
      g.step();
      ys.push(pos(p)[1]!);
    }
    expect(pos(p)[0]).toBeGreaterThan(130);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(0.1);
    // one merged collider for the whole floor row
    expect((g as any).physics.colliderCount(g.world.byId.get("map"))).toBe(1);
    noErrors(g);
  });

  it("tileAt / tagsAt / getTile / worldToCell / cellToWorld / cols / rows", async () => {
    const g = await Game.load(tilePkg(`
      local m = script.entity
      local c, r = m:worldToCell(vec2(165, 120))
      local w = m:cellToWorld(10, 7)
      local tags = m:tagsAt(vec2(15 * 16 + 4, 6 * 16 + 4))
      entity("label").text = table.concat({
        tostring(m:tileAt(vec2(8, 120))), tostring(m:tileAt(vec2(8, 8))), tostring(m:tileAt(vec2(-5, 120))),
        tostring(m:getTile(10, 7)), tostring(c), tostring(r), tostring(w), tags[1] or "none", #m:tagsAt(vec2(8, 8)),
        m.cols, m.rows,
      }, ",")`));
    noErrors(g);
    expect(label(g)).toBe("#,nil,nil,B,10,7,vec2(168, 120),spike,0,20,8");
  });

  it("spike tag fires tileTouched → script respawns the player", async () => {
    const g = await Game.load(tilePkg(`
      local m = script.entity
      local player = entitiesTagged("player")[1]
      local spawnAt = player.position
      local deaths = 0
      m.tileTouched:connect(function(other, ch, col, row)
        if other == player and table.find(m:tagsAt(m:cellToWorld(col, row)), "spike") then
          deaths += 1
          player.position = spawnAt
          player.velocity = vec2(0, 0)
          entity("label").text = "deaths " .. deaths .. " at " .. col .. "," .. row
        end
      end)`, { player: [15 * 16 + 8, 40] }));
    steps(g, 20);
    expect(label(g)).toBe("deaths 1 at 15,6");
    expect(pos(g.world.byId.get("player")!)[1]).toBeLessThan(80); // back at spawn, falling again
    noErrors(g);
  });

  it("setTile removes collision (and tileTouched reports solid tiles)", async () => {
    const g = await Game.load(tilePkg(`
      local m = script.entity
      local touched = {}
      m.tileTouched:connect(function(other, ch, col, row) table.insert(touched, ch .. col) end)
      after(1.5, function()
        entity("label").text = table.concat(touched, " ")
        for c = 10, 12 do m:setTile(c, 7, nil) end
      end)`, { player: [11 * 16 + 8, 80] }));
    const p = g.world.byId.get("player")!;
    steps(g, 85);
    expect(pos(p)[1]).toBeCloseTo(105, 0); // standing on the bricks
    steps(g, 10);
    expect(label(g)).toBe("B11");
    steps(g, 40);
    expect(pos(p)[1]).toBeGreaterThan(130); // fell through the hole
    noErrors(g);
  });

  it("setTile rejects unknown tiles and out-of-bounds cells with clear errors", async () => {
    const g = await Game.load(tilePkg(`
      local m = script.entity
      local ok1, e1 = pcall(function() m:setTile(0, 0, "Z") end)
      local ok2, e2 = pcall(function() m:setTile(99, 0, "#") end)
      entity("label").text = tostring(e1) .. " | " .. tostring(e2)`));
    expect(label(g)).toMatch(/tile "Z" is not defined in data\/tilesets\/t\.json/);
    expect(label(g)).toMatch(/cell \(99, 0\) is outside the map/);
  });

  it("perf: 500×40 map loads and steps fast", async () => {
    // rolling terrain + platforms + spikes, ~20k cells
    const rows: string[] = [];
    for (let r = 0; r < 40; r++) {
      let row = "";
      for (let c = 0; c < 500; c++) {
        const ground = 30 + Math.round(3 * Math.sin(c / 9));
        row += r >= ground ? "#" : r === 20 && c % 13 < 6 ? "#" : r === ground - 1 && c % 29 === 0 ? "^" : r === 12 && c % 17 < 3 ? "B" : ".";
      }
      rows.push(row);
    }
    const big = tilePkg(`script.entity.tileTouched:connect(function() end)`, { player: [40, 300] });
    const pkg = big.with("data/levels/l.txt", rows.join("\n"));
    const t0 = performance.now();
    const g = await Game.load(pkg);
    const loadMs = performance.now() - t0;
    const map = g.world.byId.get("map")!;
    const colliders = (g as any).physics.colliderCount(map);
    const t1 = performance.now();
    steps(g, 600, () => g.input.setAxis("move_x", 1));
    const stepMs = (performance.now() - t1) / 600;
    const t2 = performance.now();
    for (let i = 0; i < 20; i++) { map.tiles!.set(100 + i, 30, undefined); (g as any).physics.markDirty(map); g.step(); }
    const editMs = (performance.now() - t2) / 20;
    console.log(`perf 500×40: load ${loadMs.toFixed(1)}ms, ${colliders} colliders (from ${map.tiles!.cells.filter((k) => k && map.tiles!.kinds[k]!.solid).length} solid tiles), step ${stepMs.toFixed(3)}ms/tick, setTile+rebuild ${editMs.toFixed(2)}ms`);
    expect(colliders).toBeLessThan(1500);
    expect(stepMs).toBeLessThan(4);
    noErrors(g);
  });
});

// ---------------------------------------------------------------- scenes

function scenesPkg() {
  const sceneA = {
    format: "0", root: "a_root",
    entities: {
      a_root: { type: "Node2D", children: ["a_label", "a_box"] },
      a_label: { type: "UIText", props: { text: "" }, tags: ["label"] },
      a_box: { type: "Body2D", props: { body: "dynamic" }, scripts: ["scripts/client/a.luau"] },
    },
  };
  const sceneB = {
    format: "0", root: "b_root",
    entities: {
      b_root: { type: "Node2D", children: ["b_label"] },
      b_label: { type: "UIText", props: { text: "" }, tags: ["label"], scripts: ["scripts/client/b.luau"] },
    },
  };
  return Package.fromFiles({
    "dreamsy.toml": MANIFEST("scenes/a.scene.json"),
    "scenes/a.scene.json": JSON.stringify(sceneA),
    "scenes/b.scene.json": JSON.stringify(sceneB),
    "scripts/shared/state.luau": "return { ticksInA = 0 }",
    // session script: survives scene changes
    "scripts/client/session.luau": `
      local state = require("../shared/state")
      local loads = {}
      game.sceneLoaded:connect(function(path)
        table.insert(loads, path)
        entitiesTagged("label")[1].text = table.concat(loads, ",") .. "|" .. tostring(currentScene()) .. "|" .. tostring(sceneParams().gold)
      end)
      every(0.5, function() state.sessionTicks = (state.sessionTicks or 0) + 1 end)`,
    "scripts/client/a.luau": `
      local state = require("../shared/state")
      onTick(function() state.ticksInA += 1 end)
      every(0.1, function() state.timerInA = (state.timerInA or 0) + 1 end)
      after(0.5, function()
        loadScene("scenes/b.scene.json", { gold = 42 })
        state.afterLoadCall = currentScene() -- switch happens at end of tick
      end)`,
    "scripts/client/b.luau": `
      local state = require("../shared/state")
      local frozenA, frozenTimer = state.ticksInA, state.timerInA
      script.entity.text = "b sees gold=" .. tostring(sceneParams().gold)
      after(0.5, function()
        state.report = table.concat({ tostring(state.ticksInA == frozenA), tostring(state.timerInA == frozenTimer),
          tostring(state.afterLoadCall), tostring((state.sessionTicks or 0) >= 1), tostring(entity("a_box")) }, ",")
        local ok, err = pcall(loadScene, "b")
        script.entity.text = state.report .. "|" .. tostring(err)
      end)`,
  });
}

describe("scenes", () => {
  it("loadScene tears down the old scene, passes params, keeps session scripts", async () => {
    const g = await Game.load(scenesPkg());
    expect(g.scenePath).toBe("scenes/a.scene.json");
    expect(g.world.byId.get("a_label")!.get("text")).toBe("scenes/a.scene.json|scenes/a.scene.json|nil");
    steps(g, 31);
    expect(g.scenePath).toBe("scenes/b.scene.json");
    expect(g.world.byId.has("a_box")).toBe(false);
    // b.luau ran first (sees params), then sceneLoaded fired in the session script
    expect(g.world.byId.get("b_label")!.get("text")).toBe("scenes/a.scene.json,scenes/b.scene.json|scenes/b.scene.json|42");
    steps(g, 40);
    const [report, badPath] = g.world.byId.get("b_label")!.get<string>("text").split("|");
    expect(report).toBe("true,true,scenes/a.scene.json,true,nil");
    expect(badPath).toMatch(/no scene "b" \(did you mean "scenes\/b\.scene\.json"\?\)/);
    noErrors(g);
  });

  it("tile-quest: title → level_1 (spikes, coins, bricks) → level_2 → win, state carried by the session", async () => {
    const pkg = await Package.fromDir(fileURLToPath(new URL("../../games/examples/tile-quest", import.meta.url)));
    const g = await Game.load(pkg, { seed: 1 });
    expect(g.scenePath).toBe("scenes/title.scene.json");
    g.press("start_button");
    g.step();
    expect(g.scenePath).toBe("scenes/level_1.scene.json");
    expect(g.toasts.map((t) => t.text)).toContain("LEVEL 1");
    const hud = () => g.world.byId.get("hud_1")?.get<string>("text") ?? g.world.byId.get("hud_2")?.get<string>("text");
    const player = () => g.avatar()!;

    // run right: collect the 3 ground coins, then fall into spike pit A (cols 24-26) and respawn
    let deathsSeen = false;
    steps(g, 300, () => {
      g.input.setAxis("move_x", 1);
      if (/DEATHS 1/.test(hud() ?? "")) deathsSeen = true;
    });
    expect(hud()).toMatch(/COINS 3/);
    expect(deathsSeen).toBe(true);
    expect(pos(player())[0]).toBeLessThan(24 * 16); // respawned at the start, stuck before the pit

    // brick: stand under col 48 (bricks on row 13) and jump → brick removed
    g.input.setAxis("move_x", 0);
    const map1 = g.world.byId.get("map_1")!;
    (g as any).setProp(player(), "position", [48 * 16 + 8, 265]);
    steps(g, 10);
    expect(map1.tiles!.kindAt(48, 13)?.char).toBe("B");
    g.input.setButton("jump", true);
    steps(g, 40);
    g.input.setButton("jump", false);
    expect(map1.tiles!.kindAt(48, 13)).toBeUndefined();

    // flag → level 2
    (g as any).setProp(player(), "position", [114 * 16 + 8, 265]);
    steps(g, 30, () => g.input.setAxis("move_x", 1));
    expect(g.scenePath).toBe("scenes/level_2.scene.json");
    expect(hud()).toMatch(/LEVEL 2 {3}COINS 4 {3}DEATHS 1/);

    // flag → win; params show totals
    (g as any).setProp(player(), "position", [114 * 16 + 8, 265]);
    steps(g, 30, () => g.input.setAxis("move_x", 1));
    expect(g.scenePath).toBe("scenes/win.scene.json");
    expect(g.world.byId.get("win_stats")!.get("text")).toBe("COINS 4    DEATHS 1");
    g.press("again_button");
    g.step();
    expect(g.scenePath).toBe("scenes/title.scene.json");
    expect(g.logs.filter((l) => /^scene /.test(l.text)).length).toBe(5); // session saw every scene
    noErrors(g);
  });
});

