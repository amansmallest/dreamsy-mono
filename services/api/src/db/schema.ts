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
  /** Manifest `[players]` (DREAMSY.MD §3.1); max > 1 = multiplayer (§4.5). Set on commit; 1/1 when absent. */
  playersMin: integer("players_min").notNull().default(1),
  playersMax: integer("players_max").notNull().default(1),
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
  /** Coins charged when queued (CREATE_PRICE for a game's first build, else 0; §11.6). */
  charged: integer("charged").notNull().default(0),
  /** Set when `charged` was refunded (first build failed/canceled with no version). Refunds once. */
  refundedAt: timestamp("refunded_at", { withTimezone: true }),
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

// ---------- Coins economy (DREAMSY.MD §11.6; the "Stars" ledger, shown to users as coins) ----------

/** Ledger account that receives the platform's cut of plays and store sales. Seeded by migration 0011. */
export const PLATFORM_USER_ID = "u_platform";

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
  /**
   * "starter_grant" | "grant" (top-up) | "purchase" | "sale" | "play" (player debit) |
   * "play_earning" (creator credit) | "platform_fee" (platform account credit) |
   * "create" (first build: player debit + platform credit) | "create_refund" (its reversal) |
   * "remix" (remixer debit) | "remix_earning" (original owner credit)
   */
  kind: text("kind").notNull(),
  gameId: text("game_id"),
  itemId: text("item_id"),
  purchaseId: text("purchase_id"),
  /** Play pass a "play" / "play_earning" / "platform_fee" entry belongs to. */
  passId: text("pass_id"),
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

/**
 * Pay-per-play pass (DREAMSY.MD §11.6): starting someone else's game creates one per (user, game);
 * starts while it's valid are free. `price` 0 = a free start (owner / shared draft).
 */
export const playPasses = pgTable("play_passes", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  gameId: text("game_id").notNull().references(() => games.id),
  version: integer("version").notNull(),
  price: integer("price").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
}, (t) => [index("play_passes_user_game_idx").on(t.userId, t.gameId, t.expiresAt)]);

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

// ---------- Leaderboards, ghosts, groups (DREAMSY.MD §13) ----------

/** Every submitted run. `ghostKey` is set only while this run is the user's best on the board. */
export const runs = pgTable("runs", {
  id: text("id").primaryKey(),
  gameId: text("game_id").notNull().references(() => games.id),
  userId: text("user_id").notNull().references(() => users.id),
  board: text("board").notNull(),
  /** "asc" (lower is better: times) | "desc" (scores) */
  order: text("order").notNull(),
  version: integer("version").notNull(),
  value: doublePrecision("value").notNull(),
  ghostKey: text("ghost_key"),
  createdAt: createdAt(),
}, (t) => [
  index("runs_board_user_idx").on(t.gameId, t.board, t.userId, t.createdAt),
  index("runs_user_created_idx").on(t.userId, t.createdAt),
]);

/** One row per (game, board, user): the user's best run. What leaderboards rank. */
export const leaderboardBests = pgTable("leaderboard_bests", {
  gameId: text("game_id").notNull().references(() => games.id),
  board: text("board").notNull(),
  userId: text("user_id").notNull().references(() => users.id),
  value: doublePrecision("value").notNull(),
  runId: text("run_id").notNull(),
  version: integer("version").notNull(),
  order: text("order").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.gameId, t.board, t.userId] }),
  index("leaderboard_bests_rank_idx").on(t.gameId, t.board, t.value),
]);

export const groups = pgTable("groups", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  ownerId: text("owner_id").notNull().references(() => users.id),
  inviteCode: text("invite_code").notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("groups_invite_code_idx").on(t.inviteCode)]);

export const groupMembers = pgTable("group_members", {
  groupId: text("group_id").notNull().references(() => groups.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id),
  /** "owner" | "member" */
  role: text("role").notNull().default("member"),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.groupId, t.userId] }),
  index("group_members_user_idx").on(t.userId),
]);

/** Games shared with a group (drafts included): members can see and play them. */
export const groupGames = pgTable("group_games", {
  groupId: text("group_id").notNull().references(() => groups.id, { onDelete: "cascade" }),
  gameId: text("game_id").notNull().references(() => games.id),
  sharedBy: text("shared_by").notNull().references(() => users.id),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.groupId, t.gameId] }),
  index("group_games_game_idx").on(t.gameId),
]);

// ---------- Notifications + push (DREAMSY.MD §11.6) ----------

/** In-app inbox. `kind`: play_earning | remix_earning | royalty | sale | build_done | group_join | friend_request | friend_accept | game_invite. */
export const notifications = pgTable("notifications", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [index("notifications_user_idx").on(t.userId, t.id)]);

/** Expo push tokens; a token belongs to the device's last signed-in user. */
export const pushTokens = pgTable("push_tokens", {
  token: text("token").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  /** "ios" | "android" */
  platform: text("platform").notNull(),
  createdAt: createdAt(),
}, (t) => [index("push_tokens_user_idx").on(t.userId)]);

// ---------- Friends (DREAMSY.MD §13.4) ----------

/**
 * One row per pair of users, ids sorted (`userA < userB`), so a pair is unique whoever asked first.
 * `status`: "pending" (requestedBy asked the other) | "accepted".
 */
export const friendships = pgTable("friendships", {
  userA: text("user_a").notNull().references(() => users.id),
  userB: text("user_b").notNull().references(() => users.id),
  status: text("status").notNull().default("pending"),
  requestedBy: text("requested_by").notNull().references(() => users.id),
  createdAt: createdAt(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
}, (t) => [
  primaryKey({ columns: [t.userA, t.userB] }),
  index("friendships_user_b_idx").on(t.userB),
]);
