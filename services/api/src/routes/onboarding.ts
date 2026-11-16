import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { requireUser } from "../auth.js";
import { fail, parseJson, router, type Config, type Deps } from "../context.js";
import { schema } from "../db/client.js";
import { DEFAULT_GAMESERVER_INTERNAL_URL, httpLive, liveSnapshot, type LiveRoom } from "../presence.js";
import { feedGames, listed, type Q } from "../services.js";

const { users, games } = schema;

/** Tidal Dash (diver ocean runner). Override with ONBOARDING_GAME_ID. */
export const DEFAULT_ONBOARDING_GAME_ID = "g_01m7ggga6ks9nt0ce6chvtnav3";
export const ONBOARDING_MESSAGE = process.env.ONBOARDING_MESSAGE ?? "Your first Dreamsy game — made by AI. Swim as far as you can!";
/** GET /v1/live limits. */
export const LIVE_MAX_PLAYING = 30;
export const LIVE_FEATURED = 6;

export const onboardingGameId = (config: Config) => config.onboardingGameId || DEFAULT_ONBOARDING_GAME_ID;

/** True when this start is the free onboarding play: the onboarding game, by a user who hasn't finished onboarding. */
export async function isOnboardingPlay(q: Q, config: Config, userId: string, gameId: string): Promise<boolean> {
  if (gameId !== onboardingGameId(config)) return false;
  const [u] = await q.select({ onboardedAt: users.onboardedAt }).from(users).where(eq(users.id, userId));
  return !!u && u.onboardedAt === null;
}

const OnboardingDone = z.object({ done: z.literal(true) });

/** Guided first experience: the onboarding game, marking it done, and "Live now" (GET /v1/live). */
export function onboardingRoutes({ db, config, live }: Deps) {
  const r = router();
  const fetchLive = live ?? httpLive(process.env.GAMESERVER_INTERNAL_URL || DEFAULT_GAMESERVER_INTERNAL_URL, config.workerToken);
  for (const p of ["/v1/onboarding", "/v1/me/onboarding", "/v1/live"]) r.use(p, requireUser(config));

  r.get("/v1/onboarding", async (c) => {
    const id = onboardingGameId(config);
    const [g] = await db.select().from(games).where(eq(games.id, id));
    // The onboarding game may be hidden (kept out of feeds/search) — it's served only here.
    if (!g || g.status !== "published" || !g.publishedVersion) fail(404, "onboarding game not found");
    return c.json({ gameId: g.id, gameName: g.name, version: g.publishedVersion, message: ONBOARDING_MESSAGE });
  });

  /** Idempotent: the first call stamps onboarded_at, later calls keep it. */
  r.post("/v1/me/onboarding", async (c) => {
    await parseJson(c.req.raw, OnboardingDone);
    const userId = c.get("userId");
    const [cur] = await db.select().from(users).where(eq(users.id, userId));
    if (!cur) fail(401, "user no longer exists");
    if (cur.onboardedAt) return c.json({ user: cur });
    const [user] = await db.update(users).set({ onboardedAt: new Date() }).where(eq(users.id, userId)).returning();
    return c.json({ user: user! });
  });

  r.get("/v1/live", async (c) => {
    const me = c.get("userId");
    const [snap, featuredRows] = await Promise.all([
      liveSnapshot(fetchLive),
      db.select().from(games).where(and(listed(), isNotNull(games.publishedAt)))
        .orderBy(desc(games.trendingScore), desc(games.id)).limit(LIVE_FEATURED),
    ]);
    const featured = await feedGames(db, featuredRows, me);

    // lobbies with space, then running matches, then full lobbies (spectate only); server order within a group
    const rank = (r: LiveRoom) => (r.state === "lobby" ? (r.players.length < r.max ? 0 : 2) : 1);
    const rooms = snap.rooms.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i).map((x) => x.r);
    const entries: { room: LiveRoom; userId: string }[] = [];
    for (const room of rooms) {
      for (const userId of new Set(room.players)) if (userId !== me) entries.push({ room, userId });
    }
    if (!entries.length) return c.json({ online: snap.online, playing: [], featured });

    // only published, visible games: a stranger's private draft never shows up by name
    const [userRows, gameRows] = await Promise.all([
      db.select({ id: users.id, handle: users.handle, avatar: users.avatar }).from(users)
        .where(inArray(users.id, [...new Set(entries.map((e) => e.userId))])),
      db.select({ id: games.id, name: games.name }).from(games)
        .where(and(inArray(games.id, [...new Set(entries.map((e) => e.room.gameId))]), listed())),
    ]);
    const userById = new Map(userRows.map((u) => [u.id, u]));
    const gameName = new Map(gameRows.map((g) => [g.id, g.name]));
    const playing = [];
    for (const { room, userId } of entries) {
      const user = userById.get(userId), name = gameName.get(room.gameId);
      if (!user || name === undefined) continue;
      const lobby = room.state === "lobby";
      playing.push({
        user, gameId: room.gameId, gameName: name, mode: room.mode, players: room.players.length, max: room.max,
        roomCode: room.code, status: lobby ? "in_room" as const : "in_match" as const,
        spectatable: room.spectatable, joinable: lobby && room.players.length < room.max,
      });
      if (playing.length >= LIVE_MAX_PLAYING) break;
    }
    return c.json({ online: snap.online, playing, featured });
  });

  return r;
}
