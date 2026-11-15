// Data reader, clock, timeScale, game.session, ui.theme, UI input_transparent / scale, TileMap2D taps, budgets.
import { Package } from "@dreamsy/format";
import { describe, expect, it } from "vitest";
import { Game, PLAYTEST_EPOCH } from "../core/index.js";
import { simulate } from "../tools/playtest.js";

function pkg(entities: Record<string, unknown>, files: Record<string, string> = {}, manifest = "") {
  return Package.fromFiles({
    "dreamsy.toml": `format = "0"\nname = "P"\ndimension = "2d"\nentry_scene = "scenes/main.scene.json"\n${manifest}\n[style]\npreset = "pixel"\npalette = ["#101020", "#3355ff", "#ffcc00", "#f0f0f0"]\n`,
    "scenes/main.scene.json": JSON.stringify({ format: "0", root: "world", entities: { world: { type: "Node2D", children: Object.keys(entities) }, ...entities } }),
    ...files,
  });
}
const logs = (g: Game) => g.logs.map((l) => l.text);
const steps = (g: Game, n: number) => { for (let i = 0; i < n; i++) g.step(); };

describe("data reader (data.list / data.read, alias files.*)", () => {
  it("lists package dirs and reads JSON/text, read-only copies, clear errors", async () => {
    const g = await Game.load(pkg({}, {
      "data/creatures/fox.json": JSON.stringify({ name: "Fox", hp: 12, moves: ["bite", "dash"] }),
      "data/creatures/owl.json": JSON.stringify({ name: "Owl", hp: 9, moves: [] }),
      "data/creatures/notes.txt": "hello",
      "data/bad.json": "{nope",
      "scripts/client/m.luau": `
        local list = data.list("data/creatures")
        print(table.concat(list, ","))
        local fox = data.read("data/creatures/fox.json")
        print(fox.name, fox.hp, #fox.moves, fox.moves[2])
        fox.hp = 999
        print("fresh", data.read("data/creatures/fox.json").hp, files.read("data/creatures/notes.txt"), data.exists("data/creatures/owl.json"))
        print(pcall(function() return data.read("data/missing.json") end))
        print(pcall(function() return data.read("data/bad.json") end))
        print(pcall(function() return data.read("../dreamsy.toml") end))
        print(#data.list("data/nothing"))
      `,
    }));
    const l = logs(g).join("\n");
    expect(g.errors).toEqual([]);
    expect(l).toContain("data/creatures/fox.json,data/creatures/notes.txt,data/creatures/owl.json");
    expect(l).toContain("Fox\t12\t2\tdash");
    expect(l).toContain("fresh\t12\thello\ttrue");
    expect(l).toMatch(/no file "data\/missing.json"/);
    expect(l).toMatch(/data\/bad.json is not valid JSON/);
    expect(l).toMatch(/bad path "..\/dreamsy.toml"/);
    expect(l).toMatch(/\n0$/m);
  });
});

