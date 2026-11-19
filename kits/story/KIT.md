# story kit

Visual novels, point-and-click adventures and mysteries. Scripts are plain text an LLM can read and write
(`data/story/*.story.txt`), parsed by the kit into a headless VM; a portrait reading UI renders it. Flags, items,
quests, saves and menus come from **core** (story variables ARE core flags; inventory IS `core.bag`), feel from **juice**.
Example: `games/examples/kit-story` (2 chapters, 3 characters, boathouse room, deduction board, 2 endings).

## Setup
```toml
kits = ["story"]              # core + juice enabled automatically
```
```luau
-- scripts/shared/game.luau (call init() once; guard it — scenes may reload)
local Core = require("@kit/core")
local Story = require("@kit/story")
Core.setup({ theme = { primary = "#2f7f86", accent = "#ffd36b", background = "#1c1a2b", text = "#f5efe2", font = "rounded" },
             save = { key = "mygame", version = 1 } })     -- items from data/items/*.json
Story.setup()                                               -- reads data/story/** via data.list/data.read
-- scripts/client/main.luau (attached to the scene root)
local UI = require("@kit/story/ui")
UI.title(Story, { title = "Lanternlight", subtitle = "…", background = "harbor", music = "tide",
                  onStart = function(slot) Story.play({ resume = slot }) end })   -- slot nil = new game, "auto" = continue
```

## Files
| path | what |
|---|---|
| `data/story/*.story.txt` | scripts, parsed in file-name order (`01_ch1.story.txt`, `02_ch2…`); labels are global |
| `data/story/story.json` | `title, start, characters, backgrounds, cgs, endings, clues, combine, cantUse, ui` (`schemas/story.schema.json`) |
| `data/story/characters/<id>.json` | `{ name, color, default, position, expressions = {expr = "asset:x"}, size?, affection? {min,max} }` |
| `data/story/rooms/<id>.json` | point-and-click scene (`schemas/room.schema.json`) |
| `data/story/boards/<id>.json` | deduction board (`schemas/board.schema.json`) |
| `data/story/clues/<id>.json` | `{ name, text, icon? }` (or `story.json clues`) |
| `data/items/<id>.json` | core items `{ name, icon, description, stack }` — what rooms give/take |
Asset defaults when not mapped: background `bg_<id>`, CG `cg_<id>`, character `<char>_<expr>`. `@bg #102030` = flat color.

## Script format (`.story.txt`, one statement per line, indentation ignored)
```
# comment            // comment
@chapter ch1 "The Dark Lamp"          chapter marker (title card; chapters gallery; slot label)
@label start                           jump target
@bg harbor fade                        background (+ transition: fade | none)
@show mira happy left                  show/move character: [expr] [farleft|left|midleft|center|midright|right|farright]
@hide mira | @hide all
Mira: Hello, {$name}.                  dialog (speaker = character id or name; unknown names allowed, e.g. "Old Man:")
Mira (worried): It's cold.             dialog + expression change
The fog rolls in.                      narration (any other line; "> Mira: x" forces narration)
* Open the box -> box {if has key}               choice block (consecutive * lines); -> label optional (else falls through)
* Ask about the lamp -> lamp {req aff mira >= 5} {hint Needs trust}   {req} = shown locked; {if} = hidden
* Wait {set waited} {aff mira 1} {once}          inline {commands} run when chosen; {once} = disappears after use
@if trust >= 2 and not cursed / @elseif cond / @else / @endif     (nestable)
@set k | @set k = 3 | @set name = "Ash"   @unset k   @add k 1   @sub k 1
@aff mira 2                            affection meter (flag aff_mira, clamped to character affection min/max)
@give lantern 1 | @take lantern        core.bag      @earn gold 5 | @spend gold 5 (core.wallet)   @quest id start
@goto label | @call label | @return    subroutines (@back = @return)
@cg storm | @hidecg                    full-screen picture (recorded in the CG gallery)
@music tide | @music stop   @sfx door   @shake medium   @flash #ffffff   @wait 0.8   @toast text
@clue knife_mark                       add to the journal (event clue_found)
@explore boathouse                     open a point-and-click room (VM stays here until a hotspot `go`es)
@deduce who_did_it                     open a deduction board (solved → board.solved label, failed → board.failed)
@end keeper "Keeper's Light"           ending (title from story.json endings if omitted; gallery; event story_ended)
@autosave                              save to slot "auto"   @emit event   @unlock achievement   @note text (ignored)
```
Text interpolation: `{$flag}`, `{$item:id}` (count). Unknown labels/rooms/boards/clues/endings → `Story.validate()`.

