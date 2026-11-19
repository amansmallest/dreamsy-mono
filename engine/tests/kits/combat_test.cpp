// combat kit: damage pipeline, crits, status effects, projectiles, melee, the turn-based formula,
// fighter visuals and Body2D fighters, headless through real Luau. Port of
// engine-web/test/kits/combat.test.ts (same scripts, same numbers).
#include "kits/kit_test.h"

using namespace dreamsy;
using namespace dreamsy::test;

namespace {

// TS run(): the combat kit in manual mode with a seeded Lehmer RNG, then `src`; returns the run
// (its out() is what the snippet stored with save.set("out", ...)).
LuauRun run(const std::string& src, int steps = 1) {
  LuauOptions o;
  o.kits = {"combat"};
  o.steps = steps;
  LuauRun r = run_luau(
      "local C = require(\"@kit/combat\")\n"
      "C.setup({ manual = true, rand = (function() local s = 7 return function() s = (s * 48271) % 2147483647 return s / 2147483647 end end)() })\n" +
          src,
      o);
  CHECK_MESSAGE(r.errors.empty(), join(r.errors));
  return r;
}

}  // namespace

TEST_SUITE("kit combat") {

TEST_CASE("combat: damage pipeline: types, resistances, weakness, immunity, armor, shields, min damage") {
  LuauRun r = run(R"(
      local t = C.add(nil, { hp = 100, armor = 2, resist = { fire = 0.5, ice = -0.5, poison = 1 }, shield = 5, team = "enemy" })
      local a = C.damage(t, { amount = 10, type = "physical", source = "player" })   -- 10-2 = 8; shield 5 absorbs
      local b = C.damage(t, { amount = 10, type = "fire", source = "player" })       -- 5-2 = 3
      local c = C.damage(t, { amount = 10, type = "ice", source = "player" })        -- 15-2 = 13
      local d = C.damage(t, { amount = 10, type = "poison", source = "player" })     -- immune
      local e = C.damage(t, { amount = 1, source = "player" })                       -- 1-2 -> min 1
      local f = C.damage(t, { amount = 10, source = "enemy" })                       -- same team: blocked
      save.set("out", { a = {a.dealt, a.absorbed}, b = b.dealt, c = c.dealt, d = d.blocked, e = e.dealt, f = f.blocked, hp = t.hp })
    )");
  J out = r.out();
  CHECK(out["a"].dump() == "[3,5]");
  CHECK(out["b"].num() == 3);
  CHECK(out["c"].num() == 13);
  CHECK(out["d"].str() == "immune");
  CHECK(out["e"].num() == 1);
  CHECK(out["f"].str() == "team");
  CHECK(out["hp"].num() == 100 - 3 - 3 - 13 - 1);
}

TEST_CASE("combat: crits, i-frames, knockback (entity-less), death + loot drop + respawn") {
  LuauRun r = run(R"(
      local p = C.add(nil, { hp = 20, team = "player", iframes = 0.5, x = 0, y = 0, respawn = { delay = 1, x = 5, y = 5 } })
      local src = C.add(nil, { team = "enemy", x = -10, y = 0, critChance = 1, critMult = 3 })
      local a = C.damage(p, { amount = 2, source = src, knockback = 100 })
      local b = C.damage(p, { amount = 2, source = src })
      local busy = p:busy()
      for i = 1, 32 do C.update(1/60) end   -- 0.5 s: iframes over
      local moved = p.x
      local c = C.damage(p, { amount = 50, source = src, crit = false })
      local deaths, drops, respawned = 0, nil, false
      C.on("death", function() deaths += 1 end)
      local e = C.add(nil, { hp = 1, team = "enemy", x = 3, y = 4, loot = { rolls = 2, entries = { { item = "coin", count = {2, 2} } } } })
      C.on("drop", function(d, x, y) drops = { d[1].item, d[1].count, #d, x, y } end)
      C.on("respawn", function(f) respawned = f == p end)
      C.damage(e, { amount = 5, source = "player" })
      for i = 1, 70 do C.update(1/60) end
      save.set("out", { a = { a.dealt, a.crit }, b = b.blocked, busy = busy, moved = moved, cKilled = c.killed, deaths = deaths, drops = drops, respawned = respawned, hp = p.hp, pos = { p.x, p.y } })
    )");
  J out = r.out();
  CHECK(out["a"].dump() == "[6,true]");
  CHECK(out["b"].str() == "iframes");
  CHECK(out["busy"].b());
  CHECK(out["moved"].num() > 14);  // 100 px/s for ~0.15 s
  CHECK(out["moved"].num() < 18);
  CHECK(out["cKilled"].b());
  CHECK(out["deaths"].num() == 1);  // enemy (player died before the listener)
  CHECK(out["drops"].dump() == R"(["coin",4,1,3,4])");  // procgen.loot merges drops by item (2 rolls x 2)
  CHECK(out["respawned"].b());
  CHECK(out["hp"].num() == 20);
  CHECK(out["pos"].dump() == "[5,5]");
}

TEST_CASE("combat: status effects: burn stacks tick, poison ignores armor, slow, stun busy + immunity window, freeze breaks on hit") {
  LuauRun r = run(R"(
      local t = C.add(nil, { hp = 100, armor = 1 })
      C.applyStatus(t, "burn")             -- 2 dmg/0.5s/stack, -1 armor = 1
      C.applyStatus(t, "burn")             -- 2 stacks: 4-1 = 3 per tick
      for i = 1, 62 do C.update(1/60) end  -- ~1 s => 2 ticks (t=0.5, 1.0)
      local afterBurn = t.hp
      local stacks = t:stacks("burn")
      local p = C.add(nil, { hp = 100, armor = 5 })
      C.applyStatus(p, "poison", { stacks = 3 })   -- 3/s, ignores armor
      for i = 1, 121 do C.update(1/60) end
      local poisonHp = p.hp
      local s = C.add(nil, { hp = 10 })
      C.applyStatus(s, "slow")
      local slowMult = s:speedMult()
      C.applyStatus(s, "stun")
      local busy = s:busy()
      for i = 1, 60 do C.update(1/60) end
      local stunOver = not s:hasStatus("stun")
      local again = C.applyStatus(s, "stun")       -- inside immuneAfter window
      local fz = C.add(nil, { hp = 50 })
      C.applyStatus(fz, "freeze")
      local frozen = fz:busy()
      local hit = C.damage(fz, { amount = 4, source = "player" })  -- x1.25 => 5, breaks freeze
      save.set("out", { afterBurn = afterBurn, stacks = stacks, poison = poisonHp, slow = slowMult, busy = busy, stunOver = stunOver, again = again == nil, frozen = frozen, fzDealt = hit.dealt, fzFree = not fz:busy() })
    )");
  J out = r.out();
  CHECK(out["afterBurn"].num() == 94);
  CHECK(out["stacks"].num() == 2);
  CHECK(out["poison"].num() == 94);
  CHECK(out["slow"].num() == 0.5);
  CHECK(out["busy"].b());
  CHECK(out["stunOver"].b());
  CHECK(out["again"].b());
  CHECK(out["frozen"].b());
  CHECK(out["fzDealt"].num() == 5);
  CHECK(out["fzFree"].b());
}

TEST_CASE("combat: projectiles: travel, hit hostile only, pierce, lifetime, walls, homing") {
  LuauRun r = run(R"(
      local a = C.add(nil, { hp = 10, team = "enemy", x = 50, y = 0, radius = 6 })
      local b = C.add(nil, { hp = 10, team = "enemy", x = 80, y = 0, radius = 6 })
      local ally = C.add(nil, { hp = 10, team = "player", x = 20, y = 0, radius = 6 })
      local p1 = C.shoot({ x = 0, y = 0, dx = 1, dy = 0, speed = 300, amount = 3, source = "player", pierce = 1, visual = false })
      for i = 1, 30 do C.update(1/60) end
      local p2 = C.shoot({ x = 0, y = 100, angle = 0, speed = 100, lifetime = 0.5, amount = 1, source = "player", visual = false })
      for i = 1, 31 do C.update(1/60) end
      local p3 = C.shoot({ x = 0, y = 200, dx = 1, dy = 0, speed = 100, source = "player", visual = false, solid = function(x, y) return x > 20 end })
      for i = 1, 20 do C.update(1/60) end
      local h = C.add(nil, { hp = 10, team = "enemy", x = 100, y = 300, radius = 6 })
      local p4 = C.shoot({ x = 0, y = 260, dx = 1, dy = 0, speed = 150, homing = 270, amount = 2, source = "player", visual = false })
      for i = 1, 90 do C.update(1/60) end
      save.set("out", { a = a.hp, b = b.hp, ally = ally.hp, p1 = p1.done, p2 = { p2.done, math.floor(p2.x) }, p3 = { p3.done, math.floor(p3.x) }, homed = h.hp, live = #C.projectiles() })
    )");
  J out = r.out();
  CHECK(out["a"].num() == 7);
  CHECK(out["b"].num() == 7);
  CHECK(out["ally"].num() == 10);
  CHECK(out["p1"].b());
  CHECK(out["p2"][0].b());
  CHECK(out["p2"][1].num() >= 49);
  CHECK(out["p3"].dump() == "[true,21]");
  CHECK(out["homed"].num() == 8);
  CHECK(out["live"].num() == 0);
}

TEST_CASE("combat: melee arcs, lingering hitboxes, contact damage, teams config") {
  LuauRun r = run(R"(
      local hero = C.add(nil, { hp = 10, team = "player", x = 0, y = 0, iframes = 0 })
      local front = C.add(nil, { hp = 10, team = "enemy", x = 20, y = 0, radius = 4 })
      local behind = C.add(nil, { hp = 10, team = "enemy", x = -20, y = 0, radius = 4 })
      local far = C.add(nil, { hp = 10, team = "enemy", x = 60, y = 0, radius = 4 })
      local hits = C.swing(hero, { range = 24, arc = 90, angle = 0, amount = 4 })
      local hb = C.hitbox({ x = -20, y = 0, radius = 6, duration = 1, every = 0.25, amount = 1, source = hero })
      for i = 1, 60 do C.update(1/60) end
      local spiky = C.add(nil, { hp = 5, team = "enemy", x = 0, y = 8, radius = 4, contact = { amount = 2 } })
      C.update(1/60)
      C.setup({ teams = { player = { "enemy" }, enemy = {} } })
      local blocked = C.damage(hero, { amount = 1, source = front })
      save.set("out", { n = #hits, front = front.hp, behind = behind.hp, far = far.hp, hero = hero.hp, blocked = blocked.blocked })
    )");
  J out = r.out();
  CHECK(out["n"].num() == 1);
  CHECK(out["front"].num() == 6);
  CHECK(out["behind"].num() == 6);  // 4 ticks of the lingering hitbox (0, .25, .5, .75)
  CHECK(out["far"].num() == 10);
  CHECK(out["hero"].num() == 8);
  CHECK(out["blocked"].str() == "team");
}

TEST_CASE("combat: turn-based formula: type chart, deterministic damage, turn order") {
  LuauRun r = run(R"(
      local F = C.formula
      local tc = F.typeChart({ fire = { grass = 2, water = 0.5 }, water = { fire = 2 } })
      local r = (function() local s = 3 return function() s = (s * 48271) % 2147483647 return s / 2147483647 end end)()
      local d1 = F.damage({ power = 40, attack = 20, defense = 10, level = 10, typeMult = tc.mult("fire", { "grass" }), crit = false, rand = function() return 0.999 end })
      local d2 = F.damage({ power = 40, attack = 20, defense = 10, level = 10, typeMult = tc.mult("fire", "water"), crit = false, rand = function() return 0.999 end })
      local d0 = F.damage({ power = 40, attack = 20, defense = 10, typeMult = 0, crit = false })
      local order = F.turnOrder({ { id = "a", speed = 3 }, { id = "b", speed = 9 }, { id = "c", speed = 3 } })
      save.set("out", { d1 = d1, d2 = d2, d0 = d0, label = tc.label(2), order = { order[1].id, order[2].id, order[3].id }, sub = (F.damage({ style = "subtract", attack = 5, power = 3, defense = 2, variance = 0, crit = false })) })
    )");
  J out = r.out();
  // ((2*10/5+2)*40*20/10)/50+2 = 11.6 -> x2 = 23.2 (variance roll ~1)
  CHECK(out["d1"].num() == 23);
  CHECK(out["d2"].num() == 5);
  CHECK(out["d0"].num() == 0);
  CHECK(out["label"].str() == "super effective");
  CHECK(out["order"].strs() == std::vector<std::string>{"b", "a", "c"});
  CHECK(out["sub"].num() == 6);
}

TEST_CASE("combat: per-fighter flash/tint, i-frame blink on a Sprite2D fighter, absorbOnly heroes, projectile update hook") {
  LuauRun r = run(R"(
      C.defineStatus("shock", { duration = 2, tint = "#ffee55" })
      local function hex(s) local c = s.modulate return string.format("%.2f,%.2f,%.2f", c.r, c.g, c.b) end
      -- the fighter's entity IS the sprite: flash with its own colour, blink toggles the entity itself
      local spr = spawn("Sprite2D", { position = vec2(0, 0), size = vec2(10, 10) })
      local hero = C.add(spr, { hp = 10, team = "player", iframes = 0.5, flash = "#00ff00" })
      C.damage(hero, { amount = 1, source = "enemy" })
      local flashCol = hex(spr)
      local blinked = false
      for i = 1, 20 do C.update(1/60) if not spr.visible then blinked = true end end
      for i = 1, 20 do C.update(1/60) end
      local visibleAfter, colAfter = spr.visible, hex(spr)
      -- flash = false on one fighter while the global flash stays on; tint = false ignores status tints
      local quiet = spawn("Sprite2D", { size = vec2(10, 10) })
      local q = C.add(quiet, { hp = 10, flash = false, tint = false })
      C.damage(q, { amount = 1, source = "player" })
      C.applyStatus(q, "shock")
      local quietCol = hex(quiet)
      local loud = spawn("Sprite2D", { size = vec2(10, 10) })
      local l = C.add(loud, { hp = 10 })
      C.damage(l, { amount = 1, source = "player" })
      local loudCol = hex(loud)
      -- death mid-blink restores visibility
      local d = spawn("Sprite2D", { size = vec2(10, 10) })
      local df = C.add(d, { hp = 3, team = "player", iframes = 1, destroyOnDeath = false })
      C.damage(df, { amount = 1, source = "enemy" })
      for i = 1, 3 do C.update(1/60) end
      df:kill()
      local deadVisible = d.visible
      -- absorbOnly: hit + i-frame events, hp untouched, never dies
      local hits, sim = 0, 5
      local ab = C.add(nil, { team = "player", iframes = 0.3, absorbOnly = true, armor = 1 })
      local conn = C.on("hit", function(info) if info.target == ab then hits += 1 sim -= info.dealt end end)
      local a1 = C.damage(ab, { amount = 3, source = "enemy" })
      local a2 = C.damage(ab, { amount = 3, source = "enemy" })   -- i-frames
      for i = 1, 20 do C.update(1/60) end
      local a3 = C.damage(ab, { amount = 100, source = "enemy" })
      conn.disconnect()
      -- update hook: constant turn rate curves the bullet; p:cancel() from the hook stops it cleanly
      local p = C.shoot({ x = 0, y = 0, dx = 1, dy = 0, speed = 100, lifetime = 5, source = "neutral", visual = false,
        update = function(p, dt)
          local a = math.atan2(p.vy, p.vx) + math.rad(90) * dt
          p.vx, p.vy = math.cos(a) * p.speed, math.sin(a) * p.speed
        end })
      for i = 1, 60 do C.update(1/60) end
      local ages, px, py = p.age, p.x, p.y
      local k = C.shoot({ x = 0, y = 0, dx = 1, dy = 0, speed = 100, source = "neutral", visual = false,
        update = function(p) if p.age > 0.1 then p:cancel() end end })
      for i = 1, 30 do C.update(1/60) end
      save.set("out", { flashCol = flashCol, blinked = blinked, visibleAfter = visibleAfter, colAfter = colAfter, quietCol = quietCol, loudCol = loudCol,
        deadVisible = deadVisible, hits = hits, sim = sim, a1 = { a1.dealt, a1.absorbOnly, a1.killed }, a2 = a2.blocked, a3 = { a3.dealt, a3.killed },
        abHp = ab.hp, abDead = ab.dead, px = px, py = py, age = ages, kDone = k.done, kx = k.x, live = #C.projectiles() })
    )");
  J out = r.out();
  CHECK(out["flashCol"].str() == "0.00,1.00,0.00");
  CHECK(out["blinked"].b());
  CHECK(out["visibleAfter"].b());
  CHECK(out["colAfter"].str() == "1.00,1.00,1.00");
  CHECK(out["quietCol"].str() == "1.00,1.00,1.00");
  CHECK(out["loudCol"].str() != "1.00,1.00,1.00");
  CHECK(out["deadVisible"].b());
  CHECK(out["hits"].num() == 2);
  CHECK(out["sim"].num() == 5 - 2 - 99);
  CHECK(out["a1"].dump() == "[2,true,false]");
  CHECK(out["a2"].str() == "iframes");
  CHECK(out["a3"].dump() == "[99,false]");
  CHECK(out["abHp"].num() == 10);
  CHECK(out["abDead"].is_bool());
  CHECK_FALSE(out["abDead"].b());
  // quarter circle of radius 100/(pi/2) ≈ 63.7: ends near (63.7, 63.7) heading down
  CHECK(out["px"].num() > 60);
  CHECK(out["px"].num() < 67);
  CHECK(out["py"].num() > 60);
  CHECK(out["py"].num() < 67);
  CHECK_CLOSE(out["age"].num(), 1, 5);
  CHECK(out["kDone"].b());
  CHECK(out["kx"].num() < 15);
  CHECK(out["live"].num() == 1);
}

TEST_CASE("combat: entities: Body2D fighters auto-tick, knockback moves the body, death destroys it, pooled projectile sprites") {
  LuauOptions o;
  o.kits = {"combat"};
  o.steps = 61;
  LuauRun r = run_luau(R"(
      local C = require("@kit/combat")
      local hero = spawn("Body2D", { position = vec2(100, 100), body = "dynamic", gravity_scale = 0, size = vec2(12, 12) })
      local foe = spawn("Body2D", { position = vec2(140, 100), body = "dynamic", gravity_scale = 0, size = vec2(12, 12) })
      local fh = C.add(hero, { hp = 10, team = "player" })
      local ff = C.add(foe, { hp = 3, team = "enemy" })
      C.damage(fh, { amount = 1, source = ff, knockback = 200 })
      local shots = 0
      onTick(function()
        shots += 1
        if shots == 20 then
          C.shoot({ from = hero, at = foe, speed = 400, amount = 5, source = fh, color = "#ffff00", pool = "bolt" })
        end
        if shots == 60 then
          local p = C.shoot({ x = 0, y = 0, dx = 0, dy = -1, speed = 100, lifetime = 0.1, source = fh, color = "#ffff00", pool = "bolt" })
          save.set("out", { heroX = hero.position.x, foeAlive = C.alive(foe), dead = ff.dead, reused = p.entity ~= nil and p.entity.visible })
        end
      end)
    )",
                       o);
  CHECK_MESSAGE(r.errors.empty(), join(r.errors));
  J out = r.out();
  CHECK(out["heroX"].num() < 97);
  CHECK(out["dead"].b());
  CHECK(out["foeAlive"].is_bool());
  CHECK_FALSE(out["foeAlive"].b());
  CHECK(out["reused"].b());
}

}  // TEST_SUITE
