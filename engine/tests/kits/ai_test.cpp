// ai kit: behaviours simulated headless (AI.step pure agents + attach on real entities), A*, LOS.
// Port of engine-web/test/kits/ai.test.ts (same scripts and thresholds).
#include "kits/kit_test.h"

using namespace dreamsy;
using namespace dreamsy::test;

namespace {

// Shared Luau helpers: a seeded rnd(), dist(), sim() (run a brain at 60 Hz, collect action names), count().
const std::string kPre = R"(local AI = require("@kit/ai")
local seed = 11
local function rnd() seed = (seed * 48271) % 2147483647 return seed / 2147483647 end
local function dist(a, b) return math.sqrt((a.x - b.x)^2 + (a.y - b.y)^2) end
-- run brain for n seconds at 60 Hz; returns actions list
local function sim(brain, agent, world, secs)
  world.rand = rnd
  local acts = {}
  for i = 1, math.floor(secs * 60) do
    for _, a in AI.step(brain, agent, world, 1/60) do table.insert(acts, a.name) end
  end
  return acts
end
local function count(list, name) local n = 0 for _, v in list do if v == name then n += 1 end end return n end
)";

// 20x12 room; wall column at x=10 from y=0..8 (gap at bottom rows 9-10). Rows joined by a literal
// backslash-n, so it can sit inside a Luau string literal.
const std::string kRoomRows[] = {
    "####################", "#.........#........#", "#.........#........#", "#.........#........#",
    "#.........#........#", "#.........#........#", "#.........#........#", "#.........#........#",
    "#.........#........#", "#..................#", "#..................#", "####################",
};
std::string room(const std::string& sep) {
  std::string s;
  for (const std::string& row : kRoomRows) s += (s.empty() ? "" : sep) + row;
  return s;
}
const std::string kRoom = room("\\n");

// Replaces every "${ROOM}" in a script with the room text (the TS template substitution).
std::string with_room(std::string src) {
  for (size_t at = src.find("${ROOM}"); at != std::string::npos; at = src.find("${ROOM}", at + kRoom.size()))
    src.replace(at, 7, kRoom);
  return src;
}

// TS run(): the snippet runs after kPre with only the ai kit; it must not raise.
LuauRun run(const std::string& src) {
  LuauOptions o;
  o.kits = {"ai"};
  LuauRun r = run_luau(kPre + with_room(src), o);
  CHECK_MESSAGE(r.errors.empty(), join(r.errors));
  return r;
}

}  // namespace