**Expressions** (`@if`, `{if}`, `{req}`, room `if`) compile to core conditions:
`flag` · `flag >= 3` (`== != > < >= <=`, numbers/true/false/"strings") · `not x` · `a and b or (c)` · `has item [n]` ·
`aff mira >= 3` · `clue id` · `visited label` · `ending id` (any playthrough, gallery) · `solved board` · `found conclusion` · `chance 0.3`.
JSON fields taking a condition also accept core condition objects; effects accept command strings or core effect objects.

## Rooms (point-and-click) — `data/story/rooms/<id>.json`
```json
{ "name": "The Boathouse", "background": "asset:bg_boathouse", "hint": "Tap things to look; tap an item, then a thing, to use it.",
  "hotspots": [
    { "id": "net", "name": "Old net", "rect": [36, 300, 240, 200], "sprite": "asset:obj_net", "look": "A key in the net!", "take": "brass_key" },
    { "id": "ledger", "name": "Ledger", "rect": [480, 290, 160, 200], "look": "@bh_ledger" },
    { "id": "toolbox", "rect": [50, 640, 220, 150], "if": "not toolbox_open", "look": "Locked.",
      "use": { "brass_key": { "text": ["Click."], "effects": ["give wick", "clue shears_oil", "set toolbox_open"], "consume": true },
               "*": { "text": "You need a key." } } },
    { "id": "door", "name": "Back", "rect": [290, 290, 150, 250], "if": "has oiled_wick", "go": "ch1_out" },
    { "id": "prints", "rect": [230, 860, 260, 120], "look": "Wet prints.", "clue": "wet_prints" } ] }
```
rect = `[x, y, w, h]` screen px (720×1280; keep above y 1100 — inventory bar). Tap: `take` (item + hotspot hides) → `look` text
(or `"@label"` = call a script that ends with `@return`) → `clue`/`effects` → `call`/`go`. With an item selected: `use[item]` or
`use["*"]` (`text, effects, consume, remove, call, go`), else `story.json cantUse`. Two items tapped in a row = combine
(`story.json combine: [{ items: [a, b], result, text, effects?, keep? }]`).

## Deduction boards — `data/story/boards/<id>.json`
`{ title, prompt?, clues? (offered ids; default all found), links: [{ id, clues: [a, b], text, effects? }], need? (link ids; default all),
question?: { text, options: [{ text, correct? }] }, mistakes? (max wrong tries), solved: "label", failed?: "label" }` —
player taps two clues to link them; all `need` links found → question (or solved at once if none).

