import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import type { DB } from "./db/client.js";
import { schema } from "./db/client.js";
import { fail } from "./context.js";
import type { Storage } from "./storage.js";
import { inspectPackage, PackageError } from "./package.js";

const { games, gameVersions, generations, generationEvents, uploads, users, likes, plays, groupGames, groupMembers } = schema;

export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];
export type Q = DB | Tx;

export type Game = typeof games.$inferSelect;
export type Generation = typeof generations.$inferSelect;
export type GameVersion = typeof gameVersions.$inferSelect;

// ---------- views (never leak storage keys / worker internals) ----------

type VersionBrief = { orientation: string | null; thumbnailKey: string | null; playersMin: number; playersMax: number };

/** Per-game data the views need beyond the games row. Load in bulk with `hydrate`. */
export interface GameExtras {
  creator: { id: string; handle: string; avatar: Record<string, number> | null };
  remixOf: { gameId: string; name: string; version: number } | null;
  liked: boolean;
  versions: Map<number, VersionBrief>;
}

export const thumbnailUrl = (gameId: string, version: number) => `/v1/games/${gameId}/versions/${version}/thumbnail`;

const statsOf = (g: Game) => ({ plays: g.plays, likes: g.likes, remixes: g.remixes });

/** What the view shows for one version: orientation (absent in manifest = landscape) + thumbnail. */
function shown(g: Game, x: GameExtras, version: number | null) {
  const v = version ? x.versions.get(version) : undefined;
  return {
    orientation: v ? v.orientation ?? "landscape" : null,
    thumbnailUrl: v?.thumbnailKey ? thumbnailUrl(g.id, version!) : null,
  };
}

/** Manifest `[players]` of one version (§3.1, §4.5); `multiplayer` = max > 1. No version ⇒ 1/1. */
function playersShown(x: GameExtras, version: number | null) {
  const v = version ? x.versions.get(version) : undefined;
  const players = { min: v?.playersMin ?? 1, max: v?.playersMax ?? 1 };
  return { players, multiplayer: players.max > 1 };
}

/** `[players]` from a validated manifest (defaults 1/1; tolerant of older stored manifests). */
export function playersOf(manifest: unknown): { min: number; max: number } {
  const p = (manifest as { players?: { min?: unknown; max?: unknown } } | null)?.players;
  const n = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : 1);
  return { min: n(p?.min), max: n(p?.max) };
}

/** Owner view: everything. Thumbnail/orientation come from the latest version. */
export const gameView = (g: Game, x: GameExtras) => ({
  id: g.id,
  ownerId: g.ownerId,
  name: g.name,
  description: g.description,
  status: g.status,
  latestVersion: g.latestVersion,
  publishedVersion: g.publishedVersion,
  publishedAt: g.publishedAt,
  hidden: g.hidden,
  ...shown(g, x, g.latestVersion || null),
  // Players: the published version, else the latest build (owner / group views).
  ...playersShown(x, g.publishedVersion ?? (g.latestVersion || null)),
  creator: x.creator,
  stats: statsOf(g),
  remixOf: x.remixOf,
  viewer: { liked: x.liked },
  createdAt: g.createdAt,
  updatedAt: g.updatedAt,
});

/** Public view: strangers only see the published version. */
export const publicGameView = (g: Game, x: GameExtras) => {
  const { latestVersion: _l, hidden: _h, ...rest } = gameView(g, x);
  return { ...rest, ...shown(g, x, g.publishedVersion), ...playersShown(x, g.publishedVersion) };
};

/** DREAMSY.MD §11.2 FeedGame. */
export const feedGameView = (g: Game, x: GameExtras) => ({
  id: g.id,
  name: g.name,
  description: g.description,
  ...shown(g, x, g.publishedVersion),
  ...playersShown(x, g.publishedVersion),
  creator: x.creator,
  stats: statsOf(g),
  publishedAt: g.publishedAt,
  remixOf: x.remixOf,
});

