# rpg kit

Data-driven RPG / creature-collector framework: grid overworld (maps, NPCs, signs, items, doors/warps,
ledges, encounter zones, trainers with line of sight), dialog trees with conditions and effects, quests,
inventory, shops, money, party of 6 + storage, turn-based battles (types, moves, status, XP, evolution,
catching, AI), menus (team, summary, bag, quests, save), and save/continue. You write **content files**
(JSON in `data/`), tile maps and sprites; the kit runs the game. Original IP only: invent your own creature
names, types, art and wording. Golden example: `games/examples/kit-rpg` ("Starfall Keepers").

## Setup

```toml
# dreamsy.toml
orientation = "portrait"
kits = ["rpg"]
entry_scene = "scenes/title.scene.json"
```
```luau
-- scripts/client/main.luau — an UNATTACHED script (the session; survives loadScene)
local rpg = require("@kit/rpg")
rpg.setup()          -- reads data/rpg.json, data/types.json, data/<kind>/*.json; prints content issues
```
```luau
-- scripts/client/title.luau, attached to the title scene root (UIButtons btn_new / btn_continue)
local rpg = require("@kit/rpg")
entity("btn_new").pressed:connect(function() rpg.newGame() end)
entity("btn_continue").pressed:connect(function() if rpg.hasSave() then rpg.continueGame() end end)
```
Dependencies (`kit.json`, auto-enabled): core, progression, combat, juice. Content is read straight from `data/`
with `data.list/data.read`; don't generate content modules. Every `rpg.events` event is also emitted on the core
bus as `"rpg.<name>"` with named fields (e.g. `rpg.trainerDefeated {trainer}`, `rpg.creatureCaught {mon, creature}`),
so core achievements/quests can count rpg facts, and the rpg state is the core save section `"rpg"` (so
`core.save.save()` includes it). `rpg.save()` still writes its own save key `rpg`.

Scenes: a title scene, and **one empty world scene** (`{"root":"world","entities":{"world":{"type":"Node2D"}}}`)
named in `data/rpg.json` `world_scene`. The kit spawns tile layers, player, NPCs, camera and UI itself.
A map may set `"scene"` to use its own (empty or decorated) scene. Don't build overworld/battle/menu UI yourself.

Controls (platform-mapped): move = joystick/arrows; **A** (`jump`) = talk/interact/confirm; hold **B**
(`action`) = run; **C** (`action2`) or the MENU button = menu. Battles and menus are tap-first.

## Content files (JSON Schemas in `kits/rpg/schemas/`)

