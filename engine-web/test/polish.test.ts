// Engine polish pass: 2D lighting, mid-game start for tools, stacked panels, tappedAt, Text2D anchors,
// onTick/after handles, camera.viewSize/screen.size, pointer gestures, prop aliases/resets, validator. Core only (Node).
import { CATALOG, Package, validatePackage } from "@dreamsy/format";
import { describe, expect, it } from "vitest";
import { collectLights, flickerFactor, Game, lightAt, lightingState, MemorySaveHost, text2DOrigin, uiChildRect, type Entity } from "../core/index.js";
import { simulate } from "../tools/playtest.js";

function pkg(opts: { manifest?: string; entities: Record<string, unknown>; root?: string; files?: Record<string, string>; scenes?: Record<string, unknown> }) {
  const manifest = `format = "0"\nname = "P"\ndimension = "2d"\nentry_scene = "scenes/main.scene.json"\n${opts.manifest ?? ""}\n[style]\npreset = "pixel"\n`;
  return Package.fromFiles({
    "dreamsy.toml": manifest,
    "scenes/main.scene.json": JSON.stringify({ format: "0", root: opts.root ?? "world", entities: opts.entities }),
    ...Object.fromEntries(Object.entries(opts.scenes ?? {}).map(([k, v]) => [k, JSON.stringify(v)])),
    ...opts.files,
  });
}
const steps = (g: Game, n: number) => { for (let i = 0; i < n; i++) g.step(); };
const noErrors = (g: Game) => expect(g.errors.map((e) => `${e.script}:${e.line}: ${e.message}`)).toEqual([]);
const byId = (g: Game, id: string) => g.world.byId.get(id)!;
const logs = (g: Game) => g.logs.filter((l) => l.level === "info" && !l.text.startsWith("[")).map((l) => l.text);
const script = (body: string, entities: Record<string, unknown> = {}, extra: Partial<Parameters<typeof pkg>[0]> = {}) => pkg({
  entities: {
    world: { type: "Node2D", scripts: ["scripts/client/main.luau"], children: Object.keys(entities).filter((k) => !Object.values(entities).some((v) => ((v as { children?: string[] }).children ?? []).includes(k))) },
    ...entities,
  },
  ...extra,
  files: { "scripts/client/main.luau": body, ...extra.files },
});

describe("2D lighting", () => {
  it("catalog: Light2D, Lighting2D, emissive + blend props", () => {
    expect(Object.keys(CATALOG.Light2D.props)).toEqual(expect.arrayContaining(["radius", "color", "energy", "falloff", "flicker", "flicker_speed", "enabled"]));
    expect(Object.keys(CATALOG.Lighting2D.props)).toEqual(expect.arrayContaining(["ambient", "darkness", "vignette"]));
    for (const t of ["Sprite2D", "Text2D", "Particles2D"] as const) expect(CATALOG[t].props).toHaveProperty("emissive");
    for (const t of ["Sprite2D", "Particles2D"] as const) expect(CATALOG[t].props).toHaveProperty("blend");
  });

  it("lights follow their parent, flicker deterministically, are tweenable and capped at 64 nearest", async () => {
    const g = await Game.load(script(`
      local torch = entity("torch")
      tween(torch, { energy = 0 }, 1, "linear")
      for i = 1, 70 do spawn("Light2D", { position = vec2(i * 100, 0), radius = 50 }) end
    `, {
      dark: { type: "Lighting2D", props: { ambient: "#000000", darkness: 1, vignette: 0.3 } },
      player: { type: "Node2D", props: { position: [300, 200] }, children: ["torch"] },
      torch: { type: "Light2D", props: { position: [10, 0], radius: 100, color: "#ffffff", energy: 1 } },
    }));
    noErrors(g);
    const st = lightingState(g)!;
    expect(st.darkness).toBe(1);
    expect(st.vignette).toBeCloseTo(0.3);
    let ls = collectLights(g, 310, 200);
    expect(ls).toHaveLength(64);
    expect(ls[0]).toMatchObject({ x: 310, y: 200, radius: 100 });
    // the player moves → the child light follows
    byId(g, "player").props.position = [500, 500];
    ls = collectLights(g, 510, 500);
    expect(ls[0]).toMatchObject({ x: 510, y: 500 });
    // light math: full at the center, dark at the edge and outside
    const one = [{ x: 0, y: 0, radius: 100, color: [1, 1, 1] as [number, number, number], intensity: 1, falloff: 1 }];
    expect(lightAt(st, one, 0, 0)).toEqual([1, 1, 1]);
    expect(lightAt(st, one, 50, 0)[0]).toBeCloseTo(0.5);
    expect(lightAt(st, one, 200, 0)).toEqual([0, 0, 0]);
    expect(lightAt({ ...st, darkness: 0.5 }, [], 0, 0)).toEqual([0.5, 0.5, 0.5]);
    // tween energy → 0: the torch drops out
    steps(g, 61);
    expect(collectLights(g, 510, 500).some((l) => l.x === 510 && l.y === 500)).toBe(false);
    // flicker stays in [1 - amount, 1] and is deterministic
    for (let t = 0; t < 5; t += 0.1) {
      const f = flickerFactor(0.4, 8, t, 3);
      expect(f).toBeGreaterThanOrEqual(0.6 - 1e-9);
      expect(f).toBeLessThanOrEqual(1 + 1e-9);
      expect(flickerFactor(0.4, 8, t, 3)).toBe(f);
    }
  });

  it("no Lighting2D (or hidden) = no darkness; disabled lights are skipped", async () => {
    const g = await Game.load(pkg({ entities: {
      world: { type: "Node2D", children: ["d", "l"] },
      d: { type: "Lighting2D", props: { visible: false } },
      l: { type: "Light2D", props: { enabled: false } },
    } }));
    expect(lightingState(g)).toBeNull();
    expect(collectLights(g, 0, 0)).toEqual([]);
  });
});

