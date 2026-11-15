# Summer Ride — design notes

## Design
- Side-scroller. Mio rides her bike (cat Mochi in the basket) right along a country road between blue rice fields.
- Bike always pedals forward (cruise 240 px/s). Right = pedal faster (360), Left = brake (120). Jump/action = hop.
- Rocks and puddles: touching one = 'Bump!/Splash!' + slowdown (no death). Peaches float (low = ride through, high = hop).
- Gentle timer per stage ("Train leaves in m:ss"). Timer 0 = lose panel + Try again.
- Stage 1 'Rice Field Road' ends at a signpost -> auto-load stage 2. Stage 2 'Evening Station' (sunset sky, warm tint) ends at the station: Mio stops by the train, boards (fades), train departs -> ending scene.
- Ending: train rides through the sunset with Mio & Mochi in the window, peach total, 'Ride again'.

## Restyle (v2)
- All cameras zoom 3, center y 120; world is in VIRTUAL px (view ~427x240). Sprites displayed 1:1 to their SVG viewBox.
- Layers (backdrop.luau): sky 480x150 y75 f.95, hills(mountains) 480x56 y78 f.85, fields (perspective patchwork) 480x76 y138 f.55, poles 200x150 y101 f0, road 480x40 y186 f0, front hedge+paddy 480x60 y220 f-0.3 z50.
- Ground (wheel contact) y=184. Bike 48x40 (bike_1/2: girl, cat in basket, spokes+legs animate). Rock 16x12, puddle 32x6, peach 12x12.
- title_logo 196x32 pixel-letter logo sprite in the sky. [ui] theme set.
- Audio: data/sfx jump, land, peach, bump, splash, meow, select, bell, lose, whistle; data/music/summer.json (C-Am-F-G, 100bpm).

## Art bible (Summer Fields pack)
- Palette only: #f2ece6 #dedacd #b7c1c2 #81a3c5 #5e7ed6 #3b4a93 #2a3170 #8fbc8c #3d8594 #2f6b5e #e8c27a #c9685a. No black; outline #2a3170.
- Pixel art drawn in art-px, displayed at 3x (Sprite2D size = viewBox*3). Shadows hue-shift to blue/indigo.
- Hero: auburn hair #c9685a, yellow shirt #e8c27a, blue shorts, pink-red bike, white cat, wicker basket.
- Backdrop tiles 432 art px wide (1296 screen): sky_day/sky_evening, hills, fields, poles (160 wide, wires tile), road, front.

## Layout (OLD v1 screen px — superseded by Restyle v2 above)
- Ground (wheel contact) y=552. Road 534..582. Fields top 294. Sky 0..330. Front bank 576..720 (z 50, parallax -0.3).
- Level layout strings in config.luau: one char per 120 px from FIRST_X=900. '.' empty, p low peach, h high peach, r rock, R rock+high peach, w puddle, W puddle+high peach.

## Script map
- shared/config.luau — tunables + stage layouts + totalPeaches().
- shared/state.luau — session peaches.
- shared/backdrop.luau — spawns parallax tiles, update(realCamX, virtualCamX?).
- client/title.luau (title_root), client/ride.luau (ride_root, gameplay for both stages via sceneParams().stage), client/ending.luau (end_root).

## Milestones
- [x] M1 core loop + style sheet (bike, rock, puddle, peach, backdrop, HUD)
- [x] M2 two stages, timer, win/lose, station + train departure
- [x] M3 title + sweet ending
- [x] M4 restyle to Summer Fields reference (zoom 3, 6 parallax layers, new hero, logo, sfx + music)
- [ ] Ideas: more stages (bridge, village), cat meow animation
