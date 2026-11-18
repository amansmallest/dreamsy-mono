// procgen kit: determinism per seed, guaranteed connectivity over 200 seeds, room stitching, chunks,
// loot distribution, waves/names, puzzle solvability (verified independently here in C++), and the
// kit-roguelike-demo example (content from data/, bot runs over 5 engine seeds).
// Port of engine-web/test/kits/procgen.test.ts (same numbers and thresholds).
#include <algorithm>
#include <set>

#include "kits/kit_test.h"

using namespace dreamsy;
using namespace dreamsy::test;

namespace {

const char* kRoguelike = "games/examples/kit-roguelike-demo";

// TS run(): the snippet runs with P (procgen), h() (string hash) and forTicks(n, per, fn, done),
// which spreads heavy loops over frames (scripts get a CPU budget per callback). Budget 5000 ms as in
// TS, scaled under the sanitizers. Returns the whole run; out() is save.get("out").
LuauRun run(const std::string& src, int steps = 1) {
  LuauOptions o;
  o.kits = {"procgen"};
  o.steps = steps;
  o.budget_ms = budget(5000);
  LuauRun r = run_luau(R"(local P = require("@kit/procgen")
local function h(s) return P.RNG.hash(s) end
local function forTicks(n, per, fn, done)
  local i = 0
  local conn
  onTick(function()
    if i >= n then return end
    for _ = 1, per do i += 1 if i <= n then fn(i) end end
    if i >= n then done() end
  end)
end
)" + src,
                       o);
  CHECK_MESSAGE(r.errors.empty(), join(r.errors));
  return r;
}

const std::string kTemplates = R"({
  start_a = "###########\n#.........#\n#.........#\n#....S....#\n#.........#\n#.........#\n###########",
  room_a  = "###########\n#..?...?..#\n#.##...##.#\n#....E....#\n#.##...##.#\n#..?...?..#\n###########",
  room_b  = "###########\n#.........#\n#..#####..#\n#..#.E.#..#\n#..#...#..#\n#.........#\n###########",
  room_c  = "###########\n#?.?.?.?.?#\n#.E.....E.#\n#?.?.?.?.?#\n#.........#\n#?.?.?.?.?#\n###########",
  key_a   = "###########\n#.........#\n#..T...T..#\n#.........#\n#.........#\n#.........#\n###########",
  exit_boss = "###########\n#.........#\n#....B....#\n#.........#\n#.........#\n#.........#\n###########",
})";

std::vector<std::string> split_lines(const std::string& text) {
  std::vector<std::string> rows;
  size_t start = 0;
  while (true) {
    size_t nl = text.find('\n', start);
    rows.push_back(text.substr(start, nl == std::string::npos ? std::string::npos : nl - start));
    if (nl == std::string::npos) break;
    start = nl + 1;
  }
  return rows;
}

// Replays a sokoban solution (u/d/l/r walk, U/D/L/R push) on its level text and checks every move is
// legal, the push count matches and every box ends on a goal (TS: the independent verifier).
void verify_sokoban(J s) {
  CHECK(s.truthy());
  if (!s.truthy()) return;
  CHECK(s["pushes"].num() >= 6);
  CHECK(s["pushes"].num() <= 18);
  std::vector<std::string> rows = split_lines(s["text"].str());
  size_t width = 0;
  for (const std::string& r : rows) width = std::max(width, r.size());
  auto cell = [&rows](int x, int y) -> char {
    if (y < 0 || y >= static_cast<int>(rows.size()) || x < 0 || x >= static_cast<int>(rows[y].size())) return '#';
    return rows[y][x];
  };
  int px = 0, py = 0;
  std::set<std::pair<int, int>> boxes, goals;
  for (int y = 0; y < static_cast<int>(rows.size()); ++y)
    for (int x = 0; x < static_cast<int>(rows[y].size()); ++x) {
      char c = rows[y][x];
      if (c == '@' || c == '+') px = x, py = y;
      if (c == '$' || c == '*') boxes.insert({x, y});
      if (c == '.' || c == '+' || c == '*') goals.insert({x, y});
    }
  int pushes = 0;
  for (char ch : s["moves"].str()) {
    char lower = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
    int dx = lower == 'l' ? -1 : lower == 'r' ? 1 : 0;
    int dy = lower == 'u' ? -1 : lower == 'd' ? 1 : 0;
    int nx = px + dx, ny = py + dy;
    CHECK(cell(nx, ny) != '#');
    if (boxes.count({nx, ny})) {
      CHECK(std::isupper(static_cast<unsigned char>(ch)));
      int bx = nx + dx, by = ny + dy;
      CHECK(cell(bx, by) != '#');
      CHECK_FALSE(boxes.count({bx, by}));
      boxes.erase({nx, ny});
      boxes.insert({bx, by});
      ++pushes;
    } else {
      CHECK(std::islower(static_cast<unsigned char>(ch)));
    }
    px = nx, py = ny;
  }
  CHECK(width == 8);
  CHECK(pushes == s["pushes"].num());
  for (const auto& b : boxes) CHECK(goals.count(b));
}

