# core kit

Foundation systems for any game and for every genre kit: event bus, state machines, content registry,
flags, wallet, inventories, conditions/effects, quests, dialog trees, achievements, save/load, pause,
timers/cooldowns, and touch-first menus. Data-driven: content lives in `data/<kind>/*.json`.

## Setup
```toml
kits = ["core"]            # + "progression", "juice" as needed
```
```luau
local core = require("@kit/core")     -- submodules also work: require("@kit/core/inventory")
core.setup({
  currencies = { gold = { name = "Gold", icon = "asset:coin", start = 0, max = 99999 } },
  bag = { slots = 20, categorySlots = { key = 5 } },
  theme = { primary = "#4f8a5b", accent = "#ffd166", background = "#22333b", text = "#f7f3e9", font = "rounded" },
  save = { key = "mygame", version = 1, migrate = function(d, from) return d end },
  autoload = false, autosave = 10,              -- autoload: load the save now; autosave: seconds
})
```
Call `core.setup` once from a **session script** (unattached `scripts/client/*.luau`) or a shared module's
`init()`; the kit is a module, so all state survives `loadScene`.

## Content
- Kinds: `items`, `quests`, `dialog`, `achievements` (+ `skills` for the progression kit). Id = file name.
- `core.setup()` loads `data/{items,quests,dialog,achievements}/*.json` through the engine data reader (`data.list`/`data.read`);
  other kinds load on first use (`content.load(kind)`). Never generate `scripts/shared/*content*.luau` copies.
- Tests/tools: `core.setup({ data = map })` / `core.content.registerFiles(map)` — `map["data/<kind>/<id>.json"] = table` — or
  per-kind tables (`items = {...}`) replace the reader for that kind (`achievements = {}` = none, e.g. when a genre kit owns
  `data/achievements/` with its own format).
- `core.content.register(kind, defs)` (one def with id / list / id map) · `get(kind, id)` · `require(kind, id)` (errors) ·
  `all(kind)` (registration order) · `ids(kind)` · `load(kind)` · `setLoader(fn(kind) -> defs)` · `clear(kind?)`.

## Conditions & effects (shared data language)
Condition = object (kind = its key) or array (= all). Comparators `eq ne gt gte lt lte` work on flag/item/currency/level values.
| condition | true when |
|---|---|
| `{"flag":"k"}` / `{"flag":"k","eq":"open"}` / `{"flag":"kills","gte":3}` | flag truthy / compares |
| `{"item":"apple","count":3}` (`inventory`?) | owns ≥ count (default 1) |
| `{"currency":"gold","gte":50}` (or `amount`) | balance ≥ |
| `{"quest":"q","is":"done"}` is = `inactive active done failed started available`; `{"quest":"q","step":"deliver"}` | quest state / current step |
| `{"achievement":"id"}` `{"seen":"tree"}` `{"seen":"tree/node"}` `{"chance":0.3}` | unlocked / dialog visited / random |
| `{"all":[…]}` `{"any":[…]}` `{"not":{…}}` | combinators |
| progression kit: `{"level":3,"track":"player"}` `{"skill":"id","rank":2,"tree":"skills"}` `{"prestige":1}` `{"milestone":"id"}` | |

Effects = array of objects, applied in order:
`{"set":"flag","value":v}` (default true) · `{"add":"flag","value":1}` · `{"give":"item","count":1}` · `{"take":"item","count":1}` ·
`{"earn":"gold","amount":5}` · `{"spend":"gold","amount":5}` · `{"quest":"id","action":"start|complete|fail|advance|reset"}` (default start) ·
`{"unlock":"achievement"}` · `{"emit":"event","data":{…}}` · `{"toast":"text"}` · progression: `{"xp":20,"track":"player"}` `{"skillPoints":1}` `{"unlockSkill":"id"}`.
```luau
core.check(cond, ctx?) -> boolean        core.apply(effects, ctx?)
core.conditions.failing(cond) -> { leafCond }        -- "need 3 apples" UIs
core.conditions.registerCondition("hasPet", function(c, ctx) return pets[c.hasPet] ~= nil end)   -- {"hasPet":"cat"}
core.conditions.registerEffect("heal", function(e, ctx) player.hp += e.heal end)                  -- {"heal":5}
core.conditions.compare(value, cond, defaultGte?)    -- reuse comparators in custom kinds
```
Unknown kinds are script errors listing the known kinds.

