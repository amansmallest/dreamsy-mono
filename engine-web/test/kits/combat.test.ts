// combat kit: headless core tests (Luau in the real engine VM).
import { describe, expect, it } from "vitest";
import { Package } from "@dreamsy/format";
import { Game, MemorySaveHost } from "../../core/index.js";

// Run a Luau client script headless in a fresh package with the given kits; returns save.get("out").
async function runLuau(src: string, opts: { kits?: string[]; steps?: number; files?: Record<string, string>; seed?: number } = {}) {
  const kits = opts.kits ?? ["procgen", "ai", "combat"];
  const files: Record<string, string> = {
    "dreamsy.toml": `format = "0"\nname = "kit test"\ndimension = "2d"\norientation = "portrait"\nentry_scene = "scenes/main.scene.json"\nkits = [${kits.map((k) => `"${k}"`).join(", ")}]\n[style]\npreset = "clean"\n`,
    "scenes/main.scene.json": JSON.stringify({ format: "0", root: "root", entities: { root: { type: "Node2D" } } }),
    ...opts.files,
    "scripts/client/main.luau": src,
  };
  const host = new MemorySaveHost();
  const game = await Game.load(Package.fromFiles(files), { seed: opts.seed ?? 1, save: host });
  for (let i = 0; i < (opts.steps ?? 1); i++) game.step();
  const errors = game.errors.map((e) => `${e.script}:${e.line ?? "?"}: ${e.message}`);
  return { out: host.data.out as any, logs: game.logs.map((l) => l.text), errors, game };
}


const run = async (src: string, steps = 1) => {
  const r = await runLuau(`local C = require("@kit/combat")\nC.setup({ manual = true, rand = (function() local s = 7 return function() s = (s * 48271) % 2147483647 return s / 2147483647 end end)() })\n${src}`, { kits: ["combat"], steps });
  expect(r.errors).toEqual([]);
  return r.out;
};

