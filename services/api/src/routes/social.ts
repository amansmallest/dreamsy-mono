import { and, count, desc, eq, ilike, inArray, isNotNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { applyOps, Package, type Manifest } from "@dreamsy/format";
import { optionalUser, requireUser } from "../auth.js";
import { fail, parseJson, router, type Deps } from "../context.js";
import { schema } from "../db/client.js";
import { newId } from "../ids.js";
import {
  canAccessGame,
  canAccessVersion,
  commitVersion,
  decodeCursor,
  encodeCursor,
  feedGames,
  getGame,
  getVersion,
  hydrate,
  feedGameView,
  listed,
  pageGames,
  parseLimit,
  readPackage,
  recomputeTrending,
  storePackage,
  multiplayerFilter,
  viewGame,
  type Game,
} from "../services.js";
import { packageResponse } from "./games.js";

const { games, likes, plays, follows, reports, purchases, users, gameVersions } = schema;

const Play = z.object({ version: z.number().int().positive() });
const Report = z.object({ reason: z.string().trim().min(1).max(1000) });
const FeedTab = z.enum(["trending", "new", "top", "following"]).default("trending");
const MarketSort = z.enum(["popular", "new", "price"]).default("popular");

/** Distinct reporters that auto-hide a game pending review (§11.7). */
export const HIDE_AT_REPORTS = 3;

const statsOf = (g: Game) => ({ plays: g.plays, likes: g.likes, remixes: g.remixes });

/** DREAMSY.MD §11.2–11.7: feed, search, plays, likes, remix, reports, public links, marketplace. */
export function socialRoutes({ db, storage, config }: Deps) {
  const r = router();
  // /v1/games/* is already behind requireUser (registered in gameRoutes).
  r.use("/v1/feed", requireUser(config));
  r.use("/v1/search", requireUser(config));
  r.use("/v1/marketplace", requireUser(config));
  r.use("/v1/public/*", optionalUser(config));

  // ---------- feed + search ----------

  r.get("/v1/feed", async (c) => {
    const tab = FeedTab.parse(c.req.query("tab") || undefined);
    const viewerId = c.get("userId");
    const sort = {
      trending: { sort: sql`${games.trendingScore}`, sortType: "float8" as const },
      top: { sort: sql`${games.likes}`, sortType: "int4" as const },
      new: { sort: sql`${games.publishedAt}`, sortType: "timestamptz" as const },
      following: { sort: sql`${games.publishedAt}`, sortType: "timestamptz" as const },
    }[tab];
    const where = tab === "following"
      ? and(listed(), inArray(games.ownerId, db.select({ id: follows.followeeId }).from(follows).where(eq(follows.followerId, viewerId))))
      : listed();
    const page = await pageGames(db, {
      where: and(where, isNotNull(games.publishedAt), multiplayerFilter(c.req.query("multiplayer"))),
      ...sort,
      cursor: c.req.query("cursor"),
      limit: parseLimit(c.req.query("limit")),
    });
    return c.json({ games: await feedGames(db, page.games, viewerId), next: page.next });
  });

  /** ILIKE over name, description and creator handle; ordered by trending. */
  r.get("/v1/search", async (c) => {
    const q = (c.req.query("q") ?? "").trim();
    if (!q) fail(400, "q is required");
    const pattern = `%${q.slice(0, 100).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const page = await pageGames(db, {
      where: and(listed(), multiplayerFilter(c.req.query("multiplayer")), or(
        ilike(games.name, pattern),
        ilike(games.description, pattern),
        inArray(games.ownerId, db.select({ id: users.id }).from(users).where(ilike(users.handle, pattern))),
      )),
      sort: sql`${games.trendingScore}`,
      sortType: "float8",
      cursor: c.req.query("cursor"),
      limit: parseLimit(c.req.query("limit")),
    });
    return c.json({ games: await feedGames(db, page.games, c.get("userId")), next: page.next });
  });

  // ---------- plays + likes ----------

  /** Counts a play; deduped to one per user per game per UTC hour. */
  r.post("/v1/games/:id/plays", async (c) => {
    const body = await parseJson(c.req.raw, Play);
    const userId = c.get("userId");
    const g = await getGame(db, c.req.param("id"));
    if (!(await canAccessVersion(db, g, userId, body.version))) fail(404, "version not found");
    const hour = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
    const updated = await db.transaction(async (tx) => {
      const inserted = await tx.insert(plays).values({ userId, gameId: g.id, version: body.version, hour })
        .onConflictDoNothing().returning({ id: plays.id });
      if (!inserted.length) return null;
      await tx.update(games).set({ plays: sql`${games.plays} + 1` }).where(eq(games.id, g.id));
      await recomputeTrending(tx, g.id);
      return getGame(tx, g.id);
    });
    return c.json({ counted: !!updated, stats: statsOf(updated ?? g) });
  });

  async function setLike(gameId: string, userId: string, like: boolean) {
    const g = await getGame(db, gameId);
    if (!(await canAccessGame(db, g, userId))) fail(404, "game not found");
    const updated = await db.transaction(async (tx) => {
      const changed = like
        ? await tx.insert(likes).values({ userId, gameId: g.id }).onConflictDoNothing().returning({ g: likes.gameId })
        : await tx.delete(likes).where(and(eq(likes.userId, userId), eq(likes.gameId, g.id))).returning({ g: likes.gameId });
      if (!changed.length) return null; // idempotent
      await tx.update(games).set({ likes: sql`${games.likes} + ${like ? 1 : -1}` }).where(eq(games.id, g.id));
      await recomputeTrending(tx, g.id);
      return getGame(tx, g.id);
    });
    return { liked: like, stats: statsOf(updated ?? g) };
  }

  r.put("/v1/games/:id/like", async (c) => c.json(await setLike(c.req.param("id"), c.get("userId"), true)));
  r.delete("/v1/games/:id/like", async (c) => c.json(await setLike(c.req.param("id"), c.get("userId"), false)));

  // ---------- remix (§11.3) ----------

  /**
   * New draft owned by the caller; version 1 = the source's published version (latest if the caller
   * owns the source). Store items are stripped from the copy's manifest. If there are none, the
   * package blob is shared by key (content-addressed, nothing re-uploaded).
   */
  r.post("/v1/games/:id/remix", async (c) => {
    const userId = c.get("userId");
    const src = await getGame(db, c.req.param("id"));
    const isOwner = src.ownerId === userId;
    if (!isOwner && (src.status !== "published" || src.hidden)) fail(404, "game not found");
    const srcVersion = isOwner ? src.latestVersion : src.publishedVersion!;
    if (srcVersion < 1) fail(409, "game has no versions yet");
    const v = await getVersion(db, src.id, srcVersion);

    let pkg = { key: v.packageKey, sha256: v.packageSha256, sizeBytes: v.sizeBytes, manifest: v.manifest as Manifest };
    if (((v.manifest as Manifest).store ?? []).length > 0) {
      const stripped = applyOps(Package.fromZip(await readPackage(storage, v)), [{ op: "set_manifest", key: "store", value: null }]);
      pkg = await storePackage(storage, stripped.toZip());
    }

    const game = await db.transaction(async (tx) => {
      const [created] = await tx.insert(games).values({
        id: newId("g"),
        ownerId: userId,
        name: `${src.name.slice(0, 72)} (remix)`,
        description: src.description,
        remixOfGameId: src.id,
        remixOfVersion: srcVersion,
      }).returning();
      await commitVersion(tx, created!, pkg, {
        createdBy: userId,
        summary: `Remixed from ${src.name} v${srcVersion}`,
        generationId: null,
        thumbnailKey: v.thumbnailKey,
      });
      await tx.update(games).set({ remixes: sql`${games.remixes} + 1` }).where(eq(games.id, src.id));
      await recomputeTrending(tx, src.id);
      return getGame(tx, created!.id);
    });
    return c.json({ game: await viewGame(db, game, userId) }, 201);
  });

  /** Published spin-offs (remixes) of a game, most trending first. */
  r.get("/v1/games/:id/remixes", async (c) => {
    const src = await getGame(db, c.req.param("id"));
    const page = await pageGames(db, {
      where: and(listed(), eq(games.remixOfGameId, src.id)),
      sort: sql`${games.trendingScore}`,
      sortType: "float8",
      cursor: c.req.query("cursor"),
      limit: parseLimit(c.req.query("limit")),
    });
    return c.json({ games: await feedGames(db, page.games, c.get("userId")), next: page.next });
  });

  // ---------- reports (§11.7) ----------

  /** One report per user per game (repeats are no-ops). ≥3 distinct reporters ⇒ hidden. */
  r.post("/v1/games/:id/report", async (c) => {
    const body = await parseJson(c.req.raw, Report);
    const userId = c.get("userId");
    const g = await getGame(db, c.req.param("id"));
    if (g.status !== "published") fail(404, "game not found");
    if (g.ownerId === userId) fail(400, "can't report your own game");
    await db.transaction(async (tx) => {
      await getGame(tx, g.id, { lock: true });
      await tx.insert(reports).values({ gameId: g.id, userId, reason: body.reason }).onConflictDoNothing();
      const [{ n }] = (await tx.select({ n: count() }).from(reports).where(eq(reports.gameId, g.id))) as [{ n: number }];
      if (n >= HIDE_AT_REPORTS) await tx.update(games).set({ hidden: true }).where(eq(games.id, g.id));
    });
    return c.json({ ok: true });
  });

  // ---------- public (no auth) (§11.5) ----------

  async function getListedGame(id: string) {
    const g = await getGame(db, id);
    if (g.status !== "published" || g.hidden || !g.publishedVersion) fail(404, "game not found");
    return g;
  }

  r.get("/v1/public/games/:id", async (c) => {
    const g = await getListedGame(c.req.param("id"));
    const extras = await hydrate(db, [g], null);
    return c.json({ game: { ...feedGameView(g, extras(g)), publishedVersion: g.publishedVersion } });
  });

  r.get("/v1/public/games/:id/package", async (c) => {
    const g = await getListedGame(c.req.param("id"));
    const v = await getVersion(db, g.id, g.publishedVersion!);
    const res = packageResponse(await readPackage(storage, v), v.packageSha256);
    res.headers.set("cache-control", "public, max-age=300");
    return res;
  });

  // ---------- marketplace (§11.6) ----------

  /**
   * Store items across published, non-hidden games (from each published version's manifest).
   * v1: flattened in memory and paginated by offset (cursor = opaque offset).
   */
  r.get("/v1/marketplace", async (c) => {
    const sort = MarketSort.parse(c.req.query("sort") || undefined);
    const limit = parseLimit(c.req.query("limit"));
    const cur = decodeCursor(c.req.query("cursor"));
    const offset = cur ? Number(cur[0]) || 0 : 0;

    const rows = await db.select({
      gameId: games.id,
      gameName: games.name,
      publishedAt: games.publishedAt,
      store: sql<Manifest["store"]>`${gameVersions.manifest}->'store'`,
    }).from(games)
      .innerJoin(gameVersions, and(eq(gameVersions.gameId, games.id), eq(gameVersions.version, games.publishedVersion)))
      .where(and(listed(), sql`jsonb_array_length(coalesce(${gameVersions.manifest}->'store', '[]'::jsonb)) > 0`))
      .orderBy(desc(games.publishedAt), desc(games.id));

    const sales = rows.length
      ? await db.select({ gameId: purchases.gameId, itemId: purchases.itemId, n: count() }).from(purchases)
        .where(inArray(purchases.gameId, rows.map((r) => r.gameId)))
        .groupBy(purchases.gameId, purchases.itemId)
      : [];
    const salesBy = new Map(sales.map((s) => [`${s.gameId}/${s.itemId}`, s.n]));

    const items = rows.flatMap((g) => (g.store ?? []).map((i) => ({
      gameId: g.gameId,
      gameName: g.gameName,
      itemId: i.id,
      kind: i.kind,
      name: i.name,
      description: i.description ?? "",
      price: i.price,
      sales: salesBy.get(`${g.gameId}/${i.id}`) ?? 0,
    })));
    // rows are newest-first, and sort is stable, so ties keep "new" order
    if (sort === "popular") items.sort((a, b) => b.sales - a.sales);
    if (sort === "price") items.sort((a, b) => a.price - b.price);

    const page = items.slice(offset, offset + limit);
    const next = offset + limit < items.length ? encodeCursor(String(offset + limit), "") : null;
    return c.json({ items: page, next });
  });

  return r;
}
