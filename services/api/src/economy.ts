import { and, eq, inArray } from "drizzle-orm";
import { fail, type Config } from "./context.js";
import { schema } from "./db/client.js";
import { PLATFORM_USER_ID } from "./db/schema.js";
import type { Generation, Tx } from "./services.js";

const { wallets, ledger, games, generations } = schema;

/** Coins → USD: 10,000 coins = $0.10 (docs/platform.md §11.6). */
export const COINS_PER_USD = 100_000;
/** Defaults for config.createPrice / config.remixPrice (CREATE_PRICE / REMIX_PRICE env). */
export const CREATE_PRICE = 100_000;
export const REMIX_PRICE = 25_000;
export const coinsToUsd = (coins: number, places = 2) => Math.round((coins / COINS_PER_USD) * 10 ** places) / 10 ** places;

type Wallet = typeof wallets.$inferSelect;
export type LedgerEntry = { kind: string; gameId?: string; itemId?: string; purchaseId?: string; passId?: string };

/**
 * Lock (and lazily create, with the starter grant) the wallets of `userIds`, in id order so
 * concurrent transfers between the same people can't deadlock. The platform account starts at 0.
 */
export async function lockWallets(tx: Tx, config: Config, userIds: string[]): Promise<Map<string, Wallet>> {
  const ids = [...new Set(userIds)].sort();
  const out = new Map<string, Wallet>();
  for (const userId of ids) {
    const [w] = await tx.select().from(wallets).where(eq(wallets.userId, userId)).for("update");
    if (w) { out.set(userId, w); continue; }
    const starter = userId === PLATFORM_USER_ID ? 0 : config.starterStars;
    await tx.insert(wallets).values({ userId, balance: starter }).onConflictDoNothing();
    const [created] = await tx.select().from(wallets).where(eq(wallets.userId, userId)).for("update");
    if (starter > 0) {
      const hasGrant = await tx.select({ id: ledger.id }).from(ledger)
        .where(and(eq(ledger.userId, userId), inArray(ledger.kind, ["starter_grant", "grant"])));
      if (!hasGrant.length) {
        await tx.insert(ledger).values({ userId, delta: starter, balanceAfter: created!.balance, kind: "starter_grant" });
      }
    }
    out.set(userId, created!);
  }
  return out;
}

export async function lockWallet(tx: Tx, config: Config, userId: string) {
  return (await lockWallets(tx, config, [userId])).get(userId)!;
}

/** Apply one balance change + ledger row. The wallet must already be locked by this tx. */
export async function move(tx: Tx, config: Config, userId: string, delta: number, entry: LedgerEntry): Promise<number> {
  const w = await lockWallet(tx, config, userId); // re-select under the lock we already hold: current balance
  const balance = w.balance + delta;
  if (balance < 0) fail(402, "insufficient_coins", { balance: w.balance, price: -delta });
  await tx.update(wallets).set({ balance }).where(eq(wallets.userId, userId));
  await tx.insert(ledger).values({ userId, delta, balanceAfter: balance, ...entry });
  return balance;
}

/**
 * Charge `payer` `price` and split it: `floor(price · creatorShare)` to the creator, the rest to
 * the platform account. Three ledger rows summing to zero. Returns the payer's new balance.
 */
export async function chargeWithSplit(
  tx: Tx, config: Config,
  payer: string, creator: string, price: number,
  kinds: { debit: string; credit: string },
  entry: Omit<LedgerEntry, "kind">,
  /** Spin-offs: part of the creator's share goes to the parent game's owner (one level only). */
  royalty?: { userId: string; amount: number },
) {
  const royaltyTo = royalty && royalty.amount > 0 && royalty.userId !== creator ? royalty : null;
  await lockWallets(tx, config, [payer, creator, PLATFORM_USER_ID, ...(royaltyTo ? [royaltyTo.userId] : [])]);
  const balance = await move(tx, config, payer, -price, { kind: kinds.debit, ...entry });
  const share = Math.floor(price * config.creatorShare);
  const royaltyPaid = royaltyTo ? Math.min(royaltyTo.amount, share) : 0;
  const creatorEarned = share - royaltyPaid;
  if (creatorEarned > 0) await move(tx, config, creator, creatorEarned, { kind: kinds.credit, ...entry });
  if (royaltyPaid > 0) await move(tx, config, royaltyTo!.userId, royaltyPaid, { kind: "royalty", ...entry });
  const fee = price - share;
  if (fee > 0) await move(tx, config, PLATFORM_USER_ID, fee, { kind: "platform_fee", ...entry });
  return { balance, creatorEarned, fee, royaltyPaid };
}

/**
 * First build of a game (§11.6): `price` from the creator to the platform account, two `create`
 * rows summing to zero. 402 `insufficient_coins` when broke. Returns the payer's new balance.
 */
export async function chargeCreate(tx: Tx, config: Config, userId: string, gameId: string, price: number) {
  await lockWallets(tx, config, [userId, PLATFORM_USER_ID]);
  const balance = await move(tx, config, userId, -price, { kind: "create", gameId });
  await move(tx, config, PLATFORM_USER_ID, price, { kind: "create", gameId });
  return balance;
}

/**
 * Give back a first build's charge when the generation ended failed/canceled and the game still
 * has no version. Exactly once: the caller holds the generation row lock and `refunded_at` is set
 * in the same tx. Returns the refunded amount (0 when nothing to refund).
 */
export async function refundCreateIfUnbuilt(tx: Tx, config: Config, gen: Generation): Promise<number> {
  if (gen.charged <= 0 || gen.refundedAt) return 0;
  const [g] = await tx.select({ latestVersion: games.latestVersion }).from(games).where(eq(games.id, gen.gameId));
  if (!g || g.latestVersion > 0) return 0;
  await lockWallets(tx, config, [gen.userId, PLATFORM_USER_ID]);
  await move(tx, config, PLATFORM_USER_ID, -gen.charged, { kind: "create_refund", gameId: gen.gameId });
  await move(tx, config, gen.userId, gen.charged, { kind: "create_refund", gameId: gen.gameId });
  await tx.update(generations).set({ refundedAt: new Date() }).where(eq(generations.id, gen.id));
  return gen.charged;
}
