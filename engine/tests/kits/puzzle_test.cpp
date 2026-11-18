// puzzle kit: mechanic rules, undo/redo, win detection, generators (solvable at the requested
// difficulty over 100 seeds, par from the solver), deterministic match-3 cascades/specials, pack
// unlock by stars, daily seed, example end-to-end bot.
// Port of engine-web/test/kits/puzzle.test.ts (same numbers and thresholds).
#include "kits/kit_test.h"

using namespace dreamsy;
using namespace dreamsy::test;

namespace {

const char* kExample = "games/examples/kit-puzzle";

// Every test script starts with the kit, procgen and forTicks(n, per, fn, done): runs fn(1..n),
// `per` calls each tick, then done() once (big batches spread across ticks).
const std::string kPrelude = R"(local P = require("@kit/puzzle")
local procgen = require("@kit/procgen")
local function forTicks(n, per, fn, done)
  local i = 0
  onTick(function()
    if i >= n then return end
    for _ = 1, per do i += 1 if i <= n then fn(i) end end
    if i >= n then done() end
  end)
end
)";

struct PuzzleOpts {
  int steps = 1;
  FileMap files;                 // extra package files
  std::function<double()> clock;  // clock.now()
};

// TS runLuau(): a one-scene package whose only script is kPrelude + src. Returns the running game
// (its save data holds `out`; local_scores() holds the leaderboard submissions).
Game puzzle_game(const std::string& src, const PuzzleOpts& o = {}) {
  FileMap files = o.files;
  files["dreamsy.toml"] = manifest("\"puzzle\"", "scenes/main.scene.json", "portrait", "clean");
  files["scenes/main.scene.json"] = empty_scene("root");
  files["scripts/client/main.luau"] = kPrelude + src;
  script::HostOptions opts;
  opts.seed = 1;
  opts.clock = o.clock;
  // Same as the TS test: pure-logic batches (thousands of sims in one callback); the frame budget
  // is wall-clock and the debug sanitizer build is slow.
  opts.budget_ms = budget(5000);
  Game g = start(files, opts);
  g.step(o.steps);
  return g;
}

J out_of(const Game& g) { return J(&g.save())["out"]; }

// Session-script bot for the example: plays levels through the real play scene, following
// view:hint() each move.
const char* kBot = R"(
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
)";

}  // namespace

TEST_SUITE("kit puzzle") {

TEST_CASE("puzzle: push: rules, walls, pushing, win, undo/redo/restart, tap-to-walk is one undo step") {
  Game g = puzzle_game(R"(
      local lv = P.mechanic("push").parse("#######\n#@ $ .#\n#     #\n#######")
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
  )");
  CHECK_NO_ERRORS(g);
  J o = out_of(g);
  CHECK(o["wall"].is_bool());
  CHECK_FALSE(o["wall"].b());
  CHECK(o["step"].b());
  CHECK(o["push"].b());
  CHECK(o["moves"].num() == 2);
  CHECK(o["undo"].b());
  CHECK(o["afterUndo"].num() == 1);
  CHECK(o["redo"].b());
  CHECK(o["won"].b());
  CHECK(o["par"].num() == 3);
  CHECK(o["stars"].num() == 3);
  CHECK(o["restartMoves"].num() == 0);
  CHECK(o["walkMoves"].num() == 2);
  CHECK(o["walkUndo"].num() == 0);
  CHECK(o["botWon"].b());
  CHECK(o["botMoves"].num() == 3);
  CHECK(o["botStars"].num() == 3);
}

TEST_CASE("puzzle: view times levels on the platform leaderboard (win -> finish; Retry restarts; loss cancels; opt-out)") {
  PuzzleOpts po;
  po.steps = 150;
  Game g = puzzle_game(R"(
      local sl = P.mechanic("sliding")
      local lv = sl.parse("1 2 3\n4 5 6\n7 0 8")
      lv.pack, lv.index = "garden", 2
      local s = P.session("sliding", lv)
      local v = P.view.new(s, { cell = 64 })
      after(1.5, function()
        s:restart()
        after(0.5, function() s:apply(9) end)
      end)
      local s2 = P.session("sliding", sl.parse("1 2 3\n4 5 6\n7 0 8"))
      P.view.new(s2, { cell = 64, board = false })
      s2:apply(9)
  )",
                       po);
  CHECK_NO_ERRORS(g);
  // TS reads MemoryLeaderboardHost.submitted ([board, order]); the C++ host keeps the same
  // submissions in local_scores() (ascending = order "asc").
  const auto& sub = g->local_scores();
  REQUIRE(sub.size() == 1);
  CHECK(sub[0].board == "level_garden_2");
  CHECK(sub[0].ascending);
  CHECK_CLOSE(sub[0].value, 0.5, 1);  // clock restarted by Retry
}

