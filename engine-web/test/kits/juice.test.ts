// juice kit (engine-web/kits/juice): every effect runs headless without errors, cleans up, and no-ops on bad input.
import { Package } from "@dreamsy/format";
import { describe, expect, it } from "vitest";
import { Game } from "../../core/index.js";

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#f00"/></svg>`;
function pkg(script: string, kits = `["core", "juice"]`) {
  return Package.fromFiles({
    "dreamsy.toml": `format = "0"\nname = "J"\ndimension = "2d"\norientation = "portrait"\nentry_scene = "scenes/main.scene.json"\nkits = ${kits}\n`,
    "scenes/main.scene.json": JSON.stringify({ format: "0", root: "world", entities: {
      world: { type: "Node2D", children: ["cam", "hero", "label", "hud", "btn"] },
      cam: { type: "Camera2D", props: { position: [360, 640] } },
      hero: { type: "Sprite2D", props: { position: [360, 640], size: [64, 64], texture: "asset:hero" } },
      label: { type: "Text2D", props: { position: [360, 300], text: "" } },
      hud: { type: "UIText", props: { anchor: "top", offset: [0, 40], size: [400, 60], text: "0" } },
      btn: { type: "UIButton", props: { anchor: "center", size: [300, 100], text: "Go" } },
    } }),
    "scenes/two.scene.json": JSON.stringify({ format: "0", root: "two", entities: { two: { type: "Node2D" } } }),
    "assets/hero.svg": SVG,
    "assets/hero.meta.json": JSON.stringify({ kind: "image", file: "hero.svg" }),
    "scripts/client/main.luau": script,
  });
}
async function run(script: string, steps = 120, kits?: string) {
  const g = await Game.load(pkg(script, kits));
  for (let i = 0; i < steps; i++) g.step();
  return { g, errs: g.errors.map((e) => `${e.script}:${e.line}: ${e.message}`), logs: g.logs.map((l) => l.text).filter((l) => !l.startsWith("[validate]")) };
}

describe("juice kit", () => {
  it("all effects run headless, restore resting values, and clean up spawned entities", async () => {
    const r = await run(`
      local juice = require("@kit/juice")
      local core = require("@kit/core")
      local hero, hud, btn, label = entity("hero"), entity("hud"), entity("btn"), entity("label")
      local spawnedBefore = #entity("world"):children()
      juice.shake("heavy") juice.shake(4, 0.1) juice.zoomPunch()
      juice.hitstop(0.1)
      print("stopped " .. tostring(juice.stopped()) .. " paused " .. tostring(core.pause.isPaused()))
      juice.squash(hero) juice.squash(hero) juice.stretch(hero) juice.punch(hero)
      juice.flash(hero, "#ff0000") juice.flash(btn) juice.flash(label)
      juice.blink(hero, 0.3)
      juice.bounce(btn) juice.bounce(btn) local p = juice.pulse(hud) juice.float(hero)
      juice.popup("+5", vec2(100, 100)) juice.damage(12, vec2(200, 200)) juice.damage(40, vec2(200, 200), { crit = true })
      juice.damage(3, vec2(1, 1), { heal = true }) juice.damage(0, vec2(1, 1), { miss = true })
      juice.sparkle(vec2(300, 300)) juice.dust(vec2(300, 300))
      local arrived = 0
      juice.coinBurst(vec2(360, 640), { n = 6, collectTo = vec2(360, 100), onArrive = function() arrived += 1 end })
      juice.confetti()
      local tw = juice.typewriter(label, "Hello world", { cps = 60, onDone = function() print("typed " .. label.text) end })
      juice.rollup(hud, 0, 250, { seconds = 0.5, prefix = "$", onDone = function() print("rolled " .. hud.text) end })
      juice.sfx("does_not_exist")
      juice.transition("iris", { seconds = 0.1, onCovered = function() print("covered") end })
      local ticks, t0 = 0, time()
      onTick(function()
        ticks += 1
        if ticks == 3 then print("stopped later " .. tostring(juice.stopped()) .. " frozen " .. tostring(time() == t0) .. " scale " .. game.timeScale) end
        if ticks == 9 then print("resumed " .. tostring(juice.stopped()) .. " scale " .. game.timeScale .. " paused " .. tostring(core.pause.isPaused())) end
      end)
      after(2.9, function()
        p:cancel()
        print("arrived " .. arrived)
        print("scale " .. tostring(hero.scale) .. " size " .. tostring(btn.size) .. " mod " .. tostring(hero.modulate) .. " vis " .. tostring(hero.visible))
        print("paused end " .. tostring(core.pause.isPaused()))
        print("leftover " .. (#entity("world"):children() - spawnedBefore))
      end)
      -- bad input is a no-op
      juice.squash(nil) juice.flash(nil) juice.popup(nil, vec2(0, 0)) juice.typewriter(nil, "x")
    `, 200);
    expect(r.errs).toEqual([]);
    const l = r.logs;
    expect(l).toContain("stopped true paused true");
    expect(l).toContain("stopped later true frozen true scale 0"); // hitstop = game.timeScale 0 for 0.1 real s
    expect(l).toContain("resumed false scale 1 paused true"); // (transition still holds core.pause)
    expect(l).toContain("covered");
    expect(l).toContain("typed Hello world");
    expect(l).toContain("rolled $250");
    expect(l).toContain("arrived 6");
    expect(l).toContain("scale vec2(1, 1) size vec2(300, 100) mod #ffffff vis true");
    expect(l).toContain("paused end false");
    expect(l.find((x) => x.startsWith("leftover"))).toBe("leftover 0");
  });

  it("scene transitions cover, switch scene and reveal", async () => {
    const r = await run(`
      local juice = require("@kit/juice")
      game.sceneLoaded:connect(function(p) print("loaded " .. p) end)
      after(0.1, function() juice.transition("fade", { scene = "scenes/two.scene.json", seconds = 0.2 }) end)
      after(0.5, function() print("panels " .. #entity("two"):children()) end)
      after(1.0, function() print("panels after " .. #entity("two"):children()) juice.transition("wipe", { seconds = 0.1 }) end)
    `, 100);
    expect(r.errs).toEqual([]);
    expect(r.logs).toContain("loaded scenes/two.scene.json");
    expect(r.logs).toContain("panels after 0");
  });

  it("works without the core kit", async () => {
    const r = await run(`local juice = require("@kit/juice") juice.hitstop() juice.squash(entity("hero")) juice.confetti() print("ok " .. tostring(juice.stopped()))`, 30, `["juice"]`);
    expect(r.errs).toEqual([]);
    expect(r.logs).toContain("ok true");
  });
});
