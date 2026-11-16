# services/api — Dreamsy platform API

TypeScript · Hono · Postgres (Drizzle) · S3-compatible storage. No engine in here.

## Run locally

```sh
cp .env.example .env
docker compose up -d                 # postgres + minio (create bucket "dreamsy" in minio console :9001)
pnpm db:migrate
pnpm dev                              # :8787
pnpm test                             # PGlite + in-memory storage, no docker needed
```

Schema change: edit `src/db/schema.ts` → `pnpm db:generate` → commit the migration.

## Endpoints

All JSON, camelCase. Errors: `{ "error": string }`. User routes need `Authorization: Bearer <token>`.

**Auth**
| | |
|---|---|
| `POST /v1/auth/apple` `{identityToken, fullName?}` | verify Apple ID token → `{user, token}` |
| `POST /v1/auth/google` `{idToken}` | verify Google ID token → `{user, token}` |
| `POST /v1/auth/guest` | anonymous account → `{user, token}` |
| `GET /v1/me` | current user (`{id, handle, bio, createdAt}`) |
| `PATCH /v1/me` `{handle?, bio?}` | handle unique, `[a-z0-9_]{3,20}` (409 if taken); bio ≤280 |

**Games** — versions are immutable; every edit = `latestVersion + 1`
| | |
|---|---|
| `POST /v1/games` `{name, description?}` | create draft |
| `GET /v1/games?limit&before` | discover (published) |
| `GET /v1/me/games` | my games |
| `GET /v1/games/:id` | owner sees everything; others only if published (hidden games stay reachable by direct link) |
| `PATCH /v1/games/:id` | rename / describe |
| `POST /v1/games/:id/publish` `{version?}` / `unpublish` | |
| `GET /v1/games/:id/versions` | owner only |
| `GET /v1/games/:id/versions/:v` · `/package` | metadata · zip (owner, or the published version) |
| `POST /v1/games/:id/revert` `{version}` | undo: new version with an old package (+ its thumbnail) |
| `GET /v1/games/:id/versions/:v/thumbnail` | JPEG; **public** for the published version, owner (bearer) for others |

Game views now also carry `publishedAt`, `orientation` (from the shown version's manifest; absent =
`"landscape"`; `null` if no version), `thumbnailUrl` (relative URL or `null`), `creator {id, handle}`,
`stats {plays, likes, remixes}`, `remixOf {gameId, name, version} | null`, `viewer {liked}`. Owner
view: thumbnail/orientation of the latest version, plus `hidden`. Others: the published version.

**Platform v1** (DREAMSY.MD §11)
| | |
|---|---|
| `GET /v1/feed?tab=trending\|new\|top\|following&cursor&limit&multiplayer=1` | `{games: FeedGame[], next}` |
| `GET /v1/search?q&cursor&limit&multiplayer=1` | same shape; ILIKE on name, description, creator handle; trending order |
| `POST /v1/games/:id/plays` `{version}` | `{counted, stats}`; 1 per user/game/UTC hour (legacy: no charge) |
| `POST /v1/games/:id/play` `{version?}` | pay-per-play start (DREAMSY.MD §11.6): `{charged, price, balance, pass: {id, expiresAt}, creatorEarned}`; 402 `{error: "insufficient_coins", balance, price}`; also counts the play |
| `GET /v1/games/:id/play` | quote, no side effects: `{free, reason: "owner"\|"draft"\|"pass"\|null, price, balance, pass\|null}` |
| `GET /v1/me/quota` · `GET /v1/me/wallet` | also carry `createPrice` (top level and inside `quota` / `wallet`) and `remixPrice`; game views carry `playPrice` + `remixPrice` |
| `GET /v1/me/notifications?cursor&limit` | newest first: `{items: [{id, kind, title, body, data, read, createdAt}], unread, next}`; kinds `play_earning`, `remix_earning`, `royalty`, `sale`, `build_done`, `group_join`, `friend_request`, `friend_accept`, `game_invite` |
| `GET /v1/me/notifications/unread` | `{unread}` |
| `POST /v1/me/notifications/read` `{ids?, all?}` | `{unread}` |
| `POST /v1/me/push-tokens` `{token: "ExponentPushToken[…]", platform: "ios"\|"android"}` | `{ok}`; a token belongs to its last registrant |
| `DELETE /v1/me/push-tokens` `{token}` | `{ok}` |
| `GET /v1/me/earnings` | `{totalCoins, todayCoins, paidPlays, usd: {total, today}, games: [{gameId, name, coins, plays}]}` |
| `PUT` / `DELETE /v1/games/:id/like` | idempotent → `{liked, stats}` |
| `POST /v1/games/:id/remix` | 201 `{game, charged, ownerEarned}`: new draft, v1 = source published version (latest if yours), store stripped. Costs `REMIX_PRICE` (25,000) → 100% to the source's owner (+ `remix_earning` notification); free on your own game; 402 `{error: "insufficient_coins", balance, price}` |
| `POST /v1/games/:id/report` `{reason}` | `{ok}`; one per user; ≥3 distinct reporters ⇒ `hidden` |
| `POST /v1/friends/requests` `{handle}` | 201 `{request: {id, user, status: "pending", direction: "outgoing"}}`; 200 `{friend}` if they already asked you (auto-accept); 404 unknown handle, 409 already friends, 400 self |
| `POST /v1/friends/requests/:userId/accept` · `/decline` | `{friend}` · `{ok}`; 404 if no request from them, accept 409 if already friends |
| `DELETE /v1/friends/:userId` | `{ok}`: unfriend or cancel/drop a request; 404 if none |
| `GET /v1/me/friends` | `{friends: [{user {id, handle, avatar}, since, presence}], incoming: [{user, at}], outgoing: [{user, at}]}`; friends online first |
| `GET /v1/users/search?q=<prefix>` | `{users: [{id, handle, avatar, friendStatus: "none"\|"friends"\|"incoming"\|"outgoing"}]}`; handle prefix, ≤20, not self |
| `POST /v1/invites` `{userId, gameId, roomCode, version?}` | `{ok}`; friends only (403), ≤10/min (429); `game_invite` notification + push |
| `GET /v1/users/:id` | `{user, stats {games, plays, likes, followers, following}, viewer {following}}` |
| `GET /v1/users/:id/games?cursor&limit` | `{games, next}`: published FeedGames; self = all own games (owner views) |
| `PUT` / `DELETE /v1/users/:id/follow` | idempotent → `{following}` |
| `GET /v1/public/games/:id` | **public** `{game: FeedGame + publishedVersion}`; 404 for drafts/hidden |
| `GET /v1/public/games/:id/package` | **public** published zip; 404 for drafts/hidden |
| `GET /v1/marketplace?sort=popular\|new\|price&cursor&limit` | `{items: [{gameId, gameName, itemId, kind, name, description, price, sales}], next}` |

