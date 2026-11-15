import {
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  handle: text("handle").notNull(),
  bio: text("bio").notNull().default(""),
  /** Ink avatar parts picked in the app (`{ part: index }`); null until onboarding is done. */
  avatar: jsonb("avatar").$type<Record<string, number>>(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("users_handle_idx").on(t.handle)]);

/** External sign-in identities (Apple, Google, Supabase) linked to a user. */
export const authIdentities = pgTable("auth_identities", {
  /** "apple" | "google" | "supabase" */
  provider: text("provider").notNull(),
  /** Provider's stable user id (`sub` claim). */
  subject: text("subject").notNull(),
  userId: text("user_id").notNull().references(() => users.id),
  email: text("email"),
  createdAt: createdAt(),
}, (t) => [
  primaryKey({ columns: [t.provider, t.subject] }),
  index("auth_identities_user_idx").on(t.userId),
]);

export const games = pgTable("games", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull().references(() => users.id),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  /** "draft" | "published" */
  status: text("status").notNull().default("draft"),
  /** Highest committed version; 0 = empty game, no package yet. */
  latestVersion: integer("latest_version").notNull().default(0),
  publishedVersion: integer("published_version"),
  /** First publish; never cleared (feeds order "new" by it, trending decays from it). */
  publishedAt: timestamp("published_at", { withTimezone: true }),
  /** Denormalized counters (DREAMSY.MD §11.2); bumped in the same tx as the like/play/remix row. */
  plays: integer("plays").notNull().default(0),
  likes: integer("likes").notNull().default(0),
  remixes: integer("remixes").notNull().default(0),
  /** Recomputed whenever a play/like/remix lands (see recomputeTrending). */
  trendingScore: doublePrecision("trending_score").notNull().default(0),
  /** Set when this game is a remix (§11.3). */
  remixOfGameId: text("remix_of_game_id"),
  remixOfVersion: integer("remix_of_version"),
  /** Auto-set at ≥3 distinct reports; hidden games drop out of feeds/search/public (§11.7). */
  hidden: boolean("hidden").notNull().default(false),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("games_owner_idx").on(t.ownerId),
  index("games_status_idx").on(t.status, t.updatedAt),
  index("games_trending_idx").on(t.trendingScore, t.id),
  index("games_published_at_idx").on(t.publishedAt, t.id),
  index("games_remix_of_idx").on(t.remixOfGameId, t.createdAt),
]);

/** Immutable. A new edit always creates version = latest + 1. */
export const gameVersions = pgTable("game_versions", {
  gameId: text("game_id").notNull().references(() => games.id),
  version: integer("version").notNull(),
  packageKey: text("package_key").notNull(),
  packageSha256: text("package_sha256").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  manifest: jsonb("manifest").notNull(),
  summary: text("summary").notNull().default(""),
  generationId: text("generation_id"),
  /** JPEG from the harness playtest (`thumbnails/<sha256>.jpg`), if the worker sent one. */
  thumbnailKey: text("thumbnail_key"),
  createdBy: text("created_by").notNull(),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.gameId, t.version] })]);

/** Reference images a user attaches to a prompt. */
export const uploads = pgTable("uploads", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull().references(() => users.id),
  key: text("key").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  createdAt: createdAt(),
});

/** Worker-reported build metrics (harness `metrics` event, see services/api/README.md). */
export interface GenerationMetrics {
  costUsd: number;
  rounds: number;
  turns: number;
  minutes: number;
  artScore: number | null;
  artVerdict: "ship" | "polish" | null;
  playtestRuns: number;
  runtimeErrorsFixed: number;
  finalGatePassedFirstTry: boolean | null;
  memoryHits: number;
  spritesReused: number;
  spritesDrawn: number;
  kit: string | null;
  pack: string | null;
  kind: string | null;
  memoryIds?: string[];
}