/** Bulk-load creators, remix sources, viewer likes and version briefs (latest + published). */
export async function hydrate(q: Q, rows: Game[], viewerId: string | null): Promise<(g: Game) => GameExtras> {
  if (rows.length === 0) return () => { throw new Error("unreachable"); };
  const ids = rows.map((g) => g.id);
  const ownerIds = [...new Set(rows.map((g) => g.ownerId))];
  const sourceIds = [...new Set(rows.flatMap((g) => (g.remixOfGameId ? [g.remixOfGameId] : [])))];
  const wanted = rows.flatMap((g) => [
    ...(g.latestVersion > 0 ? [[g.id, g.latestVersion] as const] : []),
    ...(g.publishedVersion && g.publishedVersion !== g.latestVersion ? [[g.id, g.publishedVersion] as const] : []),
  ]);

  const [creators, sources, liked, versions] = await Promise.all([
    q.select({ id: users.id, handle: users.handle, avatar: users.avatar }).from(users).where(inArray(users.id, ownerIds)),
    sourceIds.length
      ? q.select({ id: games.id, name: games.name }).from(games).where(inArray(games.id, sourceIds))
      : [],
    viewerId
      ? q.select({ gameId: likes.gameId }).from(likes).where(and(eq(likes.userId, viewerId), inArray(likes.gameId, ids)))
      : [],
    wanted.length
      ? q.select({
        gameId: gameVersions.gameId,
        version: gameVersions.version,
        orientation: sql<string | null>`${gameVersions.manifest}->>'orientation'`,
        thumbnailKey: gameVersions.thumbnailKey,
        playersMin: gameVersions.playersMin,
        playersMax: gameVersions.playersMax,
      }).from(gameVersions).where(or(...wanted.map(([id, v]) => and(eq(gameVersions.gameId, id), eq(gameVersions.version, v)))))
      : [],
  ]);
  const creatorBy = new Map(creators.map((u) => [u.id, u]));
  const sourceName = new Map(sources.map((s) => [s.id, s.name]));
  const likedSet = new Set(liked.map((l) => l.gameId));
  const versionsBy = new Map<string, Map<number, VersionBrief>>();
  for (const v of versions) {
    if (!versionsBy.has(v.gameId)) versionsBy.set(v.gameId, new Map());
    versionsBy.get(v.gameId)!.set(v.version, {
      orientation: v.orientation, thumbnailKey: v.thumbnailKey, playersMin: v.playersMin, playersMax: v.playersMax,
    });
  }
  return (g) => ({
    creator: creatorBy.get(g.ownerId) ?? { id: g.ownerId, handle: "", avatar: null },
    remixOf: g.remixOfGameId
      ? { gameId: g.remixOfGameId, name: sourceName.get(g.remixOfGameId) ?? "", version: g.remixOfVersion! }
      : null,
    liked: likedSet.has(g.id),
    versions: versionsBy.get(g.id) ?? new Map(),
  });
}

/** Owner view for own games, public view otherwise. */
export async function viewGames(q: Q, rows: Game[], viewerId: string | null) {
  const extras = await hydrate(q, rows, viewerId);
  // Owners also see their running build (one query for the whole list) — the Create list shows round/ETA.
  const ownIds = rows.filter((g) => g.ownerId === viewerId).map((g) => g.id);
  const active = new Map<string, Generation>();
  if (ownIds.length) {
    const gens = await q.select().from(generations)
      .where(and(inArray(generations.gameId, ownIds), inArray(generations.status, ["queued", "running"])));
    for (const gen of gens) active.set(gen.gameId, gen);
  }
  return rows.map((g) => {
    if (g.ownerId !== viewerId) return publicGameView(g, extras(g));
    const gen = active.get(g.id);
    return { ...gameView(g, extras(g)), activeGeneration: gen ? generationView(gen) : null };
  });
}

export async function viewGame(q: Q, g: Game, viewerId: string | null) {
  return (await viewGames(q, [g], viewerId))[0]!;
}

/** FeedGame list; signed-in viewers also get `viewer: {liked}` per item. */
export async function feedGames(q: Q, rows: Game[], viewerId: string | null) {
  const extras = await hydrate(q, rows, viewerId);
  return rows.map((g) => {
    const x = extras(g);
    return viewerId ? { ...feedGameView(g, x), viewer: { liked: x.liked } } : feedGameView(g, x);
  });
}

export const versionView = (v: GameVersion) => ({
  gameId: v.gameId,
  version: v.version,
  sha256: v.packageSha256,
  sizeBytes: v.sizeBytes,
  manifest: v.manifest,
  summary: v.summary,
  players: { min: v.playersMin, max: v.playersMax },
  generationId: v.generationId,
  createdBy: v.createdBy,
  createdAt: v.createdAt,
});

export const generationView = (g: Generation) => ({
  id: g.id,
  gameId: g.gameId,
  prompt: g.prompt,
  imageIds: g.imageIds,
  assetIds: g.assetIds,
  selection: g.selection,
  provider: g.provider,
  baseVersion: g.baseVersion,
  status: g.status,
  attempts: g.attempts,
  resultVersion: g.resultVersion,
  error: g.error,
  etaSeconds: g.etaSeconds,
  progress: g.progress,
  createdAt: g.createdAt,
  startedAt: g.startedAt,
  finishedAt: g.finishedAt,
});