// Applies a sliding-puzzle path (1-based tile indices moved into the gap) and checks it solves the board.
void verify_sliding(J t) {
  CHECK(t.truthy());
  if (!t.truthy()) return;
  CHECK(t["moves"].num() >= 12);
  CHECK(t["moves"].num() <= 18);
  std::vector<double> b = t["board"].nums();
  for (double ti : t["path"].nums()) {
    size_t z = std::find(b.begin(), b.end(), 0.0) - b.begin();
    size_t k = static_cast<size_t>(ti) - 1;
    REQUIRE(z < b.size());
    REQUIRE(k < b.size());
    b[z] = b[k];
    b[k] = 0;
  }
  CHECK(b == std::vector<double>{1, 2, 3, 4, 5, 6, 7, 8, 0});
}

// Presses the solution on a 5x5 lights-out board ("o" = lit) and checks every light ends off.
void verify_lights(J l) {
  CHECK(l.truthy());
  if (!l.truthy()) return;
  CHECK(l["presses"].num() >= 5);
  CHECK(l["presses"].num() <= 9);
  std::vector<bool> lit;
  for (char c : l["text"].str())
    if (c != '\n') lit.push_back(c == 'o');
  REQUIRE(lit.size() == 25);
  const int d[5][2] = {{0, 0}, {1, 0}, {-1, 0}, {0, 1}, {0, -1}};
  for (double i : l["solution"].nums()) {
    int k = static_cast<int>(i) - 1, x = k % 5, y = k / 5;
    for (const auto& dd : d) {
      int nx = x + dd[0], ny = y + dd[1];
      if (nx >= 0 && ny >= 0 && nx < 5 && ny < 5) lit[ny * 5 + nx] = !lit[ny * 5 + nx];
    }
  }
  CHECK(std::none_of(lit.begin(), lit.end(), [](bool v) { return v; }));
}

// The example package with config.bot = true (the hero plays itself).
FileMap bot_package() {
  FileMap files = read_dir(kRoguelike);
  std::string& cfg = files["scripts/shared/config.luau"];
  size_t at = cfg.find("bot = false");
  REQUIRE(at != std::string::npos);
  cfg.replace(at, 11, "bot = true");
  return files;
}

}  // namespace

