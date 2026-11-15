# combat kit

Foundation kit for any game with damage: HP/shields/armor on entities (or plain tables), typed damage with
resistances, crits, knockback, i-frames, status effects (burn/poison/bleed/slow/stun/freeze/regen/haste/vulnerable
+ custom), hurtbox circles + hitboxes (also Area2D + collision layers), pooled projectiles (pierce, homing, walls),
melee arcs, contact damage, teams, death/respawn, loot drops — plus turn-based damage formulas for RPGs/deckbuilders.
Ticks itself (onTick) once the first fighter exists. Example: `games/examples/kit-roguelike-demo`.

## Setup
```toml
kits = ["combat"]            # usually with "ai", "procgen"
[physics]
layers = ["player", "enemy", "world"]
```
```luau
local combat = require("@kit/combat")
combat.setup({ solidAt = function(x, y) return grid:solidAt(x, y) end,   -- projectiles stop on walls
               lootTables = content.loot, rollLoot = procgen.loot.roll }) -- optional (rarity/pity loot)
```

## Fighters
```luau
local f = combat.add(entity?, def) -> Fighter        -- entity = Body2D/any 2D entity; nil = headless (use def.x/y)
combat.get(entity) -> Fighter?    combat.remove(f)    combat.all()    combat.reset()   -- reset on floor/level change
f.hp f.maxHp f.shield f.team f.dead f.statuses f.data f.entity
f:pos() -> x, y   f:busy() -> bool (stunned/frozen/knocked back: skip input/AI)   f:speedMult() -> number
f:heal(n)   f:kill()   f:fraction()   f:addStatus(name, opts)   f:hasStatus(name)   f:stacks(name)   f:clearStatus(name?)
```
def (all optional): `hp=10, maxHp, shield=0, shieldRegen=0 (/s), shieldDelay=2, armor=0 (flat, subtracted),
resist={fire=0.5, ice=-0.5 (weak), poison=1 (immune); status names too}, immune={"stun"}, team="enemy",
iframes=0 (s; players ~0.6–0.8), radius (hurtbox; default from entity size), critChance=0, critMult=2,
knockbackResist=0..1, contact={amount, type, knockback, status} (touch damage to hostiles), attack, defense, level, types,
loot="table_id"|table, respawn={delay=1.5, x?, y?, hp?}, destroyOnDeath=true, deathDelay=0, data={}`, `onHit(info)`, `onDeath(f, info)`,
`flash = true|false|"#hex"` (hit flash, `flashTime=0.1`), `tint = bool` (status colours), `blink = bool` (i-frame blink) — per fighter,
overriding `combat.setup({ flash, tint, blink, flashColor })`, `absorbOnly = false` (see below).

Visuals act on the fighter's sprite: the entity itself when it is a `Sprite2D`, else its first `Sprite2D` child.
i-frame blink toggles that sprite's `visible` and always restores it (i-frames end, death, `combat.remove`).

**absorbOnly** — for a hero whose health lives in another sim (run state, RPG party, server): the full pipeline runs
(teams, i-frames, `beforeDamage`, crits, resist, armor, shield, knockback, statuses, flash/blink, `hit` event with
`info.dealt` + `info.absorbOnly = true`) but `f.hp` never changes and it never dies on its own; `f:heal(n)` only emits `heal`.
Apply `info.dealt` to your own HP in `combat.on("hit")` and call `f:kill()` when your sim says so.
```luau
local hero = combat.add(player, { team = "player", iframes = 0.8, absorbOnly = true, flash = "#ffffff" })
combat.on("hit", function(info) if info.target == hero then run.hp -= info.dealt if run.hp <= 0 then hero:kill() end end end)
```

## Damage
```luau
local info = combat.damage(target, { amount = 3, type = "fire", source = attackerFighter|"player",
  crit = nil (rolls source.critChance) , knockback = 160, dir = {x,y}?, status = "burn" | {name="poison", chance=0.3, duration=3, stacks=2} | {...},
  ignoreArmor, ignoreIframes, ignoreShield })
-- info: { dealt (hp lost), absorbed (shield), amount, crit, killed, blocked = nil|"dead"|"team"|"iframes"|"immune"|"cancelled" }
```
Order: dead → team → i-frames → `beforeDamage` hooks (edit `info.amount` / set `info.cancel`) → crit → resist (≥1 = immune)
→ status `damageTakenMult` → armor → min 1 → round → shield → hp → i-frames, flash, knockback, statuses → `hit` → death.

## Status effects
`combat.applyStatus(f, name, {duration?, stacks=1, power=1, source?})` (nil if immune). Built-ins (`combat.STATUS`):
burn (fire DoT, stacks 5), poison (DoT ignores armor, stacks 10), bleed, slow (speed ×0.5), stun (busy; immune 0.5 s after),
freeze (busy, ×1.25 damage taken, breaks on hit), regen (heal), haste (×1.5), vulnerable (×1.5 taken).
Stacking: `refresh` | `stack` (+stacks ≤ maxStacks, DoT × stacks) | `extend` | `max` | `ignore`.
Custom: `combat.defineStatus("shock", { duration=2, tick=0.5, damage=1, type="lightning", speedMult=0.8, tint="#ffee55", stacking="refresh" })`.
Use `f:speedMult()` for movement and `f:busy()` to block actions; ai.attach takes both as callbacks.

