import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { optionalUser, requireUser } from "../auth.js";
import { fail, parseJson, router, type Deps } from "../context.js";
import { schema } from "../db/client.js";
import { ACTIVE_GENERATION } from "../db/schema.js";
import { newId } from "../ids.js";
import { blobResponse } from "./uploads.js";
import {
  canSeeVersion,
  commitVersion,
  getGame,
  getOwnedGame,
  getVersion,
  parseLimit,
  readPackage,
  recomputeTrending,
  versionView,
  viewGame,
  viewGames,
} from "../services.js";

const { games, gameVersions } = schema;

const CreateGame = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(2000).optional(),
});
const UpdateGame = CreateGame.partial();
const Publish = z.object({ version: z.number().int().positive().optional() });
const Revert = z.object({ version: z.number().int().positive() });

export const parseVersion = (s: string) => {
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1) fail(400, "version must be a positive integer");
  return n;
};

/** Thumbnails are **public** for the published version (§11.2), so auth is optional there. */
const THUMBNAIL_PATH = /^\/v1\/games\/[^/]+\/versions\/[^/]+\/thumbnail$/;

export function gameRoutes({ db, storage, config }: Deps) {
  const r = router();
  const auth = requireUser(config);
  const maybeAuth = optionalUser(config);
  // Also guards /v1/games/* routes registered by other routers (store, generations, social).
  r.use("/v1/games/*", (c, next) => (c.req.method === "GET" && THUMBNAIL_PATH.test(c.req.path) ? maybeAuth : auth)(c, next));
  r.use("/v1/games", requireUser(config));
  r.use("/v1/me/games", requireUser(config));

  r.post("/v1/games", async (c) => {
    const body = await parseJson(c.req.raw, CreateGame);
    const [game] = await db.insert(games).values({
      id: newId("g"),
      ownerId: c.get("userId"),
      name: body.name,
      description: body.description ?? "",
    }).returning();
    return c.json({ game: await viewGame(db, game!, c.get("userId")) }, 201);
  });

  /** Discover: published games, newest first. Cursor = `updatedAt` of the last item. */
  r.get("/v1/games", async (c) => {
    const limit = parseLimit(c.req.query("limit"));
    const before = c.req.query("before");
    const rows = await db.select().from(games)
      .where(and(eq(games.status, "published"), eq(games.hidden, false), before ? lt(games.updatedAt, new Date(before)) : undefined))
      .orderBy(desc(games.updatedAt))
      .limit(limit);
    return c.json({ games: await viewGames(db, rows, c.get("userId")), next: rows.length === limit ? rows.at(-1)!.updatedAt : null });
  });

  r.get("/v1/me/games", async (c) => {
    const rows = await db.select().from(games)
      .where(eq(games.ownerId, c.get("userId")))
      .orderBy(desc(games.updatedAt));
    return c.json({ games: await viewGames(db, rows, c.get("userId")) });
  });

  r.get("/v1/games/:id", async (c) => {
    const g = await getGame(db, c.req.param("id"));
    const userId = c.get("userId");
    if (g.ownerId !== userId && g.status !== "published") fail(404, "game not found");
    return c.json({ game: await viewGame(db, g, userId) });
  });

  r.patch("/v1/games/:id", async (c) => {
    const body = await parseJson(c.req.raw, UpdateGame);
    await getOwnedGame(db, c.req.param("id"), c.get("userId"));
    const [g] = await db.update(games)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(games.id, c.req.param("id")))
      .returning();
    return c.json({ game: await viewGame(db, g!, c.get("userId")) });
  });

  r.post("/v1/games/:id/publish", async (c) => {
    const body = await parseJson(c.req.raw, Publish);
    const g = await getOwnedGame(db, c.req.param("id"), c.get("userId"));
    const version = body.version ?? g.latestVersion;
    if (version < 1) fail(409, "game has no versions yet");
    await getVersion(db, g.id, version);
    await db.update(games)
      .set({ status: "published", publishedVersion: version, publishedAt: sql`coalesce(${games.publishedAt}, now())`, updatedAt: new Date() })
      .where(eq(games.id, g.id));
    await recomputeTrending(db, g.id);
    return c.json({ game: await viewGame(db, await getGame(db, g.id), c.get("userId")) });
  });

  r.post("/v1/games/:id/unpublish", async (c) => {
    const g = await getOwnedGame(db, c.req.param("id"), c.get("userId"));
    const [updated] = await db.update(games)
      .set({ status: "draft", publishedVersion: null, updatedAt: new Date() })
      .where(eq(games.id, g.id))
      .returning();
    return c.json({ game: await viewGame(db, updated!, c.get("userId")) });
  });

  r.get("/v1/games/:id/versions", async (c) => {
    const g = await getOwnedGame(db, c.req.param("id"), c.get("userId"));
    const rows = await db.select().from(gameVersions)
      .where(eq(gameVersions.gameId, g.id))
      .orderBy(desc(gameVersions.version));
    return c.json({ versions: rows.map(versionView) });
  });

  r.get("/v1/games/:id/versions/:version", async (c) => {
    const g = await getGame(db, c.req.param("id"));
    const version = parseVersion(c.req.param("version"));
    if (!canSeeVersion(g, c.get("userId"), version)) fail(404, "version not found");
    return c.json({ version: versionView(await getVersion(db, g.id, version)) });
  });

  r.get("/v1/games/:id/versions/:version/package", async (c) => {
    const g = await getGame(db, c.req.param("id"));
    const version = parseVersion(c.req.param("version"));
    if (!canSeeVersion(g, c.get("userId"), version)) fail(404, "version not found");
    const v = await getVersion(db, g.id, version);
    return packageResponse(await readPackage(storage, v), v.packageSha256);
  });

  /** **Public** for the published version; owner (with bearer) for any version. JPEG from the harness playtest. */
  r.get("/v1/games/:id/versions/:version/thumbnail", async (c) => {
    const g = await getGame(db, c.req.param("id"));
    const version = parseVersion(c.req.param("version"));
    const userId = (c.get("userId") as string | undefined) ?? null;
    if (!canSeeVersion(g, userId, version)) fail(404, "thumbnail not found");
    const v = await getVersion(db, g.id, version);
    if (!v.thumbnailKey) fail(404, "thumbnail not found");
    const res = await blobResponse(storage, v.thumbnailKey, "image/jpeg");
    res.headers.set("cache-control", "public, max-age=3600");
    return res;
  });

  /** Undo: versions are immutable, so revert = new version with an old package. */
  r.post("/v1/games/:id/revert", async (c) => {
    const body = await parseJson(c.req.raw, Revert);
    const userId = c.get("userId");
    const version = await db.transaction(async (tx) => {
      const g = await getOwnedGame(tx, c.req.param("id"), userId, { lock: true });
      const [active] = await tx.select({ id: schema.generations.id }).from(schema.generations)
        .where(and(eq(schema.generations.gameId, g.id), inArray(schema.generations.status, [...ACTIVE_GENERATION])));
      if (active) fail(409, "a generation is in progress on this game");
      const old = await getVersion(tx, g.id, body.version);
      return commitVersion(tx, g, {
        key: old.packageKey,
        sha256: old.packageSha256,
        sizeBytes: old.sizeBytes,
        manifest: old.manifest as never,
      }, { createdBy: userId, summary: `Reverted to version ${old.version}`, generationId: null, thumbnailKey: old.thumbnailKey });
    });
    return c.json({ version: versionView(version) }, 201);
  });

  return r;
}

export function packageResponse(body: Uint8Array<ArrayBuffer>, sha256: string) {
  return new Response(body, {
    headers: {
      "content-type": "application/zip",
      "content-length": String(body.byteLength),
      etag: `"${sha256}"`,
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
}
