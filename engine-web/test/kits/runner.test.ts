// runner kit: controls (swipes/taps/keys), segment validation + sequencing by difficulty tier, endless sim
// (jump/slide/lanes, power-ups), missions, daily challenge, characters, obby (checkpoints, timer, ghost, vanish,
// spinner, procgen stages), balance sim, and the example package end-to-end.
import { describe, expect, it } from "vitest";
import { Package } from "@dreamsy/format";
import { Game, MemoryLeaderboardHost, MemorySaveHost } from "../../core/index.js";

async function runLuau(src: string, opts: { steps?: number; save?: MemorySaveHost; clock?: () => number; drive?: (g: Game, i: number) => void } = {}) {
  const files: Record<string, string> = {
    "dreamsy.toml": `format = "0"\nname = "kit test"\ndimension = "2d"\norientation = "portrait"\nentry_scene = "scenes/main.scene.json"\nkits = ["runner"]\n[style]\npreset = "clean"\n`,
    "scenes/main.scene.json": JSON.stringify({ format: "0", root: "root", entities: { root: { type: "Node2D" } } }),
    "scripts/client/main.luau": src,
  };
  const host = opts.save ?? new MemorySaveHost();
  const game = await Game.load(Package.fromFiles(files), { seed: 1, save: host, clock: opts.clock } as any);
  for (let i = 0; i < (opts.steps ?? 1); i++) { opts.drive?.(game, i); game.step(); }
  const errors = game.errors.map((e) => `${e.script}:${e.line ?? "?"}: ${e.message}`);
  return { out: host.data.out as any, errors, host, game };
}

const CONTENT = `
local R = require("@kit/runner")
local core = require("@kit/core")
R.setup({ content = {
  segments = {
    s_open = { tier = 0, rows = { "C.C", ".C.", "C.C" } },
    s_low = { tier = 0, rows = { "J.J", "...", ".J." } },
    s_high = { tier = 1, rows = { "S.S", "CCC", "..." } },
    s_block = { tier = 1, rows = { "B..", "B..", ".B." } },
    s_mix = { tier = 2, rows = { "BJS", "...", "SBJ" } },
    s_wall = { tier = 3, rows = { "BB.", "...", ".BB", "M..", "B.B" } },
    s_power = { tier = 0, rows = { ".M.", "CCC", "CCC", "CCC", ".X.", "CCC", ".H." } },
  },
  missions = {
    m1 = { text = "Collect 20 coins in one run", stat = "coins", target = 20, scope = "run", reward = { { earn = "coins", amount = 100 } }, order = 1 },
    m2 = { text = "Jump 30 times total", stat = "jumps", target = 30, scope = "total", reward = { { earn = "coins", amount = 50 } }, order = 2 },
    m3 = { text = "Run 400 m", stat = "distance", target = 400, scope = "run", order = 3 },
    m4 = { text = "Run 2000 m", stat = "distance", target = 2000, scope = "run", order = 4 },
  },
  characters = {
    pip = { name = "Pip", cost = { coins = 0 }, order = 1 },
    zoom = { name = "Zoom", cost = { coins = 120 }, mods = { { stat = "magnetTime", add = 4 }, { stat = "jumpTime", pct = -0.1 } }, order = 2 },
  },
  stages = {
    test = { name = "Test", order = 1, width = 720, height = 1000, spawn = { x = 100, y = 900 }, parts = {
      { kind = "solid", x = 0, y = 900, w = 720, h = 40 },
      { kind = "checkpoint", x = 300, y = 820, w = 60, h = 80 },
      { kind = "goal", x = 600, y = 800, w = 80, h = 100 },
    } },
  },
} })
local out = {}
`;

const lua = async (body: string, opts: Parameters<typeof runLuau>[1] = {}) => {
  const r = await runLuau(`${CONTENT}\n${body}\nsave.set("out", out)`, opts);
  expect(r.errors).toEqual([]);
  return r;
};

