// Leaderboards + ghosts (DREAMSY.MD §13): memory host ranking, ghost recording/sampling, game-time timer, Luau API.
import { Package } from "@dreamsy/format";
import { describe, expect, it } from "vitest";
import { formatTime, Game, GHOST_MAX_FRAMES, ghostAt, GhostRecorder, MemoryLeaderboardHost, type Ghost, type LeaderboardEvent } from "../core/index.js";
import { simulate } from "../tools/playtest.js";

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#f00"/></svg>`;
const asset = (id: string) => ({ [`assets/${id}.svg`]: SVG, [`assets/${id}.meta.json`]: JSON.stringify({ kind: "image", file: `${id}.svg` }) });
const ANIMS = JSON.stringify({ run: { frames: ["asset:f1", "asset:f2"], fps: 10 }, idle: { frames: ["asset:f3"], fps: 1 } });

function pkg(script: string, extraScene?: boolean) {
  const scene = {
    format: "0", root: "world",
    entities: {
      world: { type: "Node2D", children: ["hero", "label"] },
      hero: { type: "Node2D", tags: ["player"], props: { position: [100, 50] }, children: ["spr"] },
      spr: { type: "Sprite2D", props: { anims: "data/anims/hero.json", anim: "run", size: [20, 30], position: [0, -10], z_index: 3 } },
      label: { type: "UIText", props: { text: "" } },
    },
  };
  const files: Record<string, string> = {
    "dreamsy.toml": `format = "0"\nname = "Race"\ndimension = "2d"\nentry_scene = "scenes/main.scene.json"\n`,
    "scenes/main.scene.json": JSON.stringify(scene),
    "scripts/client/main.luau": script,
    "data/anims/hero.json": ANIMS,
    ...asset("f1"), ...asset("f2"), ...asset("f3"),
  };
  if (extraScene) files["scenes/other.scene.json"] = JSON.stringify({ format: "0", root: "w", entities: { w: { type: "Node2D" } } });
  return Package.fromFiles(files);
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const noErrors = (g: Game) => expect(g.errors.map((e) => `${e.script}:${e.line}: ${e.message}`)).toEqual([]);
const label = (g: Game) => g.world.byId.get("label")!.get<string>("text");

describe("MemoryLeaderboardHost", () => {
  it("ranks asc boards by best per player, flags PBs, keeps the ghost of the best run only", async () => {
    const h = new MemoryLeaderboardHost({ entries: [{ user: "ann", value: 30 }, { user: "bob", value: 50 }] });
    const g1: Ghost = { v: 1, hz: 10, scene: "s", frames: [[0, 0, 0, 0], [1, 1, 0, 0]] };
    const r1 = await h.submit({ board: "fastest", order: "asc", value: 40, ghost: g1 });
    expect(r1).toMatchObject({ rank: 2, best: 30, personalBest: true }); // best = the board record
    const r2 = await h.submit({ board: "fastest", order: "asc", value: 45, ghost: { ...g1, scene: "worse" } });
    expect(r2).toMatchObject({ rank: 2, best: 30, personalBest: false });
    expect((await h.ghost("pb", "fastest"))?.scene).toBe("s");
    const r3 = await h.submit({ board: "fastest", order: "asc", value: 20, ghost: { ...g1, scene: "new" } });
    expect(r3).toMatchObject({ rank: 1, best: 20, personalBest: true });
    expect((await h.ghost("best", "fastest"))?.scene).toBe("new");
    expect(await h.ghost(r1.runId, "fastest")).toBeNull(); // older ghost dropped
    const page = await h.top("fastest", "public", 10);
    expect(page.entries.map((e) => [e.rank, e.user, e.value, e.hasGhost])).toEqual([[1, "you", 20, true], [2, "ann", 30, false], [3, "bob", 50, false]]);
    expect(page.me).toMatchObject({ rank: 1, value: 20, runId: r3.runId });
    expect((await h.top("fastest", "me", 10)).entries.length).toBe(1);
    expect((await h.top("fastest", "public", 2)).entries.length).toBe(2);
  });

  it("ranks desc boards (higher is better), ties go to the earlier run", async () => {
    const h = new MemoryLeaderboardHost({ entries: [{ board: "score", order: "desc", user: "ann", value: 100 }] });
    expect(await h.submit({ board: "score", order: "desc", value: 100 })).toMatchObject({ rank: 2, personalBest: true });
    expect(await h.submit({ board: "score", order: "desc", value: 90 })).toMatchObject({ rank: 2, best: 100, personalBest: false });
    expect(await h.submit({ board: "score", order: "desc", value: 150 })).toMatchObject({ rank: 1, best: 150, personalBest: true });
    expect((await h.top("score", "public", 5)).entries.map((e) => e.value)).toEqual([150, 100]);
    expect(await h.ghost("best", "nope")).toBeNull();
  });
});

describe("ghost recording", () => {
  it("samples at 10 Hz of game time and caps at 3000 frames", () => {
    const rec = new GhostRecorder("scenes/a.scene.json", 5);
    let x = 0;
    for (let t = 5; t <= 6 + 1e-9; t += 1 / 60) rec.sample(t, () => [x++, 2, 1, 3]);
    expect(rec.frames.length).toBe(11); // t = 0, 0.1 .. 1.0
    expect(rec.frames[0]).toEqual([0, 2, 1, 3]);
    const big = new GhostRecorder("s", 0);
    for (let i = 0; i < 4000; i++) big.sample(i / 10, () => [i, 0, 0, 0]);
    expect(big.frames.length).toBe(GHOST_MAX_FRAMES);
    expect(big.full).toBe(true);
    expect(big.ghost()).toMatchObject({ v: 1, hz: 10, scene: "s" });
  });

  it("interpolates position between samples; flip/frame from the earlier sample; null past the end", () => {
    const g: Ghost = { v: 1, hz: 10, scene: "s", frames: [[0, 0, 0, 1], [10, 20, 1, 2], [20, 20, 1, 0]] };
    expect(ghostAt(g, 0.05)).toEqual({ x: 5, y: 10, flipX: false, frame: 1 });
    expect(ghostAt(g, 0.15)).toMatchObject({ x: 15, y: 20, flipX: true, frame: 2 });
    expect(ghostAt(g, 0.2)).toMatchObject({ x: 20, y: 20 });
    expect(ghostAt(g, 0.31)).toBeNull();
  });

  it("formats times as mm:ss.cc", () => {
    expect(formatTime(0)).toBe("00:00.00");
    expect(formatTime(83.456)).toBe("01:23.46");
  });
});

describe("leaderboard (Luau)", () => {
  it("timer runs in game time: excludes pause and follows game.timeScale", async () => {
    const g = await Game.load(pkg(`leaderboard.start()`));
    for (let i = 0; i < 60; i++) g.step(); // 1 s
    g.pause();
    expect(g.advance(1)).toBe(0); // paused: no time passes
    g.resume();
    g.timeScale = 0.5;
    for (let i = 0; i < 60; i++) g.step(); // 0.5 s of game time
    expect(g.leaderboardRuns.fastest).toBeCloseTo(1.5, 5);
    noErrors(g);
  });

  it("start/finish submits the time + ghost, fires result next tick, cancel/elapsed/submit/raceGhost", async () => {
    const host = new MemoryLeaderboardHost({ entries: [{ user: "ann", value: 0.5 }] });
    const SCRIPT = `
local log = {}
local function show() entity("label").text = table.concat(log, " ") end
leaderboard.result:connect(function(rank, best, pb) table.insert(log, "result:" .. rank .. ":" .. string.format("%.2f", best) .. ":" .. tostring(pb)) show() end)
local hero = entity("hero")
leaderboard.start()
onTick(function(dt) hero.position = hero.position + vec2(60 * dt, 0) end)
after(0.5, function() table.insert(log, string.format("el:%.2f", leaderboard.elapsed())) show() end)
after(1, function() local t = leaderboard.finish() table.insert(log, string.format("fin:%.2f", t)) show() end)
after(1.2, function()
  leaderboard.start("lap")
  leaderboard.cancel("lap")
  table.insert(log, "running:" .. tostring(leaderboard.running("lap")))
  leaderboard.submit("score", 300)
  local ok, err = pcall(leaderboard.submit, "score", "x")
  table.insert(log, "err:" .. tostring(not ok))
  local ok2 = pcall(leaderboard.start, "bad name!")
  table.insert(log, "bad:" .. tostring(not ok2))
  show()
end)
after(2, function() leaderboard.start() leaderboard.raceGhost("pb") end)
`;
    const g = await Game.load(pkg(SCRIPT, true), { leaderboard: host });
    const events: LeaderboardEvent[] = [];
    g.onLeaderboard((e) => events.push(e));
    for (let i = 0; i < 62; i++) g.step();
    expect(g.leaderboardBusy).toBe(true);
    await flush();
    expect(label(g)).not.toMatch(/result/); // not before the next tick
    g.step();
    expect(label(g)).toMatch(/^el:0\.50 fin:1\.00 result:2:0\.50:true$/);
    expect(events).toMatchObject([{ board: "fastest", order: "asc", value: 1, finished: true, result: { rank: 2, personalBest: true } }]);
    const sub = host.submitted[0]!;
    expect(sub).toMatchObject({ board: "fastest", order: "asc", value: 1 });
    expect(sub.ghost!.scene).toBe("scenes/main.scene.json");
    expect(sub.ghost!.frames.length).toBe(11);
    // hero moves 60 px/s from x=100: samples every 0.1 s, frame index into the anim set's textures
    expect(sub.ghost!.frames[0]![0]).toBeCloseTo(100, 0);
    expect(Math.abs(sub.ghost!.frames[10]![0] - 160)).toBeLessThanOrEqual(1.5);
    expect(new Set(sub.ghost!.frames.map((f) => f[3]))).toEqual(new Set([0, 1]));

    for (let i = 0; i < 20; i++) { g.step(); await flush(); }
    expect(label(g)).toMatch(/running:false err:true bad:true result:1:300\.00:true/);
    expect(host.submitted.map((s) => [s.board, s.order, s.value])).toEqual([["fastest", "asc", 1], ["score", "desc", 300]]);

    // raceGhost("pb") at t=2: a translucent sprite replays the recorded run from the moment it spawns
    for (let i = 0; i < 50; i++) { g.step(); await flush(); }
    const ghost = g.ghostEntity!;
    expect(ghost).toBeTruthy();
    expect(ghost.type).toBe("Sprite2D");
    expect(ghost.get<number[]>("modulate")[3]).toBeCloseTo(0.45);
    expect(ghost.get<number[]>("size")).toEqual([20, 30]);
    expect(ghost.get<number>("z_index")).toBe(2);
    expect(ghost.tags.size).toBe(0);
    const gx0 = ghost.get<number[]>("position")[0]!;
    for (let i = 0; i < 30; i++) g.step();
    const gx1 = ghost.get<number[]>("position")[0]!;
    expect(gx1 - gx0).toBeCloseTo(30, 0); // 0.5 s at 60 px/s
    expect(ghost.get<number[]>("position")[1]).toBeCloseTo(40, 0); // y 50 + sprite offset -10
    // finishing/cancelling the run removes it
    for (let i = 0; i < 1; i++) g.step();
    g.requestRestart();
    expect(g.ghostEntity).toBeNull();
    noErrors(g);
  });

  it("ghost stays in its scene: removed on scene change", async () => {
    const host = new MemoryLeaderboardHost();
    await host.submit({ board: "fastest", order: "asc", value: 3, ghost: { v: 1, hz: 10, scene: "scenes/main.scene.json", frames: Array.from({ length: 30 }, (_, i) => [i, 0, 0, 0]) } });
    const g = await Game.load(pkg(`leaderboard.raceGhost("best")\nafter(0.5, function() loadScene("scenes/other.scene.json") end)`, true), { leaderboard: host });
    await flush();
    g.step();
    expect(g.ghostEntity).toBeTruthy();
    for (let i = 0; i < 40; i++) g.step();
    expect(g.scenePath).toBe("scenes/other.scene.json");
    expect(g.ghostEntity).toBeNull();
    noErrors(g);
  });

  it("armGhost (results card) spawns at the next leaderboard.start; platform restart cancels runs", async () => {
    const host = new MemoryLeaderboardHost();
    await host.submit({ board: "fastest", order: "asc", value: 3, ghost: { v: 1, hz: 10, scene: "scenes/main.scene.json", frames: [[0, 0, 0, 0], [5, 0, 0, 0]] } });
    const g = await Game.load(pkg(`leaderboard.start()\ngame.sceneLoaded:connect(function() leaderboard.start() end)`), { leaderboard: host });
    g.armGhost("best", "fastest");
    await flush();
    g.step();
    expect(g.ghostEntity).toBeNull(); // armed: waits for the next run
    g.requestRestart(); // reloads the entry scene → sceneLoaded → leaderboard.start()
    g.step();
    expect(g.ghostEntity).toBeTruthy();
    expect(Object.keys(g.leaderboardRuns)).toEqual(["fastest"]);
    expect(g.usesLeaderboards).toBe(true);
    noErrors(g);
  });

  it("playtest simulate() awaits submits", async () => {
    const r = await simulate(pkg(`leaderboard.start()\nleaderboard.result:connect(function(rank) print("RANK " .. rank) end)\nafter(1.5, function() leaderboard.finish() end)`), [], 3);
    expect(r.errors).toEqual([]);
    expect(r.logs.filter((l) => l.includes("RANK"))).toEqual(["[info] RANK 1"]);
  });
});
