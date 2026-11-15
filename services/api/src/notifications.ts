import { eq } from "drizzle-orm";
import { schema } from "./db/client.js";
import { coinsToUsd } from "./economy.js";
import { newId } from "./ids.js";
import type { Q } from "./services.js";

const { notifications, users } = schema;

export type NotificationKind = "royalty" | "play_earning" | "remix_earning" | "sale" | "build_done" | "group_join";

/**
 * Insert one in-app notification inside `tx`; returns its id. Push it after commit with
 * `pushAfterCommit(db, deps.pusher, ids)` (push.ts) so a rolled-back tx never pushes.
 */
export async function notify(
  tx: Q, userId: string, kind: NotificationKind, title: string, body: string, data: Record<string, unknown> = {},
): Promise<string> {
  const id = newId("n");
  await tx.insert(notifications).values({ id, userId, kind, title, body, data });
  return id;
}

/** 9000 → "9K", 25000 → "25K", 1500 → "1.5K", 1000000 → "1M", 500 → "500". */
export function formatCoins(n: number): string {
  const trim = (x: number) => String(Math.round(x * 10) / 10);
  if (Math.abs(n) >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (Math.abs(n) >= 1_000) return `${trim(n / 1_000)}K`;
  return String(n);
}
/** 9000 coins → "$0.09". */
export const formatUsd = (coins: number) => `$${coinsToUsd(coins).toFixed(2)}`;

async function handleOf(q: Q, userId: string) {
  const [u] = await q.select({ handle: users.handle }).from(users).where(eq(users.id, userId));
  return u?.handle ?? "someone";
}

const PAID = "You got paid";

/** Creator credited for a paid play. Never notifies yourself. */
export async function notifyPlayEarning(tx: Q, a: { creatorId: string; playerId: string; gameId: string; gameName: string; coins: number }) {
  if (a.creatorId === a.playerId || a.coins <= 0) return [];
  const who = await handleOf(tx, a.playerId);
  return [await notify(tx, a.creatorId, "play_earning", PAID,
    `@${who} played ${a.gameName} — +${formatCoins(a.coins)} coins (${formatUsd(a.coins)})`,
    { gameId: a.gameId, fromUserId: a.playerId, coins: a.coins })];
}

/** Royalty to the parent game's owner when someone plays a spin-off of it. */
export async function notifyRoyalty(tx: Q, a: { ownerId: string; playerId: string; parentGameId: string; parentName: string; gameId: string; gameName: string; coins: number }) {
  if (a.ownerId === a.playerId || a.coins <= 0) return [];
  const who = await handleOf(tx, a.playerId);
  return [await notify(tx, a.ownerId, "royalty", PAID,
    `@${who} played ${a.gameName}, a spin-off of your ${a.parentName} — +${formatCoins(a.coins)} coins royalty (${formatUsd(a.coins)})`,
    { gameId: a.gameId, parentGameId: a.parentGameId, fromUserId: a.playerId, coins: a.coins })];
}

export async function notifyRemixEarning(tx: Q, a: { ownerId: string; remixerId: string; gameId: string; gameName: string; remixGameId: string; coins: number }) {
  if (a.ownerId === a.remixerId || a.coins <= 0) return [];
  const who = await handleOf(tx, a.remixerId);
  return [await notify(tx, a.ownerId, "remix_earning", PAID,
    `@${who} remixed ${a.gameName} — +${formatCoins(a.coins)} coins (${formatUsd(a.coins)})`,
    { gameId: a.gameId, remixGameId: a.remixGameId, fromUserId: a.remixerId, coins: a.coins })];
}

export async function notifySale(tx: Q, a: { creatorId: string; buyerId: string; gameId: string; gameName: string; itemId: string; itemName: string; coins: number }) {
  if (a.creatorId === a.buyerId || a.coins <= 0) return [];
  const who = await handleOf(tx, a.buyerId);
  return [await notify(tx, a.creatorId, "sale", PAID,
    `@${who} bought ${a.itemName} in ${a.gameName} — +${formatCoins(a.coins)} coins`,
    { gameId: a.gameId, itemId: a.itemId, fromUserId: a.buyerId, coins: a.coins })];
}

export async function notifyBuildDone(tx: Q, a: { userId: string; gameId: string; gameName: string; version: number }) {
  return [await notify(tx, a.userId, "build_done", "Your game is ready",
    `${a.gameName} v${a.version} is playable`, { gameId: a.gameId, version: a.version })];
}

/** Tell the group's other members someone joined. */
export async function notifyGroupJoin(tx: Q, a: { memberIds: string[]; joinerId: string; groupId: string; groupName: string }) {
  const who = await handleOf(tx, a.joinerId);
  const ids: string[] = [];
  for (const m of a.memberIds) {
    if (m === a.joinerId) continue;
    ids.push(await notify(tx, m, "group_join", "New family member", `@${who} joined ${a.groupName}`, { groupId: a.groupId }));
  }
  return ids;
}
