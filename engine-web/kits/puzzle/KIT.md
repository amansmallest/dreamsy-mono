# puzzle kit

Grid puzzles that last 1–2 hours: a generic board/session framework (undo/redo, restart, moves, par + stars, solver
hints, win/lose, juice) + six mechanics with generators and solvers + level packs (authored and generated along a
difficulty curve, lazily) + star-gated world map, daily puzzle and saved progress. Requires core, progression, juice,
procgen (auto-enabled). Example: `games/examples/kit-puzzle` ("Paper Grid": push, flow, match-3 packs + daily flow).

## Setup
```toml
kits = ["puzzle"]
orientation = "portrait"
```
```luau
local Puzzle = require("@kit/puzzle")
local packs = Puzzle.setup()                 -- loads data/packs/*.json, then core.save.load() (progress)
-- play scene script:
local level = Puzzle.packs.get("push"):level(3)               -- or Puzzle.daily.level("flow", {...})
local s = Puzzle.session(level, { pack = level.pack, index = level.index })
local view = Puzzle.view.new(s, { origin = vec2(40, 300), cell = 96, gap = 6, skin = SKIN, palette = INKS })
local hud = Puzzle.ui.hud(s, { title = "Push 3", icons = ICONS, textColor = "#111111", onHint = function() view:hint() end, onBack = back })
s:on("won", function() Puzzle.record(s) after(0.9, function() Puzzle.ui.result(s, "win", { {"Map", back}, {"Next", nextLevel} }, { icons = ICONS }) end) end)
s:on("lost", function() Puzzle.ui.result(s, "lose", { {"Map", back}, {"Retry", function() s:restart() end} }) end)
```
Keep `Puzzle.setup()` in a shared module (runs once). Scenes: menu (`Puzzle.ui.packList`), levels (`Puzzle.ui.levelGrid`), play.

## Mechanics (`Puzzle.mechanic(id)`)
| id | rules | level (json / `.txt`) | move | par / difficulty param |
|---|---|---|---|---|
| `push` | sokoban: walk, push crates onto goals | XSB text `#` wall `-` floor `@` `+` `$` `*` `.` | `"u"\|"r"\|"d"\|"l"`; tap = step or walk path | solver moves / `pushes` (+`w h boxes walls`) |
| `flow` | link same-letter pairs, no crossing, fill all cells | letters = pairs, `.` empty, `#` blocked | `{color, cells}` full path; drag draws, tap endpoint clears | colours / `w`, `pairs` (fewer pairs = longer pipes = harder) |
| `match3` | swap → 3+; cascades; specials; move limit; objectives | `{w,h,colors,moves,seed,objective,jelly?,grid?}` | `{a, b}` cells; swipe or tap-tap | greedy-solver moves / `goal` score\|jelly\|collect, `moves`, `target` (0..1), `colors`, `jelly` |
| `sliding` | n×n sliding tiles | `"1 2 3\n4 0 5\n7 8 6"` | tile cell index; tap row/col slides a run | optimal moves / `moves`, `n` |
| `lights` | tap toggles cell + 4 neighbours; clear all | `o` lit `.` off | cell index | min presses (GF(2)) / `presses`, `w` |
| `nonogram` | fill cells to match row/column runs | `#` filled `.` empty | `{i, v=0\|1\|2}`; tap cycles fill/cross, drag paints | filled cells / `w`, `density` (line-solvable only) |

Match-3 specials: 4 in a row → `line_h`/`line_v` (clears row/column), L/T → `bomb` (3×3), 5 → colour `orb` (swap with a gem:
clears that colour; orb+orb clears the board); two specials swapped fire both. Score 10×cascade per gem (+30×cascade per special
fired), unused moves ×`bonus` (60) on win. Objectives: `{score=n}` · `{jelly=true}` (clear all jelly) · `{collect={["2"]=20}}`.
The refill RNG lives in the state: same level + same moves ⇒ same board (replays, tests, hints).

Every mechanic: `parse(text)` · `load(level) → state` · `apply(state, move) → ok, info` · `isWon(state)` · `isLost?` ·
`solve(state, opts, session) → {moves}` · `generate(params) → level` (with `par`, `difficulty`, `solution?`) ·
`tap(state, x, y, view)` / `swipe(state, x, y, dir)` / `drag(state, cells)` → move · `render(state) → items` ·
`hintCells(state, move)` · `status(state) → string`. Extras: `push.toText`, `flow.solveLevel(level, {maxNodes})`,
`match3.validMoves/bestMove/findGroups/calibrate`, `nonogram.clues/solveLine/solveClues`.
**Custom mechanic:** `Puzzle.register({ id, load, apply, isWon, render, solve?, generate?, tap?, swipe?, drag?, stars?, stochastic? })`
— build state on `Puzzle.board` (below) and everything else (sessions, undo, hints, packs, view, HUD) just works.

