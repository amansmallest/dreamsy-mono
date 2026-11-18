import { and, desc, eq, gt, gte, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { requireUser } from "../auth.js";
import { fail, router, type Deps } from "../context.js";
import { schema } from "../db/client.js";
import { chargeWithSplit, coinsToUsd, lockWallet, lockWallets } from "../economy.js";
import { PLATFORM_USER_ID } from "../db/schema.js";
import { newId } from "../ids.js";
import { notifyPlayEarning, notifyRoyalty } from "../notifications.js";
import { pushAfterCommit } from "../push.js";
import { isOnboardingPlay } from "./onboarding.js";
import { canAccessGame, canAccessVersion, countPlay, getGame, type Game, type Q } from "../services.js";

const { games, ledger, playPasses } = schema;

const PlayBody = z.object({ version: z.number().int().positive().optional() }).default({});

type Pass = typeof playPasses.$inferSelect;
const passView = (p: Pass) => ({ id: p.id, expiresAt: p.expiresAt.toISOString() });

/** Why a start is free without a pass: the owner testing, or a group member testing a shared draft. */
function freeReason(g: Game, userId: string): "owner" | "draft" | null {
  if (g.ownerId === userId) return "owner";
  if (g.status !== "published") return "draft"; // only reachable here via a group share (canAccessGame)
  return null;
}

/**
 * Pay-per-play (docs/platform.md §11.6). Starting someone else's published game costs `playPrice` coins:
 * creator `creatorShare`, platform the rest. A paid start opens a `playPassMinutes` pass for
 * (user, game); starts while it's valid are free and return the same pass. Owners and group members
 * on shared drafts play free, and so does a new account's onboarding game until its welcome sheet is shown
 * (reason "onboarding"; a later paid start doesn't reuse that free pass). v1 gate is client-side: package fetch does not check passes.
 */
export function playRoutes({ db, config, pusher }: Deps) {
  const r = router();
  r.use("/v1/me/earnings", requireUser(config));
  // /v1/games/* is already behind requireUser (gameRoutes).

  async function resolve(c: { req: { param(k: "id"): string } }, userId: string, version?: number) {
    const g = await getGame(db, c.req.param("id"));
    if (!(await canAccessGame(db, g, userId))) fail(404, "game not found");
    const testing = freeReason(g, userId);
    // A new account's first play of the onboarding game is free (guided first experience) until onboarding is done.
    const reason = testing ?? (g.status === "published" && (await isOnboardingPlay(db, config, userId, g.id)) ? "onboarding" as const : null);
    const v = version ?? (testing ? g.latestVersion : g.publishedVersion);
    if (!v || !(await canAccessVersion(db, g, userId, v))) fail(404, "version not found");
    return { g, reason, version: v };
  }

  /** Newest valid pass; a paid start only reuses a pass that was paid for (not a free draft/owner one). */
  async function validPass(q: Q, userId: string, gameId: string, now: Date, paidOnly: boolean) {
    const [p] = await q.select().from(playPasses).where(and(
      eq(playPasses.userId, userId),
      eq(playPasses.gameId, gameId),
      gt(playPasses.expiresAt, now),
      paidOnly ? gt(playPasses.price, 0) : undefined,
    )).orderBy(desc(playPasses.expiresAt)).limit(1);
    return p ?? null;
  }

  /** Quote (no side effects): what `POST /play` would do now. Lets clients label the Play button. */
  r.get("/v1/games/:id/play", async (c) => {
    const userId = c.get("userId");
    const { g, reason } = await resolve(c, userId);
    const pass = await validPass(db, userId, g.id, new Date(), !reason);
    const balance = await db.transaction(async (tx) => (await lockWallet(tx, config, userId)).balance);
    return c.json({
      free: !!reason || !!pass,
      reason: reason ?? (pass ? "pass" : null),
      price: config.playPrice,
      balance,
      pass: pass ? passView(pass) : null,
    });
  });

  r.post("/v1/games/:id/play", async (c) => {
    const text = await c.req.text();
    let raw: unknown = undefined;
    if (text.trim()) {
      try { raw = JSON.parse(text); } catch { fail(400, "body must be JSON"); }
    }
    const body = PlayBody.parse(raw);
    const userId = c.get("userId");
    const { g, reason, version } = await resolve(c, userId, body.version);
    const price = config.playPrice;

    const result = await db.transaction(async (tx) => {
      // The player's wallet row lock serializes concurrent starts by the same user: the second
      // one sees the first one's pass and is free. Paid starts lock player, creator and platform
      // up front, in id order (lockWallets), so crossing plays can't deadlock.
      const locked = await lockWallets(tx, config, reason ? [userId] : [userId, g.ownerId, PLATFORM_USER_ID]);
      const wallet = locked.get(userId)!;
      const now = new Date();
      const existing = await validPass(tx, userId, g.id, now, !reason);
      if (existing) {
        await countPlay(tx, userId, g.id, version);
        return { charged: false, reason: reason ?? "pass", balance: wallet.balance, pass: existing, creatorEarned: 0, notes: [] as string[] };
      }
      const charge = !reason && price > 0;
      if (charge && wallet.balance < price) fail(402, "insufficient_coins", { balance: wallet.balance, price });
      const [pass] = await tx.insert(playPasses).values({
        id: newId("pp"),
        userId,
        gameId: g.id,
        version,
        price: charge ? price : 0,
        expiresAt: new Date(now.getTime() + config.playPassMinutes * 60_000),
      }).returning();
      let balance = wallet.balance;
      let creatorEarned = 0;
      let notes: string[] = [];
      if (charge) {
        // Spin-off: the direct parent's owner gets a royalty out of the creator's share (one level only —
        // a spin-off of a spin-off pays the first spin-off's creator, not the grandparent).
        const parent = g.remixOfGameId
          ? (await tx.select({ id: games.id, name: games.name, ownerId: games.ownerId }).from(games).where(eq(games.id, g.remixOfGameId)))[0]
          : undefined;
        const royalty = parent ? { userId: parent.ownerId, amount: config.spinoffRoyalty ?? 1000 } : undefined;
        let royaltyPaid = 0;
        ({ balance, creatorEarned, royaltyPaid } = await chargeWithSplit(tx, config, userId, g.ownerId, price,
          { debit: "play", credit: "play_earning" }, { gameId: g.id, passId: pass!.id }, royalty));
        // One per paid pass, so at most one per (creator, game, player) per pass window.
        notes = await notifyPlayEarning(tx, { creatorId: g.ownerId, playerId: userId, gameId: g.id, gameName: g.name, coins: creatorEarned });
        if (parent && royaltyPaid > 0) {
          notes.push(...await notifyRoyalty(tx, { ownerId: parent.ownerId, playerId: userId, parentGameId: parent.id, parentName: parent.name, gameId: g.id, gameName: g.name, coins: royaltyPaid }));
        }
      }
      await countPlay(tx, userId, g.id, version);
      return { charged: charge, reason: charge ? null : reason, balance, pass: pass!, creatorEarned, notes };
    });
    pushAfterCommit(db, pusher, result.notes);

    return c.json({
      charged: result.charged,
      /** Why it was free: "owner" | "draft" | "onboarding" | "pass"; null when charged (or price 0). */
      reason: result.reason,
      price,
      balance: result.balance,
      pass: passView(result.pass),
      creatorEarned: result.creatorEarned,
    });
  });

  /** Creator earnings: paid plays + store sales credited to the caller, in coins and USD. */
  r.get("/v1/me/earnings", async (c) => c.json(await earningsOf(db, c.get("userId"))));

  return r;
}

const startOfUtcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

export async function earningsOf(q: Q, userId: string) {
  const kinds = ["play_earning", "sale", "royalty", "remix_earning"];
  const mine = and(eq(ledger.userId, userId), inArray(ledger.kind, kinds));
  const [rows, [today]] = await Promise.all([
    q.select({
      gameId: ledger.gameId,
      name: games.name,
      coins: sql<number>`coalesce(sum(${ledger.delta}), 0)::int`,
      plays: sql<number>`(count(*) filter (where ${ledger.kind} = 'play_earning'))::int`,
    }).from(ledger).leftJoin(games, eq(games.id, ledger.gameId)).where(mine)
      .groupBy(ledger.gameId, games.name),
    q.select({ coins: sql<number>`coalesce(sum(${ledger.delta}), 0)::int` }).from(ledger)
      .where(and(mine, gte(ledger.createdAt, startOfUtcDay(new Date())))),
  ]);
  const gamesOut = rows
    .map((r) => ({ gameId: r.gameId ?? "", name: r.name ?? "", coins: Number(r.coins), plays: Number(r.plays) }))
    .sort((a, b) => b.coins - a.coins || a.name.localeCompare(b.name));
  const totalCoins = gamesOut.reduce((s, x) => s + x.coins, 0);
  const todayCoins = Number(today?.coins ?? 0);
  return {
    totalCoins,
    todayCoins,
    paidPlays: gamesOut.reduce((s, x) => s + x.plays, 0),
    usd: { total: coinsToUsd(totalCoins), today: coinsToUsd(todayCoins) },
    games: gamesOut,
  };
}