`FeedGame = {id, name, description, orientation, thumbnailUrl, players {min, max}, multiplayer, creator {id, handle}, stats {plays, likes, remixes}, publishedAt, remixOf {gameId, name, version} | null}`;
feed/search/profile lists add `viewer {liked}` per item. Feeds, search, profiles, marketplace and
public routes show only published, non-hidden games.

Choices where §11 was open:
- Cursors are opaque strings; feeds use keyset `(sortKey, id)`; marketplace uses an offset (items are
  flattened from published manifests in memory — fine at v1 scale).
- `top` = most likes. `new`/`following` = `publishedAt` (first publish, never reset). `trending` =
  stored `trendingScore`, recomputed for one game whenever a play/like/unlike/remix lands and on
  publish; idle games are not re-decayed until their next write (add a periodic sweep later).
- Plays dedupe on a UTC hour bucket (not a rolling hour); owners' plays count too.
- `remixOf` includes `version` in addition to the spec's `{gameId, name}`. If the source has no store
  items, the remix reuses the same package blob (same sha256); otherwise `dreamsy.toml` is rewritten
  (via `@dreamsy/format` `set_manifest store=null`) and the new zip stored. Thumbnail is shared.
- `viewer.ownedPasses` and marketplace `iconUrl` are omitted (store icons are package assets with no URL yet).
- Reports: owners can't report their own game; hidden games are only un-hidden manually (DB).

Notifications + push (DREAMSY.MD §11.6): every notification row is inserted in the same transaction
as the event that caused it, then pushed after commit through Expo
(`https://exp.host/--/api/v2/push/send`, batches of ≤100, 10 s timeout, errors swallowed, never
blocks the request). Message: `{to, title, body, data: {...data, kind, notificationId}, sound:
"default", badge: unread}`. Tokens Expo reports as `DeviceNotRegistered` are deleted. Tests inject
`Deps.pusher`. Env: `CREATE_PRICE` (100000), `REMIX_PRICE` (25000).

Friends, invites, presence (DREAMSY.MD §13.4, `routes/friends.ts`, `presence.ts`): `Presence = {status:
"offline"|"online"|"in_room"|"in_match", gameId?, gameName?, roomCode?, mode?, players?, max?, spectatable?}`, read
from the room server (`GET $GAMESERVER_INTERNAL_URL/internal/presence?users=…`, header `x-internal-token:
$WORKER_TOKEN`, 1.5 s timeout; failure → everyone `offline`). Env `GAMESERVER_INTERNAL_URL` (default
`http://gameserver:8790`). Tests inject `Deps.presence`. `game_invite` data: `{gameId, version?, roomCode, fromUserId,
spectate: false, expiresAt}` (10 min).

