# Multiplayer (v1, live)

## What players get
- **Quick match 1v1:** two players are paired automatically, **red vs blue**.
- **Rooms:** *Create room* gives a 6-character code. Friends tap *Join* and type the code (lowercase works). Up to **8 players** in a party room, with balanced teams. Late joiners can come in on games that allow it.
- **Lobby:**
  - set your name
  - player list with team colours
  - Ready, Start (host), switch team, Leave
  - rematch when both players are ready
- **In game:**
  - team colour chips
  - name tags over players
  - shared scores
  - a winner card
  - if one player leaves, the other wins by forfeit
- **Solo:** the same games work offline against bots.

## Games to play now (all published, all with a fix pass after a real 2-player test)
| Game | Players | Type |
|---|---|---|
| **Orb Duel** | 1v1 | arena: grab orbs, first to 5 |
| **Gem Drop Duel** ("Four Fall") | 1v1 | turn-based 4-in-a-row with bomb, swap and stone gems |
| **Riddle Rumble** ("Riddle Party") | up to 8 | family quiz: same riddle for everyone, faster answers score more, 10 rounds |
| **Turbo Tiles** ("Toy Town Turbo") | up to 4 | kart racing: host picks the track, 3-2-1 countdown, A = nitro |
| **Sky Sprint** | up to 4 | race up a tower, first to the flag wins |
Any game built on the **racing kit** also gets a versus mode.

## How it works (architecture)
- **Room server** (`services/gameserver`, Node + `ws`) at `wss://api.dreamsy.dev/rooms`. It authenticates with the same token as the API.
  - It owns membership, teams, the host, shared room state, scores and the match result.
  - It relays each player's avatar position at 15 Hz, plus game events.
- **Devices run the game.** Each phone runs the full game. Other players appear as interpolated "puppets", drawn 100 ms in the past. Local controls have zero lag.
- **Host-authoritative shared logic.** Turn order, rounds and countdowns go through the host plus `room.setState`, so screens can't disagree.
- **Luau API for game makers:**
  - `players.*`, `room.*` (`replicate`, `setState`, `addScore`, `finish`, `teamColor`)
  - remote events (`fireServer` / `fireClient` / `fireAll`)
  - the AI builder knows this API, so "make it 1v1" or "add multiplayer for my family" works as a prompt
- **Limits:** 8 KB per message, 40 messages/s per player, 6-character codes, up to 8 players.

## Known limits (v1)
- Players can't physically collide with each other, because each device simulates its own player. That's why v1 games are races, turn-based duels, quizzes and pickup arenas.
- Clients are trusted for their own position. A server-authoritative simulation comes in v2.
- Pausing freezes your avatar on other screens.
- You can't reconnect to the same seat after dropping.
- The display name is cosmetic and typed in the lobby.

## Debug notes
- Typing the room code on iPhone needed two fixes: text inputs now allow user-select, and the app WebView no longer disables text interaction (fixed 2026-11-15).
- The 2-player test script: two headless browsers open the game, both tap Quick match (or Create, then Join with the code), and we compare screenshots of both screens.
