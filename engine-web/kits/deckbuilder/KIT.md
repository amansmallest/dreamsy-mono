# deckbuilder kit

Card battler with runs (Slay-the-Spire-like): cards in a compact effect language, energy + draw/discard/exhaust piles,
enemies with intent patterns, statuses, relics, procgen act maps (fights/elites/events/shops/rest/treasure/boss), rewards,
upgrades/removal, multiple characters, meta unlocks, a greedy bot + balance sim, and a portrait UI that runs the whole loop.
Requires core, progression, juice, combat (turn damage formula), procgen (rng, encounter budgets). Example: `games/examples/kit-deckbuilder`.

## Setup
```toml
kits = ["deckbuilder"]       # core/progression/juice/combat/procgen come with it
```
```luau
-- scripts/client/main.luau (attached to the entry scene root)
local Core = require("@kit/core")
local DB = require("@kit/deckbuilder")
Core.setup({ save = { key = "mygame", version = 1 } })   -- core save slot also stores the run (section "deckbuilder")
DB.setup()                                              -- reads data/cards|enemies|relics|characters|events|acts + data/deckbuilder.json
DB.ui.play({ title = "My Game", subtitle = "...", logo = "asset:logo", background = "asset:bg", heroSprite = "asset:hero",
  nodeIcons = { fight = "asset:nd_fight", elite = …, rest = …, shop = …, event = …, treasure = …, boss = … },
  intentIcons = { attack = "asset:in_attack", defend = …, buff = …, debuff = …, attack_defend = …, attack_debuff = …, attack_buff = …, unknown = … },
  music = { title = "map", map = "map", battle = "battle", boss = "boss" }, restArt = "asset:fire", restTitle = "Campfire", shopTitle = "Shop",
  character = nil (first character / title picks), locked = false (true: respect meta unlocks) })
```
`DB.setup({ content = { cards = {...}, enemies = …, relics = …, characters = …, events = …, acts = …, config = … } })` takes the same data as a
table (lists or id maps). Unknown refs (deck cards, pattern moves, act enemies/events) are errors listing every problem (`config.strict = false` to relax).
Without icons the UI falls back to glyphs/letters. All sfx are optional (`juice.sfx`): card hit hurt block buy win lose select heal power deny.

## Effect language (cards, enemy moves, relics, statuses, events)
One string per effect, run in order. Targets: `target` (chosen enemy / the player for enemies) · `all` (all hostiles) · `random` · `self` · `allies`.
| effect | meaning |
|---|---|
| `damage N [xH] [target\|all\|random\|self]` | attack: +Strength, ×0.75 Weak (attacker), ×1.5 Vulnerable (target), block first, Thorns reflect |
| `block N [allies]` | +Dexterity, ×0.75 Frail |
| `draw N` · `energy N` · `heal N` · `lose_hp N [who]` (ignores block) · `gold N` (negative ok) · `max_hp N` | |
| `apply STATUS N [who]` (default target) · `remove STATUS [who]` · `double STATUS [who]` | Artifact negates debuffs |
| `discard N` · `exhaust N` | random cards from hand |
| `add CARD [hand\|draw\|discard\|deck] [N]` | create cards (enemy "Ash" statuses, shivs; `deck` = permanent) |
| `upgrade hand\|random` | upgrade cards in hand |
| `relic ID\|random` · `card ID\|random [rarity]` · `remove_card N` · `upgrade_deck N` | run-level (events, pickups) |
| `if COND then EFFECT` | `COND` = `[not] LHS [op RHS]`; LHS: `killed` (an earlier effect killed), `target.S`/`self.S` (status stacks, `hp`, `block`, `maxhp`), `hand` `energy` `hp` `gold` `turn` `block` `draw` `discard` `exhaust` `X` `cards_played` `attacks_played`; RHS number or `N%` (of max HP) |
Numbers: `6` · `X` (energy spent on an X-cost card) · `X+1` · `$block` `$hand` `$target.poison` `$self.strength` `$stacks` (status effects) · `$var*2`.
Unknown verbs are errors at parse time. `DB.effects.describe(str, C)` makes card text; `DB.card(id, up).text` is auto-generated when `text` is omitted.