TEST_CASE("puzzle: sliding + lights: rules, win detection, optimal hints") {
  Game g = puzzle_game(R"(
      local r = {}
      local sl = P.mechanic("sliding")
      local s = P.session("sliding", sl.parse("1 2 3\n4 5 6\n7 0 8"))
      r.bad = s:apply(1)
      r.good = s:apply(9)
      r.won = s.won
      local s2 = P.session("sliding", sl.parse("1 2 3\n4 5 6\n0 7 8"))
      r.tapRun = s2:apply(sl.tap(s2.state, 2, 2))
      r.tapWon, r.tapMoves = s2.won, s2.moves
      local lg = P.mechanic("lights")
      local l = P.session("lights", lg.parse(".o.\nooo\n.o."))
      r.lpar = P.packs.ensurePar(lg, l.level)
      l:apply(5)
      r.lwon = l.won
      local l2 = P.session("lights", lg.parse("o....\noo...\no....\n.....\n....."))
      local won = P.autoplay(l2)
      r.l2won, r.l2moves = won, l2.moves
      save.set("out", r)
  )");
  CHECK_NO_ERRORS(g);
  J o = out_of(g);
  CHECK(o["bad"].is_bool());
  CHECK_FALSE(o["bad"].b());
  CHECK(o["good"].b());
  CHECK(o["won"].b());
  CHECK(o["tapRun"].b());
  CHECK(o["tapWon"].b());
  CHECK(o["tapMoves"].num() == 2);
  CHECK(o["lpar"].num() == 1);
  CHECK(o["lwon"].b());
  CHECK(o["l2won"].b());
  CHECK(o["l2moves"].num() == 1);
}

TEST_CASE("puzzle: flow: drawing, crossing cuts pipes, fill rule, solver, drag/backtrack, hints") {
  Game g = puzzle_game(R"(
      local F = P.mechanic("flow")
      local lv = F.parse("A.A\n..B\n..B")
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
      r.unsolvable = F.solveLevel(F.parse("AB\nBA")) == nil
      save.set("out", r)
  )");
  CHECK_NO_ERRORS(g);
  J o = out_of(g);
  CHECK(o["badStart"].is_bool());
  CHECK_FALSE(o["badStart"].b());
  CHECK(o["a"].b());
  CHECK(o["b"].b());
  CHECK(o["notFilled"].is_bool());
  CHECK_FALSE(o["notFilled"].b());
  CHECK(o["b2"].b());
  CHECK(o["won"].b());
  CHECK(o["cut"].num() == 2);
  CHECK(o["drag"].str() == "1,4");
  CHECK(o["solved"].b());
  CHECK(o["botWon"].b());
  CHECK(o["botMoves"].num() == o["par"].num());
  CHECK(o["unsolvable"].b());
}

TEST_CASE("puzzle: nonogram: clues, toggles, win by clues, generator is line-solvable") {
  Game g = puzzle_game(R"(
      local N = P.mechanic("nonogram")
      local lv = N.parse("#.#\n###\n..#")
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
  )");
  CHECK_NO_ERRORS(g);
  J o = out_of(g);
  CHECK(o["rows"].dump() == "[[1,1],[3],[1]]");
  CHECK(o["cols"].dump() == "[[2],[1],[3]]");
  CHECK(o["crossed"].num() == 2);
  CHECK(o["won"].b());
  CHECK(o["gen"].b());
}

TEST_CASE("puzzle: match-3: deterministic boards, cascades, specials (line, bomb, orb), objectives, move limit") {
  Game g = puzzle_game(R"(
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
  )");
  CHECK_NO_ERRORS(g);
  J o = out_of(g);
  CHECK(o["sameStart"].b());
  CHECK(o["noStartMatches"].b());
  CHECK(o["hasMoves"].b());
  CHECK(o["sameAfter"].b());
  CHECK(o["fourOk"].b());
  CHECK(o["made"].str() == "line_h");
  CHECK(o["invalid"].is_bool());
  CHECK_FALSE(o["invalid"].b());
  CHECK(o["bomb"].str() == "bomb");
  CHECK(o["orb"].str() == "color");
  CHECK(o["lost"].b());
  CHECK(o["left"].num() == 0);
  CHECK(o["cascades"].num() >= 2);
}

TEST_CASE("puzzle: generators: 100 seeds each solvable at the requested difficulty, par = solver length" *
          doctest::test_suite("slow")) {
  PuzzleOpts po;
  po.steps = 110;
  Game g = puzzle_game(R"(
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
  )",
                       po);
  CHECK_NO_ERRORS(g);
  J o = out_of(g);
  CHECK(o["push"].num() == 100);
  CHECK(o["pushIn"].num() == 100);
  CHECK(o["pushPar"].num() == 100);
  CHECK(o["slide"].num() == 100);
  CHECK(o["slideIn"].num() == 100);
  CHECK(o["lights"].num() == 100);
  CHECK(o["lightsIn"].num() == 100);
  CHECK(o["flow"].num() == 100);
  CHECK(o["flowValid"].num() == 100);
  CHECK(o["flowSolved"].num() == 15);
  CHECK(o["nono"].num() == 100);
}

