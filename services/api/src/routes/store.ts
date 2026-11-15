import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Manifest } from "@dreamsy/format";
import { requireUser } from "../auth.js";
import { fail, parseJson, router, type Deps } from "../context.js";
import { schema } from "../db/client.js";
import { newId } from "../ids.js";
import { getGame, getVersion, type Game, type Q, type Tx } from "../services.js";

const { wallets, ledger, purchases } = schema;

const Purchase = z.object({
  itemId: z.string().min(1),
  /** Client-generated; retries with the same key return the original purchase. */
  idempotencyKey: z.string().min(8).max(100),
});
const Consume = z.object({ purchaseId: z.string() });

type StoreItem = Manifest["store"][number];

/**
 * Stars economy. No real money yet: every wallet starts with a free grant; players spend Stars
 * on items games declare in dreamsy.toml `[[store]]`; the creator is credited `creatorShare`.
 * All balance changes go through the append-only ledger inside one transaction.
 */
export function storeRoutes({ db, config }: Deps) {
  const r = router();
  r.use("/v1/me/wallet", requireUser(config));
  r.use("/v1/games/:id/store", requireUser(config));
  r.use("/v1/games/:id/store/*", requireUser(config));

  /** Lock (and lazily create, with the starter grant) a user's wallet. */
  async function lockWallet(tx: Tx, userId: string) {
    const [w] = await tx.select().from(wallets).where(eq(wallets.userId, userId)).for("update");
    if (w) return w;
    await tx.insert(wallets).values({ userId, balance: config.starterStars }).onConflictDoNothing();
    const [created] = await tx.select().from(wallets).where(eq(wallets.userId, userId)).for("update");
    const hasGrant = await tx.select({ id: ledger.id }).from(ledger).where(and(eq(ledger.userId, userId), eq(ledger.kind, "starter_grant")));
    if (!hasGrant.length) {
      await tx.insert(ledger).values({ userId, delta: config.starterStars, balanceAfter: created!.balance, kind: "starter_grant" });
    }
    return created!;
  }

  async function move(tx: Tx, userId: string, delta: number, entry: { kind: string; gameId?: string; itemId?: string; purchaseId?: string }) {
    const w = await lockWallet(tx, userId);
    const balance = w.balance + delta;
    if (balance < 0) fail(402, "not enough Stars", { balance: w.balance, needed: -delta });
    await tx.update(wallets).set({ balance }).where(eq(wallets.userId, userId));
    await tx.insert(ledger).values({ userId, delta, balanceAfter: balance, ...entry });
    return balance;
  }

  /** Store items visible to this user: published version for players, latest for the owner. */
  async function storeFor(q: Q, game: Game, userId: string): Promise<{ version: number; items: StoreItem[] }> {
    const version = game.ownerId === userId ? game.latestVersion : game.status === "published" ? game.publishedVersion : null;
    if (!version) fail(404, "game not found");
    const v = await getVersion(q, game.id, version);
    return { version, items: ((v.manifest as Manifest).store ?? []) as StoreItem[] };
  }

  async function ownership(q: Q, gameId: string, userId: string) {
    const rows = await q.select().from(purchases).where(and(eq(purchases.gameId, gameId), eq(purchases.userId, userId)));
    return {
      passes: [...new Set(rows.filter((p) => p.kind === "pass").map((p) => p.itemId))],
      /** Bought but not yet used by the game. */
      unconsumed: rows.filter((p) => p.kind === "consumable" && !p.consumedAt).map((p) => ({ purchaseId: p.id, itemId: p.itemId })),
    };
  }

  r.get("/v1/me/wallet", async (c) => {
    const userId = c.get("userId");
    const balance = await db.transaction(async (tx) => (await lockWallet(tx, userId)).balance);
    const recent = await db.select().from(ledger).where(eq(ledger.userId, userId)).orderBy(desc(ledger.id)).limit(20);
    return c.json({
      wallet: { balance, currency: "stars" },
      recent: recent.map((e) => ({ delta: e.delta, balanceAfter: e.balanceAfter, kind: e.kind, gameId: e.gameId, itemId: e.itemId, createdAt: e.createdAt })),
    });
  });

  r.get("/v1/games/:id/store", async (c) => {
    const userId = c.get("userId");
    const game = await getGame(db, c.req.param("id"));
    const { version, items } = await storeFor(db, game, userId);
    return c.json({ version, items, owned: await ownership(db, game.id, userId) });
  });

  r.post("/v1/games/:id/store/purchase", async (c) => {
    const body = await parseJson(c.req.raw, Purchase);
    const userId = c.get("userId");
    const result = await db.transaction(async (tx) => {
      const [prior] = await tx.select().from(purchases).where(and(eq(purchases.userId, userId), eq(purchases.idempotencyKey, body.idempotencyKey)));
      if (prior) return { purchase: prior, replay: true };

      const game = await getGame(tx, c.req.param("id"));
      const { version, items } = await storeFor(tx, game, userId);
      const item = items.find((i) => i.id === body.itemId);
      if (!item) fail(404, `no store item "${body.itemId}" in this game`);
      if (item.kind === "pass") {
        const [owned] = await tx.select({ id: purchases.id }).from(purchases)
          .where(and(eq(purchases.userId, userId), eq(purchases.gameId, game.id), eq(purchases.itemId, item.id)));
        if (owned) fail(409, "already owned", { purchaseId: owned.id });
      }

      // Creators test their own items for free.
      const isOwner = game.ownerId === userId;
      const price = isOwner ? 0 : item.price;
      const id = newId("pur");
      const [purchase] = await tx.insert(purchases).values({
        id, userId, gameId: game.id, itemId: item.id, kind: item.kind, price, version, idempotencyKey: body.idempotencyKey,
      }).returning();
      if (price > 0) {
        await move(tx, userId, -price, { kind: "purchase", gameId: game.id, itemId: item.id, purchaseId: id });
        const share = Math.floor(price * config.creatorShare);
        if (share > 0) await move(tx, game.ownerId, share, { kind: "sale", gameId: game.id, itemId: item.id, purchaseId: id });
      }
      return { purchase: purchase!, replay: false };
    });
    const balance = await db.transaction(async (tx) => (await lockWallet(tx, userId)).balance);
    const p = result.purchase;
    return c.json({
      purchase: { id: p.id, itemId: p.itemId, kind: p.kind, price: p.price, createdAt: p.createdAt },
      balance,
    }, result.replay ? 200 : 201);
  });

  /** The game used a consumable (e.g. granted the 50 gems). Single-player games call this from the client. */
  r.post("/v1/games/:id/store/consume", async (c) => {
    const body = await parseJson(c.req.raw, Consume);
    const [updated] = await db.update(purchases)
      .set({ consumedAt: sql`now()` })
      .where(and(
        eq(purchases.id, body.purchaseId),
        eq(purchases.userId, c.get("userId")),
        eq(purchases.gameId, c.req.param("id")),
        eq(purchases.kind, "consumable"),
        isNull(purchases.consumedAt),
      ))
      .returning();
    if (!updated) fail(409, "not an unconsumed purchase of yours");
    return c.json({ ok: true });
  });

  return r;
}
