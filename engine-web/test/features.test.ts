// Engine v3 features: sprite animation, tweens, particles, camera, save data, dialogs, collision layers,
// portrait layout math. Core only (Node).
import { Package } from "@dreamsy/format";
import { describe, expect, it } from "vitest";
import { anchorRect, fitRect, Game, MemorySaveHost, safeInsets, view2D, type Entity } from "../core/index.js";
import { simulate } from "../tools/playtest.js";

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#f00"/></svg>`;
const asset = (id: string) => ({ [`assets/${id}.svg`]: SVG, [`assets/${id}.meta.json`]: JSON.stringify({ kind: "image", file: `${id}.svg` }) });

function pkg(opts: { manifest?: string; entities: Record<string, unknown>; root?: string; files?: Record<string, string>; scenes?: Record<string, unknown> }) {
  const manifest = `format = "0"\nname = "F"\ndimension = "2d"\nentry_scene = "scenes/main.scene.json"\n${opts.manifest ?? ""}\n[style]\npreset = "pixel"\n`;
  return Package.fromFiles({
    "dreamsy.toml": manifest,
    "scenes/main.scene.json": JSON.stringify({ format: "0", root: opts.root ?? "world", entities: opts.entities }),
    ...Object.fromEntries(Object.entries(opts.scenes ?? {}).map(([k, v]) => [k, JSON.stringify(v)])),
    ...opts.files,
  });
}
const steps = (g: Game, n: number, each?: (i: number) => void) => { for (let i = 0; i < n; i++) { each?.(i); g.step(); } };
const noErrors = (g: Game) => expect(g.errors.map((e) => `${e.script}:${e.line}: ${e.message}`)).toEqual([]);
const byId = (g: Game, id: string) => g.world.byId.get(id)!;
const pos = (e: Entity) => e.get<number[]>("position");

const ANIMS = JSON.stringify({
  run: { frames: ["asset:f1", "asset:f2", "asset:f3"], fps: 10 },
  jump: { frames: ["asset:f1", "asset:f2"], fps: 10, loop: false, next: "idle" },
  idle: { frames: ["asset:f3"], fps: 1 },
});
const animFiles = { ...asset("f1"), ...asset("f2"), ...asset("f3"), "data/anims/fox.json": ANIMS };

describe("sprite animation", () => {
  it("advances frames at fps, loops, and plays from a scene prop", async () => {
    const g = await Game.load(pkg({
      entities: { world: { type: "Node2D", children: ["s"] }, s: { type: "Sprite2D", props: { anims: "data/anims/fox.json", anim: "run" } } },
      files: animFiles,
    }));
    const s = byId(g, "s");
    const tex = () => s.get<string>("texture");
    steps(g, 1);
    expect(tex()).toBe("asset:f1");
    steps(g, 6); // 7 ticks = 0.1167s → frame 1
    expect(tex()).toBe("asset:f2");
    steps(g, 6);
    expect(tex()).toBe("asset:f3");
    steps(g, 6); // wraps
    expect(tex()).toBe("asset:f1");
    noErrors(g);
  });

  it("e:play on a body forwards to its sprite; non-loop fires animFinished then plays `next`; play() is idempotent", async () => {
    const g = await Game.load(pkg({
      entities: {
        world: { type: "Node2D", children: ["body"] },
        body: { type: "Body2D", props: { body: "kinematic" }, children: ["spr"], scripts: ["scripts/client/p.luau"] },
        spr: { type: "Sprite2D", props: { anims: "data/anims/fox.json" } },
      },
      files: {
        ...animFiles,
        "scripts/client/p.luau": `
          local e = script.entity
          finished = {}
          e.animFinished:connect(function(name) table.insert(finished, name) end)
          e:play("jump")
          onTick(function() if time() < 0.05 then e:play("jump") end end) -- calling every tick must not restart
          local ok, err = pcall(function() e:play("fly") end)
          print(err)
          onTick(function() if time() > 0.5 and time() < 0.52 then print("done:" .. table.concat(finished, ",")) end end)
        `,
      },
    }));
    const spr = byId(g, "spr");
    expect(spr.get<string>("anim")).toBe("jump");
    steps(g, 14); // 2 frames at 10fps = 0.2s → finished at tick 12
    expect(spr.get<string>("anim")).toBe("idle");
    expect(spr.get<string>("texture")).toBe("asset:f3");
    steps(g, 20);
    noErrors(g);
    const logs = g.logs.map((l) => l.text);
    expect(logs.some((l) => /no animation "fly".*has: run, jump, idle/.test(l))).toBe(true);
    expect(logs).toContain("done:jump");
  });

  it("auto_flip faces the body's horizontal velocity", async () => {
    const g = await Game.load(pkg({
      entities: {
        world: { type: "Node2D", children: ["body"] },
        body: { type: "Body2D", props: { body: "kinematic" }, children: ["spr"] },
        spr: { type: "Sprite2D", props: { auto_flip: true } },
      },
    }));
    const spr = byId(g, "spr");
    steps(g, 2);
    expect(spr.get<boolean>("flip_h")).toBe(false);
    (g as any).physics.setVelocity(byId(g, "body"), [-100, 0]);
    steps(g, 2);
    expect(spr.get<boolean>("flip_h")).toBe(true);
    (g as any).physics.setVelocity(byId(g, "body"), [100, 0]);
    steps(g, 2);
    expect(spr.get<boolean>("flip_h")).toBe(false);
  });
});