## Lua API
```luau
Story.setup(opts?) -> Story   -- opts { content? = {config, scripts, characters, rooms, boards, clues} (tests), commands? = {name = fn(vm, args, cmd) -> event?}, start?, galleryKey? }
Story.start(label?) -> vm     -- Core.newGame() + VM at label (story.json start, else first label)
Story.step() -> event         -- { kind = "say", speaker?, char?, expr?, text, color? } | { kind = "choice", options = {{text, index, locked, hint}} }
                              --   | { kind = "wait", seconds } | { kind = "explore", room } | { kind = "deduce", board } | { kind = "end", ending = {id,title,text} } | { kind = "done" }
Story.choose(i) -> bool       Story.event()  Story.jump(label)  Story.backlog() -> {{speaker, text, kind}}  Story.stage() -> {bg, chars={id={expr,pos}}, cg, music}
Story.clues() -> {{id, name, text, icon}}   Story.affection(char) -> n   Story.chapters()   Story.words()   Story.validate() -> {problems}
Story.command(name, fn)       -- custom @command / {command}
-- rooms / boards (headless; the UI calls these)
Story.room(id?) -> room (room:hotspots(), room:get(id))   Story.tap(hotspot, item?) -> { ok, lines, took?, used?, call?, jump? } (performs call/jump)
Story.combine(a, b) -> { ok, lines, result? }
Story.board(id?) -> board (board:clues() :found() :need() :status() "linking"|"question"|"solved"|"failed")
Story.connect(a, b) -> { ok, link?, again?, mistakes, solved?, failed?, jump? }   Story.answer(i) -> { ok, solved?, failed?, jump? }
-- saves (core.save slots "story_<slot>": flags, bag, quests, + VM section "story": position, stack, stage, backlog, clues, boards)
Story.save(slot?) Story.load(slot?) Story.hasSave(slot?) Story.deleteSave(slot?) Story.slots(n?) -> {{slot, exists, chapter, text}}
-- gallery (persistent across new games + slots; engine save key "story_gallery")
Story.gallery() (:hasEnding :hasCg :hasChapter :reset)   Story.endings() / Story.cgs() -> {{id, def, seen}}
Story.bgImage(id) Story.cgImage(id) Story.charImage(char, expr)
Story.autoplay({ pick?(options, vm) -> i, room?(Story, id), board?(Story, id), maxSteps? }) -> { ending?, done?, stuck?, lines, log }   -- bots / tests
-- UI (require("@kit/story/ui") or Story.play)
Story.play({ start?, resume? (slot), continue?, cps? (45), autoDelay? (1.4), onEnd?(ending, view), onTitle?(), labels? (true), menu? (true), charSize? }) -> view
UI.title(Story, { title, subtitle?, background?, music?, onStart(slot?) })   UI.backlog(Story) UI.menu(Story, view) UI.slots(Story, "save"|"load", view) UI.gallery(Story) UI.journal(Story)
UI.sfx = { tap, choice, clue, item, ending, wrong, right, text? }   -- data/sfx ids (missing ids are ignored)
```
Core conditions registered: `storyClue`, `storyVisited`, `storyEnding`, `storySolved`, `storyConclusion`.
Core events: `chapter_started` {chapter}, `story_choice` {text, target}, `affection_changed` {character, value, delta}, `clue_found` {clue},
`hotspot_tapped`, `item_used_on`, `items_combined`, `conclusion_found`, `board_solved`, `story_ended` {ending} — quests/achievements can count them.

Reading UI (portrait): background → characters (bottom-aligned behind the text box) → CG → text box (y 930–1240, name plate,
typewriter, tap to finish/advance) → choices stacked above the box → top bar Log / Auto / Skip / Menu (Save, Load, Journal with clues +
affection hearts, Gallery). Rooms: hotspot sprites + name tags, inventory bar at y 1100. Boards: 2-column clue cards, found conclusions,
mistakes counter, final question. Chapter title cards and an ending card (endings found n/m, Gallery, Title).

## How to build a 1–2 h game
- **Content**: 20–40k words across 5–8 chapters (one `NN_name.story.txt` per chapter, 3–6k words each), 3–6 characters × 3–5 expressions,
  6–12 backgrounds, 4–8 CGs, 3+ endings (one per major route + a bad end), 2–4 rooms (6–10 hotspots, 1–2 item puzzles each),
  1–3 deduction boards (3–5 links, 6–10 clues). Typical reading speed ≈ 250 words/min → 30k words ≈ 2 h.
- **Structure**: hub-and-spoke chapters. Every choice either moves an affection meter, sets a flag that pays off later (`@if`), or
  branches for a few lines then rejoins. Route locks at the last chapter with `@if aff x >= N and solved board`. Use `{req}` (shown locked)
  for "you could have done this" and `{if}` to hide options; `{once}` for investigation menus that loop back to themselves.
- Put `@autosave` at every chapter start; give each ending an `endings` entry (gallery shows ??? for unseen) and use `ending x` in
  later playthroughs for New Game+ lines.
- Verify with `Story.validate()` (no problems) and `Story.autoplay` bots that reach every ending (one pick policy per route).

## Do / don't
- Do write one line per text box (≤ ~220 chars). Do keep labels lowercase_snake and unique across files.
- Do end every hotspot script with `@return`; exits use `"go"`. Don't put `@explore` targets' content after the `@explore` line (it never falls through).
- Don't store story state yourself: flags/bag/VM are saved by core slots; the gallery persists on its own.
- Don't build pause/settings UI (platform owns it). Don't call `Story.setup`/`Core.setup` twice (guard your init).
