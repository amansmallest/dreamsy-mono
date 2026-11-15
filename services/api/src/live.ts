import { eq } from "drizzle-orm";
import { schema, type DB } from "./db/client.js";

const { generations, games, users } = schema;

/**
 * Mirrors the interesting build steps to the Convex live feed (services/live) for real-time
 * "live now" UIs. Fire-and-forget: Convex being slow or down never affects a build.
 * Enabled when CONVEX_SITE_URL and LIVE_INGEST_SECRET are set.
 */
const SITE = (process.env.CONVEX_SITE_URL ?? "").replace(/\/$/, "");
const SECRET = process.env.LIVE_INGEST_SECRET ?? "";

type D = Record<string, unknown>;
const s = (x: unknown) => (typeof x === "string" ? x : "");

/** Human line for a step, or null to skip (chatty internals: working, cost, heartbeat…). */
export function liveText(type: string, d: D): string | null {
  switch (type) {
    case "started": return "Build started";
    case "route": {
      const what: Record<string, string> = { new_game: "a new game", feature: "a new feature", tweak: "a tweak", asset: "a sprite edit" };
      return typeof d.kind === "string" && what[d.kind] ? `Planning ${what[d.kind]}` : null;
    }
    case "template": return `Starting from the ${s(d.kit)} kit`;
    case "memory": return Array.isArray(d.ids) && d.ids.length ? `Recalled ${d.ids.length} lessons from past builds` : null;
    case "sprite": return `Drew sprite “${s(d.id)}”`;
    case "content": return `Built ${d.items ?? ""} ${s(d.kind)} with ${d.workers ?? 1} workers`;
    case "playtest": return `Playtested (${d.shots ?? 0} screenshots)`;
    case "review": return "Art director reviewing";
    case "review.done": return `Art director: ${d.score ?? "?"}/10`;
    case "note": return s(d.text).slice(0, 160) || null;
    case "eta": return d.phase ? `Round ${d.round ?? 1}/${d.rounds ?? 1}: ${s(d.phase)}` : null;
    case "checkpoint": return `Version ${d.version} playable`;
    case "succeeded": return s(d.summary).slice(0, 160) || `Version ${d.version} ready`;
    case "failed": return "Build failed";
    default: return null;
  }
}

const meta = new Map<string, { gameId: string; gameName: string; creator: string; kind: string }>();

export function mirrorToLive(db: DB, genId: string, type: string, data: unknown): void {
  if (!SITE || !SECRET) return;
  const d = (data && typeof data === "object" ? data : {}) as D;
  const text = liveText(type, d);
  if (text === null) return;
  void (async () => {
    let m = meta.get(genId);
    if (!m || type === "succeeded" || type === "checkpoint") {
      const [row] = await db.select({ gameId: games.id, gameName: games.name, creator: users.handle })
        .from(generations).innerJoin(games, eq(games.id, generations.gameId)).innerJoin(users, eq(users.id, generations.userId))
        .where(eq(generations.id, genId));
      if (!row) return;
      m = { ...row, kind: m?.kind ?? "unknown" };
      meta.set(genId, m);
      if (meta.size > 500) meta.delete(meta.keys().next().value!);
    }
    if (type === "route" && typeof d.kind === "string") m.kind = d.kind;
    await fetch(`${SITE}/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({
        genId, gameId: m.gameId, gameName: m.gameName, creator: m.creator, kind: m.kind, type, text,
        status: type === "succeeded" ? "succeeded" : type === "failed" ? "failed" : "running",
        version: typeof d.version === "number" ? d.version : null,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (type === "succeeded" || type === "failed") meta.delete(genId);
  })().catch(() => {});
}