describe("tweens", () => {
  it("interpolates position/scale/rotation/modulate with easings and fires done", async () => {
    const g = await Game.load(pkg({
      entities: { world: { type: "Node2D", children: ["s"] }, s: { type: "Sprite2D", props: { position: [0, 0] }, scripts: ["scripts/client/t.luau"] } },
      files: {
        "scripts/client/t.luau": `
          local e = script.entity
          local t = tween(e, { position = vec2(100, 50), rotation = 90, modulate = color("#000000") }, 1, "linear")
          t.done:connect(function() print("tween done at " .. string.format("%.2f", time())) end)
          tween(e, { scale = vec2(2, 2) }, 0.5, { easing = "quad_out", delay = 0.5 })
        `,
      },
    }));
    const s = byId(g, "s");
    steps(g, 30); // 0.5s
    expect(pos(s)[0]).toBeCloseTo(50, 5);
    expect(pos(s)[1]).toBeCloseTo(25, 5);
    expect(s.get<number>("rotation")).toBeCloseTo(45, 5);
    expect(s.get<number[]>("modulate")[0]).toBeCloseTo(0.5, 5);
    expect(s.get<number[]>("scale")[0]).toBeCloseTo(1, 5); // delayed
    steps(g, 15); // 0.75s: scale quad_out at p=0.5 → 0.75
    expect(s.get<number[]>("scale")[0]).toBeCloseTo(1.75, 5);
    steps(g, 20);
    expect(pos(s)).toEqual([100, 50]);
    expect(s.get<number[]>("scale")).toEqual([2, 2]);
    expect(g.logs.map((l) => l.text)).toContain("tween done at 1.00");
    expect(g.tweenCount).toBe(0);
    noErrors(g);
  });

  it("cancel stops it, loop+yoyo keeps going, bad props are clear errors", async () => {
    const g = await Game.load(pkg({
      entities: { world: { type: "Node2D", children: ["a", "b"] }, a: { type: "Sprite2D", scripts: ["scripts/client/t.luau"] }, b: { type: "Sprite2D" } },
      files: {
        "scripts/client/t.luau": `
          local a, b = script.entity, entity("b")
          local t = tween(a, { position = vec2(100, 0) }, 1, "linear")
          after(0.25, function() t:cancel() end)
          tween(b, { position = vec2(0, 60) }, 0.5, { easing = "sine_in_out", loop = true, yoyo = true })
          local ok, err = pcall(function() tween(a, { text = "x" }, 1) end)
          print(err)
          ok, err = pcall(function() tween(a, { position = vec2(1, 1) }, 1, "wobble") end)
          print(err)
        `,
      },
    }));
    steps(g, 60);
    expect(pos(byId(g, "a"))[0]).toBeCloseTo((14 / 60) * 100, 5); // timers run before tweens: cancelled at tick 15
    expect(pos(byId(g, "b"))[1]).toBeCloseTo(0, 3); // 1s = one full there-and-back
    steps(g, 30);
    expect(pos(byId(g, "b"))[1]).toBeCloseTo(60, 3);
    const logs = g.logs.map((l) => l.text).join("\n");
    expect(logs).toMatch(/no tweenable property "text"/);
    expect(logs).toMatch(/unknown easing "wobble"/);
  });
});