ids = file names, `lowercase_snake`. Stats: `hp atk def mag res spd`. Move categories: `physical` (atk vs def),
`magic` (mag vs res), `status`. Built-in statuses: `burn` (1/16 HP per turn, halves physical damage),
`poison` (1/8 per turn), `sleep` (1–3 turns, can't act), `stun` (speed ×0.5, 25% can't act),
`freeze` (can't act, 20% thaw per turn); volatile `confuse` (2–4 turns, 1/3 self-hit), `daze` (skip this turn).

**data/rpg.json** (config)
```json
{ "start": { "map": "town", "spawn": "start" }, "world_scene": "scenes/world.scene.json",
  "player_name": "Nova", "money": 500, "items": { "tonic": 2 }, "party": [], "zoom": 3,
  "player": { "sprite": { "down": "asset:hero_down", "up": "asset:hero_up", "right": "asset:hero_right" }, "size": [12, 16], "offset_y": -3 },
  "item_sprite": "asset:item_jar", "dialog_speed": 50, "lose_money_percent": 25,
  "battle": { "sky": "#73eff7", "ground": "#a7f070", "platform": "asset:battle_pad", "music": "battle", "trainer_music": "battle", "text_seconds": 1.1 },
  "sfx": { "select": "select", "item": "item", "heal": "heal", "hit": "hit", "attack": "attack", "faint": "faint", "level": "level",
           "throw": "throw", "shake": "shake", "caught": "caught", "bump": "bump", "door": "door", "alert": "alert", "send": "send", "quest": "quest", "hop": "hop" },
  "text": { "fight": "FIGHT", "wild_prefix": "Wild " }, "ui": { "accent": "#ffcd75" }, "xp_curves": {}, "menu_extra": [] }
```
`player.sprite`: one asset or per-facing (`left` defaults to mirrored `right`); or `"anims": "data/anims/x.json"` with
`idle_<dir>` / `walk_<dir>`. `sfx` ids must exist in `data/sfx/`; unset = silent. `text` overrides any battle/menu
string (keys in battle_core `B.TEXT`). `ui` overrides colors (default: dreamsy.toml `[ui]`).

**data/types.json**: `{ "types": { "sun": { "name": "Sun", "color": "#e8743b", "immune_status": ["burn"] } },
"chart": { "sun": { "moon": 2, "star": 0.5 } } }` — attacker → defender multiplier (missing = 1, 0 = immune).

**data/creatures/<id>.json**
```json
{ "name": "Sunnip", "types": ["sun"], "description": "...",
  "base": { "hp": 45, "atk": 52, "def": 43, "mag": 55, "res": 45, "spd": 60 },
  "learnset": [ { "level": 1, "move": "flare_tap" }, { "level": 6, "move": "scorch" } ],
  "evolution": [ { "into": "solarch", "level": 9 } ],       // or { "item": "dusk_shard" }, + "if": condition
  "catch_rate": 45, "xp_yield": 64, "xp_curve": "medium",  // fast 0.8·L³ | medium L³ | slow 1.25·L³
  "sprites": { "front": "asset:sunnip", "back": "asset:sunnip_back", "icon": "asset:sunnip" } }
```
Stat = ⌊(2·base + gene)·L/100⌋ + 5; HP = ⌊(2·base + gene)·L/100⌋ + L + 10 (genes 0–15 random per catch).
Base-stat totals: ~300 for first forms, ~420 middle, ~500+ final/legendary. Missing `back` = mirrored front.

**data/moves/<id>.json**
```json
{ "name": "Scorch", "type": "sun", "category": "magic", "power": 30, "accuracy": 100, "pp": 25, "priority": 0,
  "effects": [ { "type": "status", "status": "burn", "chance": 30 } ] }
```
Effects: `status` {status, chance, target}, `stat` {stat: atk|def|mag|res|spd|acc|eva, stages ±1..6, target},
`heal` {percent}, `drain` {percent of damage}, `recoil` {percent}, `cure`, `daze`, `custom` {id → hooks.moveEffect}.
Also `hits: 3` or `[2, 3]`, `crit_stage: 0|1|2`, `accuracy: true` (never misses), `target: "self"`.
Damage = (⌊⌊⌊2L/5+2⌋·Pow·A/D⌋/50⌋ + 2) × STAB 1.5 × type × crit 1.5 (1/16) × 0.85–1.00 × burn 0.5.
Power guide: 35–45 starters, 60–80 mid, 90–120 late (lower accuracy / recoil). PP 5–35.

**data/items/<id>.json** — `kind`: heal | cure | revive | capture | battle | held | evolve | key | misc
```json
{ "name": "Tonic", "kind": "heal", "heal": 20, "price": 100, "icon": "asset:item_tonic", "description": "Restores 20 HP." }
```
Fields: `heal`, `heal_percent`, `cure` (true or [statuses]), `revive` (% HP), `power` (capture: 1 basic, 1.5–2 better),
`boost` {stat, stages} (battle), `held` {type, mult} / {heal_percent}, `evolve: true` (+ creature evolution `item`),
`teach` (move id, `teach_to` species), `level_up` n, `use` [effects] (key items), `consumable`.
Catch chance = (3·max−2·hp)/(3·max) × catch_rate/255 × power × (sleep/freeze 2, other status 1.5).

**data/trainers/<id>.json** — beating it sets flag `beat_<id>` (+ `flags`, `on_win` effects, money `reward`)
```json
{ "name": "Warden Vela", "party": [ { "creature": "glimmet", "level": 7 }, { "creature": "stellion", "level": 9, "moves": ["comet_rush"] } ],
  "ai": "smart", "items": { "tonic": 1 }, "reward": 800, "flags": ["trial_1"],
  "intro": ["Show me your bond!"], "defeat": ["You earned it."], "after": ["Go see the elder."], "battle": { "sky": "#29366f", "ground": "#3b5dc9" } }
```
AI: `random`, `smart` (best expected damage / useful status, heals at <25% HP, picks good switch-ins), or a hooks.ai name.

**data/maps/<id>.json** (cells are `[col, row]`, 0-based; tile 16 px)
```json
{ "name": "Glimmer Path", "music": "route",
  "layers": [ { "data": "file:data/levels/route1_ground.txt", "tileset": "data/tilesets/world.json" },
              { "data": "file:data/levels/route1.txt", "tileset": "data/tilesets/world.json" } ],
  "spawns": { "south": [8, 19, "up"], "north": [8, 1, "down"] },
  "warps": [ { "at": [8, 20], "to": "town", "spawn": "from_route" }, { "at": [4, 5], "to": "lodge", "spawn": "door", "on": "bump" } ],
  "encounters": { "grass": { "rate": 0.14, "table": [ { "creature": "mothlet", "min": 2, "max": 4, "weight": 40 } ] } },
  "npcs": [ { "id": "elder", "name": "Elder Moss", "at": [11, 9], "sprite": "asset:npc_elder", "dialog": "elder", "move": "look" },
            { "id": "kit", "at": [12, 8], "facing": "left", "sprite": "asset:npc_ranger", "trainer": "ranger_kit", "sight": 4 },
            { "id": "pip", "at": [8, 1], "lines": ["Not without a partner!"], "if": { "not_flag": "got_starter" } } ],
  "signs": [ { "at": [12, 12], "text": "GLIMMER PATH" } ],
  "items": [ { "at": [2, 2], "item": "tonic", "count": 2 } ],
  "triggers": [ { "at": [7, 10], "w": 1, "h": 1, "dialog": "cutscene", "once": true } ],
  "battle": { "sky": "#333c57", "ground": "#566c86" } }
```
Collision/tags come from each layer's tileset (`solid`, `tags`, read via `map:tileDef`). Tile tags the kit knows: encounter zone names (any tag
listed in `encounters`), `ledge_down|up|left|right` (hop over in that direction only), `counter` (talk across).
Warps: `on: "step"` (default; stand on it) or `"bump"` (walk into a solid door). NPC `move`: static | wander
(`radius`) | patrol (`path` of cells) | look (turns randomly); `fixed: true` never turns. Any NPC/sign/item/warp/
trigger/encounter zone can have `"if"`. Pickups disappear for good (flag `item_<map>_<x>_<y>` or `flag`).
Camera zoom (`zoom`, default 3) grows to fill the screen for small maps; keep maps ≥ 15×27 tiles for portrait.