describe("clock, timeScale, session, theme", () => {
  it("clock.now() is the injected clock (fixed in playtests), wall clock by default", async () => {
    const files = { "scripts/client/c.luau": `after(1, function() print("now " .. clock.now()) end)` };
    const r = await simulate(pkg({}, files), [], 1.5);
    expect(r.logs.join("\n")).toContain(`now ${PLAYTEST_EPOCH + 1}`);
    const g = await Game.load(pkg({}, { "scripts/client/c.luau": `print("wall " .. math.floor(clock.now()))` }));
    const wall = Number(logs(g).find((l) => l.startsWith("wall"))!.split(" ")[1]);
    expect(Math.abs(wall - Date.now() / 1000)).toBeLessThan(5);
  });

  it("game.timeScale scales dt, timers, tweens and physics; 0 freezes them (hit-stop)", async () => {
    const g = await Game.load(pkg({
      box: { type: "Body2D", props: { position: [0, 0], body: "dynamic" } },
      s: { type: "Sprite2D", props: { position: [0, 0] } },
    }, {
      "scripts/client/t.luau": `
        local total = 0
        onTick(function(dt) total += dt end)
        game.timeScale = 0.5
        print("read back " .. game.timeScale)
        tween(entity("s"), { position = vec2(100, 0) }, 1, "linear")
        after(0.5, function() print("timer at tick", total) end)
        every(2, function() print("ts " .. game.timeScale .. " total " .. string.format("%.3f", total)) end)
        local ok, err = pcall(function() game.nope = 1 end)
        print(err)
      `,
    }));
    steps(g, 60); // 1 real second at 0.5x = 0.5 game seconds
    expect(g.world.byId.get("s")!.get<number[]>("position")[0]).toBeCloseTo(50, 5);
    expect(g.time).toBeCloseTo(0.5, 6);
    const y1 = g.world.byId.get("box")!.get<number[]>("position")[1]!;
    g.timeScale = 0;
    steps(g, 30);
    expect(g.world.byId.get("box")!.get<number[]>("position")[1]).toBe(y1);
    expect(g.world.byId.get("s")!.get<number[]>("position")[0]).toBeCloseTo(50, 5);
    g.timeScale = 1;
    steps(g, 30);
    expect(g.world.byId.get("s")!.get<number[]>("position")[0]).toBeCloseTo(100, 5);
    expect(logs(g).some((l) => /game.nope is read-only/.test(l))).toBe(true);
    expect(logs(g)).toContain("read back 0.5"); // live read (not a load-time import constant)
    expect(logs(g).some((l) => l.startsWith("timer at tick"))).toBe(true);
  });

  it("game.session keeps connections alive when the creating entity dies; ui.theme() returns the [ui] theme", async () => {
    const g = await Game.load(pkg({ e: { type: "Node2D", scripts: ["scripts/client/e.luau"] } }, {
      "scripts/client/e.luau": `
        session_ticks, own_ticks = 0, 0
        onTick(function() own_ticks += 1 end)
        game.session(function() onTick(function() session_ticks += 1 if session_ticks == 30 then print("session alive", own_ticks) end end) end)
        after(0.1, function() script.entity:destroy() end)
        local t = ui.theme()
        print(t.primary, t.accent, t.background, t.text, t.panel, t.font)
      `,
    }, `[ui]\nprimary = "#112233"\npanel = "rounded"`));
    steps(g, 40);
    const l = logs(g).join("\n");
    expect(l).toMatch(/session alive\t\d/);
    const own = Number(/session alive\t(\d+)/.exec(l)![1]);
    expect(own).toBeLessThan(10); // the entity's own onTick died with it
    expect(l).toMatch(/#112233\t#[0-9a-f]{6}\t#[0-9a-f]{6}\t#[0-9a-f]{6}\trounded\tpixel/);
  });
});

describe("UI props and TileMap2D taps", () => {
  it("input_transparent panels let taps through; UI scale is tweenable without changing the hit rect", async () => {
    const g = await Game.load(pkg({
      btn: { type: "UIButton", props: { anchor: "center", size: [200, 100] }, scripts: ["scripts/client/b.luau"] },
      frame: { type: "UIPanel", props: { anchor: "center", size: [600, 600], z_index: 5, input_transparent: true } },
      label: { type: "UIText", props: { anchor: "top", size: [300, 60], input_transparent: false, text: "tap me" } },
    }, {
      "scripts/client/b.luau": `
        script.entity.pressed:connect(function() print("pressed") end)
        entity("label").tapped:connect(function() print("label tapped") end)
        tween(script.entity, { scale = vec2(1.2, 1.2) }, 0.2, { yoyo = true })
      `,
    }));
    expect(g.tapScreen(640, 360)).toBe("btn");
    expect(g.tapScreen(640, 30)).toBe("label");
    steps(g, 12);
    expect(g.world.byId.get("btn")!.get<number[]>("scale")[0]).toBeGreaterThan(1.1);
    expect(g.uiRect(g.world.byId.get("btn")!)).toEqual([540, 310, 200, 100]);
    expect(logs(g)).toContain("pressed");
    expect(logs(g)).toContain("label tapped");
  });

  it("TileMap2D fires tileTapped(col, row, char) and tapped", async () => {
    const g = await Game.load(pkg({
      map: { type: "TileMap2D", props: { position: [100, 100], tile_size: 16, tileset: "data/tilesets/t.json", data: "#.#\n###" }, scripts: ["scripts/client/m.luau"] },
    }, {
      "data/tilesets/t.json": JSON.stringify({ tiles: { "#": { color: "#888888", solid: true } } }),
      "scripts/client/m.luau": `
        script.entity.tileTapped:connect(function(c, r, ch) print("tile", c, r, ch) end)
        script.entity.tapped:connect(function() print("map tapped") end)
      `,
    }));
    expect(g.tapWorld(100 + 16 * 2 + 3, 100 + 16 + 3)?.id).toBe("map");
    g.tapWorld(100 + 16 + 3, 100 + 3); // empty cell → char nil
    expect(g.tapWorld(0, 0)).toBeNull(); // outside
    const l = logs(g);
    expect(l).toContain("tile\t2\t1\t#");
    expect(l).toContain("tile\t1\t0\tnil");
    expect(l.filter((x) => x === "map tapped").length).toBe(2);
  });
});

describe("long simulations", () => {
  it("budgetMs raises the per-call Luau budget for headless sims (default stays 250ms)", async () => {
    const heavy = { "scripts/client/h.luau": `local t0 = os.clock() while os.clock() - t0 < 0.4 do end print("survived")` };
    const short = await Game.load(pkg({}, heavy));
    expect(short.errors.map((e) => e.message).join()).toMatch(/execution budget \(250 ms\)/);
    const long = await Game.load(pkg({}, heavy), { budgetMs: 5000 });
    expect(long.errors).toEqual([]);
    expect(logs(long)).toContain("survived");
  });
});

describe("kit-agent fixes", () => {
  const TS = JSON.stringify({ tiles: { "#": { color: "#888888", solid: true, tags: ["wall"] }, "^": { sprite: "asset:sp", tags: ["spike"] } } });
  const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>`;
  it("spawn TileMap2D with tileset+data; map:isSolid / map:tileDef; e.destroyed and isEntity never throw", async () => {
    const g = await Game.load(pkg({ e: { type: "Node2D", scripts: ["scripts/client/m.luau"] } }, {
      "data/tilesets/t.json": TS,
      "assets/sp.svg": SVG, "assets/sp.meta.json": JSON.stringify({ kind: "image", file: "sp.svg" }),
      "data/rooms/a.txt": "#^#\n#.#\n",
      "scripts/client/m.luau": `
        local map = spawn("TileMap2D", { tileset = "data/tilesets/t.json", data = data.read("data/rooms/a.txt"), tile_size = 16 })
        print("dims", map.cols, map.rows, map:isSolid(0, 0), map:isSolid(1, 0), map:isSolid(1, 1), map:isSolid(9, 9))
        local d = map:tileDef("#")
        print("def", d.char, d.solid, d.tags[1], d.color, map:tileDef("^").sprite, map:tileDef("z"))
        local x = spawn("Node2D")
        print("alive", x.destroyed, isEntity(x), isEntity({}), isEntity(nil), isEntity(vec2(1, 2)))
        x:destroy()
        print("dead", x.destroyed, isEntity(x))
      `,
    }));
    expect(g.errors).toEqual([]);
    const l = logs(g);
    expect(l).toContain("dims\t3\t2\ttrue\tfalse\tfalse\tfalse");
    expect(l).toContain("def\t#\ttrue\twall\t#888888\tasset:sp\tnil");
    expect(l).toContain("alive\tfalse\ttrue\tfalse\tfalse\tfalse");
    expect(l).toContain("dead\ttrue\ttrue");
  });
});
