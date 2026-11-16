# services/gameserver — multiplayer room server (v1)

Rooms with invite codes, 1v1 quick match (red vs blue), party rooms up to `[players] max` (≤ 8).
v1 = server-relayed state sync: devices simulate, this server owns membership, teams, host, shared
state, scores and match results, and relays avatar samples + remote events. See DREAMSY.MD §4.5 and
`engine-web/net/protocol.ts` (the message contract).

```sh
pnpm -C services/gameserver start   # :8790 (GAMESERVER_PORT), WS /rooms, GET /health; JWT_SECRET from env or services/api/.env
pnpm -C services/gameserver test
```
Prod: `gameserver` service in deploy/docker-compose.yml; Caddy routes `api.dreamsy.dev/rooms*` here.

Spectators: `{t:"spectate", code}` watches a room (≤ 16, not counted in max, receive-only).
Presence for services/api: `GET /internal/presence?users=id1,id2` with header `x-internal-token: $WORKER_TOKEN`
→ `{presence: {[userId]: {status: "offline"|"online"|"in_room"|"in_match", gameId?, roomCode?, mode?, players?, max?, spectatable?}}}`
(503 when WORKER_TOKEN is unset; not routed publicly by Caddy).