## Attacks
```luau
combat.swing(attackerFighter, { range = 22, arc = 120 (deg), dir = {x,y} | angle = deg, amount = 2, knockback = 170, status? }) -> { info }
combat.hitbox({ x, y | follow = entity, offset = {x,y}, radius = 12, duration = 0.1, every = 0.5? (re-hit), source, amount, ... }) -> hb (hb.cancel())
combat.areaHitbox(area2D, { amount = 1, ... }, { source = f|team, once = false })   -- physics hitbox via layers/mask
combat.query(x, y, r, { hostileTo = f|team, exclude = f }) -> { Fighter }
local p = combat.shoot({ from = entity|{x,y} | x,y ; dx,dy | angle | at = entity|{x,y}, speed = 220, lifetime = 1.5, radius = 4,
  pierce = 0, homing = 0 (deg/s; auto-targets nearest hostile in homingRange=160 or `target`), source = f|"enemy",
  amount, type, status, knockback, solid = fn(x,y)|PathGrid (default setup.solidAt),
  sprite = "asset:bolt" | color = "#ff0" , size = {6,6}, pool = "bolt" (reuse sprites), onHit = fn(p, info), onExpire = fn(p, why),
  update = fn(p, dt) })  -- per-tick motion hook, runs after homing and before the move: steer p.vx/p.vy or set p.x/p.y
combat.projectiles() -> active list (p.x, p.y, p.vx, p.vy, p.speed, p.age (s alive), p.t (life left), p:cancel())
-- curved shot: turn 90°/s
combat.shoot({ from = f, angle = 0, speed = 120, source = f, amount = 1, color = "#ff0",
  update = function(p, dt) local a = math.atan2(p.vy, p.vx) + math.rad(90) * dt p.vx, p.vy = math.cos(a) * p.speed, math.sin(a) * p.speed end })
```

## Teams
Default: different teams are hostile, same team never (set `friendlyFire = true` to allow), `"neutral"` hits nobody.
Explicit: `combat.setup({ teams = { player = {"enemy"}, enemy = {"player"}, critters = {} } })`. `combat.hostile(a, b)`.

## Events (`combat.on(name, fn) -> {disconnect}`)
`hit(info)`, `beforeDamage(info)`, `death(f, info)`, `drop(drops, x, y, f)` (drops = {{item, count, rarity}} — spawn pickups),
`status(f, name, st)`, `statusEnd(f, name)`, `heal(f, n)`, `respawn(f)`.

## Turn-based (`combat.formula`)
```luau
local tc = combat.formula.typeChart({ fire = { grass = 2, water = 0.5 }, water = { fire = 2 } })
local dmg, d = combat.formula.damage({ power = 40, attack = 12, defense = 9, level = 7, typeMult = tc.mult("fire", {"grass"}),
  stab = true, critChance = 1/16, variance = 0.15, style = "pokemon" | "simple" | "subtract", rand = fn? })  -- d.crit, d.mult
tc.label(mult)  -- "super effective" | "not very effective" | "immune"
combat.formula.hits(accuracy, accStage, evaStage)   combat.formula.stat(base, level, growth)
combat.formula.xpFor(level)   combat.formula.turnOrder(units)  -- by speed
```

## Content files
- `data/loot/<id>.json` — loot table (`schemas/loot.json`, same format as procgen.loot):
  `{ "rolls": 1, "entries": [ {"nothing": true, "weight": 4}, {"item": "coin", "weight": 5, "count": [1,3]}, {"item": "potion", "weight": 1} ] }`
- `data/statuses/<name>.json` — custom status (`schemas/status.json`) → `combat.defineStatus(name, def)`.
- Fighter stats live in your entity data (e.g. `data/enemies/*.json`, `schemas/fighter.json`).
Both load through the engine data reader: loot tables on the first drop (unless `setup{ lootTables }`), statuses on first use
of an unknown name. Drops are rolled by `procgen.loot.roll` (rarities, nested tables, pity; merged by item) — combat requires
procgen (kit.json). Other content (enemies): `procgen.content({ "enemies" })` or `data.read`.

## Recipe: top-down hero + enemy
```luau
local hero = combat.add(player, { hp = 12, team = "player", iframes = 0.8, destroyOnDeath = false })
local f = combat.add(body, { hp = 4, team = "enemy", contact = { amount = 1, knockback = 120 }, loot = "common" })
ai.attach(body, enemyData, { grid = grid, canAct = function() return not f:busy() end, speedMult = function() return f:speedMult() end,
  hp = function() return f.hp, f.maxHp end,
  onAction = function(name, a) if name == "shoot" then combat.shoot({ x = a.x, y = a.y, dx = a.dx, dy = a.dy, source = f, amount = 1, color = "#fff" }) end end })
onTick(function() if not hero:busy() then player.velocity = move * 72 * hero:speedMult() end
  if input.pressed("action") then combat.swing(hero, { dir = facing, range = 20, arc = 140, amount = 2, knockback = 170 }) end end)
combat.on("drop", function(drops, x, y) for _, d in drops do spawnPickup(d.item, d.count, x, y) end end)
combat.on("death", function(f) if f == hero then after(2, restartRun) end end)
```

## Do / don't
- Do make enemy bodies `mask = "world"` (no body-vs-body push) and rely on hurtbox overlap for contact damage; use circle shapes in tight corridors.
- Do check `f:busy()` before applying input/AI velocity (knockback owns the body while active).
- Do `combat.reset()` when rebuilding a level in the same scene (destroys pooled projectile sprites).
- Don't read `entity.x` — kits take entities, `{x,y}` tables or Vec2; `combat.xy(v)` converts.
- Generation-time budget: every script callback has 250 ms; combat itself is cheap (O(fighters²) for contact checks — keep < ~150 fighters).
