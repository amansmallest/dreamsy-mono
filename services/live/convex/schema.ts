import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Live mirror of Dreamsy builds (source of truth stays in the API's Postgres).
 * The API pushes each build's key steps to POST /ingest; clients subscribe to `live.feed`.
 */
export const buildStatus = v.union(v.literal("running"), v.literal("succeeded"), v.literal("failed"));

export default defineSchema({
  builds: defineTable({
    genId: v.string(),
    gameId: v.string(),
    gameName: v.string(),
    creator: v.string(),
    kind: v.string(),          // new_game | feature | tweak | asset | unknown
    status: buildStatus,
    lastType: v.string(),
    lastText: v.string(),
    version: v.union(v.number(), v.null()),
    steps: v.number(),
    startedAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_genId", ["genId"])
    .index("by_status_and_updatedAt", ["status", "updatedAt"])
    .index("by_updatedAt", ["updatedAt"]),
  events: defineTable({
    genId: v.string(),
    gameName: v.string(),
    creator: v.string(),
    type: v.string(),
    text: v.string(),
    at: v.number(),
  })
    .index("by_at", ["at"])
    .index("by_genId_and_at", ["genId", "at"]),
  stats: defineTable({
    key: v.literal("global"),
    started: v.number(),
    succeeded: v.number(),
    failed: v.number(),
  }).index("by_key", ["key"]),
});
