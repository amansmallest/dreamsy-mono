import { and, asc, desc, eq, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { optionalUser, requireUser } from "../auth.js";
import { fail, parseJson, router, type Deps } from "../context.js";
import { schema } from "../db/client.js";
import { newId } from "../ids.js";
import { canAccessGame, getGame, type Q } from "../services.js";

const { runs, leaderboardBests: bests, groupMembers, users } = schema;

/** docs/platform.md §13.1 limits. */
export const BOARD_RE = /^[a-z0-9_]{1,40}$/;
export const GHOST_MAX_BYTES = 256 * 1024;
const ASC_MIN = 1;
const ASC_MAX = 6 * 3600;
const DESC_ABS_MAX = 1e12;
/** Run submits per user per minute (in-process; one API instance per region for now). */
export const RUNS_PER_MINUTE = 30;

const Order = z.enum(["asc", "desc"]);
const Ghost = z.object({
  v: z.literal(1),
  hz: z.number().positive().max(60),
  scene: z.string().min(1).max(200),
  frames: z.array(z.array(z.number().finite()).length(4)).max(20_000),
});
const SubmitRun = z.object({
  board: z.string().regex(BOARD_RE, "board must match ^[a-z0-9_]{1,40}$").default("fastest"),
  order: Order.optional(),
  version: z.number().int().positive(),
  value: z.number().finite(),
  ghost: z.unknown().optional(),
});

type Order = z.infer<typeof Order>;

/** `a` ranks ahead of `b` on this board. */
const better = (order: Order, a: SQL | typeof bests.value, b: SQL | number | typeof bests.value) =>
  order === "asc" ? sql`${a} < ${b}` : sql`${a} > ${b}`;

const userBrief = { id: users.id, handle: users.handle, avatar: users.avatar };

/** Order of an existing board (first submit fixes it), or null if it has no runs yet. */
async function boardOrder(q: Q, gameId: string, board: string): Promise<Order | null> {
  const [row] = await q.select({ order: bests.order }).from(bests)
    .where(and(eq(bests.gameId, gameId), eq(bests.board, board))).limit(1);
  return (row?.order as Order | undefined) ?? null;
}

/**
 * 1-based rank of a best row among `scope` (null = everyone): rows strictly better, plus equal rows
 * that got there earlier (ties by earlier updatedAt).
 */
async function rankOf(q: Q, gameId: string, board: string, order: Order, me: { value: number; updatedAt: Date; userId: string }, scope: SQL | undefined) {
  const [{ n }] = (await q.select({ n: sql<number>`count(*)::int` }).from(bests).where(and(
    eq(bests.gameId, gameId),
    eq(bests.board, board),
    ne(bests.userId, me.userId),
    scope,
    or(
      better(order, bests.value, me.value),
      and(eq(bests.value, me.value), sql`${bests.updatedAt} < ${me.updatedAt.toISOString()}::timestamptz`),
    ),
  ))) as [{ n: number }];
  return n + 1;
}

async function topValue(q: Q, gameId: string, board: string, order: Order): Promise<number | null> {
  const [row] = await q.select({ value: bests.value }).from(bests)
    .where(and(eq(bests.gameId, gameId), eq(bests.board, board)))
    .orderBy(order === "asc" ? asc(bests.value) : desc(bests.value), asc(bests.updatedAt))
    .limit(1);
  return row?.value ?? null;
}

const membersOf = (q: Q, groupId: string) => q.select({ id: groupMembers.userId }).from(groupMembers).where(eq(groupMembers.groupId, groupId));

export async function isMember(q: Q, groupId: string, userId: string) {
  const [row] = await q.select({ r: groupMembers.role }).from(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)));
  return !!row;
}