TEST_SUITE("kit procgen") {

TEST_CASE("procgen: rng: deterministic per seed, ranges, weighted pick distribution, shuffle, fork") {
  LuauRun r = run(R"(
      local a, b, c = P.rng(42), P.rng(42), P.rng(43)
      local same, diff = true, false
      for i = 1, 100 do local x, y, z = a:next(), b:next(), c:next() if x ~= y then same = false end if x ~= z then diff = true end end
      local r = P.rng("hello")
      local lo, hi = 99, -99
      for i = 1, 2000 do local v = r:int(-3, 3) lo = math.min(lo, v) hi = math.max(hi, v) end
      local counts = { a = 0, b = 0, c = 0 }
      for i = 1, 20000 do local k = r:weighted({ a = 1, b = 3, c = 6 }) counts[k] += 1 end
      local s = r:shuffle({ 1, 2, 3, 4, 5, 6, 7, 8 })
      table.sort(s)
      local f1, f2 = P.rng(5):fork("enemies"):next(), P.rng(5):fork("enemies"):next()
      local nv = {}
      for i = 0, 50 do table.insert(nv, P.noise.simplex2(i * 0.37, i * 0.11, 3)) end
      local nmin, nmax = math.min(table.unpack(nv)), math.max(table.unpack(nv))
      save.set("out", { same = same, diff = diff, lo = lo, hi = hi, counts = counts, sorted = table.concat(s, ","), fork = f1 == f2,
        noiseDet = P.noise.value2(1.5, 2.5, 9) == P.noise.value2(1.5, 2.5, 9), nmin = nmin, nmax = nmax, fbm = P.noise.fbm2(3.3, 4.4, { seed = 1 }) })
  )");
  J out = r.out();
  CHECK(out["same"].b());
  CHECK(out["diff"].b());
  CHECK(out["lo"].num() == -3);
  CHECK(out["hi"].num() == 3);
  CHECK_CLOSE(out["counts"]["a"].num() / 20000, 0.1, 1);
  CHECK_CLOSE(out["counts"]["b"].num() / 20000, 0.3, 1);
  CHECK_CLOSE(out["counts"]["c"].num() / 20000, 0.6, 1);
  CHECK(out["sorted"].str() == "1,2,3,4,5,6,7,8");
  CHECK(out["fork"].b());
  CHECK(out["noiseDet"].b());
  CHECK(out["nmin"].num() >= -1);
  CHECK(out["nmax"].num() <= 1);
  CHECK(std::fabs(out["fbm"].num()) <= 1);
}

TEST_CASE("procgen: dungeon / caves / terrain: deterministic per seed and connected over 200 seeds" *
          doctest::test_suite("slow")) {
  LuauRun r = run(R"(
      local det = P.toTileMap(P.dungeon({ seed = 77 })) == P.toTileMap(P.dungeon({ seed = 77 }))
        and P.toTileMap(P.caves({ seed = 77 })) == P.toTileMap(P.caves({ seed = 77 }))
        and P.toTileMap(P.terrain({ seed = 77 })) == P.toTileMap(P.terrain({ seed = 77 }))
      local differ = P.toTileMap(P.dungeon({ seed = 1 })) ~= P.toTileMap(P.dungeon({ seed = 2 }))
      local bad = {}
      local distinct = {}
      local t0 = os.clock()
      forTicks(200, 2, function(seed)
        local d = P.dungeon({ seed = seed, w = 44, h = 44, rooms = 9 })
        local rep = P.validate(d.grid, { from = d.start, targets = { d.exit } })
        local spawnsOk = true
        for _, s in d.spawns do if d.grid:get(s.x, s.y) ~= "." then spawnsOk = false end end
        if not rep.ok or not spawnsOk or #d.rooms < 4 then table.insert(bad, "dungeon " .. seed) end
        distinct[h(P.toTileMap(d))] = true
        local c = P.caves({ seed = seed, w = 40, h = 40 })
        if not P.validate(c.grid, { from = c.start, targets = { c.exit } }).ok then table.insert(bad, "caves " .. seed) end
        if seed <= 60 then
          local t = P.terrain({ seed = seed, w = 48, h = 48 })
          local walk = function(ch) local b = t.biomes[ch] return b ~= nil and b.walkable ~= false end
          if not P.validate(t.grid, { pass = walk, from = t.start }).ok then table.insert(bad, "terrain " .. seed) end
        end
      end, function()
        local nd = 0 for _ in distinct do nd += 1 end
        save.set("out", { det = det, differ = differ, bad = table.concat(bad, ","), distinct = nd, ms = (os.clock() - t0) * 1000 })
      end)
  )",
                  110);
  J out = r.out();
  CHECK(out["det"].b());
  CHECK(out["differ"].b());
  CHECK(out["bad"].str() == "");
  CHECK(out["distinct"].num() == 200);
}