// ---------- games ----------

export async function getGame(q: Q, id: string, opts: { lock?: boolean } = {}): Promise<Game> {
  const base = q.select().from(games).where(eq(games.id, id));
  const [g] = opts.lock ? await base.for("update") : await base;
  if (!g) fail(404, "game not found");
  return g;
}

export async function getOwnedGame(q: Q, id: string, userId: string, opts: { lock?: boolean } = {}) {
  const g = await getGame(q, id, opts);
  if (g.ownerId !== userId) fail(404, "game not found"); // don't reveal drafts exist
  return g;
}

/** Owner, or anyone for a published game (hidden games stay reachable by direct link when signed in). */
export function canSeeGame(g: Game, userId: string | null): boolean {
  return g.ownerId === userId || g.status === "published";
}

export function canSeeVersion(g: Game, userId: string | null, version: number): boolean {
  return g.ownerId === userId || (g.status === "published" && g.publishedVersion === version);
}

/** True when the game is shared to a group the user belongs to (§13: group members can play shared drafts). */
export async function sharedWithUser(q: Q, gameId: string, userId: string | null): Promise<boolean> {
  if (!userId) return false;
  const [row] = await q.select({ g: groupGames.gameId }).from(groupGames)
    .innerJoin(groupMembers, eq(groupMembers.groupId, groupGames.groupId))
    .where(and(eq(groupGames.gameId, gameId), eq(groupMembers.userId, userId)))
    .limit(1);
  return !!row;
}

/** `canSeeGame`, extended to games shared with one of the caller's groups. */
export async function canAccessGame(q: Q, g: Game, userId: string | null): Promise<boolean> {
  return canSeeGame(g, userId) || sharedWithUser(q, g.id, userId);
}

/** `canSeeVersion`, extended: members of a group the game is shared with can load any of its versions. */
export async function canAccessVersion(q: Q, g: Game, userId: string | null, version: number): Promise<boolean> {
  return canSeeVersion(g, userId, version) || sharedWithUser(q, g.id, userId);
}

/** Group members' view of a shared game: like the owner view (latest version playable), minus moderation. */
export async function viewSharedGames(q: Q, rows: Game[], viewerId: string | null) {
  const extras = await hydrate(q, rows, viewerId);
  return rows.map((g) => {
    const { hidden: _h, ...v } = gameView(g, extras(g));
    return v;
  });
}

export async function getVersion(q: Q, gameId: string, version: number): Promise<GameVersion> {
  const [v] = await q.select().from(gameVersions)
    .where(and(eq(gameVersions.gameId, gameId), eq(gameVersions.version, version)));
  if (!v) fail(404, "version not found");
  return v;
}

export async function readPackage(storage: Storage, v: GameVersion): Promise<Uint8Array<ArrayBuffer>> {
  const body = await storage.get(v.packageKey);
  if (!body) throw new Error(`package blob missing: ${v.packageKey}`);
  return body;
}

/** Validate + store a package blob. Content-addressed, so re-uploads are free. */
export async function storePackage(storage: Storage, zip: Uint8Array) {
  let info;
  try {
    info = inspectPackage(zip);
  } catch (e) {
    if (e instanceof PackageError) fail(400, e.message);
    throw e;
  }
  const key = `packages/${info.sha256}.zip`;
  await storage.put(key, zip, "application/zip"); // idempotent: same key ⇒ same bytes
  return { key, ...info, sizeBytes: zip.byteLength };
}

/**
 * Append a version. Caller must hold the game row lock (getGame with lock) and pass
 * the locked row so `latestVersion` is current.
 */
export async function commitVersion(
  tx: Tx,
  game: Game,
  pkg: Awaited<ReturnType<typeof storePackage>>,
  meta: { createdBy: string; summary: string; generationId: string | null; thumbnailKey?: string | null },
): Promise<GameVersion> {
  const version = game.latestVersion + 1;
  const players = playersOf(pkg.manifest);
  const [row] = await tx.insert(gameVersions).values({
    gameId: game.id,
    version,
    packageKey: pkg.key,
    packageSha256: pkg.sha256,
    sizeBytes: pkg.sizeBytes,
    manifest: pkg.manifest,
    summary: meta.summary,
    generationId: meta.generationId,
    thumbnailKey: meta.thumbnailKey ?? null,
    playersMin: players.min,
    playersMax: players.max,
    createdBy: meta.createdBy,
  }).returning();
  await tx.update(games)
    .set({ latestVersion: version, updatedAt: sql`now()` })
    .where(eq(games.id, game.id));
  return row!;
}