## Content files (schemas/*.json)
- `data/cards/<id>.json` — `{ name, cost: 0..9 | "X" | -1 (unplayable), type: attack|skill|power|status|curse, target?: enemy|all|self|none (inferred),
  rarity: basic|common|uncommon|rare|special, character?: id ("none" = never in rewards), effects: [..], text?, art?: "asset:x",
  exhaust?, retain?, ethereal?, innate?, condition?, unlock?: metaLevel, upgrade?: { overrides } }` — no `upgrade` = auto (+3 first damage/block,
  else +1 to the first number). Powers stay in play: give them `apply <status> N self` with a custom status (below).
- `data/enemies/<id>.json` — `{ name, hp: n | [min,max], tier: normal|elite|boss, act?: actId|index, cost? (encounter budget; 1, elites 4), weight?,
  minRow?, maxRow?, sprite?, start?: [effects at battle start], first?: moveId, moves: { id: { name?, intent?, effects } },
  pattern: { kind: "cycle", moves } | { kind: "random", weights, noRepeat = 2 } | { kind: "sequence", moves, then: pattern } }`.
  Intent kind is inferred from effects (attack, attack_defend, attack_debuff, attack_buff, defend, buff, debuff); the UI shows damage after modifiers.
- `data/relics/<id>.json` — `{ name, rarity: starter|common|uncommon|rare|boss|shop|special, text, icon, character?, unlock?,
  on: pickup|battle_start|turn_start|turn_end|card_played|attack_played|skill_played|power_played|enemy_killed|battle_end|shuffle|hp_lost,
  effects, every?: n (counter, persists across fights), first?: (turn 1 only), condition?, card?: type filter, triggers?: [{…same}],
  mods?: { max_energy, draw, max_hp, gold } }`.
- `data/characters/<id>.json` — `{ name, hp, energy = 3, draw = 5, gold = 99, deck: [cardIds], relics: [ids], sprite?, unlock? }`.
  Card rewards come from cards with `character` = this id (or none set).
- `data/events/<id>.json` — `{ name, text, image?, act?, choices: [ { text, effects?, condition?: "gold >= 60", result?: text, fight?: [enemyIds] } ] }`.
- `data/acts/<id>.json` — `{ name, order, rows = 12, cols = 7, paths = 6, weights?: { fight, event, elite, rest, shop }, rules?: { eliteFrom = 5,
  restFrom = 5, treasureRow (mid), restBeforeBoss = true }, bosses: [ids], encounters?: { weak|normal|elite|boss: [ [ids] | {enemies, weight} ] },
  budget?: { fight = [2,5], elite = [4,7] } (generated encounters: procgen.waves.encounter over this act's enemies, budget ramps by row),
  maxEnemies = 3, events?: [ids], background? }`. `encounters.weak` is used for the first `weakFights` (3) rows.
- `data/deckbuilder.json` — `{ statuses: { name: { text, icon?, debuff?, decay? (−1 at owner's turn end), turnStart?: [effects], turnEnd?: [effects] } },
  rarity: { fight|elite|boss|shop: { common, uncommon, rare } }, relicRarity, gold: { fight = [10,20], elite, boss }, cardChoices = 3,
  cardPrice, relicPrice, removePrice = 75, removeStep = 25, shopCards = 5, shopRelics = 2, restHeal = 0.3, budget, weakFights, meta: { curve } }`.
Built-in statuses: weak, vulnerable, frail (decay), poison (turn start, −1), strength, dexterity, regen (turn end, −1), thorns, metallicize,
ritual (+Strength at turn end), artifact. Custom example: `"ember": { "turnEnd": ["damage $stacks all"] }`.