describe("particles", () => {
  const particleGame = (props: Record<string, unknown>, seed = 3) => Game.load(pkg({
    entities: { world: { type: "Node2D", children: ["fx"] }, fx: { type: "Particles2D", props: { position: [100, 100], ...props }, scripts: ["scripts/client/fx.luau"] } },
    files: { "scripts/client/fx.luau": `local e = script.entity\nonTick(function() if time() > 0.99 and time() < 1.01 then print("count " .. e.particleCount) end end)` },
  }), { seed });

  it("emits at rate, ages out, bursts, caps at max_particles", async () => {
    const g = await particleGame({ rate: 60, lifetime: 2, lifetime_random: 0 });
    const fx = byId(g, "fx");
    steps(g, 60);
    expect(fx.emitter!.n).toBeGreaterThanOrEqual(59);
    expect(fx.emitter!.n).toBeLessThanOrEqual(60);
    expect(g.logs.map((l) => l.text).some((t) => /^count \d+$/.test(t))).toBe(true);
    steps(g, 180); // steady state: rate × lifetime
    expect(fx.emitter!.n).toBeGreaterThanOrEqual(118);
    expect(fx.emitter!.n).toBeLessThanOrEqual(121);

    const g2 = await particleGame({ emitting: false, max_particles: 50, lifetime: 0.5, lifetime_random: 0 });
    const fx2 = byId(g2, "fx");
    steps(g2, 5);
    expect(fx2.emitter?.n ?? 0).toBe(0);
    (g2 as any).burst(fx2, 30);
    expect(fx2.emitter!.n).toBe(30);
    (g2 as any).burst(fx2, 30);
    expect(fx2.emitter!.n).toBe(50); // capped
    steps(g2, 31); // > 0.5s
    expect(fx2.emitter!.n).toBe(0);
  });

  it("is deterministic for a seed, moves with gravity in world space", async () => {
    const a = await particleGame({ rate: 30, gravity: [0, 600], direction: -90, spread: 30 });
    const b = await particleGame({ rate: 30, gravity: [0, 600], direction: -90, spread: 30 });
    steps(a, 40); steps(b, 40);
    const ea = byId(a, "fx").emitter!, eb = byId(b, "fx").emitter!;
    expect(ea.n).toBe(eb.n);
    expect([...ea.x.subarray(0, ea.n)]).toEqual([...eb.x.subarray(0, eb.n)]);
    // the oldest particle went up, then fell back down (gravity)
    expect(ea.vy[0]!).toBeGreaterThan(-120);
  });

  it("e:burst from Luau", async () => {
    const g = await Game.load(pkg({
      entities: { world: { type: "Node2D", children: ["fx"] }, fx: { type: "Particles2D", props: { emitting: false }, scripts: ["scripts/client/b.luau"] } },
      files: { "scripts/client/b.luau": `script.entity:burst(12)\nprint("n=" .. script.entity.particleCount)` },
    }));
    expect(g.logs.map((l) => l.text)).toContain("n=12");
    noErrors(g);
  });
});