describe("runner kit", () => {
  it("controls: swipes, taps, keys", async () => {
    const { out } = await lua(`
      local c = R.controls.new({ keys = false, pointer = false })
      local got = {}
      local function swipe(x0, y0, x1, y1)
        c:feed(x0, y0) c:feed((x0 + x1) / 2, (y0 + y1) / 2) c:feed(x1, y1) c:feed(nil)
        table.insert(got, c:poll() or "nil")
      end
      swipe(300, 600, 150, 610) swipe(300, 600, 460, 590) swipe(300, 600, 310, 480) swipe(300, 600, 290, 720)
      c:feed(300, 600) c:feed(305, 604) c:feed(nil) table.insert(got, c:poll() or "nil")   -- tap = jump
      c:feed(300, 600) c:feed(320, 610) table.insert(got, c:poll() or "nil")                -- still holding, small move: nothing
      out.got = table.concat(got, ",")
      -- keyboard edges
      local k = R.controls.new()
      local seq = {}
      onTick(function()
        local a = k:poll()
        if a then table.insert(seq, a) end
        out.keys = table.concat(seq, ",")
        save.set("out", out)
      end)
    `, {
      steps: 8,
      drive: (g, i) => {
        if (i === 1) g.input.setAxis("move_x", -1);
        if (i === 2) g.input.setAxis("move_x", 0);
        if (i === 3) g.input.setAxis("move_x", 1);
        if (i === 4) { g.input.setAxis("move_x", 0); g.input.tap("jump"); }
        if (i === 5) g.input.tap("action");
      },
    }).then((r) => ({ out: r.host.data.out as any }));
    expect(out.got).toBe("left,right,jump,slide,jump,nil");
    expect(out.keys).toBe("left,right,jump,slide");
  });

  it("segments: validation rejects unpassable rows; sequencing follows the difficulty tier", async () => {
    const { out } = await lua(`
      out.bad1 = R.track.validate({ id = "x", rows = { "BBB" } })
      out.bad2 = R.track.validate({ id = "y", rows = { "B.", "..." } })
      out.bad3 = R.track.validate({ id = "z", rows = { "BB." , ".BB" } })
      out.good = R.track.validate({ id = "g", rows = { "B..", ".B.", "..B" } })
      local seq = R.track.sequencer({ seed = 4 })
      local maxEarly, minLate, okRange = 0, 99, true
      for d = 0, 6000, 25 do
        local s, tier = seq:next(d)
        if d < 300 then maxEarly = math.max(maxEarly, s.tier) end
        if d > 3000 then minLate = math.min(minLate, s.tier) end
        if s.tier > tier or s.tier < tier - 2 then okRange = false end
      end
      out.maxEarly, out.minLate, out.okRange = maxEarly, minLate, okRange
      -- no immediate repeats
      local rep = 0
      for i = 2, #seq.log do if seq.log[i].at < 4500 and seq.log[i].id == seq.log[i - 1].id then rep += 1 end end -- tier 5 has a single eligible segment here
      out.rep = rep
      local a, b = R.track.sequencer({ seed = 9 }), R.track.sequencer({ seed = 9 })
      local same = true
      for d = 0, 2000, 40 do if a:next(d).id ~= b:next(d).id then same = false end end
      out.same = same
      local fixed = R.track.sequencer({ seed = 2, tier = 3 })
      local allHigh = true
      for i = 1, 30 do if fixed:next(i * 30).tier < 1 then allHigh = false end end
      out.fixed = allHigh
    `);
    expect(out.bad1).toBe(false);
    expect(out.bad2).toBe(false);
    expect(out.bad3).toBe(false);
    expect(out.good).toBe(true);
    expect(out.maxEarly).toBe(0);
    expect(out.minLate).toBeGreaterThanOrEqual(1);
    expect(out.okRange).toBe(true);
    expect(out.rep).toBe(0);
    expect(out.same).toBe(true);
    expect(out.fixed).toBe(true);
  });

  it("endless sim: speed ramp, jump/slide/lanes vs obstacles, coins, magnet, shield, 2x", async () => {
    const { out } = await lua(`
      local E = R.endless
      local function only(rows) return { { id = "t", tier = 0, rows = rows } } end
      local dt = 1 / 60
      local function runTo(sim, d, action)
        local first = true
        while sim.alive and sim.dist < d do sim:step(dt, if first then action else nil) first = false end
      end
      -- low bar in the middle lane: dies without jumping, survives with a well-timed jump
      local s1 = E.new({ seed = 1, segments = only({ ".J." }) })
      runTo(s1, 14) out.lowDie = s1.alive
      local s2 = E.new({ seed = 1, segments = only({ ".J." }) })
      runTo(s2, 11.2) runTo(s2, 14, "jump") out.lowJump = s2.alive
      local s3 = E.new({ seed = 1, segments = only({ ".S." }) })
      runTo(s3, 11.2) runTo(s3, 14, "slide") out.highSlide = s3.alive
      local s4 = E.new({ seed = 1, segments = only({ ".B." }) })
      runTo(s4, 11.2) runTo(s4, 14, "jump") out.blockJump = s4.alive
      local s5 = E.new({ seed = 1, segments = only({ ".B." }) })
      runTo(s5, 10) runTo(s5, 14, "left") out.blockLane = s5.alive out.lane = s5.lane
      -- coins + 2x + magnet + shield
      local s6 = E.new({ seed = 1, segments = only({ ".C.", ".X.", ".C.", ".C." }) })
      runTo(s6, 26) out.coins2x = s6.coins     -- 1 + 2 + 2
      local s7 = E.new({ seed = 1, segments = only({ ".M.", "C.C", "C.C", "C.C" }) })
      runTo(s7, 30) out.magnet = s7.coins        -- side lanes pulled in
      local s8 = E.new({ seed = 1, segments = only({ ".H.", "...", ".B." }) })
      runTo(s8, 30) out.shieldAlive = s8.alive out.shieldLeft = s8.power.shield
      -- speed ramp
      local s9 = E.new({ seed = 3, segments = only({ "C.." }) })
      out.v0 = s9:speedAt(0) out.v1 = s9:speedAt(800) out.v2 = s9:speedAt(5000)
      local s10 = E.new({ seed = 3, segments = only({ "C.." }), modifier = { params = { speedMult = 1.5 } } })
      out.vMod = s10:speedAt(0)
    `);
    expect(out.lowDie).toBe(false);
    expect(out.lowJump).toBe(true);
    expect(out.highSlide).toBe(true);
    expect(out.blockJump).toBe(false);
    expect(out.blockLane).toBe(true);
    expect(out.lane).toBe(1);
    expect(out.coins2x).toBe(5);
    expect(out.magnet).toBeGreaterThanOrEqual(6);
    expect(out.shieldAlive).toBe(true);
    expect(out.shieldLeft).toBe(0);
    expect(out.v0).toBe(10);
    expect(out.v1).toBe(15);
    expect(out.v2).toBe(23);
    expect(out.vMod).toBe(15);
  });

  it("missions (run + total scope), characters bought with coins, best distance, persistence", async () => {
    const save = new MemorySaveHost();
    const a = await lua(`
      out.slots = #R.missions()
      out.first = R.missions()[1].id
      local sim = R.newRun({ seed = 5 })
      local bot = {}
      while sim.alive and sim.dist < 450 do sim:step(1 / 60, R.endless.botAction(sim, bot, { reaction = 0.3, miss = 0 })) end
      out.live = #R.progress(sim:summary(), false) >= 0
      local sum = R.finish(sim)
      out.sumCoins = sum.coins
      out.completed = #sum.missions
      out.best = R.best()
      out.wallet = R.coins()
      out.chars = #R.characters()
      out.sel = R.characters()[1].selected
      core.wallet.add("coins", 200)
      out.buy = R.buyCharacter("zoom")
      out.select = R.selectCharacter("zoom")
      out.magnetTime = R.params().magnetTime
      out.missionsAfter = {}
      for _, m in R.missions() do table.insert(out.missionsAfter, m.id) end
      core.save.save()
    `, { save });
    expect(a.out.slots).toBe(3);
    const lb = (a.game.leaderboardHost as MemoryLeaderboardHost).submitted;
    expect(lb.map((r) => [r.board, r.order, r.value])).toEqual([["distance", "desc", a.out.best]]);
    expect(a.out.first).toBe("m1");
    expect(a.out.best).toBeGreaterThanOrEqual(400);
    expect(a.out.completed).toBeGreaterThanOrEqual(1); // m3 (400 m)
    expect(a.out.chars).toBe(2);
    expect(a.out.sel).toBe(true);
    expect(a.out.buy).toBe(true);
    expect(a.out.magnetTime).toBe(12);
    expect(a.out.missionsAfter).toContain("m4");
    const b = await lua(`
      core.save.load()
      out.best = R.best()
      out.owned = R.characters()[2].owned
      out.selected = R.meta.data.character
      out.m = #R.missions()
    `, { save });
    expect(b.out.best).toBe(a.out.best);
    expect(b.out.owned).toBe(true);
    expect(b.out.selected).toBe("zoom");
    expect(b.out.m).toBeGreaterThan(0);
  });

  it("daily challenge: seeded by clock day, modifier, reward once", async () => {
    const day = 20500 * 86400;
    const { out } = await lua(`
      local a, b, c = R.daily(${day} + 10), R.daily(${day} + 86000), R.daily(${day} + 86400 * 2)
      out.same = a.seed == b.seed and a.target == b.target
      out.diff = a.seed ~= c.seed
      out.mod = a.modifier ~= nil
      local d = R.daily()
      out.today = d.day
      local before = R.coins()
      out.r1 = R.meta.completeDaily(d.target + 10)
      out.r2 = R.meta.completeDaily(d.target + 50)
      out.gain = R.coins() - before
      out.done = R.daily().done
      local sim = R.newRun({ daily = true })
      out.dailySeed = sim.seq.rng ~= nil and sim.daily.seed == d.seed
    `, { clock: () => day + 500 });
    expect(out.same).toBe(true);
    expect(out.diff).toBe(true);
    expect(out.mod).toBe(true);
    expect(out.today).toBe(20500);
    expect(out.r1).toBe(true);
    expect(out.r2).toBe(false);
    expect(out.gain).toBe(150);
    expect(out.done).toBe(true);
    expect(out.dailySeed).toBe(true);
  });

  it("obby: checkpoint, timer, finish, ghost record/playback, vanish, spinner, procgen stages", async () => {
    const { out, game } = await lua(`
      local O = R.obby
      local o = R.obbyRun("test")
      local t = 0
      while not o.finished and t < 600 do o:step(1 / 60, 1, false, false) t += 1 end
      out.finished = o.finished
      out.cp = o.checkpoint
      out.time = o.time
      out.deaths = o.deaths
      out.best = R.finishStage("test", o)
      local ghost = o:ghostString()
      out.ghostLen = #ghost
      local o2 = R.obbyRun("test")
      local gx, gy = o2:ghostAt(0.5)
      out.ghostX = gx
      out.realX = nil
      -- second slower run is not a best
      local o3 = R.obbyRun("test")
      for i = 1, 30 do o3:step(1 / 60, 0, false, false) end
      while not o3.finished do o3:step(1 / 60, 1, false, false) end
      out.best2 = R.finishStage("test", o3)
      out.rec = R.stageRecord("test").best
      -- death on spikes -> respawn at checkpoint
      local st = { width = 720, height = 1000, spawn = { x = 100, y = 900 }, parts = {
        { kind = "solid", x = 0, y = 900, w = 720, h = 40 }, { kind = "checkpoint", x = 200, y = 820, w = 40, h = 80 },
        { kind = "spike", x = 400, y = 880, w = 40, h = 20 } } }
      local o4 = O.new(st)
      local died = false
      for i = 1, 200 do o4:step(1 / 60, 1, false, false) for _, e in o4.events do if e.name == "death" then died = true end end end
      for i = 1, 40 do o4:step(1 / 60, 0, false, false) end
      out.spikeDied = died
      out.respawnX = math.floor(o4.x)
      -- vanishing tile: stand on it, it disappears, you fall
      local st2 = { width = 720, height = 2000, spawn = { x = 100, y = 500 }, parts = { { kind = "vanish", x = 0, y = 500, w = 300, h = 30, on = 0.5, off = 1 } } }
      local o5 = O.new(st2)
      for i = 1, 30 do o5:step(1 / 60, 0, false, false) end
      out.vanishStand = o5.ground ~= nil
      for i = 1, 40 do o5:step(1 / 60, 0, false, false) end
      out.vanishFell = o5.ground == nil and o5.y > 500
      -- spinner kills when the arm sweeps through the player
      local st3 = { width = 720, height = 1000, spawn = { x = 360, y = 900 }, parts = { { kind = "solid", x = 0, y = 900, w = 720, h = 40 }, { kind = "spinner", x = 360, y = 870, r = 120, speed = 180 } } }
      local o6 = O.new(st3)
      for i = 1, 90 do o6:step(1 / 60, 0, false, false) end
      out.spinDeaths = o6.deaths
      -- jump
      local o7 = O.new(st)
      o7:step(1 / 60, 0, true, true)
      for i = 1, 10 do o7:step(1 / 60, 0, false, true) end
      out.jumped = o7.y < 880
      -- procgen: deterministic, within the jump envelope
      local okAll = true
      local probs = {}
      for seed = 1, 40 do
        for d = 1, 10, 3 do
          local s = O.generate({ seed = seed, difficulty = d, platforms = 16 })
          local ok, p = O.check(s)
          if not ok then okAll = false table.insert(probs, seed .. ":" .. d .. ":" .. p[1]) end
        end
      end
      out.envelope = okAll
      out.probs = table.concat(probs, " ")
      local g1, g2 = O.generate({ seed = 7, difficulty = 5 }), O.generate({ seed = 7, difficulty = 5 })
      out.genSame = #g1.parts == #g2.parts and g1.parts[5].x == g2.parts[5].x and g1.parts[9].y == g2.parts[9].y
      local kinds = {}
      for _, p in O.generate({ seed = 3, difficulty = 9, platforms = 30 }).parts do kinds[p.kind] = true end
      out.kinds = kinds
      -- bot climbs an easy generated stage
      local easy = O.new(O.generate({ seed = 11, difficulty = 1, platforms = 8 }))
      local bot = {}
      for i = 1, 60 * 60 do
        if easy.finished then break end
        local ax, j, h = O.botInput(easy, bot)
        easy:step(1 / 60, ax, j, h)
      end
      out.botFinished = easy.finished
      out.botCp = easy.checkpoint
    `);
    expect(out.finished).toBe(true);
    expect((game.leaderboardHost as MemoryLeaderboardHost).submitted.map((r) => [r.board, r.order])).toEqual([["stage_test", "asc"], ["stage_test", "asc"]]);
    expect(out.cp).toBe(1);
    expect(out.time).toBeGreaterThan(1);
    expect(out.best).toBe(true);
    expect(out.ghostLen).toBeGreaterThan(40);
    expect(out.ghostX).toBeGreaterThan(100);
    expect(out.best2).toBe(false);
    expect(out.rec).toBeCloseTo(out.time, 1);
    expect(out.spikeDied).toBe(true);
    expect(Math.abs(out.respawnX - 220)).toBeLessThan(3);
    expect(out.vanishStand).toBe(true);
    expect(out.vanishFell).toBe(true);
    expect(out.spinDeaths).toBeGreaterThan(0);
    expect(out.jumped).toBe(true);
    expect(out.probs).toBe("");
    expect(out.envelope).toBe(true);
    expect(out.genSame).toBe(true);
    expect(out.kinds.move && out.kinds.vanish && out.kinds.conveyor && out.kinds.spinner && out.kinds.spike && out.kinds.checkpoint && out.kinds.goal).toBeTruthy();
    expect(out.botFinished).toBe(true);
  });

  it("balance: bot survival distance falls as the tier rises", async () => {
    const t0 = Date.now();
    const r = await runLuau(`${CONTENT}
      local job = R.balanceJob({ runs = 8, maxDist = 1500 })
      local ticks = 0
      onTick(function() if not job.done then ticks += 1 if job:step(4000) then out.b = job.result out.ticks = ticks save.set("out", out) end end end)`, { steps: 600 });
    expect(r.errors).toEqual([]);
    const out = r.out;
    console.log("runner balance", JSON.stringify(Object.fromEntries(Object.entries(out.b).map(([k, v]: any) => [k, { mean: Math.round(v.mean), p10: v.p10, p50: v.p50, p90: v.p90 }]))), "ticks", out.ticks, Date.now() - t0, "ms");
    const b = out.b;
    expect(Object.keys(b).length).toBeGreaterThanOrEqual(4);
    expect(b["0"].mean).toBeGreaterThan(b["3"].mean);
  });
});

