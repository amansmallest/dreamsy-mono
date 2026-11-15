import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { AssetMeta, Package } from "@dreamsy/format";
import { optionalUser, requireUser } from "../auth.js";
import { fail, router, type Deps } from "../context.js";
import { schema } from "../db/client.js";
import { canAccessVersion, generationView, getGame, getVersion, readPackage, type GameVersion } from "../services.js";
import { parseVersion } from "./games.js";

const { generations, games } = schema;

const MIME: Record<string, string> = {
  svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", webp: "image/webp",
  glb: "model/gltf-binary", ogg: "audio/ogg", mp3: "audio/mpeg", wav: "audio/wav", ttf: "font/ttf", otf: "font/otf",
};

/** Unzipped packages by sha256 (versions are immutable, so this never goes stale). Small LRU. */
const unzipped = new Map<string, Package>();
async function openPackage(storage: Deps["storage"], v: GameVersion): Promise<Package> {
  const hit = unzipped.get(v.packageSha256);
  if (hit) { unzipped.delete(v.packageSha256); unzipped.set(v.packageSha256, hit); return hit; }
  const pkg = Package.fromZip(await readPackage(storage, v));
  unzipped.set(v.packageSha256, pkg);
  if (unzipped.size > 32) unzipped.delete(unzipped.keys().next().value!);
  return pkg;
}

/**
 * Per-asset access for the web dashboard's sprite gallery (click a sprite → edit it):
 *   GET /v1/games/:id/versions/:v/assets          → every asset with provenance
 *   GET /v1/games/:id/versions/:v/assets/:file    → the file (public for the published version)
 *   GET /v1/me/activity                           → my builds across all games, newest first
 */
export function assetRoutes({ db, storage, config }: Deps) {
  const r = router();

  async function visibleVersion(gameId: string, versionParam: string, userId: string | null) {
    const game = await getGame(db, gameId);
    const version = parseVersion(versionParam);
    if (!(await canAccessVersion(db, game, userId, version))) fail(404, "version not found");
    return getVersion(db, game.id, version);
  }

  r.get("/v1/games/:id/versions/:version/assets", optionalUser(config), async (c) => {
    const v = await visibleVersion(c.req.param("id"), c.req.param("version"), c.get("userId") ?? null);
    const pkg = await openPackage(storage, v);
    const assets = [];
    for (const path of pkg.paths("assets/")) {
      const m = path.match(/^assets\/([^/]+)\.meta\.json$/);
      if (!m) continue;
      let meta;
      try { meta = AssetMeta.parse(JSON.parse(pkg.text(path)!)); } catch { continue; }
      const bytes = pkg.bytes(`assets/${meta.file}`);
      if (!bytes) continue;
      assets.push({
        id: m[1]!,
        kind: meta.kind,
        file: meta.file,
        url: `/v1/games/${v.gameId}/versions/${v.version}/assets/${encodeURIComponent(meta.file)}`,
        prompt: meta.source?.prompt ?? null,
        model: meta.source?.model ?? null,
        sizeBytes: bytes.byteLength,
      });
    }
    assets.sort((a, b) => a.id.localeCompare(b.id));
    return c.json({ gameId: v.gameId, version: v.version, assets });
  });

  r.get("/v1/games/:id/versions/:version/assets/:file", optionalUser(config), async (c) => {
    const file = decodeURIComponent(c.req.param("file"));
    if (!/^[a-z0-9_\-]+\.[a-z0-9]+$/.test(file)) fail(400, "bad asset file name");
    const v = await visibleVersion(c.req.param("id"), c.req.param("version"), c.get("userId") ?? null);
    const pkg = await openPackage(storage, v);
    const bytes = pkg.bytes(`assets/${file}`);
    if (!bytes) fail(404, "asset not found");
    const ext = file.split(".").pop()!;
    return new Response(bytes as Uint8Array<ArrayBuffer>, {
      headers: {
        "content-type": MIME[ext] ?? "application/octet-stream",
        "cache-control": "private, max-age=31536000, immutable", // versions are immutable
        // SVGs are model-written: never let them run as a document.
        ...(ext === "svg" ? { "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox" } : {}),
      },
    });
  });

  r.get("/v1/me/activity", requireUser(config), async (c) => {
    const userId = c.get("userId");
    const limit = Math.min(Math.max(Number(c.req.query("limit")) || 20, 1), 50);
    const before = c.req.query("cursor");
    const rows = await db.select().from(generations)
      .where(and(eq(generations.userId, userId), before ? lt(generations.createdAt, new Date(before)) : undefined))
      .orderBy(desc(generations.createdAt))
      .limit(limit);
    const gameRows = rows.length
      ? await db.select({ id: games.id, name: games.name }).from(games).where(inArray(games.id, [...new Set(rows.map((g) => g.gameId))]))
      : [];
    const names = new Map(gameRows.map((g) => [g.id, g.name]));
    return c.json({
      items: rows.map((g) => ({
        generation: generationView(g),
        game: { id: g.gameId, name: names.get(g.gameId) ?? "", thumbnailUrl: g.resultVersion ? `/v1/games/${g.gameId}/versions/${g.resultVersion}/thumbnail` : null },
      })),
      next: rows.length === limit ? rows.at(-1)!.createdAt.toISOString() : null,
    });
  });

  return r;
}
