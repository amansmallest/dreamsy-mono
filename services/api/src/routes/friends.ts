import { and, asc, count, eq, gt, inArray, like, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { requireUser } from "../auth.js";
import { fail, parseJson, router, type Deps } from "../context.js";
import { schema } from "../db/client.js";
import { notifyFriendAccept, notifyFriendRequest, notifyGameInvite } from "../notifications.js";
import { DEFAULT_GAMESERVER_INTERNAL_URL, httpPresence, presenceFor, type Presence } from "../presence.js";
import { pushAfterCommit } from "../push.js";
import { canAccessGame, getGame, type Q } from "../services.js";

const { friendships, users, notifications, games } = schema;

/** docs/platform.md §13.4 limits. */
export const INVITES_PER_MINUTE = 10;
export const INVITE_TTL_MS = 10 * 60 * 1000;
export const SEARCH_LIMIT = 20;

const Handle = z.string().trim().toLowerCase().transform((s) => s.replace(/^@/, "")).pipe(z.string().min(1).max(40));
const FriendRequest = z.object({ handle: Handle });
const Invite = z.object({
  userId: z.string().min(1).max(64),
  gameId: z.string().min(1).max(64),
  roomCode: z.string().trim().toUpperCase().pipe(z.string().regex(/^[A-Z0-9]{4,12}$/, "roomCode must be 4–12 letters/digits")),
  /** Optional: the game version the room runs (passed through as data.version). */
  version: z.number().int().min(1).optional(),
});

const userBrief = { id: users.id, handle: users.handle, avatar: users.avatar };
type UserBrief = { id: string; handle: string; avatar: Record<string, number> | null };
type Friendship = typeof friendships.$inferSelect;
export type FriendStatus = "none" | "friends" | "incoming" | "outgoing";

/** Pair key: ids sorted so (a, b) and (b, a) are the same row. */
const pair = (x: string, y: string) => (x < y ? { userA: x, userB: y } : { userA: y, userB: x });
const pairWhere = (x: string, y: string) => {
  const p = pair(x, y);
  return and(eq(friendships.userA, p.userA), eq(friendships.userB, p.userB));
};
const other = (f: Friendship, me: string) => (f.userA === me ? f.userB : f.userA);
const statusFor = (f: Friendship | undefined, me: string): FriendStatus =>
  !f ? "none" : f.status === "accepted" ? "friends" : f.requestedBy === me ? "outgoing" : "incoming";

/** Online first: in a room/match, then online, then offline. */
const RANK: Record<Presence["status"], number> = { in_room: 0, in_match: 1, online: 2, offline: 3 };

/** Friends, friend requests, search, game invites, presence (§13.4). */
export function friendRoutes({ db, config, pusher, presence }: Deps) {
  const r = router();
  const fetchPresence = presence
    ?? httpPresence(process.env.GAMESERVER_INTERNAL_URL || DEFAULT_GAMESERVER_INTERNAL_URL, config.workerToken);
  for (const p of ["/v1/friends/*", "/v1/me/friends", "/v1/users/search", "/v1/invites"]) r.use(p, requireUser(config));

  async function brief(q: Q, id: string): Promise<UserBrief> {
    const [u] = await q.select(userBrief).from(users).where(eq(users.id, id));
    if (!u) fail(404, "user not found");
    return u;
  }

  async function friendView(userId: string, f: Friendship) {
    const user = await brief(db, userId);
    const p = await presenceFor(fetchPresence, [userId]);
    return { user, since: f.acceptedAt ?? f.createdAt, presence: p.get(userId)! };
  }

  /** Accept the pending row (caller is the addressee) and notify the requester. Inside `tx`. */
  async function acceptIn(tx: Q, f: Friendship, me: string) {
    const [row] = await tx.update(friendships).set({ status: "accepted", acceptedAt: new Date() })
      .where(pairWhere(f.userA, f.userB)).returning();
    const notes = await notifyFriendAccept(tx, { toUserId: f.requestedBy, fromUserId: me });
    return { row: row!, notes };
  }

  r.post("/v1/friends/requests", async (c) => {
    const { handle } = await parseJson(c.req.raw, FriendRequest);
    const me = c.get("userId");
    const [target] = await db.select(userBrief).from(users).where(eq(users.handle, handle));
    if (!target) fail(404, "user not found");
    if (target.id === me) fail(400, "can't friend yourself");

    const out = await db.transaction(async (tx) => {
      // Insert-first: the PK makes concurrent requests for one pair collapse onto one row.
      const [created] = await tx.insert(friendships).values({ ...pair(me, target.id), status: "pending", requestedBy: me })
        .onConflictDoNothing().returning();
      if (created) return { kind: "requested" as const, notes: await notifyFriendRequest(tx, { toUserId: target.id, fromUserId: me }) };
      const [f] = await tx.select().from(friendships).where(pairWhere(me, target.id)).for("update");
      if (!f) fail(409, "try again");
      if (f.status === "accepted") fail(409, "already friends");
      if (f.requestedBy === me) return { kind: "requested" as const, notes: [] as string[] }; // repeat: idempotent, no re-notify
      const { row, notes } = await acceptIn(tx, f, me); // they had already asked: auto-accept
      return { kind: "accepted" as const, row, notes };
    });
    pushAfterCommit(db, pusher, out.notes);
    if (out.kind === "accepted") return c.json({ friend: await friendView(target.id, out.row) });
    return c.json({ request: { id: target.id, user: target, status: "pending", direction: "outgoing" } }, 201);
  });

  r.post("/v1/friends/requests/:userId/accept", async (c) => {
    const me = c.get("userId");
    const from = c.req.param("userId");
    const out = await db.transaction(async (tx) => {
      const [f] = await tx.select().from(friendships).where(pairWhere(me, from)).for("update");
      if (f?.status === "accepted") fail(409, "already friends");
      if (!f || f.requestedBy !== from) fail(404, "no friend request from that user");
      return acceptIn(tx, f, me);
    });
    pushAfterCommit(db, pusher, out.notes);
    return c.json({ friend: await friendView(from, out.row) });
  });

  r.post("/v1/friends/requests/:userId/decline", async (c) => {
    const me = c.get("userId");
    const from = c.req.param("userId");
    const [gone] = await db.delete(friendships)
      .where(and(pairWhere(me, from), eq(friendships.status, "pending"), eq(friendships.requestedBy, from))).returning();
    if (!gone) fail(404, "no friend request from that user");
    return c.json({ ok: true });
  });

  /** Unfriend, cancel my outgoing request, or drop an incoming one. */
  r.delete("/v1/friends/:userId", async (c) => {
    const me = c.get("userId");
    const [gone] = await db.delete(friendships).where(pairWhere(me, c.req.param("userId"))).returning();
    if (!gone) fail(404, "not friends");
    return c.json({ ok: true });
  });

  r.get("/v1/me/friends", async (c) => {
    const me = c.get("userId");
    const rows = await db.select().from(friendships).where(or(eq(friendships.userA, me), eq(friendships.userB, me)));
    const ids = rows.map((f) => other(f, me));
    const briefs = new Map(ids.length
      ? (await db.select(userBrief).from(users).where(inArray(users.id, ids))).map((u) => [u.id, u])
      : []);
    const accepted = rows.filter((f) => f.status === "accepted");
    const pres = await presenceFor(fetchPresence, accepted.map((f) => other(f, me)));
    // The room server only knows game ids; fill in names for "Playing <game>".
    const gameIds = [...new Set([...pres.values()].map((p) => p.gameId).filter((g): g is string => !!g))];
    if (gameIds.length) {
      const names = new Map((await db.select({ id: games.id, name: games.name }).from(games).where(inArray(games.id, gameIds))).map((g) => [g.id, g.name]));
      for (const p of pres.values()) if (p.gameId && names.has(p.gameId)) p.gameName = names.get(p.gameId);
    }
    const friends = accepted.map((f) => {
      const id = other(f, me);
      return { user: briefs.get(id)!, since: f.acceptedAt ?? f.createdAt, presence: pres.get(id)! };
    }).sort((a, b) => RANK[a.presence.status] - RANK[b.presence.status] || a.user.handle.localeCompare(b.user.handle));
    const pending = (dir: "incoming" | "outgoing") => rows
      .filter((f) => f.status === "pending" && (f.requestedBy === me) === (dir === "outgoing"))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((f) => ({ user: briefs.get(other(f, me))!, at: f.createdAt }));
    return c.json({ friends, incoming: pending("incoming"), outgoing: pending("outgoing") });
  });

  /** Handle prefix search (≤ 20, excludes self) with the caller's friendStatus per user. */
  r.get("/v1/users/search", async (c) => {
    const me = c.get("userId");
    const q = (c.req.query("q") ?? "").trim().toLowerCase().replace(/^@/, "").slice(0, 40);
    if (!q) return c.json({ users: [] });
    const escaped = q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const found = await db.select(userBrief).from(users)
      .where(and(like(users.handle, `${escaped}%`), ne(users.id, me)))
      .orderBy(asc(users.handle)).limit(SEARCH_LIMIT);
    const ids = found.map((u) => u.id);
    const rels = ids.length
      ? await db.select().from(friendships).where(or(
          and(eq(friendships.userA, me), inArray(friendships.userB, ids)),
          and(eq(friendships.userB, me), inArray(friendships.userA, ids)),
        ))
      : [];
    const byOther = new Map(rels.map((f) => [other(f, me), f]));
    return c.json({ users: found.map((u) => ({ ...u, friendStatus: statusFor(byOther.get(u.id), me) })) });
  });

  /** Invite a friend into a room: game_invite notification + push. Friends only; ≤ 10/min per sender. */
  r.post("/v1/invites", async (c) => {
    const body = await parseJson(c.req.raw, Invite);
    const me = c.get("userId");
    if (body.userId === me) fail(400, "can't invite yourself");
    const [f] = await db.select().from(friendships).where(pairWhere(me, body.userId));
    if (f?.status !== "accepted") fail(403, "you can only invite friends");
    const game = await getGame(db, body.gameId);
    if (!(await canAccessGame(db, game, me))) fail(404, "game not found");
    const [sent] = await db.select({ n: count() }).from(notifications).where(and(
      eq(notifications.kind, "game_invite"),
      sql`${notifications.data}->>'fromUserId' = ${me}`,
      gt(notifications.createdAt, new Date(Date.now() - 60_000)),
    ));
    if ((sent?.n ?? 0) >= INVITES_PER_MINUTE) fail(429, "too many invites; wait a minute");
    const version = body.version ?? game.publishedVersion ?? undefined;
    const notes = await db.transaction((tx) => notifyGameInvite(tx, {
      toUserId: body.userId, fromUserId: me, gameId: game.id, gameName: game.name, version,
      roomCode: body.roomCode, expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    }));
    pushAfterCommit(db, pusher, notes);
    return c.json({ ok: true });
  });

  return r;
}