TEST_CASE("puzzle: match-3 generator: objectives calibrated so the hint bot wins with 3 stars" *
          doctest::test_suite("slow")) {
  PuzzleOpts po;
  po.steps = 20;
  Game g = puzzle_game(R"(
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
  )",
                       po);
  CHECK_NO_ERRORS(g);
  J o = out_of(g);
  CHECK(o["made"].num() == 12);
  CHECK(o["won"].num() == 12);
  CHECK(o["three"].num() == 12);
}

TEST_CASE("puzzle: packs: authored + generated with a curve, star-gated unlocks, sequential levels, save roundtrip") {
  PuzzleOpts po;
  po.files["data/levels/l2.txt"] = "o....\noo...\no....\n.....\n.....";
  Game g = puzzle_game(R"(
      local core = require("@kit/core")
      P.packs.define("a", { name = "A", mechanic = "lights", levels = {
        { text = ".o.\nooo\n.o." }, "data/levels/l2.txt",
        { generate = { count = 4, seed = 9, params = { w = 4 }, curve = { { at = 0, params = { presses = 2 } }, { at = 1, params = { presses = 6 } } } } } } })
      P.packs.define("b", { name = "B", mechanic = "lights", unlock = { stars = 5 }, levels = { { text = "o.\n.." } } })
      P.packs.define("c", { name = "C", mechanic = "lights", unlock = { puzzleStars = 3, pack = "a" }, levels = { { text = "o.\n.." } } })
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
  )",
                       po);
  CHECK_NO_ERRORS(g);
  J o = out_of(g);
  CHECK(o["count"].num() == 6);
  REQUIRE(o["pars"].size() == 6);
  CHECK(o["pars"][0].num() == 1);
  CHECK(o["pars"][1].num() == 1);
  CHECK(o["pars"][2].num() <= o["pars"][5].num());
  CHECK(o["l3gen"].b());
  CHECK(o["lockedB"].is_bool());
  CHECK_FALSE(o["lockedB"].b());
  CHECK(o["need"].num() == 5);
  CHECK(o["lvl2"].is_bool());
  CHECK_FALSE(o["lvl2"].b());
  CHECK(o["lvl2after"].b());
  CHECK(o["cUnlocked"].b());
  CHECK(o["total"].num() == 5);
  CHECK(o["unlockedB"].b());
  CHECK(o["cond"].b());
  CHECK(o["next"].num() == 3);
  CHECK(o["afterReset"].num() == 0);
  CHECK(o["afterLoad"].num() == 5);
}

TEST_CASE("puzzle: daily: same puzzle all day (clock.now), new one tomorrow, streak") {
  const double day = 20500;
  auto mk = [](double t) {
    PuzzleOpts po;
    po.clock = [t] { return t; };
    return puzzle_game(R"(
      local lv = P.daily.level("flow", { params = { w = 6, pairs = 5 } })
      local s = P.session(lv)
      P.autoplay(s)
      P.record(s)
      save.set("out", { day = P.daily.day(), key = table.concat(lv.ends[1], ","), seed = P.daily.seed(), won = s.won, streak = P.daily.streak(), solved = P.daily.solved() })
    )",
                       po);
  };
  Game a = mk(day * 86400 + 100), b = mk(day * 86400 + 80000), c = mk((day + 1) * 86400 + 5);
  CHECK_NO_ERRORS(a);
  CHECK_NO_ERRORS(b);
  CHECK_NO_ERRORS(c);
  J oa = out_of(a), ob = out_of(b), oc = out_of(c);
  CHECK(oa["day"].num() == day);
  CHECK(oa["seed"].num() == ob["seed"].num());
  CHECK(oa["key"].str() == ob["key"].str());
  CHECK(oc["seed"].num() != oa["seed"].num());
  CHECK(oa["won"].b());
  CHECK(oa["streak"].num() == 1);
  CHECK(oa["solved"].b());
}

TEST_CASE("puzzle example kit-puzzle: boots, bot solves levels in every pack via hints + daily, zero script errors" *
          doctest::test_suite("slow")) {
  script::HostOptions opts;
  opts.seed = 3;
  opts.budget_ms = budget(250);
  opts.clock = [] { return 20500.0 * 86400; };
  Game g = start_dir(kExample, {{"scripts/client/zz_bot.luau", kBot}}, opts);
  g.step_until([&] { return J(&g.save())["bot"]["done"].truthy(); }, 60 * 150);
  CHECK_NO_ERRORS(g);
  J bot = J(&g.save())["bot"];
  REQUIRE(bot["done"].b());
  CHECK(bot["solved"].num() >= 9);
  CHECK(bot["packs"].strs() == std::vector<std::string>{"push", "flow", "match"});
  CHECK(bot["daily"].b());
  CHECK(bot["unlocked"]["flowBefore"].is_bool());
  CHECK_FALSE(bot["unlocked"]["flowBefore"].b());
  CHECK(bot["unlocked"]["flowAfter"].b());
  CHECK(bot["unlocked"]["match"].b());
  CHECK(bot["unlocked"].size() == 3);
  CHECK(bot["stars"].num() >= 27);
}

}  // TEST_SUITE