describe("camera", () => {
  const camGame = (cam: Record<string, unknown>, script = "") => Game.load(pkg({
    entities: {
      world: { type: "Node2D", children: ["p", "cam"] },
      p: { type: "Node2D", props: { position: [0, 0] }, scripts: ["scripts/client/c.luau"] },
      cam: { type: "Camera2D", props: { follow: "p", ...cam } },
    },
    files: { "scripts/client/c.luau": script },
  }));

  it("shake offsets decay to zero and are deterministic", async () => {
    const run = async () => {
      const g = await camGame({}, `camera.shake(10, 0.5)`);
      const offs: number[][] = [];
      steps(g, 40, () => offs.push([...g.shakeOffset]));
      return { g, offs };
    };
    const { g, offs } = await run();
    const mags = offs.map(([x, y]) => Math.hypot(x!, y!));
    expect(Math.max(...mags.slice(0, 10))).toBeGreaterThan(3);
    expect(mags.every((m) => m <= 10 * Math.SQRT2 + 1e-9)).toBe(true);
    expect(mags.slice(31).every((m) => m === 0)).toBe(true);
    expect(g.cameraView().x).toBe(0);
    expect((await run()).offs).toEqual(offs);
  });

  it("smoothing lags behind, deadzone holds still, limits clamp the view", async () => {
    const g = await camGame({ smoothing: 0.5 });
    steps(g, 1);
    const p = byId(g, "p");
    p.props.position = [200, 0];
    steps(g, 1);
    const x1 = g.cameraView().x;
    expect(x1).toBeGreaterThan(0);
    expect(x1).toBeLessThan(200);
    steps(g, 120);
    expect(g.cameraView().x).toBeCloseTo(200, 1);

    const d = await camGame({ deadzone: [100, 100] });
    steps(d, 1);
    byId(d, "p").props.position = [40, 0];
    steps(d, 1);
    expect(d.cameraView().x).toBe(0);
    byId(d, "p").props.position = [80, 0];
    steps(d, 1);
    expect(d.cameraView().x).toBe(30);

    // landscape 1280×720 view; limits 0..2000 × 0..720 → x ∈ [640, 1360], y fixed at 360
    const l = await camGame({ limit_min: [0, 0], limit_max: [2000, 720] });
    steps(l, 1);
    expect([l.cameraView().x, l.cameraView().y]).toEqual([640, 360]);
    byId(l, "p").props.position = [5000, 100];
    steps(l, 1);
    expect([l.cameraView().x, l.cameraView().y]).toEqual([1360, 360]);
  });

  it("zoomTo tweens the camera zoom; screenToWorld matches the view", async () => {
    const g = await camGame({}, `
      local t = camera.zoomTo(2, 0.5)
      t.done:connect(function()
        local w = camera.screenToWorld(vec2(0, 0))
        print("tl", w.x, w.y)
        local s = camera.worldToScreen(vec2(0, 0))
        print("center", s.x, s.y)
      end)
    `);
    steps(g, 40);
    expect(byId(g, "cam").get<number>("zoom")).toBe(2);
    const logs = g.logs.map((l) => l.text);
    expect(logs).toContain("tl\t-320\t-180");
    expect(logs).toContain("center\t640\t360");
    noErrors(g);
  });
});

describe("save data", () => {
  const files = {
    "scripts/client/session.luau": `
      local n = save.get("runs", 0) + 1
      save.set("runs", n)
      save.set("profile", { name = "fox", levels = { 1, 2, 3 }, best = { time = 12.5 } })
      print("runs " .. n)
      game.sceneLoaded:connect(function(p)
        if p == "scenes/two.scene.json" then
          local prof = save.get("profile")
          print("two:" .. prof.name .. ":" .. #prof.levels .. ":" .. prof.best.time .. ":" .. save.get("runs"))
          local ok, err = pcall(function() save.set("bad", vec2(1, 2)) end)
          print(err)
          ok, err = pcall(function() save.set("huge", string.rep("x", 70000)) end)
          print(err)
          save.remove("profile")
          print("after remove " .. tostring(save.get("profile")))
        end
      end)
      after(0.1, function() loadScene("scenes/two.scene.json") end)
    `,
  };
  const make = () => pkg({
    entities: { world: { type: "Node2D" } },
    scenes: { "scenes/two.scene.json": { format: "0", root: "two", entities: { two: { type: "Node2D" } } } },
    files,
  });

  it("persists across loadScene and across game launches (shared host), with JSON + size checks", async () => {
    const host = new MemorySaveHost();
    const g = await Game.load(make(), { save: host });
    steps(g, 20);
    noErrors(g);
    const logs = g.logs.map((l) => l.text);
    expect(logs).toContain("runs 1");
    expect(logs).toContain("two:fox:3:12.5:1");
    expect(logs.some((l) => /save values must be nil, booleans/.test(l))).toBe(true);
    expect(logs.some((l) => /max 65536 \(64KB\)/.test(l))).toBe(true);
    expect(logs).toContain("after remove nil");
    expect(host.data).toEqual({ runs: 1 });
    g.dispose();
    const g2 = await Game.load(make(), { save: host });
    expect(g2.logs.map((l) => l.text)).toContain("runs 2");
  });
});