export const generations = pgTable("generations", {
  id: text("id").primaryKey(),
  gameId: text("game_id").notNull().references(() => games.id),
  userId: text("user_id").notNull().references(() => users.id),
  prompt: text("prompt").notNull(),
  imageIds: jsonb("image_ids").$type<string[]>().notNull(),
  /** Asset ids the edit is scoped to (sprite click-to-edit); empty = whole game. */
  assetIds: jsonb("asset_ids").$type<string[]>().notNull().default([]),
  /** Entity IDs the user tapped to scope the edit. */
  selection: jsonb("selection").$type<string[]>().notNull(),
  /** Version the edit applies on top of (0 = from scratch). */
  baseVersion: integer("base_version").notNull(),
  /** "queued" | "running" | "succeeded" | "failed" | "canceled" */
  status: text("status").notNull().default("queued"),
  /** Model provider that builds it: "anthropic" (Claude) | "openai". Workers claim only their provider's jobs. */
  provider: text("provider").notNull().default("anthropic"),
  workerId: text("worker_id"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  attempts: integer("attempts").notNull().default(0),
  resultVersion: integer("result_version"),
  error: text("error"),
  /** Worker's latest estimate, from `eta` events. */
  etaSeconds: integer("eta_seconds"),
  /** `{round, rounds, phase}` from `eta` events (multi-round builds). */
  progress: jsonb("progress").$type<{ round?: number; rounds?: number; phase?: string }>(),
  /** Per-build metrics from the worker's `metrics` event (insights graphs); null until it arrives. */
  metrics: jsonb("metrics").$type<GenerationMetrics>(),
  createdAt: createdAt(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, (t) => [
  index("generations_queue_idx").on(t.status, t.createdAt),
  index("generations_game_idx").on(t.gameId),
  index("generations_user_day_idx").on(t.userId, t.createdAt),
]);

/** Append-only progress log, streamed to clients over SSE. */
export const generationEvents = pgTable("generation_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  generationId: text("generation_id").notNull().references(() => generations.id),
  type: text("type").notNull(),
  data: jsonb("data").notNull(),
  createdAt: createdAt(),
}, (t) => [index("generation_events_gen_idx").on(t.generationId, t.id)]);

// ---------- Stars economy (no real money yet) ----------

export const wallets = pgTable("wallets", {
  userId: text("user_id").primaryKey().references(() => users.id),
  balance: integer("balance").notNull().default(0),
  createdAt: createdAt(),
});

/** Append-only. Sum of deltas per user == wallets.balance. */
export const ledger = pgTable("ledger", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  delta: integer("delta").notNull(),
  balanceAfter: integer("balance_after").notNull(),
  /** "starter_grant" | "purchase" | "sale" */
  kind: text("kind").notNull(),
  gameId: text("game_id"),
  itemId: text("item_id"),
  purchaseId: text("purchase_id"),
  createdAt: createdAt(),
}, (t) => [index("ledger_user_idx").on(t.userId, t.id)]);

export const purchases = pgTable("purchases", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  gameId: text("game_id").notNull().references(() => games.id),
  itemId: text("item_id").notNull(),
  /** "pass" | "consumable" */
  kind: text("kind").notNull(),
  price: integer("price").notNull(),
  /** Game version whose manifest defined the item. */
  version: integer("version").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  index("purchases_owner_idx").on(t.userId, t.gameId),
  uniqueIndex("purchases_idem_idx").on(t.userId, t.idempotencyKey),
]);

// ---------- Platform v1: social (DREAMSY.MD §11) ----------

export const likes = pgTable("likes", {
  userId: text("user_id").notNull().references(() => users.id),
  gameId: text("game_id").notNull().references(() => games.id),
  createdAt: createdAt(),
}, (t) => [
  primaryKey({ columns: [t.userId, t.gameId] }),
  index("likes_game_idx").on(t.gameId, t.createdAt),
]);

/** One row per counted play; `hour` (UTC hour bucket) dedupes to 1/user/game/hour. */
export const plays = pgTable("plays", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  gameId: text("game_id").notNull().references(() => games.id),
  version: integer("version").notNull(),
  hour: timestamp("hour", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("plays_dedupe_idx").on(t.userId, t.gameId, t.hour),
  index("plays_game_idx").on(t.gameId, t.createdAt),
]);

export const follows = pgTable("follows", {
  followerId: text("follower_id").notNull().references(() => users.id),
  followeeId: text("followee_id").notNull().references(() => users.id),
  createdAt: createdAt(),
}, (t) => [
  primaryKey({ columns: [t.followerId, t.followeeId] }),
  index("follows_followee_idx").on(t.followeeId),
]);

/** One report per user per game. */
export const reports = pgTable("reports", {
  gameId: text("game_id").notNull().references(() => games.id),
  userId: text("user_id").notNull().references(() => users.id),
  reason: text("reason").notNull(),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.gameId, t.userId] })]);

export const ACTIVE_GENERATION = ["queued", "running"] as const;
export const TERMINAL_GENERATION = ["succeeded", "failed", "canceled"] as const;

/** Pending email sign-in codes (one row per address; the latest code wins). Only a hash is stored. */
export const emailCodes = pgTable("email_codes", {
  email: text("email").primaryKey(),
  codeHash: text("code_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  attempts: integer("attempts").notNull().default(0),
  /** Rate limit: codes sent in the current hour window. */
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  sendsInWindow: integer("sends_in_window").notNull().default(0),
  lastSentAt: timestamp("last_sent_at", { withTimezone: true }).notNull(),
});