## Events — `core.events`
```luau
core.emit("enemy_defeated", { enemy = "slime" })     -- game facts; quests + achievements count them
local c = core.events.on("item_gained", function(data, name) end)   c.disconnect()
core.events.once(name, fn)   core.events.on("*", function(name, data) end)
core.events.onScene(name, fn)    -- auto-dropped after loadScene: USE THIS from scene scripts that touch entities
local bus = core.events.new()    bus:on / bus:emit / bus:once / bus:onScene / bus:clear   -- private bus
```
Built-in events (data fields): `item_gained`/`item_lost` {item, count, inventory} · `item_used` · `currency_changed` {currency, amount, delta} ·
`flag_changed` {key, value, old} · `quest_started|quest_step|quest_progress|quest_completed|quest_failed` {quest, step?, objective?, count?, target?} ·
`achievement_unlocked` {achievement} · `dialog_started|dialog_ended` {dialog, path} · `dialog_choice` · `pause_changed` {paused, reason} ·
`game_saved` · `game_loaded` {version} · `ui_pressed` {label} · progression: `level_up` {track, level, gained} · `skill_unlocked` · `milestone_reached` · `daily_claimed`.

## FSM — `core.fsm.new(def)`
```luau
local m = core.fsm.new({ initial = "idle", context = enemy, onChange = function(m, from, to) end, states = {
  idle   = { enter = function(m, from, ...) end, update = function(m, dt) if seen then return "chase" end end,
             exit = function(m, to) end, on = { hurt = "stun", alert = function(m, d) return if d < 100 then "chase" else nil end } },
  chase  = { update = function(m, dt) if m.time > 3 then return "idle" end end },
  stun   = { enter = function(m) after(0.5, function() m:go("idle") end) end } } })
onTick(function(dt) m:update(dt) end)     m:send("hurt", dmg)     m:go("idle")
m.state  m.previous  m.time (s in state)  m:is("idle")  m:can("hurt")  m.history
```

## Flags — `core.flags`
`get(k, default?)` · `set(k, v)` · `add(k, n=1) -> new` · `toggle(k)` · `has(k)` · `all()` · `reset()`. Saved automatically.

## Wallet — `core.wallet` (in-game currencies, never Stars)
`define(id, {name, icon, start, max})` · `get(c)` · `add(c, n) -> applied delta` (clamped 0..max; negative ok) · `set(c, n)` ·
`spend(c, n) -> bool` · `has(c, n)` · `canAfford({gold=10, gems=1})` · `pay(costs) -> bool` (atomic) · `all()` · `reset()`.

## Inventory — `core.bag` (default) / `core.inventory.new(opts)`
Item def (`data/items/<id>.json`, schema `schemas/item.schema.json`):
`{ "name", "description"?, "icon"?: "asset:x", "category"?, "stack"?: 99 (1 = unstackable), "max"?: total cap, "value"?,
  "use"?: effects, "useCondition"?: cond, "consumable"?: true when use is set, "data"?: {genre fields} }`
```luau
local chest = core.inventory.new({ id = "chest", slots = 12, categorySlots = { food = 2 }, strict = true })  -- registered + saved by id
bag:add(id, n=1, all?) -> added      -- partial when full; all=true: all-or-nothing (returns 0)
bag:remove(id, n=1) -> bool          -- all-or-nothing        bag:removeAt(slot, n?)
bag:count(id)  bag:has(id, n?)  bag:canAdd(id, n) -> fits  bag:freeSlots()  bag:usedSlots()
bag:list(category?) -> { {id, count, def} } (merged)  bag:stacks() -> { {slot, id, count} }  bag:slot(i)
bag:move(a, b) (merge/swap)  bag:sort(cmp?)  bag:use(id, ctx?) -> bool  bag:clear()  bag.onChange = fn(inv)
core.inventory.get(id)  core.inventory.item(id) -> def
```
Unknown item ids are errors (`strict = false` allows them). Set `inv.saved = false` to exclude an inventory from saves.