TEST_SUITE("kit ai") {

TEST_CASE("ai: A* on grids (4/8-dir, no corner cutting, unreachable), graphs, line of sight") {
  LuauRun r = run(R"(
      local g = AI.grid("${ROOM}", { tileSize = 16 })
      local p = g:find(2, 2, 15, 2)
      local d = AI.grid("${ROOM}", { diagonal = true }):find(2, 2, 15, 2)
      local blocked = AI.grid("#####\n#.#.#\n#####"):find(1, 1, 3, 1)
      local near = AI.grid("#####\n#.#.#\n#####"):find(1, 1, 3, 1, { nearest = true })
      local corner = AI.grid("....\n.#..\n....", { diagonal = true }):find(0, 0, 2, 2)
      local ids, cost = AI.graphPath({ a = { x = 0, y = 0, links = { "b", "c" } }, b = { x = 10, y = 0, links = { "d" } }, c = { x = 0, y = 50, links = { "d" } }, d = { x = 20, y = 0, links = {} } }, "a", "d")
      local wcost = select(2, AI.graphPath({ a = { links = { b = 5, c = 1 } }, b = { links = { d = 1 } }, c = { links = { d = 1 } }, d = { links = {} } }, "a", "d"))
      save.set("out", {
        len = #p, passesGap = (function() for _, c in p do if c.x == 10 then return c.y >= 9 end end return false end)(),
        dlen = #d, blocked = blocked == nil, nearLen = #near,
        cornerOk = (function() for i = 2, #corner do local a, b = corner[i-1], corner[i] if a.x ~= b.x and a.y ~= b.y and (a.x == 1 and a.y == 0 or b.x == 1 and b.y == 1) then return false end end return true end)(),
        graph = table.concat(ids, ""), wcost = wcost,
        los1 = g:los(40, 40, 120, 40), los2 = g:los(40, 40, 220, 40), los3 = g:losCells(2, 9, 15, 9),
      })
  )");
  J out = r.out();
  CHECK(out["len"].num() == 28);  // manhattan via the gap: 7 down + 13 right + 7 up = 27 steps (+ start)
  CHECK(out["passesGap"].b());
  CHECK(out["dlen"].num() < out["len"].num());
  CHECK(out["blocked"].b());
  CHECK(out["nearLen"].num() == 1);
  CHECK(out["cornerOk"].b());
  CHECK(out["graph"].str() == "abd");
  CHECK(out["wcost"].num() == 2);
  CHECK(out["los1"].b());
  CHECK_FALSE(out["los2"].b());
  CHECK(out["los3"].b());
}

TEST_CASE("ai: idle / wander / patrol (points + platformer turn-at-wall)") {
  LuauRun r = run(R"(
      local idle = { x = 50, y = 50 }
      sim(AI.brain("idle"), idle, {}, 2)
      local w = { x = 100, y = 100 }
      local maxD, moved = 0, 0
      local b = AI.brain({ behavior = "wander", radius = 40, speed = 50 })
      for i = 1, 600 do
        local px, py = w.x, w.y
        AI.step(b, w, { rand = rnd }, 1/60)
        moved += math.abs(w.x - px) + math.abs(w.y - py)
        maxD = math.max(maxD, dist(w, w.home))
      end
      local pa = { x = 0, y = 0 }
      local pb = AI.brain({ behavior = "patrol", points = { {100, 0}, {100, 100}, {0, 100} }, speed = 100, wait = 0 })
      local visited = {}
      for i = 1, 60 * 6 do
        AI.step(pb, pa, {}, 1/60)
        for k, pt in { {100,0}, {100,100}, {0,100} } do if math.abs(pa.x - pt[1]) < 5 and math.abs(pa.y - pt[2]) < 5 and visited[#visited] ~= k then table.insert(visited, k) end end
      end
      local g = AI.grid("${ROOM}")
      local plat = { x = 40, y = 40, radius = 6 }
      local xs = {}
      local plb = AI.brain({ behavior = "patrol", distance = 1000, speed = 80 })
      local minX, maxX = 1e9, -1e9
      for i = 1, 60 * 6 do AI.step(plb, plat, { grid = g, mode = "platformer" }, 1/60) minX = math.min(minX, plat.x) maxX = math.max(maxX, plat.x) end
      save.set("out", { idle = { idle.x, idle.y }, maxD = maxD, moved = moved, visited = table.concat(visited, ","), minX = minX, maxX = maxX })
  )");
  J out = r.out();
  CHECK(out["idle"].dump() == "[50,50]");
  CHECK(out["moved"].num() > 50);
  CHECK(out["maxD"].num() < 48);
  CHECK(out["visited"].str().rfind("1,2,3,1", 0) == 0);
  CHECK(out["maxX"].num() < 160);  // turned at the wall column (x = 160..176)
  CHECK(out["minX"].num() < 30);   // and at the left wall
}

TEST_CASE("ai: chase: aggro radius, pathfinds around walls, leash returns home; flee runs away") {
  LuauRun r = run(R"(
      local g = AI.grid("${ROOM}")
      local far = { x = 40, y = 40 }
      sim(AI.brain({ behavior = "chase", aggro = 50 }), far, { target = { x = 140, y = 40 } }, 2)
      local c = { x = 40, y = 40 }
      local target = { x = 260, y = 40 }   -- behind the wall: needs the gap at the bottom
      local acts = sim(AI.brain({ behavior = "chase", aggro = 400, speed = 90, forget = 99 }), c, { target = target, grid = g, sight = false }, 8)
      local l = { x = 40, y = 40 }
      local lb = AI.brain({ behavior = "chase", aggro = 1000, leash = 60, speed = 90 })
      sim(lb, l, { target = { x = 140, y = 150 } }, 1.5)
      local leashed = dist(l, l.home)
      sim(lb, l, { target = nil }, 2)
      local f = { x = 100, y = 100 }
      sim(AI.brain({ behavior = "flee", range = 200, speed = 60 }), f, { target = { x = 90, y = 100 } }, 1)
      save.set("out", { far = { far.x, far.y }, reach = dist(c, target), aggro = count(acts, "aggro"), leashed = leashed, back = dist(l, l.home), flee = f.x })
  )");
  J out = r.out();
  CHECK(out["far"].dump() == "[40,40]");
  CHECK(out["reach"].num() < 12);
  CHECK(out["aggro"].num() == 1);
  CHECK(out["leashed"].num() < 80);
  CHECK(out["back"].num() < 8);
  CHECK(out["flee"].num() > 150);
}

TEST_CASE("ai: keep_distance (ranged), charge, jump_at, swoop, turret (LOS), spawner (max)") {
  LuauRun r = run(R"(
      local g = AI.grid("${ROOM}")
      local r = { x = 80, y = 152 }
      local tgt = { x = 60, y = 152 }
      local racts = sim(AI.brain({ behavior = "keep_distance", min = 60, max = 100, speed = 80, fireEvery = 1 }), r, { target = tgt, grid = g }, 4)
      local rd = dist(r, tgt)
      local ch = { x = 40, y = 40 }
      local cb = AI.brain({ behavior = "charge", range = 150, windup = 0.5, speed = 300, duration = 0.3 })
      local seq, maxV = {}, 0
      for i = 1, 90 do
        for _, a in AI.step(cb, ch, { target = { x = 140, y = 40 }, rand = rnd }, 1/60) do table.insert(seq, a.name) end
        maxV = math.max(maxV, math.abs(ch.vx))
      end
      local j = { x = 40, y = 100, onFloor = true }
      local jacts = AI.step(AI.brain({ behavior = "jump_at", range = 200, jump = 300 }), j, { target = { x = 120, y = 100 }, mode = "platformer", rand = rnd }, 1/60)
      local s = { x = 100, y = 20 }
      local sb = AI.brain({ behavior = "swoop", hover = 60, every = 1.5, swoopSpeed = 250 })
      local minY, maxY, sw = 1e9, -1e9, 0
      for i = 1, 60 * 3 do
        for _, a in AI.step(sb, s, { target = { x = 100, y = 150 }, rand = rnd }, 1/60) do if a.name == "swoop" then sw += 1 end end
        if i < 80 then minY = math.min(minY, s.y) end
        maxY = math.max(maxY, s.y)
      end
      local t1 = { x = 40, y = 40 }
      local shotsSeen = count(sim(AI.brain({ behavior = "turret", range = 300, fireEvery = 0.5 }), t1, { target = { x = 120, y = 40 }, grid = g }, 2.1), "shoot")
      local shotsWall = count(sim(AI.brain({ behavior = "turret", range = 300, fireEvery = 0.5 }), { x = 40, y = 40 }, { target = { x = 260, y = 40 }, grid = g }, 2.1), "shoot")
      local alive = 0
      local spActs = sim(AI.brain({ behavior = "spawner", every = 0.5, max = 3, spawn = "bat" }), { x = 0, y = 0 }, { children = function() return alive end }, 0.1)
      local spawns = 0
      local sp = AI.brain({ behavior = "spawner", every = 0.5, max = 3, spawn = "bat" })
      local ag = { x = 0, y = 0 }
      for i = 1, 60 * 5 do for _, a in AI.step(sp, ag, { children = function() return alive end, rand = rnd }, 1/60) do if a.name == "spawn" then spawns += 1 alive += 1 end end end
      save.set("out", { rd = rd, rshots = count(racts, "shoot"), seq = table.concat(seq, ","), maxV = maxV, jump = jacts[1] and jacts[1].name, jvy = j.vy,
        hoverY = minY, diveY = maxY, swoops = sw, t1 = { t1.x, t1.y }, shotsSeen = shotsSeen, shotsWall = shotsWall, spawns = spawns })
  )");
  J out = r.out();
  CHECK(out["rd"].num() >= 55);
  CHECK(out["rd"].num() <= 105);
  CHECK(out["rshots"].num() >= 3);
  CHECK(out["seq"].str().rfind("telegraph,charge", 0) == 0);
  CHECK(out["maxV"].num() == 300);
  CHECK(out["jump"].str() == "jump");
  CHECK(out["jvy"].num() < -250);
  CHECK(out["hoverY"].num() < 60);
  CHECK(out["diveY"].num() > 130);
  CHECK(out["swoops"].num() >= 1);
  CHECK(out["t1"].dump() == "[40,40]");
  CHECK(out["shotsSeen"].num() == 4);
  CHECK(out["shotsWall"].num() == 0);
  CHECK(out["spawns"].num() == 3);
}

TEST_CASE("ai: boss phases by hp threshold + pattern sequences; FSM transitions; utility selection") {
  LuauRun r = run(R"(
      local boss = AI.brain({ behavior = "boss", phases = {
        { hp = 1.0, pattern = { { action = "ring", count = 8, wait = 0.5 }, { behavior = "chase", time = 1, aggro = 999 } } },
        { hp = 0.5, pattern = { { action = "summon", wait = 0.3 }, { action = "slam", wait = 0.3 } } },
      } })
      local b = { x = 0, y = 0, hp = 100, maxHp = 100 }
      local acts = sim(boss, b, { target = { x = 50, y = 0 } }, 2)
      b.hp = 40
      local acts2 = sim(boss, b, { target = { x = 50, y = 0 } }, 1.3)
      local fsm = AI.brain({ fsm = { start = "idle", states = { idle = { behavior = "idle" }, chase = { behavior = "chase", aggro = 100, speed = 60 } },
        transitions = { { from = "idle", to = "chase", when = "near:80" }, { from = "chase", to = "idle", when = "far:150" } } } })
      local a = { x = 0, y = 0 }
      sim(fsm, a, { target = { x = 200, y = 0 } }, 0.5)
      local s1 = fsm.state
      sim(fsm, a, { target = { x = 60, y = 0 } }, 0.2)
      local s2 = fsm.state
      sim(fsm, a, { target = { x = 400, y = 0 } }, 0.2)
      local s3 = fsm.state
      local u = AI.brain({ utility = { { behavior = "chase", aggro = 999, score = "target_near" }, { behavior = "flee", range = 999, score = "hp_low", weight = 2 } } })
      local ua = { x = 0, y = 0, hp = 100, maxHp = 100 }
      sim(u, ua, { target = { x = 100, y = 0 } }, 0.5)
      local x1 = ua.x
      ua.hp = 10
      sim(u, ua, { target = { x = 100, y = 0 } }, 1)
      save.set("out", { acts = table.concat(acts, ","), acts2 = table.concat(acts2, ","), s = { s1, s2, s3 }, chaseX = x1, fleeX = ua.x })
  )");
  J out = r.out();
  CHECK(out["acts"].str().rfind("phase,ring,aggro", 0) == 0);
  CHECK(out["acts2"].str() == "phase,summon,slam,summon,slam,summon");
  CHECK(out["s"].strs() == std::vector<std::string>{"idle", "chase", "idle"});
  CHECK(out["chaseX"].num() > 5);
  CHECK(out["fleeX"].num() < out["chaseX"].num());
}

TEST_CASE("ai: attach: a Body2D enemy chases the player entity around a TileMap2D wall; stops when destroyed") {
  // The scene's TileMap2D holds the room with real newlines (JSON-escaped as \n).
  LuauOptions o;
  o.kits = {"ai"};
  o.steps = 401;
  o.files = {
      {"data/tilesets/t.json", R"({"tiles":{"#":{"color":"#333333","solid":true}}})"},
      {"scenes/main.scene.json",
       R"({"format":"0","root":"root","entities":{"root":{"type":"Node2D","children":["map"]},)"
       R"("map":{"type":"TileMap2D","props":{"tileset":"data/tilesets/t.json","data":")" + room("\\n") + R"("}}}})"},
  };
  LuauRun r = run_luau(R"(
      local AI = require("@kit/ai")
      local map = entity("map")
      local hero = spawn("Body2D", { position = vec2(264, 40), body = "static", size = vec2(10, 10) })
      hero:addTag("player")
      local foe = spawn("Body2D", { position = vec2(40, 40), body = "dynamic", gravity_scale = 0, lock_rotation = true, size = vec2(10, 10) })
      local ctl = AI.attach(foe, { behavior = "chase", aggro = 400, speed = 120, forget = 99 }, { grid = map, solid = "#", sight = false })
      local n = 0
      onTick(function()
        n += 1
        if n == 400 then save.set("out", { d = (foe.position - hero.position):length() }) end
      end)
  )",
                       o);
  CHECK_MESSAGE(r.errors.empty(), join(r.errors));
  CHECK(r.out()["d"].num() < 20);
}

}  // TEST_SUITE
