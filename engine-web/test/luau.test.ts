// Sandbox + API contract checks on a tiny in-memory package.
import { Package } from "@dreamsy/format";
import { describe, expect, it } from "vitest";
import { Game } from "../core/index.js";

const manifest = `format = "0"\nname = "T"\ndimension = "2d"\nentry_scene = "scenes/main.scene.json"\n[style]\npreset = "clean"\n`;
function pkgWith(script: string, extra: Record<string, string> = {}) {
  const scene = {
    format: "0", root: "world",
    entities: {
      world: { type: "Node2D", children: ["floor", "box", "zone", "label"] },
      floor: { type: "Body2D", props: { position: [0, 100], size: [400, 20], body: "static" } },
      box: { type: "Body2D", props: { position: [0, 0], size: [20, 20], body: "dynamic" }, tags: ["player"], scripts: ["scripts/client/main.luau"] },
      zone: { type: "Area2D", props: { position: [0, 60], size: [40, 40] } },
      label: { type: "UIText", props: { text: "hi" } },
    },
  };
  return Package.fromFiles({ "dreamsy.toml": manifest, "scenes/main.scene.json": JSON.stringify(scene), "scripts/client/main.luau": script, ...extra });
}
async function run(script: string, ticks = 60, extra?: Record<string, string>, opts = {}) {
  const g = await Game.load(pkgWith(script, extra), { budgetMs: 100, ...opts });
  for (let i = 0; i < ticks; i++) g.step();
  return g;
}
const text = (g: Game) => g.world.byId.get("label")!.get<string>("text");

describe("luau runtime", () => {
  it("sandbox: no io/debug/loadstring/getfenv, os.clock only", async () => {
    const g = await run(`entity("label").text = table.concat({tostring(io), tostring(debug), tostring(loadstring), tostring(getfenv), type(os.clock), tostring(os.time)}, ",")`, 1);
    expect(text(g)).toBe("nil,nil,nil,nil,function,nil");
    expect(g.errors).toEqual([]);
  });

  it("kills runaway scripts and pcall can't swallow the budget error", async () => {
    const g = await run(`
      local n = 0
      onTick(function() n += 1 entity("label").text = tostring(n) end)
      pcall(function() while true do end end)
      entity("label").text = "survived"`, 3);
    expect(g.errors[0]?.message).toMatch(/execution budget/);
    expect(text(g)).toBe("3"); // the script died, its earlier onTick still runs
  });

  it("memory cap", async () => {
    const g = await run(`local t = {} for i = 1, 1e8 do t[i] = string.rep("x", 100) .. i end`, 1, undefined, { memoryLimitMB: 16, budgetMs: 5000 });
    expect(g.errors[0]?.message).toMatch(/memory/);
  });

  it("vectors, colors, require, entities, physics, signals, timers", async () => {
    const g = await run(`
      local cfg = require("../shared/cfg")
      local box = script.entity
      local v = vec2(3, 4)
      assert(v:length() == 5 and (v * 2).x == 6 and (v + vec2(1, 1)) == vec2(4, 5))
      assert(tostring(color("#ff0000")) == "#ff0000")
      assert(box.id == "box" and box.type == "Body2D" and box.parent == entity("world"))
      assert(#entitiesTagged("player") == 1 and entitiesTagged("player")[1] == box)
      local entered = 0
      entity("zone").bodyEntered:connect(function(other) if other == box then entered += 1 end end)
      local fired = 0
      after(0.5, function() fired += 1 end)
      local t = every(0.25, function() fired += 10 end)
      local s = spawn("Sprite2D", { position = vec2(5, 5), modulate = "#00ff00" }, box)
      assert(s.parent == box and s.modulate.g == 1)
      onTick(function()
        entity("label").text = string.format("%d|%d|%d|%s", cfg.answer, entered, fired, tostring(box.onFloor))
      end)
      after(0.6, function() t:cancel() end)`, 90, { "scripts/shared/cfg.luau": "return { answer = 42 }" });
    expect(g.errors).toEqual([]);
    expect(text(g)).toBe("42|1|21|true");
    expect(g.world.byId.get("box")!.get<number[]>("position")[1]).toBeGreaterThan(70);
  });

  it("reports script errors with file and line", async () => {
    const g = await run(`local x = nil\nonTick(function() local y = x.z end)`, 5);
    expect(g.errors).toHaveLength(1);
    expect(g.errors[0]).toMatchObject({ script: "scripts/client/main.luau", line: 2, count: 5 });
  });

  it("is deterministic for a seed", async () => {
    const a = await run(`entity("label").text = tostring(random()) .. tostring(math.random(1, 6))`, 1, undefined, { seed: 3 });
    const b = await run(`entity("label").text = tostring(random()) .. tostring(math.random(1, 6))`, 1, undefined, { seed: 3 });
    expect(text(a)).toBe(text(b));
  });
});