## Quests — `core.quests` (`data/quests/<id>.json`)
```json
{ "title": "Apple Pie", "requires": {"quest":"intro"}, "autoStart": false, "repeatable": false,
  "steps": [
    { "id": "gather", "text": "Pick 3 apples", "objectives": [ { "id": "a", "condition": {"item":"apple","count":3} } ],
      "effects": [ {"take":"apple","count":3} ] },
    { "id": "hunt", "text": "Pop 3 slimes", "objectives": [ { "id": "s", "event": "enemy_defeated", "match": {"enemy":"slime"}, "count": 3 } ] } ],
  "rewards": [ {"earn":"gold","amount":30}, {"xp":25} ] }
```
Objectives: `event`+`match`(fields equal in event data)+`count` (adds `data.count` or 1 per event; `perEvent: true` = always 1), or
`condition` (done while it holds; re-checked on every event). Step done → its `effects` → next step; last step → `rewards` → `quest_completed`.
`autoStart` quests start as soon as `requires` holds.
`start(id, force?) -> bool` · `status(id)` · `isActive` `isDone` · `step(id) -> stepDef` · `progress(id) -> { {id,text,count,target,done} }` ·
`canStart(id)` · `advance(id)` · `complete(id)` · `fail(id)` · `reset(id)` · `list(status?)` · `available()` · `timesCompleted(id)` · `evaluate()`.

## Dialog — `core.dialog` (`data/dialog/<id>.json`)
```json
{ "speaker": "Owl", "portrait": "asset:owl", "start": "root", "nodes": {
  "root":  { "branches": [ {"condition":{"quest":"pie","is":"done"},"next":"after"}, {"next":"hello"} ] },
  "hello": { "lines": ["Hoo!", {"text":"Hi.","speaker":"You"}], "next": "ask" },
  "ask":   { "text": "Pick 3 apples?", "choices": [
             {"text":"Sure","next":"yes","effects":[{"quest":"pie"}]},
             {"text":"Buy (99g)","condition":{"currency":"gold","gte":99},"showLocked":true,"next":"rich"},
             {"text":"Later"} ] },
  "yes":   { "text": "You have {item:apple} apples.", "effects": [{"set":"agreed"}] },
  "after": { "text": "Thanks!" }, "rich": { "text": "Hoo!" } } }
```
Branch nodes jump to the first passing `next` (no text). No `next`/`choices` (or `"end"`) ends. Choices failing `condition` are hidden
(or shown "(locked)" with `showLocked`). Text interpolation: `{flag:k}` `{item:id}` `{currency:id}` `{var:k}` (ctx.vars).
```luau
core.dialog.play("owl", { onEnd = function(cursor) end, speed?, position?, block?, pause? (true), ctx? }) -> cursor
  -- renders with engine ui.dialog/ui.choice (kit dialog box fallback); pushes core.pause "dialog" while open
local c = core.dialog.open("owl", ctx?)   -- pure cursor (tests, custom UIs)
c:view() -> { speaker, portrait, lines = {{text,speaker,portrait}}, choices = {{text, locked, index}}? }
c:advance()   c:choose(i) -> bool   c.done   c.nodeId   c.path
core.dialog.seen("owl/ask")
```

## Achievements — `core.achievements` (`data/achievements/<id>.json`)
`{ "name", "description"?, "icon"?, "hidden"?, "condition"?, "event"?, "match"?, "count"?, "rewards"? }` — unlocks on `count` matching
events (and `condition`, if both) or when `condition` holds (checked on every event).
`unlock(id)` · `isUnlocked(id)` · `progress(id) -> count, target` · `list(includeHidden?) -> { {id, def, unlocked} }` · `reset()`.