describe("dialogs", () => {
  const dlg = (script: string) => Game.load(pkg({
    entities: { world: { type: "Node2D", children: ["p"] }, p: { type: "Node2D", scripts: ["scripts/client/d.luau"] } },
    files: { "scripts/client/d.luau": script },
  }));

  it("typewriter, advance with jump/action, blocks game input, done fires", async () => {
    const g = await dlg(`
      jumps = 0
      onTick(function() if input.pressed("jump") then jumps += 1 end end)
      local d = ui.dialog({ "Hello there!", { text = "I'm the fox.", speaker = "Fox", portrait = "asset:f1" } }, { speed = 30 })
      d.done:connect(function() print("dialog done, jumps " .. jumps) end)
      after(3, function() print("later jumps " .. jumps) end)
    `);
    const d = () => g.dialogs.current;
    expect(d()!.lines[0]!.text).toBe("Hello there!");
    steps(g, 10); // 1/6 s at 30 cps = 5 chars
    expect(Math.floor(d()!.shown)).toBe(5);
    g.input.tap("jump"); steps(g, 1); // first press completes the line
    expect(d()!.shown).toBe(12);
    expect(d()!.index).toBe(0);
    g.input.tap("action"); steps(g, 1); // next line
    expect(d()!.index).toBe(1);
    expect(d()!.lines[1]!.speaker).toBe("Fox");
    g.input.tap("jump"); steps(g, 1);
    g.input.tap("jump"); steps(g, 1); // close
    expect(d()).toBeNull();
    steps(g, 5);
    g.input.tap("jump"); steps(g, 1); // now the game sees jumps
    steps(g, 200);
    const logs = g.logs.map((l) => l.text);
    expect(logs).toContain("dialog done, jumps 0");
    expect(logs).toContain("later jumps 1");
    noErrors(g);
  });

  it("choice: navigate with move_y, confirm with action → callback gets 1-based index; taps work headless", async () => {
    const g = await dlg(`
      ui.choice("Take the key?", { "Yes", "No", "Maybe" }, function(i) print("picked " .. i)
        local d2 = ui.dialog("Ok!", { speed = 0 })
        d2.done:connect(function() print("bye") end)
      end, { speed = 0 })
    `);
    steps(g, 2);
    g.input.setAxis("move_y", 1); steps(g, 1);
    g.input.setAxis("move_y", 0); steps(g, 1);
    g.input.setAxis("move_y", 1); steps(g, 1);
    g.input.setAxis("move_y", 0); steps(g, 1);
    expect(g.dialogs.current!.selected).toBe(2);
    g.input.tap("action"); steps(g, 1);
    expect(g.logs.map((l) => l.text)).toContain("picked 3");
    expect(g.dialogs.current!.lines[0]!.text).toBe("Ok!");
    expect(g.tapScreen(360, 640)).toBe("dialog");
    steps(g, 1);
    expect(g.dialogs.current).toBeNull();
    expect(g.logs.map((l) => l.text)).toContain("bye");
    noErrors(g);
  });

  it("playtest simulate() reports dialog lines and advances them with presses", async () => {
    const p = pkg({
      entities: { world: { type: "Node2D" } },
      files: { "scripts/client/s.luau": `ui.dialog({ { text = "One", speaker = "A" }, "Two" }, { speed = 0 })\nsave.set("seen", true)` },
    });
    const r = await simulate(p, [{ t: 0.5, press: ["jump"] }], 1);
    expect(r.errors).toEqual([]);
    expect(r.dialogLog).toEqual(["A: One", "Two"]);
    expect(r.dialog?.text).toBe("Two");
    expect(r.save).toEqual({ seen: true });
  });
});

describe("collision layers", () => {
  it("bodies only collide with layers in their mask; areas only detect masked layers", async () => {
    const g = await Game.load(pkg({
      manifest: `[physics]\nlayers = ["player", "enemy", "world", "pickup"]`,
      entities: {
        world: { type: "Node2D", children: ["floor", "player", "enemy", "zone", "ghost"] },
        floor: { type: "Body2D", props: { position: [200, 300], size: [800, 20], layer: "world" } },
        player: { type: "Body2D", props: { position: [200, 100], size: [20, 20], body: "dynamic", lock_rotation: true, layer: "player", mask: "world,pickup" }, tags: ["player"] },
        enemy: { type: "Body2D", props: { position: [200, 40], size: [20, 20], body: "dynamic", lock_rotation: true, layer: "enemy", mask: "world" } },
        ghost: { type: "Body2D", props: { position: [400, 100], size: [20, 20], body: "dynamic", layer: "enemy", mask: "enemy" } },
        zone: { type: "Area2D", props: { position: [200, 280], size: [100, 20], mask: "player" }, scripts: ["scripts/client/z.luau"] },
      },
      files: { "scripts/client/z.luau": `script.entity.bodyEntered:connect(function(o) print("zone " .. o.id) end)` },
    }));
    steps(g, 120);
    noErrors(g);
    const p = pos(byId(g, "player")), e = pos(byId(g, "enemy")), gh = pos(byId(g, "ghost"));
    // both rest on the floor (top 290, half height 10) — enemy fell through the player instead of stacking
    expect(p[1]).toBeCloseTo(280, 0);
    expect(e[1]).toBeCloseTo(280, 0);
    expect(gh[1]).toBeGreaterThan(400); // ghost collides with nothing but enemies: falls through the floor
    const logs = g.logs.map((l) => l.text);
    expect(logs).toContain("zone player");
    expect(logs).not.toContain("zone enemy");
  });

  it("unknown layer names are errors (script) and validator issues (scene)", async () => {
    const g = await Game.load(pkg({
      manifest: `[physics]\nlayers = ["player"]`,
      entities: { world: { type: "Node2D", children: ["b"] }, b: { type: "Body2D", scripts: ["scripts/client/b.luau"] } },
      files: { "scripts/client/b.luau": `local ok, err = pcall(function() script.entity.layer = "lava" end)\nprint(err)\nprint(script.entity.layer == "")` },
    }));
    const logs = g.logs.map((l) => l.text);
    expect(logs.some((l) => /unknown collision layer "lava" \(layers: player\)/.test(l))).toBe(true);
    expect(logs).toContain("true");
  });
});