**data/dialog/<id>.json**
```json
{ "speaker": "Elder Moss", "start": "start", "nodes": {
  "start": { "branches": [ { "if": { "flag": "got_starter" }, "goto": "again" } ],
             "lines": ["Ah, {player}!", "Choose a partner."],
             "choices": [ { "text": "Sunnip", "effects": [ { "give_creature": "sunnip", "level": 5 } ], "goto": "picked" },
                          { "text": "Later", "goto": "end" } ] },
  "picked": { "lines": ["Good choice!"], "effects": [ { "set_flag": "got_starter" }, { "start_quest": "first_steps" } ] },
  "again":  { "lines": ["Go north, {player}."] } } }
```
Node order: `branches` (first match jumps) → `lines` → `effects` → `choices` (last line is the prompt) → `next`.
Short form: a single node at top level. Lines: string or {text, speaker, portrait, if}. `{player}`, `{money}`, `{var.x}`.

**data/quests/<id>.json**
```json
{ "name": "The Lost Charm", "description": "...", "steps": [
    { "id": "find", "text": "Find the charm in Hollow Cave", "objectives": [ { "type": "item", "item": "moon_charm" } ] },
    { "id": "return", "text": "Return it", "objectives": [ { "type": "flag", "flag": "charm_returned" }, { "type": "item", "item": "moon_charm", "consume": true } ] } ],
  "rewards": { "money": 200, "items": { "super_tonic": 2 }, "flags": [] } }
```
Objectives: item {item,count,consume}, flag, visit {map}, talk {npc id}, defeat {trainer} or {creature|creature_type,count},
catch {creature|creature_type,count}, party_size, level, money {amount}, condition {if}, custom {id}. Steps auto-advance
when all objectives hold (`"auto": false` / no objectives = advance with an effect). `auto_start`, `start_if`.

