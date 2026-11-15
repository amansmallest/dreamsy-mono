import { v } from "convex/values";
import { internalMutation, query, type MutationCtx } from "./_generated/server";
import schema, { buildStatus } from "./schema";

const KEEP_EVENTS_MS = 24 * 60 * 60 * 1000;

async function bumpStats(ctx: MutationCtx, field: "started" | "succeeded" | "failed") {
  const s = await ctx.db.query("stats").withIndex("by_key", (q) => q.eq("key", "global")).unique();
  if (s) await ctx.db.patch("stats", s._id, { [field]: s[field] + 1 });
  else await ctx.db.insert("stats", { key: "global", started: 0, succeeded: 0, failed: 0, [field]: 1 });
}

/** One build step from the API (called by the /ingest HTTP action). */
export const ingest = internalMutation({
  args: {
    genId: v.string(),
    gameId: v.string(),
    gameName: v.string(),
    creator: v.string(),
    kind: v.string(),
    type: v.string(),
    text: v.string(),
    status: buildStatus,
    version: v.union(v.number(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    const now = Date.now();
    const b = await ctx.db.query("builds").withIndex("by_genId", (q) => q.eq("genId", a.genId)).unique();
    if (!b) {
      await ctx.db.insert("builds", {
        genId: a.genId, gameId: a.gameId, gameName: a.gameName, creator: a.creator, kind: a.kind,
        status: a.status, lastType: a.type, lastText: a.text, version: a.version, steps: 1, startedAt: now, updatedAt: now,
      });
      await bumpStats(ctx, "started");
    } else {
      if (b.status === "running" && a.status !== "running") await bumpStats(ctx, a.status);
      await ctx.db.patch("builds", b._id, {
        gameName: a.gameName || b.gameName,
        kind: a.kind !== "unknown" ? a.kind : b.kind,
        status: a.status, lastType: a.type, lastText: a.text,
        version: a.version ?? b.version, steps: b.steps + 1, updatedAt: now,
      });
    }
    if (!b && a.status !== "running") await bumpStats(ctx, a.status);
    await ctx.db.insert("events", { genId: a.genId, gameName: a.gameName, creator: a.creator, type: a.type, text: a.text, at: now });
    return null;
  },
});

const buildDoc = schema.doc("builds");
const eventDoc = schema.doc("events");

/** Everything the "Live now" panels need, in one subscription. */
export const feed = query({
  args: {},
  returns: v.object({
    running: v.array(buildDoc),
    recentBuilds: v.array(buildDoc),
    events: v.array(eventDoc),
    stats: v.object({ started: v.number(), succeeded: v.number(), failed: v.number() }),
  }),
  handler: async (ctx) => {
    const running = await ctx.db.query("builds")
      .withIndex("by_status_and_updatedAt", (q) => q.eq("status", "running")).order("desc").take(12);
    const recentBuilds = await ctx.db.query("builds").withIndex("by_updatedAt").order("desc").take(12);
    const events = await ctx.db.query("events").withIndex("by_at").order("desc").take(30);
    const s = await ctx.db.query("stats").withIndex("by_key", (q) => q.eq("key", "global")).unique();
    return { running, recentBuilds, events, stats: { started: s?.started ?? 0, succeeded: s?.succeeded ?? 0, failed: s?.failed ?? 0 } };
  },
});

/** One build's live step list (newest first). */
export const build = query({
  args: { genId: v.string() },
  returns: v.object({ build: v.union(buildDoc, v.null()), events: v.array(eventDoc) }),
  handler: async (ctx, { genId }) => {
    const build = await ctx.db.query("builds").withIndex("by_genId", (q) => q.eq("genId", genId)).unique();
    const events = await ctx.db.query("events").withIndex("by_genId_and_at", (q) => q.eq("genId", genId)).order("desc").take(50);
    return { build, events };
  },
});

/** Hourly: drop events older than a day (in batches) and close builds silent for 2h. */
export const prune = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    const old = await ctx.db.query("events").withIndex("by_at", (q) => q.lt("at", now - KEEP_EVENTS_MS)).take(500);
    for (const e of old) await ctx.db.delete("events", e._id);
    const stale = await ctx.db.query("builds")
      .withIndex("by_status_and_updatedAt", (q) => q.eq("status", "running").lt("updatedAt", now - 2 * 60 * 60 * 1000)).take(100);
    for (const b of stale) await ctx.db.patch("builds", b._id, { status: "failed", lastText: "stopped responding", updatedAt: now });
    return null;
  },
});

/** Admin: remove one build and its events (e.g. smoke tests). `npx convex run --prod live:removeBuild '{"genId":"..."}'` */
export const removeBuild = internalMutation({
  args: { genId: v.string() },
  returns: v.null(),
  handler: async (ctx, { genId }) => {
    const b = await ctx.db.query("builds").withIndex("by_genId", (q) => q.eq("genId", genId)).unique();
    if (b) await ctx.db.delete("builds", b._id);
    for await (const e of ctx.db.query("events").withIndex("by_genId_and_at", (q) => q.eq("genId", genId))) await ctx.db.delete("events", e._id);
    const s = await ctx.db.query("stats").withIndex("by_key", (q) => q.eq("key", "global")).unique();
    if (s && b) await ctx.db.patch("stats", s._id, {
      started: Math.max(0, s.started - 1),
      ...(b.status !== "running" ? { [b.status]: Math.max(0, s[b.status] - 1) } : {}),
    });
    return null;
  },
});
