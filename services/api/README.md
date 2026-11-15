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
| `GET /v1/feed?tab=trending\|new\|top\|following&cursor&limit` | `{games: FeedGame[], next}` |
| `GET /v1/search?q&cursor&limit` | same shape; ILIKE on name, description, creator handle; trending order |
| `POST /v1/games/:id/plays` `{version}` | `{counted, stats}`; 1 per user/game/UTC hour |
| `PUT` / `DELETE /v1/games/:id/like` | idempotent → `{liked, stats}` |
| `POST /v1/games/:id/remix` | 201 `{game}`: new draft, v1 = source published version (latest if yours), store stripped |
| `POST /v1/games/:id/report` `{reason}` | `{ok}`; one per user; ≥3 distinct reporters ⇒ `hidden` |
| `GET /v1/users/:id` | `{user, stats {games, plays, likes, followers, following}, viewer {following}}` |
| `GET /v1/users/:id/games?cursor&limit` | `{games, next}`: published FeedGames; self = all own games (owner views) |
| `PUT` / `DELETE /v1/users/:id/follow` | idempotent → `{following}` |
| `GET /v1/public/games/:id` | **public** `{game: FeedGame + publishedVersion}`; 404 for drafts/hidden |
| `GET /v1/public/games/:id/package` | **public** published zip; 404 for drafts/hidden |
| `GET /v1/marketplace?sort=popular\|new\|price&cursor&limit` | `{items: [{gameId, gameName, itemId, kind, name, description, price, sales}], next}` |

`FeedGame = {id, name, description, orientation, thumbnailUrl, creator {id, handle}, stats {plays, likes, remixes}, publishedAt, remixOf {gameId, name, version} | null}`;
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

**Uploads** — `POST /v1/uploads` (multipart `file`, png/jpeg/webp/heic ≤10MB) · `GET /v1/uploads/:id`

**Generations** (prompt → harness)
| | |
|---|---|
| `POST /v1/games/:id/generations` `{prompt, imageIds?, selection?}` | queue; one active per game; daily quota |
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