TEST_CASE("procgen: room-template stitching: 200 seeds, key reachable before the locked door, exit reachable through it, markers reported" *
          doctest::test_suite("slow")) {
  LuauRun r = run("local T = " + kTemplates + R"(
      local bad, markersTotal, bosses = {}, 0, 0
      local a = P.toTileMap(P.rooms({ templates = T, seed = 9 }))
      local b = P.toTileMap(P.rooms({ templates = T, seed = 9 }))
      local spawns = P.spawnList(P.rooms({ templates = T, seed = 9 }), { markers = { E = "enemy", T = "chest", B = "boss" }, tileSize = 16 })
      forTicks(200, 10, function(seed)
        local lv = P.rooms({ templates = T, seed = seed, rooms = 6, branches = 2 })
        local g = lv.grid
        local noDoor = function(c) return c ~= nil and c ~= "#" and c ~= "+" end
        local open = function(c) return c ~= nil and c ~= "#" end
        local pre = P.validate(g, { pass = noDoor, from = lv.start, targets = { lv.key }, requireAll = false })
        local exitBlocked = not P.validate(g, { pass = noDoor, from = lv.start, targets = { lv.exit }, requireAll = false }).ok
        local full = P.validate(g, { pass = open, from = lv.start, targets = { lv.exit } })
        if not (pre.ok and full.ok and exitBlocked) then table.insert(bad, seed) end
        markersTotal += #lv.markers
        for _, m in lv.markers do if m.char == "B" then bosses += 1 end end
      end, function()
        save.set("out", { bad = table.concat(bad, ","), det = a == b, markers = markersTotal, bosses = bosses, spawn1 = spawns[1] })
      end)
  )",
                  30);
  J out = r.out();
  CHECK(out["bad"].str() == "");
  CHECK(out["det"].b());
  CHECK(out["markers"].num() > 200 * 4);
  CHECK(out["bosses"].num() == 200);
  CHECK(std::fmod(out["spawn1"]["x"].num(), 16) == 8);
}