**data/shops/<id>.json**: `{ "name": "MART", "items": ["tonic", { "item": "bright_jar", "price": 400, "if": { "flag": "trial_1" } }], "sell": true }`

**Conditions** (object = all keys hold; list = all): `flag`, `not_flag`, `flags`, `item`(+`count`), `no_item`, `money`,
`var`(+`eq|ne|gte|lte`), `quest`(+`state`: not_started|active|done|started, or +`step`), `party_has`, `party_size`,
`level` (highest party level ≥), `caught`, `seen`, `map`, `all`, `any`, `not`.
**Effects** (one key each, run in order; battles/shops/dialogs wait): `set_flag`, `clear_flag`, `set_var`/`add_var` (+`value`),
`give_item`/`take_item` (+`count`), `give_money`, `take_money`, `give_creature` (+`level`, `nickname`), `heal` (also sets the
blackout respawn point), `start_battle` (trainer id; rest runs only on a win), `wild_battle` {creature, level, can_run},
`warp` {map, spawn}, `start_quest`, `advance_quest`, `complete_quest`, `open_shop`, `open_storage`, `dialog`, `emit` (+`args`),
`sfx`, `music`, `toast`, `wait`, `save`; any effect may carry `"if"`.

## Script API (`local rpg = require("@kit/rpg")`)
```luau
rpg.setup(opts?)                 rpg.newGame()   rpg.continueGame() -> bool   rpg.hasSave()   rpg.save() -> bool
rpg.enterMap(mapId, spawnId | {x, y, facing})    rpg.warp(mapId, spawnId?)    -- warp = with fade
rpg.check(condition) -> bool     rpg.apply(effects, done?)    rpg.text("Hi {player}")
rpg.flag(name)  rpg.setFlag(name, v?)  rpg.give(item, n?)  rpg.take(item, n?)  rpg.count(item)  rpg.money()  rpg.addMoney(n)
rpg.party()  rpg.giveCreature(id, level)  rpg.heal()
rpg.startBattle(trainerId, done(result))  rpg.wildBattle({ creature, level, can_run }, done(result))   -- "win"|"lose"|"run"|"caught"
rpg.say(lines, opts?, done?)  rpg.runDialog(idOrDef, opts?, done?)  rpg.openMenu()  rpg.openShop(id, done?)
rpg.quests.state(id) / .stepId(id) / .start(id) / .advance(id) / .complete(id) / .log()
rpg.state.get()  -- the save table: player{map,x,y,facing}, money, bag, party, box, flags, vars, quests, seen, caught, playtime
rpg.creatures.create(id, level) / .gainXp(mon, n) / .evolve(mon, into) / .learn(mon, move, slot?) / .heal(mon)
rpg.content.<kind>[id]   rpg.content.add(kind, id, def)   rpg.content.issues
```
XP curves are `@kit/progression` curves (`rpg.creatures.curve(name)`); the type chart is a `@kit/combat` `formula.typeChart`
(`rpg.content.typeChart.mult/label`). Damage stays the kit's own floored formula (above).
`require("@kit/rpg/battle")`: `Battle.new(opts)` + `:submit(action)` (pure engine, for custom screens/sims),
`Battle.damage(a, d, move, {crit, roll})`, `Battle.catchChance(mon, power)`, `Battle.runChance(...)`, `Battle.speed` (UI speed), `Battle.TEXT`.