/** docs/platform.md §13.3: run submit, leaderboards, ghosts. */
export function leaderboardRoutes({ db, storage, config }: Deps) {
  const r = router();
  // /v1/games/* is already behind requireUser (gameRoutes). Ghosts are readable anonymously for listed games.
  r.use("/v1/runs/*", optionalUser(config));

  const recent = new Map<string, number[]>();
  function rateLimit(userId: string) {
    const now = Date.now();
    const hits = (recent.get(userId) ?? []).filter((t) => now - t < 60_000);
    if (hits.length >= RUNS_PER_MINUTE) fail(429, "too many runs; slow down");
    hits.push(now);
    recent.set(userId, hits);
    if (recent.size > 10_000) for (const [k, v] of recent) if (!v.some((t) => now - t < 60_000)) recent.delete(k);
  }

  async function visibleGame(id: string, userId: string | null) {
    const g = await getGame(db, id);
    if (!(await canAccessGame(db, g, userId))) fail(404, "game not found");
    return g;
  }

  r.post("/v1/games/:id/runs", async (c) => {
    const userId = c.get("userId");
    const body = await parseJson(c.req.raw, SubmitRun);
    const g = await visibleGame(c.req.param("id"), userId);
    if (body.version > g.latestVersion) fail(400, "unknown version");

    const existing = await boardOrder(db, g.id, body.board);
    if (existing && body.order && body.order !== existing) fail(409, `board "${body.board}" is ${existing}`);
    const order: Order = existing ?? body.order ?? "asc";

    if (order === "asc" && (body.value < ASC_MIN || body.value > ASC_MAX)) fail(400, `value must be between ${ASC_MIN} and ${ASC_MAX} seconds`);
    if (order === "desc" && Math.abs(body.value) > DESC_ABS_MAX) fail(400, "value out of range");

    let ghostBytes: Uint8Array | null = null;
    if (body.ghost !== undefined && body.ghost !== null) {
      const parsed = Ghost.safeParse(body.ghost);
      if (!parsed.success) fail(400, `ghost: ${parsed.error.issues.map((i) => `${i.path.join(".") || "ghost"}: ${i.message}`).join("; ")}`);
      ghostBytes = new TextEncoder().encode(JSON.stringify(parsed.data));
      if (ghostBytes.byteLength > GHOST_MAX_BYTES) fail(413, "ghost is larger than 256 KB");
    }

    rateLimit(userId);

    const runId = newId("run");
    const ghostKey = ghostBytes ? `ghosts/${runId}.json` : null;
    const res = await db.transaction(async (tx) => {
      const [prev] = await tx.select().from(bests)
        .where(and(eq(bests.gameId, g.id), eq(bests.board, body.board), eq(bests.userId, userId)))
        .for("update");
      const pb = !prev || (order === "asc" ? body.value < prev.value : body.value > prev.value);
      // Ghosts are kept only for the user's best run on the board.
      if (pb && ghostKey) await storage.put(ghostKey, ghostBytes!, "application/json");
      const [run] = await tx.insert(runs).values({
        id: runId, gameId: g.id, userId, board: body.board, order, version: body.version, value: body.value,
        ghostKey: pb ? ghostKey : null,
      }).returning();
      let oldGhost: string | null = null;
      if (pb) {
        if (prev) {
          const [old] = await tx.select({ key: runs.ghostKey }).from(runs).where(eq(runs.id, prev.runId));
          if (old?.key) {
            oldGhost = old.key;
            await tx.update(runs).set({ ghostKey: null }).where(eq(runs.id, prev.runId));
          }
        }
        await tx.insert(bests).values({
          gameId: g.id, board: body.board, userId, value: body.value, runId, version: body.version, order, updatedAt: run!.createdAt,
        }).onConflictDoUpdate({
          target: [bests.gameId, bests.board, bests.userId],
          set: { value: body.value, runId, version: body.version, updatedAt: run!.createdAt },
          // Concurrent first submits: only a better value may replace the row.
          setWhere: better(order, sql`excluded.value`, bests.value),
        });
      }
      const [mine] = await tx.select().from(bests)
        .where(and(eq(bests.gameId, g.id), eq(bests.board, body.board), eq(bests.userId, userId)));
      // PB: rank of my (new) best. Otherwise: where this run would place against everyone else's bests.
      const rank = pb
        ? await rankOf(tx, g.id, body.board, order, mine!, undefined)
        : await rankOf(tx, g.id, body.board, order, { value: body.value, updatedAt: new Date("9999-12-31T00:00:00Z"), userId }, undefined);
      return { run: run!, pb, rank, best: await topValue(tx, g.id, body.board, order), oldGhost };
    });
    if (res.oldGhost) await storage.delete(res.oldGhost).catch(() => {});

    return c.json({
      run: runView(res.run),
      rank: res.rank,
      best: res.best,
      personalBest: res.pb,
    }, 201);
  });

  /** Boards of a game that have runs (dashboard picker). */
  r.get("/v1/games/:id/leaderboards", async (c) => {
    const g = await visibleGame(c.req.param("id"), c.get("userId"));
    const rows = await db.select({
      board: bests.board,
      order: sql<string>`min(${bests.order})`,
      players: sql<number>`count(*)::int`,
      best: sql<number>`case when min(${bests.order}) = 'asc' then min(${bests.value}) else max(${bests.value}) end`,
      updatedAt: sql<string>`max(${bests.updatedAt})`,
    }).from(bests).where(eq(bests.gameId, g.id)).groupBy(bests.board).orderBy(asc(bests.board));
    return c.json({
      boards: rows.map((b) => ({ board: b.board, order: b.order, players: b.players, best: b.best, updatedAt: new Date(b.updatedAt) })),
    });
  });

  r.get("/v1/games/:id/leaderboards/:board", async (c) => {
    const userId = c.get("userId");
    const board = c.req.param("board");
    if (!BOARD_RE.test(board)) fail(400, "board must match ^[a-z0-9_]{1,40}$");
    const g = await visibleGame(c.req.param("id"), userId);
    const limit = Math.min(Math.max(Number(c.req.query("limit")) || 20, 1), 100);
    const scopeParam = c.req.query("scope") || "public";
    const order: Order = (await boardOrder(db, g.id, board)) ?? "asc";
    const byValue = order === "asc" ? asc : desc;

    if (scopeParam === "me") {
      const rows = await db.select({ run: runs, user: userBrief }).from(runs)
        .innerJoin(users, eq(users.id, runs.userId))
        .where(and(eq(runs.gameId, g.id), eq(runs.board, board), eq(runs.userId, userId)))
        .orderBy(byValue(runs.value), asc(runs.createdAt))
        .limit(limit);
      const me = await meBlock(g.id, board, order, userId, undefined);
      return c.json({
        board, order, scope: "me",
        entries: rows.map((row, i) => ({
          rank: i + 1, user: row.user, value: row.run.value, runId: row.run.id,
          hasGhost: !!row.run.ghostKey, version: row.run.version, at: row.run.createdAt,
        })),
        ...(me ? { me } : {}),
      });
    }

    let scope: SQL | undefined;
    if (scopeParam.startsWith("group:")) {
      const groupId = scopeParam.slice("group:".length);
      if (!(await isMember(db, groupId, userId))) fail(404, "group not found");
      scope = inArray(bests.userId, membersOf(db, groupId));
    } else if (scopeParam !== "public") {
      fail(400, "scope must be public, me or group:<id>");
    }

    const rows = await db.select({ best: bests, user: userBrief, ghostKey: runs.ghostKey }).from(bests)
      .innerJoin(users, eq(users.id, bests.userId))
      .leftJoin(runs, eq(runs.id, bests.runId))
      .where(and(eq(bests.gameId, g.id), eq(bests.board, board), scope))
      .orderBy(byValue(bests.value), asc(bests.updatedAt), asc(bests.userId))
      .limit(limit);
    const me = await meBlock(g.id, board, order, userId, scope);
    return c.json({
      board, order, scope: scopeParam,
      entries: rows.map((row, i) => ({
        rank: i + 1, user: row.user, value: row.best.value, runId: row.best.runId,
        hasGhost: !!row.ghostKey, version: row.best.version, at: row.best.updatedAt,
      })),
      ...(me ? { me } : {}),
    });
  });

  async function meBlock(gameId: string, board: string, order: Order, userId: string, scope: SQL | undefined) {
    const [mine] = await db.select().from(bests)
      .where(and(eq(bests.gameId, gameId), eq(bests.board, board), eq(bests.userId, userId)));
    if (!mine) return null;
    return { rank: await rankOf(db, gameId, board, order, mine, scope), value: mine.value, runId: mine.runId };
  }

  r.get("/v1/runs/:runId/ghost", async (c) => {
    const userId = (c.get("userId") as string | undefined) ?? null;
    const [run] = await db.select().from(runs).where(eq(runs.id, c.req.param("runId")));
    if (!run) fail(404, "run not found");
    const g = await getGame(db, run.gameId);
    const visible = userId ? await canAccessGame(db, g, userId) : g.status === "published" && !g.hidden;
    if (!visible) fail(404, "run not found");
    if (!run.ghostKey) fail(404, "no ghost for this run");
    const body = await storage.get(run.ghostKey);
    if (!body) fail(404, "no ghost for this run");
    return new Response(body, {
      headers: { "content-type": "application/json", "cache-control": "private, max-age=31536000, immutable" },
    });
  });

  return r;
}

export const runView = (r: typeof runs.$inferSelect) => ({
  id: r.id,
  gameId: r.gameId,
  userId: r.userId,
  board: r.board,
  order: r.order,
  version: r.version,
  value: r.value,
  hasGhost: !!r.ghostKey,
  createdAt: r.createdAt,
});