TEST_CASE("procgen: platformer chunks: difficulty ramp, deterministic, reachable") {
  LuauRun r = run(R"(
      local chunks = {
        { id = "start", grid = "........\n........\n........\n########", tags = { "start" } },
        { id = "flat", grid = "........\n........\n........\n########", difficulty = 1 },
        { id = "gap", grid = "........\n........\n........\n###..###", difficulty = 3 },
        { id = "step", grid = "........\n........\n....####\n########", difficulty = 4 },
        { id = "spikes", grid = "........\n........\n...##...\n##^^^^##", difficulty = 6 },
        { id = "pit", grid = "........\n...##...\n........\n##....##", difficulty = 8 },
        { id = "goal", grid = "........\n........\n........\n########", tags = { "end" } },
      }
      local bad = {}
      local mono = true
      for seed = 1, 100 do
        local s = P.chunks.sequence({ chunks = chunks, seed = seed, length = 8, from = 1, to = 8 })
        local r = P.chunks.reachable(s.grid, { jump = 3, run = 4 })
        if not r.ok then table.insert(bad, seed) end
        if s.difficulties[2] > s.difficulties[#s.difficulties - 1] then mono = false end
      end
      local a = P.chunks.sequence({ chunks = chunks, seed = 5 })
      local b = P.chunks.sequence({ chunks = chunks, seed = 5 })
      save.set("out", { bad = table.concat(bad, ","), mono = mono, det = P.toTileMap(a) == P.toTileMap(b), first = a.sequence[1], last = a.sequence[#a.sequence], height = a.height })
  )");
  J out = r.out();
  CHECK(out["bad"].str() == "");
  CHECK(out["mono"].b());
  CHECK(out["det"].b());
  CHECK(out["first"].str() == "start");
  CHECK(out["last"].str() == "goal");
}

TEST_CASE("procgen: loot tables: weights/rarity tier distribution, counts, nested tables, pity" *
          doctest::test_suite("slow")) {
  LuauRun r = run(R"(
      local tables = {
        gems = { entries = { { item = "ruby", weight = 1 }, { item = "opal", weight = 1 } } },
        chest = { id = "chest", rolls = 1, rarities = { common = 70, rare = 25, legendary = 5 },
          entries = { { item = "coin", rarity = "common", count = { 1, 5 } }, { item = "potion", rarity = "common" },
                      { item = "sword", rarity = "rare" }, { item = "crown", rarity = "legendary" } },
          guaranteed = { { table = "gems" } }, pity = { rarity = "legendary", after = 20 } },
      }
      local rng = P.rng(1)
      local n = { coin = 0, potion = 0, sword = 0, crown = 0, gem = 0 }
      local maxCoin, minCoin = 0, 99
      for i = 1, 20000 do
        for _, d in P.loot.roll(tables.chest, rng, { tables = tables }) do
          if d.item == "ruby" or d.item == "opal" then n.gem += 1 else n[d.item] += 1 end
          if d.item == "coin" then maxCoin = math.max(maxCoin, d.count) minCoin = math.min(minCoin, d.count) end
        end
      end
      -- pity: never more than 20 rolls without a legendary
      local state, gap, worst = {}, 0, 0
      local r2 = P.rng(2)
      for i = 1, 5000 do
        local got = false
        for _, d in P.loot.roll(tables.chest, r2, { tables = tables, state = state }) do if d.item == "crown" then got = true end end
        if got then gap = 0 else gap += 1 end
        worst = math.max(worst, gap)
      end
      local odds = P.loot.odds(tables.chest)
      save.set("out", { n = n, maxCoin = maxCoin, minCoin = minCoin, worst = worst, odds = odds })
  )");
  J out = r.out();
  const double N = 20000;
  CHECK(out["n"]["gem"].num() == N);
  CHECK_CLOSE(out["n"]["coin"].num() / N, 0.35, 1);
  CHECK_CLOSE(out["n"]["potion"].num() / N, 0.35, 1);
  CHECK_CLOSE(out["n"]["sword"].num() / N, 0.25, 1);
  CHECK(std::fabs(out["n"]["crown"].num() / N - 0.05) < 0.01);
  CHECK(out["minCoin"].num() == 1);
  CHECK(out["maxCoin"].num() == 5);
  CHECK(out["worst"].num() < 20);
  CHECK_CLOSE(out["odds"]["crown"].num(), 0.05, 5);
}

TEST_CASE("procgen: waves / encounters by budget; names; text templates") {
  LuauRun r = run(R"(
      local enemies = { { id = "rat", cost = 1 }, { id = "orc", cost = 3, minLevel = 3 }, { id = "ogre", cost = 6, minLevel = 5 } }
      local ws = P.waves.waves(enemies, { seed = 4, count = 8, budget = 4, growth = 1.4, boss = { id = "dragon", every = 4 } })
      local ok = true
      for _, w in ws do if w.cost > w.budget then ok = false end end
      local enc = P.waves.encounter(enemies, 10, 3, { level = 1 })
      local onlyRats = true
      for _, id in enc.ids do if id ~= "rat" then onlyRats = false end end
      local m = P.names.markov({ "aldric", "borin", "calen", "dorian", "elric", "fenwick", "garrick", "halden", "isolde", "jorund" })
      local n1, n2 = m.make(P.rng(3)), m.make(P.rng(3))
      save.set("out", { ok = ok, w1 = #ws[1].ids, w8 = #ws[8].ids, bossAt4 = ws[4].ids[#ws[4].ids], enc = #enc.ids, onlyRats = onlyRats,
        names = n1 == n2, nameLen = #n1, text = P.names.fill("The {adj} {noun}", { adj = { "Grim" }, noun = { "Keep" } }, 1) })
  )");
  J out = r.out();
  CHECK(out["ok"].b());
  CHECK(out["w8"].num() > out["w1"].num());
  CHECK(out["bossAt4"].str() == "dragon");
  CHECK(out["enc"].num() == 10);
  CHECK(out["onlyRats"].b());
  CHECK(out["names"].b());
  CHECK(out["nameLen"].num() >= 4);
  CHECK(out["text"].str() == "The Grim Keep");
}

TEST_CASE("procgen: puzzles: sokoban / sliding / lights-out are solvable at the requested difficulty (verified independently in C++)" *
          doctest::test_suite("slow")) {
  LuauRun r = run(R"(
      local soko, slide, lights = {}, {}, {}
      for seed = 1, 6 do
        local s = P.puzzle.sokoban({ seed = seed, w = 8, h = 8, boxes = 2, minPushes = 6, maxPushes = 18 })
        table.insert(soko, s and { text = s.text, pushes = s.pushes, moves = s.moves } or false)
        local t = P.puzzle.sliding({ seed = seed, n = 3, minMoves = 12, maxMoves = 18 })
        table.insert(slide, t and { board = t.board, moves = t.moves, path = t.path } or false)
        local l = P.puzzle.lightsOut({ seed = seed, w = 5, minPresses = 5, maxPresses = 9 })
        table.insert(lights, l and { text = l.text, presses = l.presses, solution = l.solution } or false)
      end
      local unsolvable = P.puzzle.solveSokoban("#####\n#.@$#\n#####")
      local parity = P.puzzle.solveSliding({ 2, 1, 3, 4, 5, 6, 7, 8, 0 }, 3)
      save.set("out", { soko = soko, slide = slide, lights = lights, dead = unsolvable.solvable, parity = parity.solvable })
  )");
  J out = r.out();
  CHECK(out["soko"].size() == 6);
  for (J s : out["soko"].values()) verify_sokoban(s);
  CHECK(out["slide"].size() == 6);
  for (J t : out["slide"].values()) verify_sliding(t);
  CHECK(out["lights"].size() == 6);
  for (J l : out["lights"].values()) verify_lights(l);
  CHECK(out["dead"].is_bool());
  CHECK_FALSE(out["dead"].b());
  CHECK(out["parity"].is_bool());
  CHECK_FALSE(out["parity"].b());
}

// ---------------------------------------------------------------- kit-roguelike-demo

TEST_CASE("procgen: kit-roguelike-demo: content comes from data/ through the engine reader (procgen.content), no generated module") {
  CHECK_FALSE(repo_exists(std::string(kRoguelike) + "/scripts/shared/content.luau"));
  // TS copies only data/. The C++ loader validates the package, and data/tilesets reference
  // assets/*, so the assets come along too (they don't affect what procgen.content() reads).
  FileMap data;
  for (const auto& [path, bytes] : read_dir(kRoguelike))
    if (path.rfind("data/", 0) == 0 || path.rfind("assets/", 0) == 0) data[path] = bytes;
  LuauOptions o;
  o.kits = {"procgen", "ai", "combat"};
  o.files = data;
  o.budget_ms = budget(5000);
  LuauRun r = run_luau(R"(local P = require("@kit/procgen")
      local c = P.content()
      local n = function(t) local k = 0 for _ in t do k += 1 end return k end
      save.set("out", { enemies = n(c.enemies), loot = n(c.loot), rooms = n(c.rooms), start = c.rooms.start_hall, ogre = c.enemies.ogre.id }))",
                       o);
  CHECK_MESSAGE(r.errors.empty(), join(r.errors));
  J out = r.out();
  CHECK(out["rooms"].num() == 7);
  CHECK(out["loot"].num() == 4);
  CHECK(out["enemies"].num() > 0);
  CHECK(out["ogre"].str() == "ogre");
  CHECK_FALSE(matches(out["start"].str(), R"(\n$)"));
}

// TS: for (const seed of [1, 2, 3, 4, 5]) it(`bot run, engine seed ${seed}: ...`). One doctest
// subcase per seed keeps each seed's failure separate.
TEST_CASE("procgen: kit-roguelike-demo: bot run, engine seeds 1-5: zero script errors, floors descend, combat + loot happen" *
          doctest::test_suite("slow")) {
  for (uint32_t seed = 1; seed <= 5; ++seed) {
    SUBCASE(("engine seed " + std::to_string(seed)).c_str()) {
      script::HostOptions o;
      o.seed = seed;
      o.budget_ms = budget(250);  // TS default; scaled for the sanitizer build
      Game g = start(bot_package(), o);
      g.step(60 * 120);
      CHECK_NO_ERRORS(g);
      std::vector<std::string> warnings;
      for (const auto& l : g->logs())
        if (l.level == "warn" || l.level == "error") warnings.push_back(l.text);
      CHECK_MESSAGE(warnings.empty(), join(warnings));
      int max_floor = -1;
      std::vector<std::string> floors = g.logs_with("floor ");
      for (const std::string& f : floors) max_floor = std::max(max_floor, std::atoi(f.c_str()));
      MESSAGE("seed " << seed << ": max floor " << max_floor << ", " << floors.size() << " floors built, deaths "
                      << g.logs_with("died").size());
      CHECK(max_floor >= 3);  // stairs work, floors 1-3 (rooms, dungeon, caves + boss)
    }
  }
}

}  // TEST_SUITE
