import { and, count, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { requireUser, signUserToken } from "../auth.js";
import { fail, parseJson, router, type Deps, type IdentityProvider } from "../context.js";
import { schema } from "../db/client.js";
import { newId } from "../ids.js";
import { feedGames, listed, pageGames, parseLimit, viewGames } from "../services.js";

const { users, authIdentities, games, follows } = schema;

/** Ink avatar: part name -> option index. The app owns what the parts mean. */
const Avatar = z.record(z.string().regex(/^[a-z]{1,16}$/), z.number().int().min(0).max(99))
  .refine((a) => Object.keys(a).length <= 16, "avatar has too many parts");

const UpdateMe = z.object({
  handle: z.string().regex(/^[a-z0-9_]{3,20}$/, "handle must be 3–20 chars of a-z, 0-9, _").optional(),
  bio: z.string().max(280).optional(),
  avatar: Avatar.optional(),
});

export const userView = (u: typeof users.$inferSelect) => ({ id: u.id, handle: u.handle, bio: u.bio, avatar: u.avatar, createdAt: u.createdAt });

/** Postgres unique_violation, whether or not the driver error is wrapped by drizzle. */
const isUniqueViolation = (e: unknown): boolean =>
  !!e && typeof e === "object" && ((e as { code?: string }).code === "23505" || isUniqueViolation((e as { cause?: unknown }).cause));

const AppleSignIn = z.object({
  identityToken: z.string().min(1),
  /** Apple only sends the name on first sign-in; not stored yet, reserved for profile. */
  fullName: z.string().max(200).optional(),
});
const GoogleSignIn = z.object({ idToken: z.string().min(1) });
const SupabaseSignIn = z.object({ accessToken: z.string().min(1) });
const DemoSignIn = z.object({ username: z.string().trim().toLowerCase().pipe(z.string().regex(/^[a-z0-9_]{3,20}$/, "username must be 3–20 chars of a-z, 0-9, _")) });

/**
 * Demo bypass (judges, app review, phone demos): no email code. Allowed for any username ending in
 * "_demo" and for the special names in DEMO_USERNAMES (default "demo,judge"). DEMO_LOGIN=0 turns it off.
 * The same username always signs into the same account (no password: demo accounts are shared by design).
 */
export function demoAllowed(username: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.DEMO_LOGIN === "0") return false;
  const special = (env.DEMO_USERNAMES ?? "demo,judge").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return username.endsWith("_demo") || special.includes(username);
}

