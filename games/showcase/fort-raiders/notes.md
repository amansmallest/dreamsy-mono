# Village Raiders
Single-player Clash-like: build a 12x12 village, train troops, raid generated outposts.

## Layout (1280x720)
- Grid (48px tiles, 576px) on the left; camera at (620,300) (config.CAMERA_POS).
- Right side panel (x 650-1270): resources/army/trophies/hint at top, build/train buttons in 3 columns (y 290-578), RAID button at y 590.
- Raid mode swaps village_ui for raid_ui (troop select, End Raid) in the same panel.

## Scripts
- scripts/client/game.luau: all game logic, UI wiring, visuals.
- scripts/shared/config.luau: tunables (buildings, troops, costs, caps).
- scripts/shared/raid_sim.luau: deterministic raid simulation + outpost generator.

## Known gaps
- Result panel is centered on screen and may cover the grid (intended).
