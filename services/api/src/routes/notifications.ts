import { and, count, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import { z } from "zod";
import { requireUser } from "../auth.js";
import { fail, parseJson, router, type Deps } from "../context.js";
import { schema } from "../db/client.js";
import { removePushToken } from "../push.js";
import type { Q } from "../services.js";

const { notifications, pushTokens } = schema;

const MarkRead = z.object({
  ids: z.array(z.string().max(64)).max(500).optional(),
  all: z.boolean().optional(),
});
const PushToken = z.object({
  token: z.string().trim().regex(/^Expo(nent)?PushToken\[.+\]$/, "token must be an Expo push token").max(200),
  platform: z.enum(["ios", "android"]),
});
const RemoveToken = z.object({ token: z.string().trim().min(1).max(200) });

type Row = typeof notifications.$inferSelect;
const view = (n: Row) => ({
  id: n.id, kind: n.kind, title: n.title, body: n.body, data: n.data, read: n.readAt !== null, createdAt: n.createdAt,
});

export async function unreadCount(q: Q, userId: string) {
  const [r] = await q.select({ n: count() }).from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
  return Number(r?.n ?? 0);
}

/** In-app inbox + Expo push tokens (DREAMSY.MD §11.6). */
export function notificationRoutes({ db, config }: Deps) {
  const r = router();
  r.use("/v1/me/notifications", requireUser(config));
  r.use("/v1/me/notifications/*", requireUser(config));
  r.use("/v1/me/push-tokens", requireUser(config));

  /** Newest first; `cursor` = the last id of the previous page. */
  r.get("/v1/me/notifications", async (c) => {
    const userId = c.get("userId");
    const limit = Math.min(Math.max(Number(c.req.query("limit")) || 20, 1), 100);
    const cursor = c.req.query("cursor") || null;
    const rows = await db.select().from(notifications)
      .where(and(eq(notifications.userId, userId), cursor ? lt(notifications.id, cursor) : undefined))
      .orderBy(desc(notifications.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    return c.json({
      items: page.map(view),
      unread: await unreadCount(db, userId),
      next: rows.length > limit ? page[page.length - 1]!.id : null,
    });
  });

  r.get("/v1/me/notifications/unread", async (c) => c.json({ unread: await unreadCount(db, c.get("userId")) }));

  /** `{all: true}` marks everything read; `{ids}` marks those (the caller's only). */
  r.post("/v1/me/notifications/read", async (c) => {
    const body = await parseJson(c.req.raw, MarkRead);
    const userId = c.get("userId");
    if (!body.all && !body.ids?.length) fail(400, "pass ids or all: true");
    await db.update(notifications).set({ readAt: new Date() }).where(and(
      eq(notifications.userId, userId),
      isNull(notifications.readAt),
      body.all ? undefined : inArray(notifications.id, body.ids!),
    ));
    return c.json({ unread: await unreadCount(db, userId) });
  });

  /** Register this device; a token moves to whoever signed in on the device last. */
  r.post("/v1/me/push-tokens", async (c) => {
    const body = await parseJson(c.req.raw, PushToken);
    const userId = c.get("userId");
    await db.insert(pushTokens).values({ token: body.token, userId, platform: body.platform })
      .onConflictDoUpdate({ target: pushTokens.token, set: { userId, platform: body.platform } });
    return c.json({ ok: true });
  });

  r.delete("/v1/me/push-tokens", async (c) => {
    const body = await parseJson(c.req.raw, RemoveToken);
    await removePushToken(db, c.get("userId"), body.token);
    return c.json({ ok: true });
  });

  return r;
}
