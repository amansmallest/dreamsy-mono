import { randomInt } from "node:crypto";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { requireUser } from "../auth.js";
import { fail, parseJson, router, type Deps } from "../context.js";
import { schema } from "../db/client.js";
import { newId } from "../ids.js";
import { getGame, viewSharedGames, type Q } from "../services.js";
import { notifyGroupJoin } from "../notifications.js";
import { pushAfterCommit } from "../push.js";

const { groups, groupMembers, groupGames, users, games } = schema;

/** DREAMSY.MD §13.3 limits. */
export const GROUP_MAX_MEMBERS = 50;
/** No 0/O/1/I/L: codes get read aloud and typed on phones. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 8;

const CreateGroup = z.object({ name: z.string().trim().min(1).max(60) });
const JoinGroup = z.object({ code: z.string().trim().min(1).max(32) });
const ShareGame = z.object({ gameId: z.string().min(1).max(64) });

const newCode = () => Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
const normalizeCode = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

type Group = typeof groups.$inferSelect;

const userBrief = { id: users.id, handle: users.handle, avatar: users.avatar };

/** Groups: family/friends circles for leaderboards and sharing drafts (§13). */
export function groupRoutes({ db, config, pusher }: Deps) {
  const r = router();
  r.use("/v1/groups", requireUser(config));
  r.use("/v1/groups/*", requireUser(config));
  r.use("/v1/me/groups", requireUser(config));

  async function view(q: Q, g: Group, userId: string) {
    const [[counted], [me]] = await Promise.all([
      q.select({ n: count() }).from(groupMembers).where(eq(groupMembers.groupId, g.id)),
      q.select({ role: groupMembers.role }).from(groupMembers).where(and(eq(groupMembers.groupId, g.id), eq(groupMembers.userId, userId))),
    ]);
    return { id: g.id, name: g.name, ownerId: g.ownerId, inviteCode: g.inviteCode, memberCount: counted?.n ?? 0, role: me?.role ?? null, createdAt: g.createdAt };
  }

  /** The group, if the caller is a member (404 otherwise: don't reveal groups exist). */
  async function memberGroup(q: Q, groupId: string, userId: string, opts: { owner?: boolean; lock?: boolean } = {}) {
    const base = q.select({ group: groups }).from(groups)
      .innerJoin(groupMembers, and(eq(groupMembers.groupId, groups.id), eq(groupMembers.userId, userId)))
      .where(eq(groups.id, groupId));
    const [row] = opts.lock ? await base.for("update", { of: groups }) : await base;
    if (!row) fail(404, "group not found");
    if (opts.owner && row.group.ownerId !== userId) fail(403, "only the group owner can do that");
    return row.group;
  }

  async function insertWithCode(values: { id: string; name: string; ownerId: string }) {
    for (let i = 0; i < 5; i++) {
      const [g] = await db.insert(groups).values({ ...values, inviteCode: newCode() }).onConflictDoNothing().returning();
      if (g) return g;
    }
    throw new Error("could not allocate an invite code");
  }

  r.post("/v1/groups", async (c) => {
    const body = await parseJson(c.req.raw, CreateGroup);
    const userId = c.get("userId");
    const g = await insertWithCode({ id: newId("grp"), name: body.name, ownerId: userId });
    await db.insert(groupMembers).values({ groupId: g.id, userId, role: "owner" });
    return c.json({ group: await view(db, g, userId), inviteCode: g.inviteCode }, 201);
  });

  r.get("/v1/me/groups", async (c) => {
    const userId = c.get("userId");
    const rows = await db.select({ group: groups }).from(groups)
      .innerJoin(groupMembers, eq(groupMembers.groupId, groups.id))
      .where(eq(groupMembers.userId, userId))
      .orderBy(desc(groupMembers.joinedAt));
    return c.json({ groups: await Promise.all(rows.map((r) => view(db, r.group, userId))) });
  });

  /** Idempotent: joining a group you're already in returns it. */
  r.post("/v1/groups/join", async (c) => {
    const body = await parseJson(c.req.raw, JoinGroup);
    const userId = c.get("userId");
    const code = normalizeCode(body.code);
    if (code.length !== CODE_LENGTH) fail(400, "invite code must be 8 characters");
    const { g, notes } = await db.transaction(async (tx) => {
      const [g] = await tx.select().from(groups).where(eq(groups.inviteCode, code)).for("update");
      if (!g) fail(404, "invite code not found");
      const members = await tx.select({ userId: groupMembers.userId }).from(groupMembers).where(eq(groupMembers.groupId, g.id));
      if (members.some((m) => m.userId === userId)) return { g, notes: [] as string[] };
      if (members.length >= GROUP_MAX_MEMBERS) fail(409, `group is full (${GROUP_MAX_MEMBERS} members)`);
      await tx.insert(groupMembers).values({ groupId: g.id, userId, role: "member" });
      const notes = await notifyGroupJoin(tx, { memberIds: members.map((m) => m.userId), joinerId: userId, groupId: g.id, groupName: g.name });
      return { g, notes };
    });
    pushAfterCommit(db, pusher, notes);
    return c.json({ group: await view(db, g, userId) });
  });

  r.get("/v1/groups/:id", async (c) => {
    const userId = c.get("userId");
    const g = await memberGroup(db, c.req.param("id"), userId);
    const members = await db.select({ user: userBrief, role: groupMembers.role, joinedAt: groupMembers.joinedAt })
      .from(groupMembers).innerJoin(users, eq(users.id, groupMembers.userId))
      .where(eq(groupMembers.groupId, g.id))
      .orderBy(asc(groupMembers.joinedAt));
    return c.json({ group: await view(db, g, userId), members });
  });

  /** Leaving as owner hands the group to the longest-standing member; the last one out deletes it. */
  r.post("/v1/groups/:id/leave", async (c) => {
    const userId = c.get("userId");
    await db.transaction(async (tx) => {
      const g = await memberGroup(tx, c.req.param("id"), userId, { lock: true });
      await tx.delete(groupMembers).where(and(eq(groupMembers.groupId, g.id), eq(groupMembers.userId, userId)));
      if (g.ownerId !== userId) return;
      const [heir] = await tx.select().from(groupMembers).where(eq(groupMembers.groupId, g.id))
        .orderBy(asc(groupMembers.joinedAt)).limit(1);
      if (!heir) {
        await tx.delete(groups).where(eq(groups.id, g.id));
        return;
      }
      await tx.update(groupMembers).set({ role: "owner" })
        .where(and(eq(groupMembers.groupId, g.id), eq(groupMembers.userId, heir.userId)));
      await tx.update(groups).set({ ownerId: heir.userId }).where(eq(groups.id, g.id));
    });
    return c.json({ ok: true });
  });

  r.delete("/v1/groups/:id", async (c) => {
    const g = await memberGroup(db, c.req.param("id"), c.get("userId"), { owner: true });
    await db.delete(groups).where(eq(groups.id, g.id)); // members + shared games cascade
    return c.json({ ok: true });
  });

  /** Owner: new invite code (old links stop working). */
  r.post("/v1/groups/:id/invite-code", async (c) => {
    const g = await memberGroup(db, c.req.param("id"), c.get("userId"), { owner: true });
    for (let i = 0; i < 5; i++) {
      const [u] = await db.update(groups).set({ inviteCode: newCode() }).where(eq(groups.id, g.id)).returning()
        .catch(() => [] as Group[]);
      if (u) return c.json({ inviteCode: u.inviteCode });
    }
    throw new Error("could not allocate an invite code");
  });

  /** Share a game with the group: your own (drafts too) or any published game. Idempotent. */
  r.post("/v1/groups/:id/games", async (c) => {
    const body = await parseJson(c.req.raw, ShareGame);
    const userId = c.get("userId");
    const grp = await memberGroup(db, c.req.param("id"), userId);
    const game = await getGame(db, body.gameId);
    if (game.ownerId !== userId && (game.status !== "published" || game.hidden)) fail(404, "game not found");
    await db.insert(groupGames).values({ groupId: grp.id, gameId: game.id, sharedBy: userId }).onConflictDoNothing();
    const [gameView] = await viewSharedGames(db, [game], userId);
    return c.json({ game: gameView }, 201);
  });

  /** Unshare: whoever shared it, the game's owner, or the group owner. */
  r.delete("/v1/groups/:id/games/:gameId", async (c) => {
    const userId = c.get("userId");
    const grp = await memberGroup(db, c.req.param("id"), userId);
    const [row] = await db.select().from(groupGames)
      .where(and(eq(groupGames.groupId, grp.id), eq(groupGames.gameId, c.req.param("gameId"))));
    if (!row) fail(404, "game not shared with this group");
    const game = await getGame(db, row.gameId);
    if (![row.sharedBy, game.ownerId, grp.ownerId].includes(userId)) fail(403, "only the sharer, the game's owner or the group owner can unshare");
    await db.delete(groupGames).where(and(eq(groupGames.groupId, grp.id), eq(groupGames.gameId, row.gameId)));
    return c.json({ ok: true });
  });

  r.get("/v1/groups/:id/games", async (c) => {
    const userId = c.get("userId");
    const grp = await memberGroup(db, c.req.param("id"), userId);
    const rows = await db.select({ share: groupGames, sharer: userBrief }).from(groupGames)
      .innerJoin(users, eq(users.id, groupGames.sharedBy))
      .where(eq(groupGames.groupId, grp.id))
      .orderBy(desc(groupGames.at));
    const gameRows = rows.length ? await db.select().from(games).where(inArray(games.id, rows.map((r) => r.share.gameId))) : [];
    const views = new Map((await viewSharedGames(db, gameRows, userId)).map((v) => [v.id, v]));
    return c.json({
      games: rows.flatMap((r) => {
        const v = views.get(r.share.gameId);
        return v ? [{ ...v, sharedBy: r.sharer, sharedAt: r.share.at }] : [];
      }),
    });
  });

  return r;
}