export function userRoutes({ db, config, identity }: Deps) {
  const r = router();

  const newUser = () => {
    const id = newId("u");
    return { id, handle: `dreamer_${id.slice(-8)}` };
  };

  /** Find-or-create the user behind a verified provider identity. */
  async function signIn(provider: IdentityProvider, token: string) {
    const { subject, email } = await identity.verify(provider, token);
    const user = await db.transaction(async (tx) => {
      const [existing] = await tx.select({ user: users }).from(authIdentities)
        .innerJoin(users, eq(users.id, authIdentities.userId))
        .where(and(eq(authIdentities.provider, provider), eq(authIdentities.subject, subject)));
      if (existing) return existing.user;
      const [created] = await tx.insert(users).values(newUser()).returning();
      await tx.insert(authIdentities).values({ provider, subject, userId: created!.id, email })
        .onConflictDoNothing();
      // Lost a race with a concurrent first sign-in: use the winner's user.
      const [winner] = await tx.select({ user: users }).from(authIdentities)
        .innerJoin(users, eq(users.id, authIdentities.userId))
        .where(and(eq(authIdentities.provider, provider), eq(authIdentities.subject, subject)));
      return winner!.user;
    });
    return { user, token: await signUserToken(config, user.id) };
  }

  r.post("/v1/auth/apple", async (c) => {
    const body = await parseJson(c.req.raw, AppleSignIn);
    return c.json(await signIn("apple", body.identityToken));
  });

  r.post("/v1/auth/google", async (c) => {
    const body = await parseJson(c.req.raw, GoogleSignIn);
    return c.json(await signIn("google", body.idToken));
  });

  /** Supabase Auth session (Google OAuth in the app) -> Dreamsy user + token. */
  r.post("/v1/auth/supabase", async (c) => {
    const body = await parseJson(c.req.raw, SupabaseSignIn);
    return c.json(await signIn("supabase", body.accessToken));
  });

  /** Demo bypass: `{ username }` → the demo account with that handle (created on first use). */
  r.post("/v1/auth/demo", async (c) => {
    const { username } = await parseJson(c.req.raw, DemoSignIn);
    if (!demoAllowed(username)) fail(403, "demo sign-in is only for usernames ending in _demo");
    const user = await db.transaction(async (tx) => {
      const find = () => tx.select({ user: users }).from(authIdentities)
        .innerJoin(users, eq(users.id, authIdentities.userId))
        .where(and(eq(authIdentities.provider, "demo"), eq(authIdentities.subject, username)));
      const [existing] = await find();
      if (existing) return existing.user;
      const [handleTaken] = await tx.select({ id: users.id }).from(users).where(eq(users.handle, username));
      const fresh = newUser();
      const [created] = await tx.insert(users).values(handleTaken ? fresh : { ...fresh, handle: username }).returning();
      await tx.insert(authIdentities).values({ provider: "demo", subject: username, userId: created!.id, email: null }).onConflictDoNothing();
      const [winner] = await find();
      return winner!.user;
    });
    return c.json({ user, token: await signUserToken(config, user.id) });
  });

  /** Anonymous guest account. Linking a guest to Apple/Google: later. */
  r.post("/v1/auth/guest", async (c) => {
    const [user] = await db.insert(users).values(newUser()).returning();
    return c.json({ user, token: await signUserToken(config, user!.id) }, 201);
  });

  r.get("/v1/me", requireUser(config), async (c) => {
    const [user] = await db.select().from(users).where(eq(users.id, c.get("userId")));
    if (!user) fail(401, "user no longer exists");
    return c.json({ user });
  });

  r.patch("/v1/me", requireUser(config), async (c) => {
    const body = await parseJson(c.req.raw, UpdateMe);
    const userId = c.get("userId");
    if (body.handle) {
      const [taken] = await db.select({ id: users.id }).from(users).where(and(eq(users.handle, body.handle), ne(users.id, userId)));
      if (taken) fail(409, "handle is taken");
    }
    let user;
    try {
      [user] = await db.update(users).set(body).where(eq(users.id, userId)).returning();
    } catch (e) {
      if (isUniqueViolation(e)) fail(409, "handle is taken"); // lost a race
      throw e;
    }
    if (!user) fail(401, "user no longer exists");
    return c.json({ user });
  });

  // ---------- creators & following (DREAMSY.MD §11.4) ----------

  r.use("/v1/users/*", requireUser(config));

  async function getUser(id: string) {
    const [u] = await db.select().from(users).where(eq(users.id, id));
    if (!u) fail(404, "user not found");
    return u;
  }

  r.get("/v1/users/:id", async (c) => {
    const u = await getUser(c.req.param("id"));
    const viewerId = c.get("userId");
    const [[gameStats], [followers], [following], [viewerFollows]] = await Promise.all([
      db.select({
        games: count(),
        plays: sql<number>`coalesce(sum(${games.plays}), 0)::int`,
        likes: sql<number>`coalesce(sum(${games.likes}), 0)::int`,
      }).from(games).where(and(eq(games.ownerId, u.id), listed())),
      db.select({ n: count() }).from(follows).where(eq(follows.followeeId, u.id)),
      db.select({ n: count() }).from(follows).where(eq(follows.followerId, u.id)),
      db.select({ n: count() }).from(follows).where(and(eq(follows.followerId, viewerId), eq(follows.followeeId, u.id))),
    ]);
    return c.json({
      user: userView(u),
      stats: { games: gameStats!.games, plays: gameStats!.plays, likes: gameStats!.likes, followers: followers!.n, following: following!.n },
      viewer: { following: viewerFollows!.n > 0 },
    });
  });

  /** Published (not hidden) games as FeedGame; your own profile lists all your games as owner views. */
  r.get("/v1/users/:id/games", async (c) => {
    const u = await getUser(c.req.param("id"));
    const viewerId = c.get("userId");
    const self = u.id === viewerId;
    const page = await pageGames(db, {
      where: self ? eq(games.ownerId, u.id) : and(eq(games.ownerId, u.id), listed()),
      sort: sql`${games.createdAt}`,
      sortType: "timestamptz",
      cursor: c.req.query("cursor"),
      limit: parseLimit(c.req.query("limit")),
    });
    return c.json({
      games: self ? await viewGames(db, page.games, viewerId) : await feedGames(db, page.games, viewerId),
      next: page.next,
    });
  });

  r.put("/v1/users/:id/follow", async (c) => {
    const u = await getUser(c.req.param("id"));
    const viewerId = c.get("userId");
    if (u.id === viewerId) fail(400, "can't follow yourself");
    await db.insert(follows).values({ followerId: viewerId, followeeId: u.id }).onConflictDoNothing();
    return c.json({ following: true });
  });

  r.delete("/v1/users/:id/follow", async (c) => {
    const u = await getUser(c.req.param("id"));
    await db.delete(follows).where(and(eq(follows.followerId, c.get("userId")), eq(follows.followeeId, u.id)));
    return c.json({ following: false });
  });

  return r;
}
