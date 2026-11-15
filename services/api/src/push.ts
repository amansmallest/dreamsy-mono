import { and, count, eq, inArray, isNull } from "drizzle-orm";
import type { PushMessage, PushTicket, Pusher } from "./context.js";
import { schema, type DB } from "./db/client.js";

const { notifications, pushTokens } = schema;

export const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
/** Expo accepts at most 100 messages per request. */
const BATCH = 100;
const TIMEOUT_MS = 10_000;

/** Default pusher: the Expo push API. A non-2xx answer yields no tickets (callers swallow errors). */
export const expoPusher: Pusher = async (messages) => {
  const res = await fetch(EXPO_PUSH_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(messages),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return [];
  const json = (await res.json()) as { data?: unknown };
  return Array.isArray(json.data) ? (json.data as PushTicket[]) : [];
};

const pending = new Set<Promise<void>>();

/**
 * Fire-and-forget: push the given (already committed) notifications to their owners' devices.
 * Never throws and never blocks the request. Call it after the transaction that inserted them.
 */
export function pushAfterCommit(db: DB, pusher: Pusher | undefined, notificationIds: string[]): void {
  if (!notificationIds.length) return;
  const p: Promise<void> = deliver(db, pusher ?? expoPusher, notificationIds)
    .catch(() => {})
    .finally(() => { pending.delete(p); });
  pending.add(p);
}

/** Wait for in-flight pushes (tests). */
export async function flushPushes(): Promise<void> {
  while (pending.size) await Promise.all([...pending]);
}

async function deliver(db: DB, pusher: Pusher, ids: string[]) {
  const rows = await db.select().from(notifications).where(inArray(notifications.id, ids));
  const userIds = [...new Set(rows.map((n) => n.userId))];
  if (!userIds.length) return;
  const tokens = await db.select().from(pushTokens).where(inArray(pushTokens.userId, userIds));
  if (!tokens.length) return;
  const unread = new Map(
    (await db.select({ userId: notifications.userId, n: count() }).from(notifications)
      .where(and(inArray(notifications.userId, userIds), isNull(notifications.readAt)))
      .groupBy(notifications.userId)).map((r) => [r.userId, Number(r.n)]),
  );

  const messages: PushMessage[] = [];
  for (const n of rows) {
    for (const t of tokens) {
      if (t.userId !== n.userId) continue;
      messages.push({
        to: t.token,
        title: n.title,
        body: n.body,
        data: { ...n.data, kind: n.kind, notificationId: n.id },
        sound: "default",
        badge: unread.get(n.userId) ?? 0,
      });
    }
  }

  // Tickets come back in message order; DeviceNotRegistered = the app was uninstalled / token revoked.
  const dead = new Set<string>();
  for (let i = 0; i < messages.length; i += BATCH) {
    const chunk = messages.slice(i, i + BATCH);
    let tickets: PushTicket[] = [];
    try { tickets = await pusher(chunk); } catch { continue; }
    tickets.forEach((t, j) => {
      if (t?.status === "error" && t.details?.error === "DeviceNotRegistered" && chunk[j]) dead.add(chunk[j]!.to);
    });
  }
  if (dead.size) await db.delete(pushTokens).where(inArray(pushTokens.token, [...dead]));
}

/** Forget one of the caller's tokens (sign-out on a device). */
export async function removePushToken(db: DB, userId: string, token: string) {
  await db.delete(pushTokens).where(and(eq(pushTokens.token, token), eq(pushTokens.userId, userId)));
}
