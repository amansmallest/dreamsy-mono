# City Rush — design notes

## Design
- Top-down arcade street racer. 3 laps on a looping city highway vs 5 rivals.
- Controls: stick/arrows = point where you want to drive (absolute steering, throttle = stick amount). Action (or jump) = hold to boost.
- Boost meter refills while drifting (hard turns at speed) and on clean overtakes (+100 pts, no hit in last 1.2s; dirty pass +50).
- Hazards: guard rails (bounce + sparks), oil slicks (spin out), car bumps.
- Flow: title (scenes/main) -> race (scenes/race) countdown 3-2-1-GO -> 3 laps -> results panel (place, time, best lap, points, Play again / Title).
- Place bonus points added at finish.

## ART BIBLE
- Palette (pack arcade-racer): #3b3338 outline/dark, #605c59 #716660 asphalt, #938273 #a2a7a1 greys, #d9c598 #c6955b sand, #e0a030 #ffd84a yellow/orange posts, #87524b brown, #d8403a red, #3a6fd8 blue, #3fb04a green, #f4f4f0 white.
- All sprites drawn at design px and shown at 2x (car 16x24 -> 32x48; road cell 128 -> 256; corner 256 -> 512; buildings 48 -> 96).
- 1px #3b3338 outline, light from top-left (white highlight left/top, shade right/bottom).
- Road warm grey #716660, rails grey with orange posts, lane dashes #a2a7a1, painted arrows #d9c598.
- Ground sand #c6955b packed with rooftops (warehouse grey, containers blue/red, brown, white, small).

## Track
- scripts/shared/track.luau: turtle PROGRAM of straights (1 cell=256px) and 90° corners (centerline radius 384, sprite 512). Builds pieces + polyline; closest(x,y,hint), pointAt(s), distance, bounds, startS (finish line), cornerStarts.

## Script map
- scripts/shared/config.luau: tunables (speeds, grip, boost, points).
- scripts/shared/state.luau: session best lap/time.
- scripts/client/title.luau: title scroller + start.
- scripts/client/race.luau: everything in race (world build, cars physics, AI, collisions, laps, HUD, results).

## Perf
- Scenery uses 256px city-block sprites (block_a/b) far from road and 128px single buildings near it, grouped into 1024px chunk Node2Ds culled by camera (cullChunks). ~520 entities, 60fps.
- config.debugFast + LAPS=1 = quick autopilot finish for testing results.

## Audio
- sfx: beep go crash bump skid boost pass lap finish oil select. music: title, race.

## Milestones
- [x] M1 core loop: track, player car, rivals, rails, HUD
- [x] M2 laps/positions/overtakes/boost/oil/results/title
- [ ] M3 ideas: minimap, more tracks, skid marks
