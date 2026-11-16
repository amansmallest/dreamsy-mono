# Dreamsy

## Problem
We think games drive a lot of curiosity and creativity, especially games like Roblox and Minecraft. They're where a whole generation learned to build, to share and to make things with friends. And everyone has a game of their own in their head: a kid with a dragon that collects socks, a mum who wants a cooking game for her daughter, two friends with an inside joke that deserves a boss fight.

Roblox proved that games made by players can be bigger than games made by studios. But turning an idea into something your friends can actually play still means a desktop editor, a scripting language and weeks of evenings. So most game ideas die as a sentence in a group chat.

## How it works
1. **Say it.** "An endless runner under the ocean where you're a diver dodging jellyfish." That's the whole brief.
2. **Watch it get made.** An AI studio picks the right genre kit and a house art style, designs the levels, draws every sprite and writes the music. Then it **plays its own game**, finds what's broken and fixes it before you ever see it.
3. **Play it, share it, steal it.** Send it to friends, race their ghosts, or spin off anyone's game and make it yours. The original creator gets paid when you do.

## What makes it feel different
- **Games, not demos.** 21 hand-tested genre kits (platformers, racers, tower defense, deckbuilders, social deduction…) give every build real systems underneath: progression, saves, tutorials, an hour or two of play.
- **Tap anything to change it.** Tap the knight's shield and say "make it red". Only that sprite is redrawn; the rest of your game stays exactly as it was.
- **Play together, properly.** Quick match 1v1, red vs blue. Rooms of up to 8 for family night. Invite a friend with a push notification, or let a third friend spectate.
- **Beat your friends, or their ghosts.** Public and family leaderboards. Every best run leaves a see-through replay you can race head to head.
- **Your first game is a prank.** New players start in "Nope.", a tiny troll platformer that kills you three times and mocks you for it before letting you win. It's the fastest way we found to make someone laugh and say "wait, an AI made this?"
- **Creators get paid from day one.** A play costs 10,000 coins ($0.10) and the creator keeps 90%. A spin-off costs 25,000 coins, all of it to the original creator, plus a royalty on every play of the spin-off.
- **A pro studio when you want it.** dreamsy.dev streams every build step live, with versions, leaderboards, earnings and one-click play.

## Why we built this
The best games we played as kids were the ones we invented with friends: rules made up on the spot, levels drawn on paper. We wanted to bring that back. The gap between "what if there was a game where…" and "here, play it" should be one sentence, on the phone already in your pocket.

## How it's built
- **Our own engine.** TypeScript, three.js for rendering, Rapier for physics, game logic in Luau compiled to WebAssembly in a sandbox. The same engine runs in the app, in the browser, and in our cloud playtests.
- **An AI studio, not a single prompt.**
  - A router picks the genre kit and art style.
  - Claude Opus directs the build; parallel builders produce levels and content in bulk.
  - The game is then played automatically, and an art and UX director reviews screenshots against a "would a first-time player understand this?" bar.
  - GPT builds too, and the system fails over between model accounts so builds never stall.
- **It learns from its own builds.** A retrieval memory of lessons and reusable sprites, so every build starts a little smarter than the last.
- **Real-time where it matters.** Convex streams build progress live. A Node WebSocket room server runs multiplayer: quick match, rooms, spectators and invites.
- **Everywhere.** Expo React Native app, the web studio, and a PWA, so anyone with a browser can play.

## What was hard
- **Coherence.** Left alone, AI-written games fall apart: a jump button that does nothing, a level you can't finish, a tutorial nobody understands. Genre kits plus self-playtests plus a UX review fixed most of it.
- **Patience.** A big game takes 15–30 minutes to first playable. So we made the wait part of the show: you watch it being built step by step, and it keeps growing for an hour after.
- **Phones.** Thumbs drift, keyboards cover inputs, and a joystick that brakes your car by accident ruins a racer. We rewrote the touch controls three times.
- **Multiplayer sync.** Every phone runs the game itself, while the room server is the referee for turns, scores and who won.

## Where we are
- **36 games** live on the platform, all made by typing an idea
- **Small game:** about 6 minutes and about $3.50 to build. **Edits:** about a minute.
- **About 490 automated tests** across the engine, API, harness and room server
- **No users or revenue yet**; coins are free while we test. The first game anyone plays on Dreamsy is designed to make them rage.
