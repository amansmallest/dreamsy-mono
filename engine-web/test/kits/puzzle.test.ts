// puzzle kit: mechanic rules, undo/redo, win detection, generators (solvable at the requested difficulty over 100 seeds,
// par from the solver), deterministic match-3 cascades/specials, pack unlock by stars, daily seed, example end-to-end bot.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Package } from "@dreamsy/format";
import { Game, MemorySaveHost } from "../../core/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

async function runLuau(src: string, opts: { steps?: number; files?: Record<string, string>; clock?: () => number } = {}) {
  const files: Record<string, string> = {
    "dreamsy.toml": `format = "0"\nname = "kit test"\ndimension = "2d"\norientation = "portrait"\nentry_scene = "scenes/main.scene.json"\nkits = ["puzzle"]\n[style]\npreset = "clean"\n`,
    "scenes/main.scene.json": JSON.stringify({ format: "0", root: "root", entities: { root: { type: "Node2D" } } }),
    ...opts.files,
    "scripts/client/main.luau": `local P = require("@kit/puzzle")
local procgen = require("@kit/procgen")
local function forTicks(n, per, fn, done)
  local i = 0
  onTick(function()
    if i >= n then return end
    for _ = 1, per do i += 1 if i <= n then fn(i) end end
    if i >= n then done() end
  end)
end
${src}`,
  };
  const host = new MemorySaveHost();
  const game = await Game.load(Package.fromFiles(files), { seed: 1, save: host, clock: opts.clock, budgetMs: 5000 }); // pure-logic batches (thousands of sims in one callback) under parallel test load: the 250ms frame budget is wall-clock
  for (let i = 0; i < (opts.steps ?? 1); i++) game.step();
  const errors = game.errors.map((e) => `${e.script}:${e.line ?? "?"}: ${e.message}`);
  return { out: host.data.out as any, errors, game, host };
}
const run = async (src: string, steps = 1, files?: Record<string, string>) => {
  const r = await runLuau(src, { steps, files });
  expect(r.errors).toEqual([]);
  return r.out;
};

// Session-script bot for the example: plays levels through the real play scene, following view:hint() each move.
const BOT = `
local App = require("../shared/app")
local Puzzle = require("@kit/puzzle")
local plan = { {"push",1},{"push",2},{"push",3},{"push",4}, {"flow",1},{"flow",2},{"flow",3}, {"match",1},{"match",2},{"match",3}, {"daily"} }
local k, state, wait, solved, packsSeen = 0, "idle", 30, 0, {}
local unlocked = { flowBefore = Puzzle.progress.isUnlocked("flow") }
local function nextJob()
  k += 1
  local j = plan[k]
  if not j then
    unlocked.flowAfter = Puzzle.progress.isUnlocked("flow")
    unlocked.match = Puzzle.progress.isUnlocked("match")
    save.set("bot", { done = true, solved = solved, packs = packsSeen, daily = Puzzle.daily.solved(), stars = Puzzle.progress.totalStars(), unlocked = unlocked })
    state = "done"
    return
  end
  if j[1] == "daily" then App.daily() else App.play(j[1], j[2]) end
  state, wait = "loading", 5
end
game.sceneLoaded:connect(function(path) if path == "scenes/play.scene.json" then state, wait = "playing", 20 end end)
onTick(function()
  if wait > 0 then wait -= 1 return end
  if state == "idle" then nextJob() return end
  if state ~= "playing" then return end
  local cur = App.current
  local s = cur.session
  if s.won then
    solved += 1
    local pid = if cur.pack then cur.pack.id else "daily"
    if pid ~= "daily" and not table.find(packsSeen, pid) then table.insert(packsSeen, pid) end
    state, wait = "idle", 70
    return
  end
  if s.lost then state, wait = "idle", 10 return end
  local mv = cur.view:hint()
  if mv ~= nil then cur.view:play(mv) end
  wait = 3
end)
`;