describe("tools start mid-game", () => {
  const files = {
    "scripts/client/main.luau": `
      local p = sceneParams()
      print("scene", currentScene(), "level", p.level, "coins", save.get("coins", 0), "clock", clock.now())
    `,
  };
  const scene2 = { format: "0", root: "w2", entities: { w2: { type: "Node2D", scripts: ["scripts/client/main.luau"] } } };

  it("Game.load scene + sceneParams; simulate scene/sceneParams/save/clock", async () => {
    const p = pkg({ entities: { world: { type: "Node2D" } }, scenes: { "scenes/level.scene.json": scene2 }, files });
    const g = await Game.load(p, { scene: "scenes/level.scene.json", sceneParams: { level: 3 } });
    expect(logs(g)).toEqual([expect.stringMatching(/^scene\tscenes\/level\.scene\.json\tlevel\t3\tcoins\t0/)]);
    const r = await simulate(p, [], 0.1, { scene: "scenes/level.scene.json", sceneParams: { level: 7 }, save: { coins: 42 }, clock: 1000 });
    expect(r.errors).toEqual([]);
    expect(r.logs.join("\n")).toMatch(/level\t7\tcoins\t42\tclock\t1000/);
    expect(r.save).toEqual({ coins: 42 });
  });

  it("simulate autoDialog answers choices; audio summary is not capped", async () => {
    const p = script(`
      ui.choice("Pick", { "A", "B", "C" }, function(i) print("picked", i) end)
      for i = 1, 700 do sfx.play("blip") end
    `, {}, { files: { "data/sfx/blip.json": JSON.stringify({ freq: 600 }) } });
    const r = await simulate(p, [], 1, { autoDialog: 2 });
    expect(r.errors).toEqual([]);
    expect(r.logs.join("\n")).toContain("picked\t2");
    expect(r.audio.sfx.blip).toBe(700);
  });
});

describe("UIPanel layout = stack", () => {
  it("stacks visible children in order with gap/padding; hidden ones take no space; taps hit stacked rects", async () => {
    const g = await Game.load(script(`
      entity("b2").pressed:connect(function() print("b2") end)
    `, {
      list: { type: "UIPanel", props: { size: [300, 600], layout: "stack", gap: 10, padding: 20, scroll: true }, children: ["b1", "hid", "b2", "b3"] },
      b1: { type: "UIButton", props: { size: [200, 50] } },
      hid: { type: "UIButton", props: { size: [200, 500], visible: false } },
      b2: { type: "UIButton", props: { size: [200, 60], anchor: "top", offset: [0, 5] } },
      b3: { type: "UIButton", props: { size: [100, 40], anchor: "top_right" } },
    }, { root: "world" }));
    noErrors(g);
    const r = (id: string) => uiChildRect(byId(g, id), 300, 600);
    expect(r("b1")).toEqual([0, 20, 200, 50]);
    expect(r("b2")).toEqual([50, 20 + 50 + 10 + 5, 200, 60]);
    expect(r("b3")).toEqual([200, 20 + 50 + 10 + 5 + 60 + 10, 100, 40]);
    expect(g.tapScreen(150, 100)).toBe("b2");
    expect(logs(g)).toContain("b2");
    // non-stack panels keep anchors
    byId(g, "list").props.layout = "none";
    expect(r("b3")).toEqual([200, 0, 100, 40]);
  });
});

describe("tappedAt (cell taps)", () => {
  it("reports local coords from the sprite's top-left, even when scaled/moved", async () => {
    const g = await Game.load(script(`
      entity("board").tappedAt:connect(function(p)
        print("cell", math.floor(p.x / 50), math.floor(p.y / 50), p.x, p.y)
      end)
    `, { board: { type: "Sprite2D", props: { position: [400, 300], size: [400, 400] } } }));
    noErrors(g);
    g.tapWorld(200 + 75, 100 + 120); // board spans 200..600 x 100..500
    expect(logs(g)).toEqual(["cell\t1\t2\t75\t120"]);
  });
});