// ---------- example package (games/examples/kit-runner) ----------
import { resolve } from "node:path";
const EXAMPLE = resolve(__dirname, "../../../games/examples/kit-runner");
async function examplePkg(edit: (cfg: string) => string) {
  const pkg = await Package.fromDir(EXAMPLE);
  const files: Record<string, string | Uint8Array> = {};
  for (const p of pkg.paths()) files[p] = pkg.bytes(p)!;
  files["scripts/shared/config.luau"] = edit(new TextDecoder().decode(files["scripts/shared/config.luau"] as Uint8Array));
  return Package.fromFiles(files);
}

describe("kit-runner example", () => {
  it("endless: bot runs several seeds with zero script errors; missions/best persist", async () => {
    for (const seed of [1, 2, 3]) {
      const host = new MemorySaveHost();
      const game = await Game.load(await examplePkg((c) => c.replace("bot = false", "bot = true").replace("seed = nil", `seed = ${seed}`)), { seed, save: host });
      for (let i = 0; i < 60 * 120; i++) game.step();
      expect(game.errors.map((e) => `${e.script}:${e.line}: ${e.message}`)).toEqual([]);
      const runs = game.logs.filter((l) => l.text.startsWith("run over")).map((l) => l.text);
      console.log(`runner example seed ${seed}:`, runs.join(" | ") || "(still running)");
    }
  });
  it("obby: bot climbs stages (scene changes) with zero script errors", async () => {
    const host = new MemorySaveHost();
    const game = await Game.load(await examplePkg((c) => c.replace("bot = false", "bot = true").replace(`botMode = "endless"`, `botMode = "obby"`)), { seed: 1, save: host });
    for (let i = 0; i < 60 * 40; i++) game.step();
    expect(game.errors.map((e) => `${e.script}:${e.line}: ${e.message}`)).toEqual([]);
    const fin = game.logs.filter((l) => l.text.startsWith("stage ")).map((l) => l.text);
    console.log("obby example:", fin.join(" | "));
    expect(fin.length).toBeGreaterThanOrEqual(1);
  });
  it("example content: every segment valid; balance per tier", async () => {
    const pkg = await examplePkg((c) => c);
    const files: Record<string, string | Uint8Array> = {};
    for (const p of pkg.paths()) files[p] = pkg.bytes(p)!;
    files["scripts/client/run.luau"] = `
local R = require("@kit/runner")
require("../shared/game").init()
local job = R.balanceJob({ runs = 16, maxDist = 3000 })
local out = { stages = #R.stages() }
for _, st in R.stages() do local ok = R.obby.check(st) if st.generated and not ok then out.badStage = st.id end end
onTick(function() if not job.done and job:step(5000) then out.b = job.result save.set("out", out) end end)`;
    delete files["scripts/client/obby.luau"];
    const host = new MemorySaveHost();
    const game = await Game.load(Package.fromFiles(files), { seed: 1, save: host });
    for (let i = 0; i < 2000 && !(host.data.out as any)?.b; i++) game.step();
    expect(game.errors.map((e) => e.message)).toEqual([]);
    const out = host.data.out as any;
    expect(out.stages).toBe(6);
    expect(out.badStage).toBeUndefined();
    const rows = Object.entries(out.b).map(([t, v]: any) => `tier ${t}: mean ${Math.round(v.mean)} m  p10 ${v.p10}  p50 ${v.p50}  p90 ${v.p90}`);
    console.log("runner balance (bot reaction 0.25 s, 2% miss)\n" + rows.join("\n"));
    expect(out.b["0"].mean).toBeGreaterThan(out.b["5"].mean);
  });
});