describe("puzzle kit", () => {
  it("push: rules, walls, pushing, win, undo/redo/restart, tap-to-walk is one undo step", async () => {
    const out = await run(`
      local lv = P.mechanic("push").parse("#######\\n#@ $ .#\\n#     #\\n#######")
      local s = P.session("push", lv)
      local r = {}
      r.par = P.packs.ensurePar(P.mechanic("push"), lv)
      r.wall = s:apply("u")
      r.step = s:apply("r")
      local ok, info = s:apply("r")
      r.push = info.push
      r.moves = s.moves
      r.undo = s:undo()
      r.afterUndo = s.moves
      r.redo = s:redo()
      s:apply("r")
      r.won = s.won
      r.stars = s:stars()
      local events = {}
      s:restart()
      r.restartMoves = s.moves
      local walk = P.mechanic("push").tap(s.state, 2, 2)
      s:apply(walk)
      r.walkMoves = s.moves
      s:undo()
      r.walkUndo = s.moves
      -- hint bot
      s:restart()
      local won, n = P.autoplay(s)
      r.botWon, r.botMoves, r.botStars = won, s.moves, s:stars()
      save.set("out", r)
    `);
    expect(out.wall).toBe(false);
    expect(out.step).toBe(true);
    expect(out.push).toBe(true);
    expect(out.moves).toBe(2);
    expect(out.undo).toBe(true);
    expect(out.afterUndo).toBe(1);
    expect(out.redo).toBe(true);
    expect(out.won).toBe(true);
    expect(out.par).toBe(3);
    expect(out.stars).toBe(3);
    expect(out.restartMoves).toBe(0);
    expect(out.walkMoves).toBe(2);
    expect(out.walkUndo).toBe(0);
    expect(out.botWon).toBe(true);
    expect(out.botMoves).toBe(3);
    expect(out.botStars).toBe(3);
  });

  it("sliding + lights: rules, win detection, optimal hints", async () => {
    const out = await run(`
      local r = {}
      local sl = P.mechanic("sliding")
      local s = P.session("sliding", sl.parse("1 2 3\\n4 5 6\\n7 0 8"))
      r.bad = s:apply(1)
      r.good = s:apply(9)
      r.won = s.won
      local s2 = P.session("sliding", sl.parse("1 2 3\\n4 5 6\\n0 7 8"))
      r.tapRun = s2:apply(sl.tap(s2.state, 2, 2))
      r.tapWon, r.tapMoves = s2.won, s2.moves
      local lg = P.mechanic("lights")
      local l = P.session("lights", lg.parse(".o.\\nooo\\n.o."))
      r.lpar = P.packs.ensurePar(lg, l.level)
      l:apply(5)
      r.lwon = l.won
      local l2 = P.session("lights", lg.parse("o....\\noo...\\no....\\n.....\\n....."))
      local won = P.autoplay(l2)
      r.l2won, r.l2moves = won, l2.moves
      save.set("out", r)
    `);
    expect(out.bad).toBe(false);
    expect(out.good).toBe(true);
    expect(out.won).toBe(true);
    expect(out.tapRun).toBe(true);
    expect(out.tapWon).toBe(true);
    expect(out.tapMoves).toBe(2);
    expect(out.lpar).toBe(1);
    expect(out.lwon).toBe(true);
    expect(out.l2won).toBe(true);
    expect(out.l2moves).toBe(1);
  });

  it("flow: drawing, crossing cuts pipes, fill rule, solver, drag/backtrack, hints", async () => {
    const out = await run(`
      local F = P.mechanic("flow")
      local lv = F.parse("A.A\\n..B\\n..B")
      local s = P.session("flow", lv)
      local r = {}
      -- idx(x,y) = y*3+x+1: A = 1,3 · B = 6,9
      r.badStart = s:apply({ color = 1, cells = { 2, 5 } })
      r.a = s:apply({ color = 1, cells = { 1, 2, 3 } })
      r.b = s:apply({ color = 2, cells = { 6, 9 } })
      r.notFilled = s.won   -- 4,5,7,8 empty and fill is required
      r.b2 = s:apply({ color = 2, cells = { 6, 5, 4, 7, 8, 9 } })
      r.won = s.won
      r.status = s:status()
      -- crossing: a new A path through B's pipe cuts B
      local s2 = P.session("flow", lv)
      s2:apply({ color = 2, cells = { 6, 5, 4, 7, 8, 9 } })
      s2:apply({ color = 1, cells = { 1, 4 } })
      r.cut = #s2.state.paths[2]
      -- drag with backtrack
      local d = F.drag(s2.state, { 1, 4, 5, 4 })
      r.drag = table.concat(d.cells, ",")
      -- solver
      local sol = F.solveLevel(lv)
      r.solved = sol ~= nil
      local s3 = P.session("flow", lv)
      local won = P.autoplay(s3)
      r.botWon, r.botMoves, r.par = won, s3.moves, P.packs.ensurePar(F, lv)
      -- unsolvable
      r.unsolvable = F.solveLevel(F.parse("AB\\nBA")) == nil
      save.set("out", r)
    `);
    expect(out.badStart).toBe(false);
    expect(out.a).toBe(true);
    expect(out.b).toBe(true);
    expect(out.notFilled).toBe(false);
    expect(out.b2).toBe(true);
    expect(out.won).toBe(true);
    expect(out.cut).toBe(2);
    expect(out.drag).toBe("1,4");
    expect(out.solved).toBe(true);
    expect(out.botWon).toBe(true);
    expect(out.botMoves).toBe(out.par);
    expect(out.unsolvable).toBe(true);
  });

  it("nonogram: clues, toggles, win by clues, generator is line-solvable", async () => {
    const out = await run(`
      local N = P.mechanic("nonogram")
      local lv = N.parse("#.#\\n###\\n..#")
      local s = P.session("nonogram", lv)
      local r = { rows = s.state.rows, cols = s.state.cols }
      s:apply(N.tap(s.state, 1, 0))   -- fill wrong cell
      s:apply(N.tap(s.state, 1, 0))   -- -> crossed (cost 0)
      r.crossed = s.state.board.layers.mark[2]
      local won = P.autoplay(s)
      r.won, r.moves, r.par = won, s.moves, P.packs.ensurePar(N, lv)
      local g = N.generate({ seed = 3, w = 6 })
      r.gen = g ~= nil and N.solveClues(N.clues(g.w, g.h, g.solution)) ~= nil
      save.set("out", r)
    `);
    expect(out.rows).toEqual([[1, 1], [3], [1]]);
    expect(out.cols).toEqual([[2], [1], [3]]);
    expect(out.crossed).toBe(2);
    expect(out.won).toBe(true);
    expect(out.gen).toBe(true);
  });

  it("match-3: deterministic boards, cascades, specials (line, bomb, orb), objectives, move limit", async () => {
    const out = await run(`
      local M3 = P.mechanic("match3")
      local r = {}
      local lv = { w = 6, h = 6, colors = 5, moves = 10, seed = 42, objective = { score = 99999 } }
      local a, b = M3.load(lv), M3.load(lv)
      r.sameStart = a.board:key({ "gem" }) == b.board:key({ "gem" })
      r.noStartMatches = #M3.findGroups(a) == 0
      r.hasMoves = #M3.validMoves(a) > 0
      for i = 1, 5 do
        local m = M3.bestMove(a)
        M3.apply(a, m) M3.apply(b, m)
      end
      r.sameAfter = a.board:key({ "gem", "special" }) == b.board:key({ "gem", "special" }) and a.score == b.score
      -- authored: swapping (3,1)<->(3,0) makes a row of 4 on row 0 → line special
      local four = { w = 5, h = 4, colors = 5, moves = 5, seed = 1, objective = { score = 99999 },
        grid = { "11214", "34123", "25345", "43552" } }
      local s = M3.load(four)
      local ok, info = M3.apply(s, { a = 3, b = 8 })
      r.fourOk = ok
      local specials = 0
      for _, v in s.board.layers.special do if v > 0 then specials += 1 end end
      r.made = info.steps[1].created[1] and info.steps[1].created[1].special
      r.invalid = (M3.apply(M3.load(four), { a = 1, b = 7 }))
      -- L shape → bomb: row 2 "222" + column x=0 rows 0..2 after swap
      local L = { w = 5, h = 5, colors = 5, moves = 5, seed = 1, objective = { score = 99999 },
        grid = { "21345", "24513", "32254", "24531", "53142" } }
      local s3 = M3.load(L)
      local ok3, info3 = M3.apply(s3, { a = 11, b = 16 })
      r.bomb = ok3 and info3.steps[1].created[1] and info3.steps[1].created[1].special
      -- five in a row → orb; orb swap clears a colour
      local five = { w = 5, h = 3, colors = 5, moves = 5, seed = 9, objective = { score = 99999 },
        grid = { "11211", "34134", "45345" } }
      local s5 = M3.load(five)
      local ok5, info5 = M3.apply(s5, { a = 3, b = 8 })
      r.orb = ok5 and info5.steps[1].created[1] and info5.steps[1].created[1].special
      -- objectives + lose
      local sess = P.session("match3", { w = 6, h = 6, colors = 5, moves = 3, seed = 5, objective = { score = 1e9 } })
      P.autoplay(sess)
      r.lost, r.left = sess.lost, sess.state.movesLeft
      r.cascades = 0
      local c = M3.load({ w = 7, h = 8, colors = 4, moves = 30, seed = 77, objective = { score = 1e9 } })
      for i = 1, 30 do local m = M3.bestMove(c) if not m then break end local _, inf = M3.apply(c, m) r.cascades = math.max(r.cascades, inf.cascades) end
      save.set("out", r)
    `);
    expect(out.sameStart).toBe(true);
    expect(out.noStartMatches).toBe(true);
    expect(out.hasMoves).toBe(true);
    expect(out.sameAfter).toBe(true);
    expect(out.fourOk).toBe(true);
    expect(out.made).toBe("line_h");
    expect(out.invalid).toBe(false);
    expect(out.bomb).toBe("bomb");
    expect(out.orb).toBe("color");
    expect(out.lost).toBe(true);
    expect(out.left).toBe(0);
    expect(out.cascades).toBeGreaterThanOrEqual(2);
  });

  it("generators: 100 seeds each solvable at the requested difficulty, par = solver length", async () => {
    const out = await run(`
      local r = { push = 0, pushIn = 0, pushPar = 0, slide = 0, slideIn = 0, lights = 0, lightsIn = 0, flow = 0, flowValid = 0, nono = 0, flowSolved = 0 }
      local Pu, Sl, Li, Fl, No = P.mechanic("push"), P.mechanic("sliding"), P.mechanic("lights"), P.mechanic("flow"), P.mechanic("nonogram")
      forTicks(100, 1, function(i)
        local want = 2 + (i % 5)
        local g = Pu.generate({ seed = i, pushes = want, w = 7, h = 7 })
        if g then
          r.push += 1
          if g.pushes >= want and g.pushes <= want + 5 then r.pushIn += 1 end
          local sol = Pu.solve(Pu.load(g))
          if sol and #sol.moves <= g.par then r.pushPar += 1 end
        end
        local sm = 6 + (i % 8)
        local s = Sl.generate({ seed = i, moves = sm })
        if s then r.slide += 1 if s.par >= sm and s.par == #Sl.solve(Sl.load(s)).moves then r.slideIn += 1 end end
        local lp = 3 + (i % 4)
        local l = Li.generate({ seed = i, presses = lp })
        if l then r.lights += 1 if l.par >= lp and #Li.solve(Li.load(l)).moves == l.par then r.lightsIn += 1 end end
        local f = Fl.generate({ seed = i, w = 5 + (i % 3), pairs = 4 + (i % 3) })
        if f then
          r.flow += 1
          local st = Fl.load(f)
          for c, cells in f.solution do Fl.apply(st, { color = c, cells = cells }) end
          if Fl.isWon(st) then r.flowValid += 1 end
          if i <= 45 and i % 3 == 0 and Fl.solveLevel(f) then r.flowSolved += 1 end
        end
        local n = No.generate({ seed = i, w = 5 + (i % 3) })
        if n then r.nono += 1 end
      end, function() save.set("out", r) end)
    `, 110);
    expect(out.push).toBe(100);
    expect(out.pushIn).toBe(100);
    expect(out.pushPar).toBe(100);
    expect(out.slide).toBe(100);
    expect(out.slideIn).toBe(100);
    expect(out.lights).toBe(100);
    expect(out.lightsIn).toBe(100);
    expect(out.flow).toBe(100);
    expect(out.flowValid).toBe(100);
    expect(out.flowSolved).toBe(15);
    expect(out.nono).toBe(100);
  }, 120000);

  it("match-3 generator: objectives calibrated so the hint bot wins with 3 stars", async () => {
    const out = await run(`
      local r = { made = 0, won = 0, three = 0 }
      local goals = { "score", "jelly", "collect" }
      forTicks(12, 1, function(i)
        local lv = P.mechanic("match3").generate({ seed = i, goal = goals[(i % 3) + 1], moves = 15, w = 7, h = 7, jelly = 8 })
        if lv then
          r.made += 1
          local s = P.session("match3", lv)
          local won = P.autoplay(s)
          if won then r.won += 1 end
          if s:stars() == 3 then r.three += 1 end
        end
      end, function() save.set("out", r) end)
    `, 20);
    expect(out.made).toBe(12);
    expect(out.won).toBe(12);
    expect(out.three).toBe(12);
  }, 60000);

  it("packs: authored + generated with a curve, star-gated unlocks, sequential levels, save roundtrip", async () => {
    const out = await run(`
      local core = require("@kit/core")
      P.packs.define("a", { name = "A", mechanic = "lights", levels = {
        { text = ".o.\\nooo\\n.o." }, "data/levels/l2.txt",
        { generate = { count = 4, seed = 9, params = { w = 4 }, curve = { { at = 0, params = { presses = 2 } }, { at = 1, params = { presses = 6 } } } } } } })
      P.packs.define("b", { name = "B", mechanic = "lights", unlock = { stars = 5 }, levels = { { text = "o.\\n.." } } })
      P.packs.define("c", { name = "C", mechanic = "lights", unlock = { puzzleStars = 3, pack = "a" }, levels = { { text = "o.\\n.." } } })
      local a = P.packs.get("a")
      local r = { count = a:count(), pars = {} }
      for i = 1, a:count() do r.pars[i] = a:level(i).par end
      r.l3gen = a:level(3).generated == true
      r.lockedB = P.progress.isUnlocked("b")
      r.need = P.progress.starsNeeded("b")
      r.lvl2 = P.progress.levelUnlocked("a", 2)
      local s = P.session(a:level(1))
      P.autoplay(s)
      P.record(s)
      r.lvl2after = P.progress.levelUnlocked("a", 2)
      r.cUnlocked = P.progress.isUnlocked("c")
      P.progress.record("a", 2, 2, 5)
      r.total = P.progress.totalStars()
      r.unlockedB = P.progress.isUnlocked("b")
      r.cond = core.check({ puzzleStars = 5 })
      r.next = P.progress.nextLevel("a")
      -- save roundtrip
      core.save.save()
      P.progress.reset()
      r.afterReset = P.progress.totalStars()
      core.save.load()
      r.afterLoad = P.progress.totalStars()
      save.set("out", r)
    `, 1, { "data/levels/l2.txt": "o....\noo...\no....\n.....\n....." });
    expect(out.count).toBe(6);
    expect(out.pars.slice(0, 2)).toEqual([1, 1]);
    expect(out.pars[2]).toBeLessThanOrEqual(out.pars[5]);
    expect(out.l3gen).toBe(true);
    expect(out.lockedB).toBe(false);
    expect(out.need).toBe(5);
    expect(out.lvl2).toBe(false);
    expect(out.lvl2after).toBe(true);
    expect(out.cUnlocked).toBe(true);
    expect(out.total).toBe(5);
    expect(out.unlockedB).toBe(true);
    expect(out.cond).toBe(true);
    expect(out.next).toBe(3);
    expect(out.afterReset).toBe(0);
    expect(out.afterLoad).toBe(5);
  });

  it("daily: same puzzle all day (clock.now), new one tomorrow, streak", async () => {
    const day = 20500;
    const mk = (t: number) => runLuau(`
      local lv = P.daily.level("flow", { params = { w = 6, pairs = 5 } })
      local s = P.session(lv)
      P.autoplay(s)
      P.record(s)
      save.set("out", { day = P.daily.day(), key = table.concat(lv.ends[1], ","), seed = P.daily.seed(), won = s.won, streak = P.daily.streak(), solved = P.daily.solved() })
    `, { clock: () => t });
    const a = await mk(day * 86400 + 100), b = await mk(day * 86400 + 80000), c = await mk((day + 1) * 86400 + 5);
    for (const r of [a, b, c]) expect(r.errors).toEqual([]);
    expect(a.out.day).toBe(day);
    expect(a.out.seed).toBe(b.out.seed);
    expect(a.out.key).toBe(b.out.key);
    expect(c.out.seed).not.toBe(a.out.seed);
    expect(a.out.won).toBe(true);
    expect(a.out.streak).toBe(1);
    expect(a.out.solved).toBe(true);
  });

  it("example kit-puzzle: boots, bot solves levels in every pack via hints + daily, zero script errors", async () => {
    const dir = join(ROOT, "games/examples/kit-puzzle");
    const files: Record<string, string | Uint8Array> = {};
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else files[relative(dir, p)] = readFileSync(p); } };
    walk(dir);
    files["scripts/client/zz_bot.luau"] = BOT;
    const host = new MemorySaveHost();
    const game = await Game.load(Package.fromFiles(files as any), { seed: 3, save: host, clock: () => 20500 * 86400 });
    for (let i = 0; i < 60 * 150; i++) {
      game.step();
      if ((host.data.bot as any)?.done) break;
    }
    const errors = game.errors.map((e) => `${e.script}:${e.line ?? "?"}: ${e.message}`);
    expect(errors).toEqual([]);
    const bot = host.data.bot as any;
    expect(bot?.done).toBe(true);
    expect(bot.solved).toBeGreaterThanOrEqual(9);
    expect(bot.packs).toEqual(["push", "flow", "match"]);
    expect(bot.daily).toBe(true);
    expect(bot.unlocked).toEqual({ flowBefore: false, flowAfter: true, match: true });
    expect(bot.stars).toBeGreaterThanOrEqual(27);
  }, 120000);
});
