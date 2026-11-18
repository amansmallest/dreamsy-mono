# Cloud Hopper — design notes

2.5D oblique platformer (portrait). Pip the explorer hops across floating stone blocks above a sea of clouds.

## Core loop
- Joystick moves on the ground plane; A = jump (z_velocity 420, ~90px peak). Blocks: static Body2D with `height` + Sprite2D child (same size/height).
- Height unit = 24px. Max climb step = 48 (2 units). Taller blocks are climbed like stairs.
- Cloud sea = z 0: landing there (onGround, groundZ 0) = fall -> puff, -1 heart, respawn on last checkpoint (drop in from +70). 3 hearts per level; 0 -> Out of hearts panel (Retry / Title).
- Gems: Area2D with z/height (low gem top+6 walk-in, high gem top+54 needs a jump). Pickup is checked manually in level.luau (xy box + z overlap).
- Goal flag block (F) ends a level; level 3 -> win scene.
- Crumble blocks (X): shake 0.6s after first stand, then layer->ghost + tween z down + fade. Reset on respawn.
- Spring (S): standing on it sets hero z_velocity = 680 (peak ~236 above).

## Levels (data/levels/level_N.json)
rows = top->bottom, tokens space-separated, 7 cols of 64px. Token = hex height digit (x24px) + flags:
P start, C checkpoint, F goal, X crumble, S spring, g low gem, j high gem, n narrow (40px wide), w shallow (40px deep). `.` = empty.
hints: [{row, text}] shown when the hero first reaches row <= row. intro: dialog lines. start_hint, idle_hint.
Rules (SPEED 185, verified by playtest): up steps <= +48 only with <=1 empty cell gap; 2-cell gaps only when dropping >= 24. Every landing after a gap is >= 2 rows deep (a full-speed jump travels ~130-200px). Stairs of +48 single rows work because the next wall stops overshoot. Paths ascend up the screen so front blocks never hide the hero.
Test any segment with sceneParams {level, skipIntro=true, startCol, startRow}; set config DEBUG=true for land/fell/gem logs.
1 Stepping Stones (staircase, small gaps, high gem) 3 gems
2 Sky Tower (2-cell gaps, narrow stair ledges, 216px tower with gems) 6 gems
3 Crumble Heights (crumbles, two springs) 5 gems

## ART BIBLE (toon)
- Outline #2b2140 (deep plum), 2-3px, round joins. Flat fills + one shade tone, light from top-left.
- Stone tops #f6d79f / rim #e8b878 / cracks #d29a5c; grass #7ccf5a; gold goal #ffd84a/#f2b632; crumble #efa47f/#8e3f2a; spring red #e2563f + white; rune blue #3a8fd6.
- Sky gradient #5fb2ee -> #c6ebff; clouds white with #cfe2f5 underside (no outline, soft); far islands hazy #a9c3e6.
- Hero Pip 40x50: red cap #e2563f + goggles #8fe3ff, orange scarf #ffb03a, blue tunic #3f7fd6, brown boots. Faces right.
- Gems pink #ff5fa8. Hearts #ff4d6d. UI: navy panels #1d3a6b, orange buttons #ff8a3d, rounded font.
- z_index: sky -20, far islands -15, clouds -10, world 0, fx 40+.

## Script map
- scripts/shared/config.luau — tunables. run.luau — session state (level, gems per level, frozen, fell/fx hooks). decor.luau — sky/cloud/block spawners.
- scripts/client/level.luau (level_root) — builds level from JSON, camera target, hints, gems, checkpoints, crumbles, springs, hearts, win/lose, HUD.
- scripts/client/hero.luau (hero) — movement, jump buffer + coyote, anims, squash, fall detection -> run.fell().
- scripts/client/title.luau, win.luau — menus.
- Scenes: main (title), level (params {level=n, startCol?, startRow?, skipIntro?}), win.
- Save: unlocked, gems_N, tutorial_done. Leaderboard board full_run (start at level 1 begin, finish on win scene).

## Milestones
- [x] 1 Core loop: hero, blocks, jump, fall/respawn, HUD, style sheet
- [x] 2 Three levels + gems + checkpoints + crumbles + springs
- [x] 3 Title, win screen, sounds, music, tutorial hints
- [ ] 4 Polish ideas: moving platforms, wind gusts, more levels, time-trial medals