## Events & hooks
```luau
rpg.events.<name>:connect(fn)   -- flagSet(name, v) itemObtained(id, n) itemUsed moneyChanged creatureObtained(mon, where)
  -- creatureCaught(mon) creatureSeen levelUp(mon, L) evolved(mon, from, to) questUpdated(id, state, step) questCompleted(id)
  -- battleStarted(b) battleEnded(b, result) trainerDefeated(id) mapEntered(mapId) stepped(x, y, map) interacted(kind, def)
  -- dialogStarted/Ended(id) saved loaded newGame custom(name, args)
rpg.hooks.moveEffect.<id> = function(ctx) ... end      -- ctx: battle, user, target, damage, say(text), emit(ev), rng
rpg.hooks.effect.<name> = function(value, effect, done) ... return "wait" end   -- custom dialog/quest effects
rpg.hooks.condition.<name> = function(value, cond) return bool end
rpg.hooks.objective.<id> = function(objective, questRec) return progress end
rpg.hooks.encounter = function(mapId, tag, x, y) return { creature, level } | false | nil end
rpg.hooks.ai.<name> = function(battle, side) return { kind = "move", slot = 1 } end
rpg.hooks.status.<name> = { text = "{mon} is chilled!", canAct = fn(mon, b, side) -> (bool, msg?), onTurnEnd = fn(mon, b, side) }
rpg.hooks.catchChance / rpg.hooks.damage = function(value, ctx) return newValue end
rpg.hooks.interact = function(kind, def) return true end      -- take over NPC/sign/item interaction
rpg.hooks.startBattle = function(opts, done) return true end  -- replace the battle screen entirely
```

## How to build a 1–2 hour RPG with this kit
1. **World graph first** (notes.md): a start town → 2–3 routes → caves/forests → towns, each region gated by a
   trial/boss flag (`if: {flag: "trial_2"}` on a blocking NPC or warp). 8–15 maps (towns ~20×30, routes 17×35–60,
   dungeons 2–3 floors), 1 healer + 1 shop per town (`heal` effect also sets the respawn point).
2. **Level curve**: wild L2–5 on route 1, +3–5 per region; trainers ≈ wild max +1; trial bosses (6–8 "trials") lead
   at region cap +2 with 2–4 creatures and `"ai": "smart"`, last boss ~L45–55. Medium curve: L10 ≈ 1k XP.
   XP per KO = xp_yield·L/7 (×1.5 trainers) → ~6–10 battles per level early. Test with `Battle.new` sims.
3. **Content counts**: 40–80 creatures (3-stage and 2-stage lines + singles, a few rare/legendary with low
   `catch_rate`), 6–12 types with a readable chart (each type 2 strengths/2 weaknesses), 60–120 moves, 15–30 items,
   20–40 trainers + 6–8 trial bosses, 15–30 quests (fetch, catch-N-of-type, defeat, deliver, visit), 40–80 dialogs.
4. **Pacing**: a starter choice (3 creatures with a type triangle), catching tutorial quest, a shop unlock per trial
   (`if` on shop items), new capture tiers mid-game, HM-like gates via key items + `if` conditions, 1–2 legendary
   `wild_battle` set-pieces with `can_run: false`.
5. **Art**: 32×32 front sprites (24–40 ok; rendered 240 px), optional back sprites, 12×16 characters with
   down/up/right, 16×16 tiles (ground layer + object layer; trees with transparent corners over grass).
6. **Do**: keep every id referenced in data defined (rpg.setup prints `content:` issues); give each map
   spawns for every warp target; put encounter tags on tiles, not entities; save often via a menu or `save` effect.
   **Don't**: re-implement movement, battles or menus; use `after()`/`every()` for kit timing; add physics bodies
   to maps; copy any existing franchise's names, types, creatures, music or UI.