## Save — `core.save` (engine `save`, one key, versioned)
Saves flags, wallet, every inventory, quests, achievements, dialog-seen, plus registered sections (progression registers itself).
```luau
core.save.save(slot?) -> bool      core.save.load(slot?) -> bool (false if none)     core.save.exists(slot?)   core.save.delete(slot?)
core.newGame()                      -- reset all sections to start values (doesn't delete the save)
core.save.section("party", { serialize = function(self) return {...} end, deserialize = function(self, t) end, reset? })  -- t may be nil
core.save.configure({ key, version, migrate = function(sections, fromVersion) return sections end })
core.save.onBeforeSave(fn)  core.save.onAfterLoad(fn(sections))  core.save.snapshot()  core.save.restore(snap)
```
Bump `version` when the shape changes; `migrate` receives the sections table (`d.flags`, `d.wallet`, `d.quests`, …). Max 64 KB total.

## Pause, timers
```luau
core.pause.push(reason, scoped?)  core.pause.pop(reason)  core.pause.isPaused()  core.pause.reasons()  core.pause.clock()
  -- gameplay pause (menus, dialogs, hitstop) separate from the platform pause; scoped = auto-released on loadScene
  -- gameplay code: onTick(function(dt) if core.pause.isPaused() then return end ... end)
local cd = core.timers.cooldown(0.5)   cd.use() -> bool (fires if ready)  cd.ready()  cd.remaining()  cd.progress()  cd.reset()  cd.set(s)
core.timers.after(s, fn) / every(s, fn) / countdown(s, onDone, onTick(remaining)?) -> { cancel(), remaining()?, add(s)? }
core.timers.stopwatch() -> { elapsed(), reset() }      -- all on pause.clock(): they stop while core.pause is active
```
Timers belong to the calling script (die with its scene, like `after`).

## Menus — `core.menus` (alias `core.ui`)
Portrait-first, buttons ≥ 96 px, modal (dim + swallow taps, pushes scoped `core.pause` "menu"). Each returns a handle
`{ root, box, close(), isOpen(), refresh(newItems?) }`.
```luau
core.menus.theme({ primary, accent, background, text, dim, disabled, font })     -- mirror dreamsy.toml [ui]
core.menus.list({ title, items = { { label, detail?, disabled?, onSelect(item, h) } }, keepOpen?, perPage? (6), closeLabel? (false = none), onClose? })
core.menus.grid({ title, cells = { { label?, icon? "asset:x", count?, locked?, onSelect(cell, h) } }, columns? (4), rows? (3), cellSize? (136), keepOpen? (true) })
core.menus.confirm(text, onYes?, onNo?, { yes?, no?, title? })
core.menus.tabs({ title, tabs = { { label, build(contentPanel, h) } }, initial?, height? })   h.select(i)
core.menus.toast(text, seconds?)          core.menus.isOpen()
core.menus.panel(parent, props)  core.menus.text(parent, text, props)  core.menus.button(parent, label, onPress, props)   -- building blocks
```
Pagination is automatic. Build rows inside `tabs` with `core.menus.text/button(content, …, { offset = vec2(0, y) })`.

## Extension points (for genre kits)
- Register condition/effect kinds (`level`, `hasCreature`, `partySize`, …) so their content files can use them in quests/dialog.
- `core.save.section(name, obj)` for kit state; `core.events` for kit facts (`battle_won`, `wave_cleared`) that quests/achievements count.
- Item `data` holds genre fields (damage, equip slot, heal); `bag:use` + custom effects implement them.
- Your own inventories (`core.inventory.new({ id = "storage" })`) and private buses (`core.events.new()`).

## Do / don't
- Do keep content in data files and reference ids; validate against `schemas/*.json`.
- Do use `core.events.onScene` for handlers that touch scene entities; plain `on` handlers outlive the scene.
- Do gate gameplay with `core.pause.isPaused()` so menus/dialogs/hitstop freeze it.
- Don't store entities or Vec2 in flags/sections (save is JSON). Don't call `core.setup` twice.
- Don't build pause/settings/volume menus — the platform owns those.