describe("phone layout (portrait 720×1280)", () => {
  it("fits the reference screen with letterbox/pillarbox math", () => {
    // iPhone 14 portrait 390×844: width-limited
    const f = fitRect(720, 1280, 390, 844);
    expect(f.s).toBeCloseTo(390 / 720, 9);
    expect(f.w).toBeCloseTo(390, 9);
    expect(f.h).toBeCloseTo(693.33, 1);
    expect(f.x).toBe(0);
    expect(f.y).toBeCloseTo((844 - 693.333) / 2, 2);
    // landscape game on a 2:1 phone in landscape: height-limited, pillarboxed
    const l = fitRect(1280, 720, 1688, 844);
    expect(l.s).toBeCloseTo(844 / 720, 9);
    expect(l.x).toBeCloseTo((1688 - 1280 * (844 / 720)) / 2, 6);
    expect(l.y).toBe(0);
  });

  it("safe-area insets only cost space where they reach into the game rect (ref px)", () => {
    const f = fitRect(720, 1280, 390, 844); // bars of ~75px top/bottom
    const s = safeInsets(f, { top: 47, right: 0, bottom: 34, left: 0 }, 390, 844);
    expect(s).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    // a 9:16 screen (no bars): insets apply fully, converted to ref px
    const g = fitRect(720, 1280, 360, 640);
    const t = safeInsets(g, { top: 30, right: 0, bottom: 20, left: 0 }, 360, 640);
    expect(t.top).toBeCloseTo(60, 6);
    expect(t.bottom).toBeCloseTo(40, 6);
    // anchors within the safe area
    expect(anchorRect("bottom_right", [-10, -10], [100, 50], 0, t.top, 720, 1280 - t.top - t.bottom)).toEqual([610, 1280 - 40 - 60, 100, 50]);
    expect(anchorRect("top", [0, 8], [200, 40], 0, 60, 720, 1180)).toEqual([260, 68, 200, 40]);
  });

  it("portrait games get a 720×1280 view; landscape (no orientation) stays 1280×720", async () => {
    const p = await Game.load(pkg({ manifest: `orientation = "portrait"`, entities: { world: { type: "Node2D", children: ["b"] }, b: { type: "UIButton", props: { anchor: "bottom", offset: [0, -40], size: [300, 100] }, scripts: ["scripts/client/b.luau"] } } ,
      files: { "scripts/client/b.luau": `script.entity.pressed:connect(function() print("pressed") end)` } }));
    expect(p.refSize).toEqual([720, 1280]);
    const v = view2D(p, 390, 844);
    expect([v.w, v.h]).toEqual([720, 1280]);
    expect([v.cx, v.cy]).toEqual([360, 640]); // no camera: top-left is (0,0)
    expect(p.uiRect(byId(p, "b"))).toEqual([210, 1140, 300, 100]);
    expect(p.tapScreen(360, 1190)).toBe("b");
    expect(p.logs.map((l) => l.text)).toContain("pressed");
    const l = await Game.load(pkg({ entities: { world: { type: "Node2D" } } }));
    expect(l.refSize).toEqual([1280, 720]);
    const lv = view2D(l, 1280, 720);
    expect([lv.w, lv.h, lv.scale]).toEqual([1280, 720, 1]);
  });
});