describe("combat kit", () => {
  it("damage pipeline: types, resistances, weakness, immunity, armor, shields, min damage", async () => {
    const out = await run(`
      local t = C.add(nil, { hp = 100, armor = 2, resist = { fire = 0.5, ice = -0.5, poison = 1 }, shield = 5, team = "enemy" })
      local a = C.damage(t, { amount = 10, type = "physical", source = "player" })   -- 10-2 = 8; shield 5 absorbs
      local b = C.damage(t, { amount = 10, type = "fire", source = "player" })       -- 5-2 = 3
      local c = C.damage(t, { amount = 10, type = "ice", source = "player" })        -- 15-2 = 13
      local d = C.damage(t, { amount = 10, type = "poison", source = "player" })     -- immune
      local e = C.damage(t, { amount = 1, source = "player" })                       -- 1-2 -> min 1
      local f = C.damage(t, { amount = 10, source = "enemy" })                       -- same team: blocked
      save.set("out", { a = {a.dealt, a.absorbed}, b = b.dealt, c = c.dealt, d = d.blocked, e = e.dealt, f = f.blocked, hp = t.hp })
    `);
    expect(out.a).toEqual([3, 5]);
    expect(out.b).toBe(3);
    expect(out.c).toBe(13);
    expect(out.d).toBe("immune");
    expect(out.e).toBe(1);
    expect(out.f).toBe("team");
    expect(out.hp).toBe(100 - 3 - 3 - 13 - 1);
  });

  it("crits, i-frames, knockback (entity-less), death + loot drop + respawn", async () => {
    const out = await run(`
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
    `);
    expect(out.a).toEqual([6, true]);
    expect(out.b).toBe("iframes");
    expect(out.busy).toBe(true);
    expect(out.moved).toBeGreaterThan(14); // 100 px/s for ~0.15 s
    expect(out.moved).toBeLessThan(18);
    expect(out.cKilled).toBe(true);
    expect(out.deaths).toBe(1); // enemy (player died before the listener)
    expect(out.drops).toEqual(["coin", 4, 1, 3, 4]); // procgen.loot merges drops by item (2 rolls x 2)
    expect(out.respawned).toBe(true);
    expect(out.hp).toBe(20);
    expect(out.pos).toEqual([5, 5]);
  });

  it("status effects: burn stacks tick, poison ignores armor, slow, stun busy + immunity window, freeze breaks on hit", async () => {
    const out = await run(`
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
    `);
    expect(out.afterBurn).toBe(94);
    expect(out.stacks).toBe(2);
    expect(out.poison).toBe(94);
    expect(out.slow).toBe(0.5);
    expect(out.busy).toBe(true);
    expect(out.stunOver).toBe(true);
    expect(out.again).toBe(true);
    expect(out.frozen).toBe(true);
    expect(out.fzDealt).toBe(5);
    expect(out.fzFree).toBe(true);
  });

  it("projectiles: travel, hit hostile only, pierce, lifetime, walls, homing", async () => {
    const out = await run(`
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
    `);
    expect(out.a).toBe(7);
    expect(out.b).toBe(7);
    expect(out.ally).toBe(10);
    expect(out.p1).toBe(true);
    expect(out.p2[0]).toBe(true);
    expect(out.p2[1]).toBeGreaterThanOrEqual(49);
    expect(out.p3).toEqual([true, 21]);
    expect(out.homed).toBe(8);
    expect(out.live).toBe(0);
  });

  it("melee arcs, lingering hitboxes, contact damage, teams config", async () => {
    const out = await run(`
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
    `);
    expect(out.n).toBe(1);
    expect(out.front).toBe(6);
    expect(out.behind).toBe(6); // 4 ticks of the lingering hitbox (0, .25, .5, .75)
    expect(out.far).toBe(10);
    expect(out.hero).toBe(8);
    expect(out.blocked).toBe("team");
  });

  it("turn-based formula: type chart, deterministic damage, turn order", async () => {
    const out = await run(`
      local F = C.formula
      local tc = F.typeChart({ fire = { grass = 2, water = 0.5 }, water = { fire = 2 } })
      local r = (function() local s = 3 return function() s = (s * 48271) % 2147483647 return s / 2147483647 end end)()
      local d1 = F.damage({ power = 40, attack = 20, defense = 10, level = 10, typeMult = tc.mult("fire", { "grass" }), crit = false, rand = function() return 0.999 end })
      local d2 = F.damage({ power = 40, attack = 20, defense = 10, level = 10, typeMult = tc.mult("fire", "water"), crit = false, rand = function() return 0.999 end })
      local d0 = F.damage({ power = 40, attack = 20, defense = 10, typeMult = 0, crit = false })
      local order = F.turnOrder({ { id = "a", speed = 3 }, { id = "b", speed = 9 }, { id = "c", speed = 3 } })
      save.set("out", { d1 = d1, d2 = d2, d0 = d0, label = tc.label(2), order = { order[1].id, order[2].id, order[3].id }, sub = (F.damage({ style = "subtract", attack = 5, power = 3, defense = 2, variance = 0, crit = false })) })
    `);
    // ((2*10/5+2)*40*20/10)/50+2 = 11.6 -> x2 = 23.2 (variance roll ~1)
    expect(out.d1).toBe(23);
    expect(out.d2).toBe(5);
    expect(out.d0).toBe(0);
    expect(out.label).toBe("super effective");
    expect(out.order).toEqual(["b", "a", "c"]);
    expect(out.sub).toBe(6);
  });

  it("per-fighter flash/tint, i-frame blink on a Sprite2D fighter, absorbOnly heroes, projectile update hook", async () => {
    const out = await run(`
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
    `);
    expect(out.flashCol).toBe("0.00,1.00,0.00");
    expect(out.blinked).toBe(true);
    expect(out.visibleAfter).toBe(true);
    expect(out.colAfter).toBe("1.00,1.00,1.00");
    expect(out.quietCol).toBe("1.00,1.00,1.00");
    expect(out.loudCol).not.toBe("1.00,1.00,1.00");
    expect(out.deadVisible).toBe(true);
    expect(out.hits).toBe(2);
    expect(out.sim).toBe(5 - 2 - 99);
    expect(out.a1).toEqual([2, true, false]);
    expect(out.a2).toBe("iframes");
    expect(out.a3).toEqual([99, false]);
    expect(out.abHp).toBe(10);
    expect(out.abDead).toBe(false);
    // quarter circle of radius 100/(pi/2) ≈ 63.7: ends near (63.7, 63.7) heading down
    expect(out.px).toBeGreaterThan(60);
    expect(out.px).toBeLessThan(67);
    expect(out.py).toBeGreaterThan(60);
    expect(out.py).toBeLessThan(67);
    expect(out.age).toBeCloseTo(1, 5);
    expect(out.kDone).toBe(true);
    expect(out.kx).toBeLessThan(15);
    expect(out.live).toBe(1);
  });

  it("entities: Body2D fighters auto-tick, knockback moves the body, death destroys it, pooled projectile sprites", async () => {
    const r = await runLuau(`
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
    `, { kits: ["combat"], steps: 61 });
    expect(r.errors).toEqual([]);
    expect(r.out.heroX).toBeLessThan(97);
    expect(r.out.dead).toBe(true);
    expect(r.out.foeAlive).toBe(false);
    expect(r.out.reused).toBe(true);
  });
});