## Battle — `DB.Battle` (headless, deterministic per seed)
```luau
local b = DB.Battle.new({ C = DB.content(), seed, deck = { {id, up?} }, enemies = { "rat", "rat" }, player = { hp, maxHp?, energy, draw }, relics?, run? })
b:start()                     -- start effects, battle_start relics, intents, turn 1
b:canPlay(i) -> ok, reason ("energy"|"unplayable"|"condition"|"not your turn")     b:play(handIndex, enemyIndex|unit?) -> ok, reason
b:endTurn()                   -- discard (retain stays, ethereal exhausts), statuses, every enemy acts, new intents, next turn
b.state  "player"|"won"|"lost"   b.turn b.energy b.maxEnergy b.drawCount b.hand b.drawPile b.discard b.exhausted b.powers b.player b.enemies
b:alive()  b:incoming() (intent damage total)  b:costOf(card)  b:def(card)  b:piles() (ids per pile)  b:draw(n)  b:applyStatus(u, s, n)
b:calcDamage(src, tgt, base, isAttack)  b:gainBlock(u, n)  b:heal(u, n)  b:chooseMove(e)  b:refreshIntents()
b:on(event, fn)  -- damage {src,tgt,amount,blocked} block status heal draw shuffle discard exhaust add card_played enemy_move intent
                 -- enemy_killed relic turn_start enemy_turn battle_start won lost  ("*" = all)
```
Enemy unit: `{ id, enemyId, def, name, hp, maxHp, block, statuses, intent = {move, kind, name, damage?, hits?}, history, dead }`.
RNG streams: `procgen.rng(seed)` forks "shuffle", "ai", "fx" — UI timing never changes outcomes.

## Run — `DB.newRun({ character?, seed?, locked? })` → `DB.current` (or `DB.Run.new({ C, character, seed, unlockLevel? })`)
```luau
run.state  "map"|"battle"|"reward"|"shop"|"rest"|"event"|"won"|"lost"
run.hp run.maxHp run.gold run.deck ({id, up, uid}) run.relics run.floor run.actIndex run:act() run.map run.pos run.path run.stats
run:choices() -> nodeIds          run:go(nodeId)            -- enters the node (battle starts at run.battle)
run:afterBattle()                 -- after battle won/lost: rewards (gold, 3 cards, elite relic, boss relic choice) or "lost"
run:takeGold() run:takeCard(i) run:skipCards() run:takeRelic(i?) run:leave()   -- leave after a boss -> next act or "won"
run:buyCard(i) run:buyRelic(i) run:buyRemoval(deckIndex?)   (run.shop = { cards = {{id, price, sold}}, relics, removePrice, removed })
run:rest("heal") | run:rest("upgrade", deckIndex)          run:eventChoices() -> {{index, text, locked}}   run:eventChoose(i)
run:addCard(id, up?) run:removeCardAt(i) run:upgradeCardAt(i) run:addRelic(id) run:worstCard() run:deckPower() run:score()
run:cardPool(rarity) run:rollCards(n, kind, rng) run:relicPool(rarities) run:serialize() / DB.Run.restore(C, t)
run:on(name, fn)   -- card_added card_removed card_upgraded relic_added act_started node_entered battle_started battle_won
                   -- enemy_defeated card_played gold_gained rested event_choice run_ended
```
Run facts also go to `core.emit` (quests/achievements can count `battle_won`, `enemy_defeated`, `card_played`, `run_ended`…; `DB.setup({events=false})` to mute).
Every random choice is `procgen.rng(seed .. ":" .. label)`: same seed ⇒ same map, encounters, rewards, shops. Save: `core.save.save()` stores the run
(section "deckbuilder"); a fight in progress restarts from its first turn on load. The UI autosaves between screens and deletes the save at the end.

