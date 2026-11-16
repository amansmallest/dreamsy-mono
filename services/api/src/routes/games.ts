import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { z } from "zod";
import { optionalUser, requireUser } from "../auth.js";
import { fail, parseJson, router, type Deps } from "../context.js";
import { schema } from "../db/client.js";
import { ACTIVE_GENERATION } from "../db/schema.js";
import { newId } from "../ids.js";
import { blobResponse } from "./uploads.js";
import {
  canAccessVersion,
  commitVersion,
  getGame,
  getOwnedGame,
  getVersion,
  multiplayerFilter,
  parseLimit,
  publishFields,
  sharedWithUser,
  readPackage,
  recomputeTrending,
  versionView,
  viewGame,
  viewGames,
  viewSharedGames,
} from "../services.js";

const { games, gameVersions } = schema;

const Visibility = z.enum(["public", "private"]);
const CreateGame = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(2000).optional(),
  /** §11.8: default "public" (every new version goes live). */
  visibility: Visibility.optional(),
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
      ...(body.visibility ? { visibility: body.visibility } : {}),
    }).returning();
    return c.json({ game: await viewGame(db, game!, c.get("userId")) }, 201);
  });

  /** Discover: published games, newest first. Cursor = `updatedAt` of the last item. `?multiplayer=1` filters. */
  r.get("/v1/games", async (c) => {
    const limit = parseLimit(c.req.query("limit"));
    const before = c.req.query("before");
    const rows = await db.select().from(games)
      .where(and(
        eq(games.status, "published"), eq(games.hidden, false),
        before ? lt(games.updatedAt, new Date(before)) : undefined,
        multiplayerFilter(c.req.query("multiplayer")),
      ))
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
    if (g.ownerId !== userId) {
      // Group members of a shared game get the latest version (drafts included), §13.
      if (await sharedWithUser(db, g.id, userId)) return c.json({ game: { ...(await viewSharedGames(db, [g], userId))[0], shared: true } });
      if (g.status !== "published") fail(404, "game not found");
    }
    return c.json({ game: await viewGame(db, g, userId) });
  });

  /** Rename / describe / switch visibility (§11.8). Public ⇒ latest version goes live; private ⇒ unpublished. */
  r.patch("/v1/games/:id", async (c) => {
    const { visibility, ...body } = await parseJson(c.req.raw, UpdateGame);
    const g = await getOwnedGame(db, c.req.param("id"), c.get("userId"));
    if (Object.keys(body).length > 0) {
      await db.update(games).set({ ...body, updatedAt: new Date() }).where(eq(games.id, g.id));
    }
    if (visibility === "public") await setLive(g.id, null);
    else if (visibility === "private") await makePrivate(g.id);
    return c.json({ game: await viewGame(db, await getGame(db, g.id), c.get("userId")) });
  });

  /**
   * Make the game public and put `version` (default: latest) live. With no versions yet it just
   * turns public; the first commit then goes live by itself.
   */
  async function setLive(id: string, requested: number | null) {
    await db.transaction(async (tx) => {
      const g = await getGame(tx, id, { lock: true });
      const version = requested ?? g.latestVersion;
      if (version < 1) {
        await tx.update(games).set({ visibility: "public", updatedAt: new Date() }).where(eq(games.id, id));
        return;
      }
      await getVersion(tx, id, version);
      await tx.update(games)
        .set({ visibility: "public", ...publishFields(version), updatedAt: new Date() })
        .where(eq(games.id, id));
      await recomputeTrending(tx, id);
    });
  }

  async function makePrivate(id: string) {
    await db.update(games)
      .set({ visibility: "private", status: "draft", publishedVersion: null, updatedAt: new Date() })
      .where(eq(games.id, id));
  }

  /** Public + this version live (pin an older version: the next commit moves live to the newest again). */
  r.post("/v1/games/:id/publish", async (c) => {
    const body = await parseJson(c.req.raw, Publish);
    const g = await getOwnedGame(db, c.req.param("id"), c.get("userId"));
    const version = body.version ?? g.latestVersion;
    if (version < 1) fail(409, "game has no versions yet");
    await setLive(g.id, version);
    return c.json({ game: await viewGame(db, await getGame(db, g.id), c.get("userId")) });
  });

  /** Same as PATCH {visibility: "private"}. */
  r.post("/v1/games/:id/unpublish", async (c) => {
    const g = await getOwnedGame(db, c.req.param("id"), c.get("userId"));
    await makePrivate(g.id);
    return c.json({ game: await viewGame(db, await getGame(db, g.id), c.get("userId")) });
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
    if (!(await canAccessVersion(db, g, c.get("userId"), version))) fail(404, "version not found");
    return c.json({ version: versionView(await getVersion(db, g.id, version)) });
  });

  r.get("/v1/games/:id/versions/:version/package", async (c) => {
    const g = await getGame(db, c.req.param("id"));
    const version = parseVersion(c.req.param("version"));
    if (!(await canAccessVersion(db, g, c.get("userId"), version))) fail(404, "version not found");
    const v = await getVersion(db, g.id, version);
    return packageResponse(await readPackage(storage, v), v.packageSha256);
  });

  /** **Public** for the published version; owner (with bearer) for any version. JPEG from the harness playtest. */
  r.get("/v1/games/:id/versions/:version/thumbnail", async (c) => {
    const g = await getGame(db, c.req.param("id"));
    const version = parseVersion(c.req.param("version"));
    const userId = (c.get("userId") as string | undefined) ?? null;
    if (!(await canAccessVersion(db, g, userId, version))) fail(404, "thumbnail not found");
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