**Uploads** — `POST /v1/uploads` (multipart `file`, png/jpeg/webp/heic ≤10MB) · `GET /v1/uploads/:id`

**Generations** (prompt → harness)
| | |
|---|---|
| `POST /v1/games/:id/generations` `{prompt, imageIds?, selection?}` | 201 `{generation, charged}`; queue; one active per game; daily quota. A game's **first** build (no versions yet) costs `CREATE_PRICE` (100,000) → platform, refunded once if it ends failed/canceled with no version; edits free; 402 `{error: "insufficient_coins", balance, price}` |
| `GET /v1/games/:id/generations` · `GET /v1/generations/:id` | |
| `POST /v1/generations/:id/cancel` | |
| `GET /v1/generations/:id/events` | SSE progress; resumes via `Last-Event-ID` |

**Worker** (harness; `Bearer $WORKER_TOKEN`)
```
POST /v1/worker/claim {workerId}            → job + base package url + image urls, or 204
POST /v1/worker/generations/:id/events      {workerId, type, data}   renews lease
POST /v1/worker/generations/:id/checkpoint  multipart workerId, summary, package(zip), thumbnail?(jpeg)  → {version}
POST /v1/worker/generations/:id/complete    multipart workerId, summary, package(zip), thumbnail?(jpeg ≤2MB)
POST /v1/worker/generations/:id/fail        {workerId, error, retryable}
GET  /v1/worker/games/:id/versions/:v/package
GET  /v1/worker/uploads/:id
```
A 409 from events/checkpoint/complete means stop: the job was canceled or reassigned (or the base is stale).

Multi-round builds: `checkpoint` commits a normal, publishable version (base check like `complete`),
keeps the job `running`, renews the lease, appends a `checkpoint {version, summary}` event and moves the
generation's `baseVersion` to the new version, so the next checkpoint/complete (or a re-claim after a
lost lease) builds on it. An `eta` event with `{etaSeconds, round, rounds, phase}` also updates the
generation's `etaSeconds` and `progress {round, rounds, phase}` (both in the generation view;
`etaSeconds` is cleared on complete).

The claim response's `generation` also carries `userId`, and `game` carries `remixOf {gameId, version} | null`
(the harness scopes its retrieval memory with them: a user's prompts are only recalled for that user).

A `metrics` event (one per job, sent just before `complete`/`fail`) is validated and stored on
`generations.metrics` (400 if malformed):
```
{costUsd, rounds, turns, minutes, artScore: number|null, artVerdict: "ship"|"polish"|null, playtestRuns,
 runtimeErrorsFixed, finalGatePassedFirstTry: boolean|null, memoryHits, spritesReused, spritesDrawn,
 kit: string|null, pack: string|null, kind: string|null, memoryIds?: string[]}
```
Other continual-improvement events (passed through to SSE, not stored on the generation): `memory`
`{hits, lessonsUsed, remixUsed, fromBuilds, ids, backend}` at the start of a build ("learned from N past
builds"), `memory.saved {lessons, consolidated, items}` after a round, `sprites.found {query, hits}`,
and `sprite {id, from?}` (`from` = sprite-library id it was adapted from).

**Insights** (graphs; bearer token)
| | |
|---|---|
| `GET /v1/me/insights?days=30` | the caller's builds |
| `GET /v1/insights/engine?days=30` | all builds, aggregated (no prompts or per-user data) |

`days` is an integer 1–365 (default 30; else 400). Both return:
```
{
  days, since: "YYYY-MM-DD",
  daily: [{date: "YYYY-MM-DD", builds, succeeded, failed, avgArtScore, avgCostUsd, avgMinutes, avgMemoryHits, spritesReusedPct}],
  byKit: [{kit, builds, avgArtScore, avgCostUsd}],
  totals: {builds, succeeded, failed, avgArtScore, avgCostUsd, avgMinutes, avgMemoryHits, spritesReusedPct,
           successRatePct, withMetrics, totalCostUsd, memoryHits, spritesReused, spritesDrawn,
           runtimeErrorsFixed, finalGateFirstTryPct}
}
```
- A build = a generation that finished `succeeded` or `failed` (canceled excluded), bucketed by
  `finishedAt` UTC day. `daily` has one entry per day, oldest first, including empty days (`builds: 0`, averages `null`).
- `builds/succeeded/failed` count every build; averages only builds that reported metrics (`avgArtScore`
  only reviewed builds) and are `null` when none qualify. `spritesReusedPct = reused / (reused + drawn) × 100`.
- `byKit` covers builds with metrics, `kit` = the build's primary genre kit or `"none"`; sorted by builds desc.
- Percentages have 1 decimal, averages 2 (cost 4).

## Not yet
Guest → Apple/Google account linking · presigned/CDN package downloads · rate limiting ·
report review queue / un-hide · periodic trending decay · matchmaking (slice 2) · real full-package validation (lives in `format/`).