// ---------- stats ----------

/**
 * DREAMSY.MD §11.2: (plays_7d + 3·likes_7d + 5·remixes_7d) / (hoursSincePublish + 2)^1.2.
 * Cheap: three indexed counts for one game. Called whenever a play/like/remix lands and on publish.
 * Scores of games with no new activity are not decayed until their next write.
 */
export async function recomputeTrending(q: Q, gameId: string) {
  const since = sql`now() - interval '7 days'`;
  await q.update(games).set({
    trendingScore: sql`(
      (select count(*) from ${plays} where ${plays.gameId} = ${gameId} and ${plays.createdAt} > ${since})
      + 3 * (select count(*) from ${likes} where ${likes.gameId} = ${gameId} and ${likes.createdAt} > ${since})
      + 5 * (select count(*) from games r where r.remix_of_game_id = ${gameId} and r.created_at > ${since})
    )::float8 / power(greatest(extract(epoch from now() - coalesce(${games.publishedAt}, now())), 0) / 3600.0 + 2, 1.2)`,
  }).where(eq(games.id, gameId));
}

// ---------- keyset pagination ----------

/** Opaque cursor = [sortKey as Postgres text, id] of the last row. */
export const encodeCursor = (key: string, id: string) => Buffer.from(JSON.stringify([key, id])).toString("base64url");

export function decodeCursor(s: string | undefined): [string, string] | null {
  if (!s) return null;
  try {
    const v = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && typeof v[1] === "string") return [v[0], v[1]];
  } catch {}
  fail(400, "invalid cursor");
}

export const parseLimit = (s: string | undefined) => Math.min(Math.max(Number(s) || 20, 1), 50);

/**
 * One page of games ordered by `(sort DESC, id DESC)`. The cursor carries the sort key as Postgres
 * text so timestamps keep microsecond precision across round trips.
 */
export async function pageGames(
  q: Q,
  opts: { where: SQL | undefined; sort: SQL; sortType: "float8" | "timestamptz" | "int4"; cursor?: string; limit: number },
) {
  const cur = decodeCursor(opts.cursor);
  const rows = await q.select({ game: games, key: sql<string>`(${opts.sort})::text` }).from(games)
    .where(and(
      opts.where,
      cur ? sql`(${opts.sort}, ${games.id}) < (${cur[0]}::${sql.raw(opts.sortType)}, ${cur[1]})` : undefined,
    ))
    .orderBy(sql`${opts.sort} desc`, sql`${games.id} desc`)
    .limit(opts.limit);
  const last = rows.at(-1);
  return { games: rows.map((r) => r.game), next: rows.length === opts.limit && last ? encodeCursor(last.key, last.game.id) : null };
}

/** Published, not hidden: what feeds, search, profiles and public links may show. */
export const listed = () => and(eq(games.status, "published"), eq(games.hidden, false));

/** Games whose published version is multiplayer (`[players] max > 1`, §4.5). */
export const multiplayerOnly = () => sql`exists (select 1 from ${gameVersions} where ${gameVersions.gameId} = ${games.id}
  and ${gameVersions.version} = ${games.publishedVersion} and ${gameVersions.playersMax} > 1)`;

/** `?multiplayer=1` (or `true`) on list endpoints → the multiplayer filter; anything else → no filter. */
export const multiplayerFilter = (q: string | undefined) => (q === "1" || q === "true" ? multiplayerOnly() : undefined);

// ---------- generations ----------

export async function appendEvent(q: Q, generationId: string, type: string, data: unknown = {}) {
  await q.insert(generationEvents).values({ generationId, type, data });
}

export async function getGeneration(q: Q, id: string, opts: { lock?: boolean } = {}) {
  const base = q.select().from(generations).where(eq(generations.id, id));
  const [g] = opts.lock ? await base.for("update") : await base;
  if (!g) fail(404, "generation not found");
  return g;
}

export async function getUploadsOwnedBy(q: Q, ids: string[], userId: string) {
  if (ids.length === 0) return [];
  const rows = await q.select().from(uploads)
    .where(and(inArray(uploads.id, ids), eq(uploads.ownerId, userId)));
  if (rows.length !== new Set(ids).size) fail(400, "unknown image id");
  return rows;
}