describe("Text2D align anchor", () => {
  it("center = centered on position, left = starts at position, right = ends at position; vertically centered", () => {
    expect(text2DOrigin("center", 100, 20)).toEqual([-50, -10]);
    expect(text2DOrigin("left", 100, 20)).toEqual([0, -10]);
    expect(text2DOrigin("right", 100, 20)).toEqual([-100, -10]);
    expect(CATALOG.Text2D.props.align.default).toBe("center");
  });
});

describe("handles: onTick → Connection, after/every → Timer", () => {
  it("onTick:disconnect stops it; after():cancel prevents it", async () => {
    const g = await Game.load(script(`
      local n = 0
      local c
      c = onTick(function() n += 1 if n == 3 then c:disconnect() end end)
      local t = after(0.05, function() print("after fired") end)
      t:cancel()
      local e = every(0.02, function() print("every") end)
      after(0.03, function() e:cancel() end)
      after(0.1, function() print("n", n, c.connected) end)
    `));
    steps(g, 10);
    noErrors(g);
    expect(logs(g)).toEqual(["every", "n\t3\tfalse"]);
  });
});

describe("camera.viewSize / screen.size", () => {
  it("reference size per orientation; view size divides by zoom", async () => {
    const g = await Game.load(script(`
      print(screen.size(), camera.viewSize())
      entity("cam").zoom = 2
      print(camera.viewSize())
    `, { cam: { type: "Camera2D" } }, { manifest: `orientation = "portrait"` }));
    noErrors(g);
    expect(logs(g)).toEqual(["vec2(720, 1280)\tvec2(720, 1280)", "vec2(360, 640)"]);
  });
});

describe("pointer gestures", () => {
  it("pointerDown/pointerUp/swipe fire even when down+up happen between ticks; input.pointer() survives one tick", async () => {
    const g = await Game.load(script(`
      input.pointerDown:connect(function(p) print("down", p.x, p.y) end)
      input.pointerUp:connect(function(p) print("up", p.x, p.y) end)
      input.swipe:connect(function(dir, v) print("swipe", dir, v.x > 0) end)
      onTick(function() local p = input.pointer() if p then print("ptr", p.x) end end)
    `));
    g.pointerDown(100, 500);
    g.pointerUp(300, 510); // same tick: a flick
    g.step();
    noErrors(g);
    expect(logs(g)).toEqual(["down\t100\t500", "up\t300\t510", "swipe\tright\ttrue", "ptr\t300"]);
    steps(g, 3);
    expect(logs(g).filter((l) => l.startsWith("ptr"))).toHaveLength(1);
  });

  it("simulate swipe timeline step", async () => {
    const p = script(`input.swipe:connect(function(dir) print("swipe", dir) end)`);
    const r = await simulate(p, [{ t: 0.2, swipe: { from: [360, 900], to: [360, 600], seconds: 0.1 } }], 0.5);
    expect(r.logs.join("\n")).toContain("swipe\tup");
  });

  it("open dialogs take taps before any UI panel (modal panels don't stall them)", async () => {
    const g = await Game.load(script(`
      entity("modal").tapped:connect(function() print("modal") end)
      ui.dialog({ "hello" }, { speed = 0 }).done:connect(function() print("done") end)
    `, { modal: { type: "UIPanel", props: { size: [720, 1280], z_index: 4096 } } }));
    g.step();
    expect(g.tapScreen(360, 640)).toBe("dialog");
    steps(g, 2);
    expect(logs(g)).toEqual(["done"]);
  });
});

describe("props: aliases and nil resets", () => {
  it("Sprite2D color aliases modulate; nil resets to the default", async () => {
    const g = await Game.load(script(`
      local s = entity("s")
      print(s.color, s.modulate)
      s.color = color("#00ff00")
      print(s.modulate)
      s.modulate = nil
      print(s.modulate)
      local b = entity("b")
      b.text = nil
      print(b.text, b.icon)
    `, { s: { type: "Sprite2D", props: { color: "#ff0000" } }, b: { type: "UIButton", props: { text: "Go" } } }));
    noErrors(g);
    expect(logs(g)).toEqual(["#ff0000\t#ff0000", "#00ff00", "#ffffff", "Button\tnil"]);
    expect(byId(g, "s").get("modulate")).toEqual([1, 1, 1, 1]);
  });
});

describe("validator", () => {
  it("screen-only scenes don't warn about a missing camera; world scenes still do", () => {
    const ui = pkg({ root: "ui", entities: { ui: { type: "Folder", children: ["t"] }, t: { type: "UIText", props: { text: "hi" } } } });
    expect(validatePackage(ui).issues.map((i) => i.code)).not.toContain("scene.no_camera");
    const world = pkg({ entities: { world: { type: "Node2D" } } });
    expect(validatePackage(world).issues.map((i) => i.code)).toContain("scene.no_camera");
  });

  it("new UIPanel / UIText props are in the catalog", () => {
    expect(Object.keys(CATALOG.UIPanel.props)).toEqual(expect.arrayContaining(["layout", "gap", "padding", "tint", "radius", "clip"]));
    expect(CATALOG.UIText.props).toHaveProperty("valign");
  });
});

void MemorySaveHost;
void (null as unknown as Entity);