## Map — `DB.Map.generate({ seed|rng, rows, cols, paths, weights?, rules? })` / `DB.Map.check(map) -> { ok, problems }`
Bottom-to-top non-crossing paths; row 1 fights, treasure mid-act, rest before the boss, no elites/rests before `eliteFrom`/`restFrom`, no
elite/rest/shop twice in a row. `check` = BFS: every node reachable from a start and reaching the boss, no crossings/skips.

## Meta progression — `DB.meta` (engine save key "deckbuilder_meta", survives runs)
`get() -> {xp, runs, wins, best}` · `level()` (progression curve, `config.meta.curve`) · `record(run)` (auto on run end) · `unlocked(def)` ·
`unlocksAt(level) -> {cards, relics, characters}`. Content with `unlock: N` appears only at meta level ≥ N when runs start with `locked = true`.

## Bot + balance — `DB.bot`, `DB.sim`
```luau
local rep = DB.sim({ character?, seeds = 40, startSeed = 1 })   -- greedy bot plays N seeded runs
print(DB.bot.format(rep))   -- "runs 60 winRate 40% avgFloor 12.9 avgTurns/fight 2.9 deaths {boss=33,...} power[floor:value/deck] ..."
rep.winRate rep.avgFloor rep.avgTurns rep.deaths {enemyId = n} rep.power { {floor, power, size} } rep.results { {seed, won, floor, hp, deck} }
DB.bot.playTurn(b) DB.bot.fight(b) DB.bot.step(run) DB.bot.playRun(run)   DB.Run.cardValue(C, id, up) (heuristic power)
```
Targets for a shippable act: greedy bot win rate 30–60% per act (players beat the bot), 3–6 turns per normal fight, deaths spread over elites +
boss (not one wall), deck power rising each floor. Tune hp/budgets/boss numbers, not the bot.

## UI — `DB.ui` (portrait 720×1280; call from a scene script)
`play(opts)` runs title → map → battle → reward/shop/rest/event → ending. Builders for custom flows: `title(o)` `map(run, o)` `battle(run, b, {onDone})`
`rewards(run, o)` `shop(run, o)` `rest(run, o)` `event(run, o)` `deck(run, {title, filter?, onPick?(i), preview? "upgrade"})` `ending(run, {onAgain})`
`card(parent, def, x, y, {w = 150, z, onTap, price?, dim?})` `hud(root, run)` + `UI.TYPE_COLORS/RARITY_COLORS/sfx` tables. Battle: tap a card to lift it,
tap an enemy (or the card again for untargeted cards); dragging a lifted card above y 800 and releasing plays it. Top-right 100 px stays free.

## How to build a 1–2 h game
- **Content counts**: 2–3 characters × 60–100 cards total (per character: 10 basic deck slots of 2–3 basics, ~20 common, ~15 uncommon, ~8 rare),
  3 acts (rows 12–15 each), 25+ enemies (per act: 5–7 normals, 2–3 elites, 1–2 bosses), 20+ relics (starter per character, ~8 common, ~6 uncommon,
  ~4 rare, 3+ boss, 2 shop), 12+ events (4 per act), 2–4 custom statuses. A run ≈ 40–50 min; several runs + meta unlocks (cards/relics/characters at
  meta levels 2–6) reach 1–2 h.
- **Archetypes**: give each character 2–3 synergies the reward pool can build toward (e.g. poison + double, block + `$block` damage, powers + custom
  status). Every rare should change how a run plays.
- **Enemies**: each has a readable pattern (cycle/sequence) or weighted random with `noRepeat`; mix attack/defend/buff/debuff; elites gate
  relics; bosses use `sequence` → `cycle` with a telegraphed big hit. Scale act 2/3 via hp, budgets and `start` buffs.
- **Balance loop**: `DB.sim({ seeds = 60 })` after every content batch; check win rate, turns per fight and the death table.
- **Do**: keep every number in data; use `if … then …` conditions instead of custom code; give powers a status with `turnStart/turnEnd`.
- **Don't**: rely on `random()` for gameplay (use the run/battle rng); edit `run.deck` directly while a battle is live; give cards paid randomness.