## Board — `Puzzle.board`
`B.new(w, h)` · `b:layer(name, fill)` (flat 1-based array) · `b:get/set(layer, x, y)` (0-based cells) · `b:index(x, y)` · `b:xy(i)` ·
`b:inside` · `b:neighbors(x, y) → {x,y,dir,i}` · `b:adjacent(i, j)` · `b:fill` · `b:count` · pieces `b:addPiece(kind, x, y, props)` (stable `id`) ·
`pieceAt(x, y, kind?)` · `piecesOf(kind?)` · `movePiece` · `removePiece` · `b:key(layers?)` · `B.fromRows(text, legend)` · `b:toRows(fn)` ·
`B.copy(v)` (deep, keeps metatables) · `B.equal(a, b)` · `B.DIRS` `B.ORDER`.

## Session — `Puzzle.session(level, opts?)` / `Puzzle.session(mechanic, level, opts?)`
`s:apply(move) → ok, info` (invalid = no change; `{m1, m2, steps = true}` = one undo step) · `s:undo()` `s:redo()` `s:canUndo()`
`s:restart()` · `s:hint() → move` (solver; plan cached while followed; counts `s.hintsUsed`) · `s:step()` (apply the hint) ·
`s:solve()` · `s:stars()` (0 until won) · `s:render()` · `s:status()` · fields `state moves par won lost level mech history`.
Stars: par mechanics `level.stars = {3★ max moves, 2★ max moves}` (default `{par, ceil(1.5·par)}`); match3 by score
`level.stars = {2★, 3★}`; `opts.hintPenalty` stars per hint. Events `s:on(name, fn)`: `moved {move, info, moves}` · `invalid` · `won {stars, moves, par}` ·
`lost` · `undone` · `redone` · `restarted` · `hint`. Core events: `puzzle_won {mechanic, pack, level, stars, moves}`, `puzzle_lost`, `puzzle_stars` (quests/achievements).
`Puzzle.autoplay(s, max?) → won, n` (headless bot) · `Puzzle.record(s)` (progress / daily).

## View — `Puzzle.view.new(session, opts)` (board rendering + input + feedback)
opts: `origin` (world top-left) · `cell` (96) · `gap` · `palette` (tint colours) · `sfx` (id map or false) · `input` (true) · `skin`:
`skin[kind] = { sprite?, color? ("#hex" | "tint" → palette[item.tint]), size? (cell fraction or {w, h}), onSprite?/onColor? (item.on:
crate on goal, connected endpoint), specials? = {line_h=…}, text? = {size, color, font} } | fn(item) → spec`.
Render kinds — push: `floor wall goal box player` · flow: `cell wall end pipe link_h link_v` · match3: `slot jelly gem orb` (+`item.special`) ·
sliding: `slot tile` · lights: `on off` · nonogram: `cell fill cross clue_row clue_col` · view: `select hint`.
Methods: `view:hint()` (pulses hint cells, returns move) · `view:play(move)` · `view:refresh(animate)` · `view:setSession(s)` ·
`view:cellCenter(x, y)` · `view:cellAt(worldPos)` · `view:size()` · `view:destroy()`. Pieces with ids tween; match3 gems drop in;
cleared cells pop + sparkle; cascades/specials popup + shake; win → confetti. Gestures: tap / swipe (≥0.45 cell) / drag across cells.
Platform leaderboard: the view times each level (`leaderboard.start` when bound, `finish` on win; Retry restarts, a loss
cancels) on board `"level_<pack>_<index>"` / `"level_daily_<day>"` / `"level_<id>"` → engine results card (time, rank, PB).
`board = "name"` overrides, `board = false` opts out; stochastic (score) mechanics like match3 are not timed.
Default sfx ids: `move push bump win lose undo hint match special connect select star` (missing ids are silent).

## UI — `Puzzle.ui` (portrait, themed by `[ui]` via `ui.theme()`, buttons ≥ 112 px)
`hud(s, {title, icons, textColor, statusColor, onHint, onBack, onUndo?, onRestart?, redo?}) → {refresh, setSession, setTitle, destroy, buttons}` ·
`result(s, "win"|"lose", { {label, fn}, … }, {icons, title}) → {close}` (animated stars) ·
`levelGrid(pack, {onPick(i), columns = 4, top = 220, icons})` (scroll; lock/stars per level) ·
`packList(packs, {onPick(pack), extra = { {label, detail, fn, image} }, icons})` (world map; "Need N more stars") ·
`stars(parent, props, icons) → {set(n, pop)}` · `button` `text` `panel`. Icons: `star starEmpty undo restart hint lock back`.

