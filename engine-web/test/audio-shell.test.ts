// sfx / music recording, settings.get, pause/resume/restart (core, no DOM).
import { Package } from "@dreamsy/format";
import { describe, expect, it } from "vitest";
import { Game } from "../core/index.js";
import { simulate } from "../tools/playtest.js";

const MANIFEST = `format = "0"\nname = "T"\ndimension = "2d"\nentry_scene = "scenes/main.scene.json"\n`;
function pkg(script: string, attach = false) {
  const scene = { format: "0", root: "world", entities: { world: { type: "Node2D", children: ["label"] }, label: { type: "UIText", props: { text: "" }, ...(attach ? { scripts: ["scripts/client/main.luau"] } : {}) } } };
  return Package.fromFiles({
    "dreamsy.toml": MANIFEST,
    "scenes/main.scene.json": JSON.stringify(scene),
    "data/sfx/jump.json": JSON.stringify({ wave: "square", freq: 300, slide: 1, decay: 0.15 }),
    "data/music/theme.json": JSON.stringify({ bpm: 120, steps: 4, channels: [{ wave: "triangle", notes: "C4 - E4 ." }] }),
    "scripts/client/main.luau": script,
  });
}
const label = (g: Game) => g.world.byId.get("label")!.get<string>("text");
const noErrors = (g: Game) => expect(g.errors.map((e) => `${e.script}:${e.line}: ${e.message}`)).toEqual([]);

describe("audio (core recording)", () => {
  it("records sfx.play / music.play / music.stop with options", async () => {
    const g = await Game.load(pkg(`
      sfx.play("jump")
      sfx.play("jump", { volume = 0.5, pitch = 1.5 })
      music.play("theme", { fade = 2 })
      music.play("theme") -- already playing: ignored
      after(0.5, function() music.stop(1) end)`));
    for (let i = 0; i < 40; i++) g.step();
    expect(g.audioLog.map((e) => ({ ...e, time: undefined }))).toEqual([
      { kind: "sfx", id: "jump", volume: 1, pitch: 1, time: undefined },
      { kind: "sfx", id: "jump", volume: 0.5, pitch: 1.5, time: undefined },
      { kind: "music", id: "theme", fade: 2, time: undefined },
      { kind: "music_stop", fade: 1, time: undefined },
    ]);
    expect(g.musicId).toBeNull();
    expect(g.sfxData("jump")).toMatchObject({ wave: "square", freq: 300, slide: 1, attack: 0, volume: 0.5 });
    noErrors(g);
  });

  it("missing sounds are script errors naming the file", async () => {
    const g = await Game.load(pkg(`local ok, e = pcall(sfx.play, "boom") entity("label").text = tostring(e)`));
    expect(label(g)).toMatch(/no sound "boom" \(add data\/sfx\/boom\.json\)/);
  });

  it("settings.get reads the platform settings (mute → 0)", async () => {
    const g = await Game.load(pkg(`onTick(function() entity("label").text = settings.get("music") .. "," .. settings.get("sfx") .. "," .. tostring(settings.get("mute")) end)`));
    g.step();
    expect(label(g)).toBe("0.7,0.9,false");
    g.settings = { ...g.settings, mute: true };
    g.step();
    expect(label(g)).toBe("0,0,true");
  });

  it("playtest report lists sounds played", async () => {
    const r = await simulate(pkg(`sfx.play("jump") every(0.25, function() sfx.play("jump") end) music.play("theme")`), [], 1);
    expect(r.audio).toEqual({ sfx: { jump: 5 }, music: ["theme"] });
  });
});

describe("pause / resume / restart", () => {
  it("pause freezes ticks and fires game.paused / game.resumed", async () => {
    const g = await Game.load(pkg(`
      local n, log = 0, {}
      onTick(function() n += 1 end)
      game.paused:connect(function() table.insert(log, "paused@" .. n) end)
      game.resumed:connect(function() table.insert(log, "resumed@" .. n) entity("label").text = table.concat(log, " ") end)`));
    g.advance(0.1);
    g.pause();
    expect(g.advance(1)).toBe(0);
    g.resume();
    expect(label(g)).toBe("paused@5 resumed@5"); // advance() runs at most 5 ticks per call
    expect(g.advance(1 / 60 + 1e-6)).toBe(1);
  });

  it("restart: default reloads the entry scene; game.restartRequested overrides", async () => {
    const g = await Game.load(pkg(`script.entity.text = "fresh"`, true)); // attached: re-runs with the scene
    g.world.byId.get("label")!.props.text = "dirty";
    g.requestRestart();
    expect(label(g)).toBe("fresh");

    const h = await Game.load(pkg(`game.restartRequested:connect(function() entity("label").text = "custom restart" end)`));
    h.requestRestart();
    expect(label(h)).toBe("custom restart");
  });
});
