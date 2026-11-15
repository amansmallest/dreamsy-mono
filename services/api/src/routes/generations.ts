import { and, asc, desc, eq, gt, gte, inArray } from "drizzle-orm";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { requireUser } from "../auth.js";
import { fail, parseJson, router, type Deps } from "../context.js";
import { schema } from "../db/client.js";
import { ACTIVE_GENERATION, TERMINAL_GENERATION } from "../db/schema.js";
import { newId } from "../ids.js";
import {
  appendEvent,
  generationView,
  getGeneration,
  getOwnedGame,
  getUploadsOwnedBy,
  type Q,
} from "../services.js";

const { generations, generationEvents } = schema;

const CreateGeneration = z.object({
  prompt: z.string().trim().min(1).max(60_000), // long design briefs welcome
  imageIds: z.array(z.string()).max(8).default([]),
  /** Scope the edit to these sprites/assets (web dashboard click-to-edit). */
  assetIds: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)).max(20).default([]),
  /** Entity IDs the user tapped in the preview to scope the edit. */
  selection: z.array(z.string().max(200)).max(100).default([]),
  /** Which model family builds it (default Claude). */
  provider: z.enum(["anthropic", "openai"]).default("anthropic"),
});

const isTerminal = (s: string) => (TERMINAL_GENERATION as readonly string[]).includes(s);

export function generationRoutes({ db, config }: Deps) {
  const r = router();

  /** Rolling 24h window. */
  async function quota(q: Q, userId: string) {
    const since = new Date(Date.now() - 86_400_000);
    const rows = await q.select({ createdAt: generations.createdAt }).from(generations)
      .where(and(eq(generations.userId, userId), gte(generations.createdAt, since)))
      .orderBy(asc(generations.createdAt));
    const used = rows.length;
    const oldest = rows[0]?.createdAt;
    return {
      limit: config.dailyGenerationQuota,
      used,
      remaining: Math.max(0, config.dailyGenerationQuota - used),
      /** When the next build frees up (null if not at the limit). */
      resetsAt: used >= config.dailyGenerationQuota && oldest ? new Date(oldest.getTime() + 86_400_000) : null,
    };
  }

  r.get("/v1/me/quota", requireUser(config), async (c) => c.json({ quota: await quota(db, c.get("userId")) }));
  r.use("/v1/generations/*", requireUser(config));
  r.use("/v1/games/:id/generations", requireUser(config));

  /**
   * Ask the harness to build/edit a game. One active generation per game, because each
   * edit is a diff against `baseVersion`.
   */
  r.post("/v1/games/:id/generations", async (c) => {
    const body = await parseJson(c.req.raw, CreateGeneration);
    const userId = c.get("userId");

    const gen = await db.transaction(async (tx) => {
      const game = await getOwnedGame(tx, c.req.param("id"), userId, { lock: true });
      await getUploadsOwnedBy(tx, body.imageIds, userId);

      const [active] = await tx.select({ id: generations.id }).from(generations)
        .where(and(eq(generations.gameId, game.id), inArray(generations.status, [...ACTIVE_GENERATION])));
      if (active) fail(409, `generation ${active.id} is already in progress for this game`, { activeGenerationId: active.id });

      const q = await quota(tx, userId);
      if (q.remaining <= 0) fail(429, "daily generation quota reached", { quota: q });

      const [row] = await tx.insert(generations).values({
        id: newId("gen"),
        gameId: game.id,
        userId,
        prompt: body.prompt,
        imageIds: body.imageIds,
        assetIds: body.assetIds,
        selection: body.selection,
        provider: body.provider,
        baseVersion: game.latestVersion,
      }).returning();
      await appendEvent(tx, row!.id, "queued", {});
      return row!;
    });
    return c.json({ generation: generationView(gen) }, 201);
  });

  r.get("/v1/games/:id/generations", async (c) => {
    const game = await getOwnedGame(db, c.req.param("id"), c.get("userId"));
    const rows = await db.select().from(generations)
      .where(eq(generations.gameId, game.id))
      .orderBy(desc(generations.createdAt))
      .limit(50);
    return c.json({ generations: rows.map(generationView) });
  });

  r.get("/v1/generations/:id", async (c) => {
    const gen = await getGeneration(db, c.req.param("id"));
    if (gen.userId !== c.get("userId")) fail(404, "generation not found");
    return c.json({ generation: generationView(gen) });
  });

  r.post("/v1/generations/:id/cancel", async (c) => {
    const gen = await db.transaction(async (tx) => {
      const g = await getGeneration(tx, c.req.param("id"), { lock: true });
      if (g.userId !== c.get("userId")) fail(404, "generation not found");
      if (isTerminal(g.status)) return g;
      const [updated] = await tx.update(generations)
        .set({ status: "canceled", finishedAt: new Date(), leaseExpiresAt: null })
        .where(eq(generations.id, g.id))
        .returning();
      await appendEvent(tx, g.id, "canceled", {});
      return updated!;
    });
    return c.json({ generation: generationView(gen) });
  });

  /**
   * Progress stream. Replays from `Last-Event-ID` (or `?after=`), then tails until the
   * generation is terminal. Polls Postgres, so it works across API instances.
   */
  r.get("/v1/generations/:id/events", async (c) => {
    const gen = await getGeneration(db, c.req.param("id"));
    if (gen.userId !== c.get("userId")) fail(404, "generation not found");
    let lastId = Number(c.req.header("last-event-id") ?? c.req.query("after") ?? 0) || 0;

    return streamSSE(c, async (stream) => {
      let aborted = false;
      stream.onAbort(() => { aborted = true; });
      while (!aborted) {
        // Read status BEFORE events: if terminal now, every event is already written.
        const [{ status } = { status: "failed" }] = await db.select({ status: generations.status })
          .from(generations).where(eq(generations.id, gen.id));
        const events = await db.select().from(generationEvents)
          .where(and(eq(generationEvents.generationId, gen.id), gt(generationEvents.id, lastId)))
          .orderBy(asc(generationEvents.id))
          .limit(200);
        for (const e of events) {
          await stream.writeSSE({ id: String(e.id), event: e.type, data: JSON.stringify(e.data) });
          lastId = e.id;
        }
        if (events.length === 200) continue;
        if (isTerminal(status)) break;
        await stream.sleep(config.ssePollMs);
      }
    });
  });

  return r;
}