## Packs — `data/packs/<id>.json` (schema `schemas/pack.schema.json`)
```json
{ "name": "Push", "order": 1, "mechanic": "push", "icon": "asset:crate", "unlock": { "stars": 6 },
  "levels": [ "data/levels/push_01.txt", "data/levels/push_02.json", { "text": "#####\n#@$.#\n#####" },
    { "generate": { "count": 120, "seed": 11, "params": { "w": 7, "h": 7, "boxes": 2 },
      "curve": [ { "at": 0, "params": { "pushes": 3 } }, { "at": 0.5, "params": { "pushes": 7, "boxes": 2 } }, { "at": 1, "params": { "pushes": 10, "boxes": 3 } } ] } } ] }
```
Generated runs: level j of `count` gets `curve` params at x = (j−1)/(count−1) (progression difficulty tiers: numbers lerp, strings from
the lower tier) + `params` + seed = seed·1000 + j. Generated on first open (cached), always solvable, `par` from the solver.
`Puzzle.packs.load(dir?)` · `define(id, def)` · `get(id)` · `list()` · `pack:count()` · `pack:level(i)` · `generateRun(mechanic, gen)` · `ensurePar(mech, lv)`.
Unlock: `{stars = n}` (total) · `{stars = n, pack = id}` · `{completed = id}` · any core condition (`{"puzzleStars": 20, "pack"?: "push"}` is registered).
`gate`: `"sequential"` (default: beat i−1 to open i) | `"open"`.

## Progress + daily
`Puzzle.progress`: `record(pack, i, stars, moves)` · `stars(pack, i)` · `best` · `completed` · `packStars(pack)` · `totalStars()` · `isUnlocked(pack)` ·
`starsNeeded(pack)` · `levelUnlocked(pack, i)` · `nextLevel(pack)` — saved as core save section `"puzzle"` (autosaves on record).
`Puzzle.daily`: `level(mechanic, { params?, curve? (tiers over weekday 0 Mon … 6 Sun), salt? })` (seed = hash(day), day = floor(clock.now()/86400):
same puzzle for everyone all day) · `day()` · `weekday()` · `seed()` · `solved()` · `complete(stars)` → streak (progression streak "puzzle_daily") · `streak()` · `nextIn()`.

## How to build a 1–2 h puzzle game
- **Size**: 150–300 levels at 20–40 s each. 3–4 packs × 40–80 levels: 3–5 authored teaching levels per pack, the rest one or two
  `generate` runs. Add a daily (`Puzzle.daily`) for return visits.
- **One mechanic at a time**: pack 1 = one rule set, tiny boards. Each later pack adds ONE idea (new mechanic, or the same with
  more boxes / jelly / fewer pairs). Teach it with an authored level where the new thing is the only thing on the board.
- **Difficulty ramp** (curve per pack, sawtooth across packs — each pack starts easier than the previous one ended):
  push `pushes` 3→7, `boxes` 1→2, 6×6→7×7 for live generation (bigger/harder push levels: author them as data/levels files — live generation of 8×8 / 3 boxes / 10 pushes exceeds the 250 ms script budget) · flow `w` 5→8 with `pairs` ≈ w (fewer = harder) · match3 `goal` score→jelly→collect,
  `moves` 22→14, `target` 0.55→0.85, `colors` 4→5 · sliding `moves` 6→22 (3×3), then 4×4 · lights `presses` 2→8 · nonogram `w` 5→10.
- **Stars**: 3★ = at par (solver optimum; match3: the hint bot's final score), 2★ = within 1.5×. Gate pack k+1 at ≈ 2× its
  predecessor's level count in stars (most players get it with mostly-2★ play). Show "Need N more stars" (packList does).
- **Hints** are always available (solver); use `hintPenalty = 1` if you want hints to cost stars.
- **Budget**: each generated level must build in one script callback (< 250 ms). Measured: push 7×7 ≈ 10–140 ms (bounded by
  `tries` attempts, default 2, then returns the closest difficulty; deterministic, no wall-clock cut-off), flow ≤ 7×7 < 5 ms, match3 calibration 40–70 ms, sliding/lights/nonogram < 15 ms.
  Live-generated sokoban: keep ≤ 7×7, ≤ 2 boxes, ≤ 7 pushes; ship harder push levels as authored data. Open each level in its own scene load.

## Do / don't
- Do keep levels in `data/levels` + `data/packs`; let the solver compute `par` (omit it) unless you want a stricter target.
- Do theme `[ui]` with readable pairs: `text` is drawn on `primary` buttons and on `background` cards; pass `textColor` to the HUD for labels over the scene.
- Do call `Puzzle.record(s)` on win (progress, stars, daily streak, core events).
- Don't hand-edit generated levels in place — change the curve/seed; don't write your own undo, hint or star logic.
- Don't read `input.axis` for puzzles (it shows a joystick); the view handles taps/swipes/drags.
