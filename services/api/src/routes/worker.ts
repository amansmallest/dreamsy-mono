import { createHash } from "node:crypto";
import { and, asc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { requireWorker } from "../auth.js";
import { fail, parseJson, router, type Deps } from "../context.js";
import { schema } from "../db/client.js";
import { mirrorToLive } from "../live.js";
import { MAX_PACKAGE_BYTES } from "../package.js";
import {
  appendEvent,
  commitVersion,
  generationView,
  getGame,
  getGeneration,
  getVersion,
  readPackage,
  storePackage,
  versionView,
  type Generation,
  type Tx,
} from "../services.js";
import { packageResponse, parseVersion } from "./games.js";
import { blobResponse } from "./uploads.js";

const { generations, uploads } = schema;

const WorkerId = z.string().min(1).max(200);
const Claim = z.object({ workerId: WorkerId, provider: z.enum(["anthropic", "openai"]).default("anthropic") });
const Event = z.object({
  workerId: WorkerId,
  type: z.string().regex(/^[a-z][a-z0-9_.]*$/).max(64)
    .refine((t) => !RESERVED_EVENTS.has(t), "reserved event type"),
  data: z.unknown().default({}),
});
/** `eta` event payload; also stored on the generation for clients that poll. */
const Eta = z.object({
  etaSeconds: z.number().int().min(0).nullable().optional(),
  round: z.number().int().min(0).optional(),
  rounds: z.number().int().min(0).optional(),
  phase: z.string().max(100).optional(),
});
/** `metrics` event payload (one per job, sent before complete/fail); stored on the generation for insights. */
const count = z.number().int().min(0);
export const Metrics = z.object({
  costUsd: z.number().min(0),
  rounds: count,
  turns: count,
  minutes: z.number().min(0),
  artScore: z.number().min(0).max(10).nullable(),
  artVerdict: z.enum(["ship", "polish"]).nullable(),
  playtestRuns: count,
  runtimeErrorsFixed: count,
  finalGatePassedFirstTry: z.boolean().nullable(),
  memoryHits: count,
  spritesReused: count,
  spritesDrawn: count,
  kit: z.string().max(64).nullable(),
  pack: z.string().max(64).nullable(),
  kind: z.string().max(32).nullable(),
  memoryIds: z.array(z.string().max(120)).max(100).optional(),
});
const Fail = z.object({
  workerId: WorkerId,
  error: z.string().max(4000),
  retryable: z.boolean().default(false),
});

/** Event types only the API emits. */
const RESERVED_EVENTS = new Set(["queued", "started", "succeeded", "failed", "canceled", "requeued", "checkpoint"]);
const MAX_EVENT_BYTES = 64 * 1024;
export const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;

/**
 * Harness worker protocol:
 *   claim → (events…, each renews the lease) → complete | fail
 * A worker that goes silent past its lease loses the job; another worker re-claims it.
 * Any 409 from events/complete means "stop working on this job" (canceled or reassigned).
 */
export function workerRoutes({ db, storage, config }: Deps) {
  const r = router();
  r.use("/v1/worker/*", requireWorker(config));

  const lease = () => new Date(Date.now() + config.leaseSeconds * 1000);

  r.post("/v1/worker/claim", async (c) => {
    const { workerId, provider } = await parseJson(c.req.raw, Claim);

    const claimed = await db.transaction(async (tx) => {
      // Jobs whose worker died too many times are given up on.
      const dead = await tx.update(generations)
        .set({ status: "failed", error: "worker lease expired too many times", finishedAt: new Date(), leaseExpiresAt: null })
        .where(and(
          eq(generations.status, "running"),
          lt(generations.leaseExpiresAt, new Date()),
          gte(generations.attempts, config.maxAttempts),
        ))
        .returning({ id: generations.id });
      for (const d of dead) await appendEvent(tx, d.id, "failed", { error: "worker lease expired too many times" });

      const [job] = await tx.select().from(generations)
        .where(and(eq(generations.provider, provider), or(
          eq(generations.status, "queued"),
          and(eq(generations.status, "running"), lt(generations.leaseExpiresAt, new Date())),
        )))
        .orderBy(asc(generations.createdAt))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!job) return null;

      const [updated] = await tx.update(generations).set({
        status: "running",
        workerId,
        leaseExpiresAt: lease(),
        attempts: sql`${generations.attempts} + 1`,
        startedAt: job.startedAt ?? new Date(),
      }).where(eq(generations.id, job.id)).returning();
      await appendEvent(tx, job.id, "started", { attempt: updated!.attempts });
      return updated!;
    });

    if (!claimed) return c.body(null, 204);
    mirrorToLive(db, claimed.id, "started", {});

    const game = await getGame(db, claimed.gameId);
    const images = claimed.imageIds.length
      ? await db.select().from(uploads).where(inArray(uploads.id, claimed.imageIds))
      : [];
    const base = claimed.baseVersion > 0 ? versionView(await getVersion(db, game.id, claimed.baseVersion)) : null;

    return c.json({
      // userId + remixOf scope the harness's retrieval memory (a user's prompts are recalled only for them).
      generation: { ...generationView(claimed), userId: claimed.userId },
      leaseSeconds: config.leaseSeconds,
      game: {
        id: game.id, name: game.name, description: game.description,
        remixOf: game.remixOfGameId ? { gameId: game.remixOfGameId, version: game.remixOfVersion } : null,
      },
      base: base && { ...base, packageUrl: `/v1/worker/games/${game.id}/versions/${base.version}/package` },
      images: images.map((u) => ({ id: u.id, contentType: u.contentType, url: `/v1/worker/uploads/${u.id}` })),
    });
  });

  r.post("/v1/worker/generations/:id/events", async (c) => {
    const body = await parseJson(c.req.raw, Event);
    if (JSON.stringify(body.data).length > MAX_EVENT_BYTES) fail(413, "event data too large");
    let eta: z.infer<typeof Eta> | null = null;
    if (body.type === "eta") {
      const parsed = Eta.safeParse(body.data);
      if (!parsed.success) fail(400, `eta: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      eta = parsed.data;
    }
    let metrics: z.infer<typeof Metrics> | null = null;
    if (body.type === "metrics") {
      const parsed = Metrics.safeParse(body.data);
      if (!parsed.success) fail(400, `metrics: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      metrics = parsed.data;
    }
    await db.transaction(async (tx) => {
      await ownedRunning(tx, c.req.param("id"), body.workerId);
      await tx.update(generations).set({
        leaseExpiresAt: lease(),
        ...(eta && {
          etaSeconds: eta.etaSeconds ?? null,
          progress: { round: eta.round, rounds: eta.rounds, phase: eta.phase },
        }),
        ...(metrics && { metrics }),
      }).where(eq(generations.id, c.req.param("id")));
      await appendEvent(tx, c.req.param("id"), body.type, body.data);
    });
    mirrorToLive(db, c.req.param("id"), body.type, body.data);
    return c.json({ ok: true, leaseSeconds: config.leaseSeconds });
  });

  /** Parse + store the multipart result of a build round (shared by checkpoint and complete). */
  async function readResult(req: { parseBody(): Promise<Record<string, string | File | (string | File)[]>> }) {
    const form = await req.parseBody();
    const workerId = WorkerId.parse(form["workerId"]);
    const summary = typeof form["summary"] === "string" ? form["summary"].slice(0, 4000) : "";
    const file = form["package"];
    if (!(file instanceof File)) fail(400, "multipart field 'package' is required");
    const thumb = form["thumbnail"];
    if (thumb !== undefined && !(thumb instanceof File)) fail(400, "multipart field 'thumbnail' must be a file");
    // Store blobs outside the transaction; orphans are harmless (content-addressed).
    const thumbnailKey = thumb ? await storeThumbnail(storage, new Uint8Array(await thumb.arrayBuffer())) : null;
    const pkg = await storePackage(storage, new Uint8Array(await file.arrayBuffer()));
    return { workerId, summary, pkg, thumbnailKey };
  }

  /** Lock job + game, check the base is current, append the version. */
  async function commitResult(tx: Tx, id: string, res: Awaited<ReturnType<typeof readResult>>) {
    const gen = await ownedRunning(tx, id, res.workerId);
    const game = await getGame(tx, gen.gameId, { lock: true });
    if (game.latestVersion !== gen.baseVersion) {
      fail(409, `game moved from version ${gen.baseVersion} to ${game.latestVersion}; edit is stale`);
    }
    const version = await commitVersion(tx, game, res.pkg, {
      createdBy: gen.userId, summary: res.summary, generationId: gen.id, thumbnailKey: res.thumbnailKey,
    });
    return { gen, version };
  }

  const resultLimit = bodyLimit({
    maxSize: MAX_PACKAGE_BYTES + MAX_THUMBNAIL_BYTES + 1024 * 1024,
    onError: () => fail(413, "package too large"),
  });

  /**
   * Multi-round builds: commit an intermediate version (playable like any other) and keep the job
   * running. The generation's baseVersion moves to the new version so the next checkpoint/complete
   * builds on it. Renews the lease.
   */
  r.post("/v1/worker/generations/:id/checkpoint", resultLimit, async (c) => {
    const res = await readResult(c.req);
    const version = await db.transaction(async (tx) => {
      const { gen, version } = await commitResult(tx, c.req.param("id"), res);
      await tx.update(generations).set({ baseVersion: version.version, leaseExpiresAt: lease() }).where(eq(generations.id, gen.id));
      await appendEvent(tx, gen.id, "checkpoint", { version: version.version, summary: res.summary });
      return version;
    });
    mirrorToLive(db, c.req.param("id"), "checkpoint", { version: version.version, summary: res.summary });
    return c.json({ version: versionView(version) }, 201);
  });

  /** multipart: workerId, summary, package (zip), thumbnail? (JPEG ≤2MB). Commits version = base + 1. */
  r.post("/v1/worker/generations/:id/complete", resultLimit, async (c) => {
    const res = await readResult(c.req);
    const { gen, version } = await db.transaction(async (tx) => {
      const { gen, version } = await commitResult(tx, c.req.param("id"), res);
      const [done] = await tx.update(generations).set({
        status: "succeeded",
        resultVersion: version.version,
        finishedAt: new Date(),
        leaseExpiresAt: null,
        etaSeconds: null,
      }).where(eq(generations.id, gen.id)).returning();
      await appendEvent(tx, gen.id, "succeeded", { version: version.version, summary: res.summary });
      return { gen: done!, version };
    });
    mirrorToLive(db, gen.id, "succeeded", { version: version.version, summary: res.summary });
    return c.json({ generation: generationView(gen), version: versionView(version) }, 201);
  });

  r.post("/v1/worker/generations/:id/fail", async (c) => {
    const body = await parseJson(c.req.raw, Fail);
    const gen = await db.transaction(async (tx) => {
      const gen = await ownedRunning(tx, c.req.param("id"), body.workerId);
      const retry = body.retryable && gen.attempts < config.maxAttempts;
      const [updated] = await tx.update(generations).set(retry
        ? { status: "queued", workerId: null, leaseExpiresAt: null, error: body.error }
        : { status: "failed", leaseExpiresAt: null, error: body.error, finishedAt: new Date() },
      ).where(eq(generations.id, gen.id)).returning();
      await appendEvent(tx, gen.id, retry ? "requeued" : "failed", { error: body.error });
      return updated!;
    });
    if (gen.status === "failed") mirrorToLive(db, gen.id, "failed", { error: body.error });
    return c.json({ generation: generationView(gen) });
  });

  r.get("/v1/worker/games/:id/versions/:version/package", async (c) => {
    const v = await getVersion(db, c.req.param("id"), parseVersion(c.req.param("version")));
    return packageResponse(await readPackage(storage, v), v.packageSha256);
  });

  r.get("/v1/worker/uploads/:id", async (c) => {
    const [row] = await db.select().from(uploads).where(eq(uploads.id, c.req.param("id")));
    if (!row) fail(404, "upload not found");
    return blobResponse(storage, row.key, row.contentType);
  });

  return r;
}

/** Validate (JPEG magic, ≤2MB) and store a thumbnail, content-addressed. */
async function storeThumbnail(storage: Deps["storage"], bytes: Uint8Array): Promise<string> {
  if (bytes.byteLength > MAX_THUMBNAIL_BYTES) fail(413, "thumbnail too large (max 2MB)");
  if (bytes.byteLength < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) fail(415, "thumbnail must be a JPEG");
  const key = `thumbnails/${createHash("sha256").update(bytes).digest("hex")}.jpg`;
  await storage.put(key, bytes, "image/jpeg");
  return key;
}

/** Lock the job and assert this worker still owns it. */
async function ownedRunning(tx: Tx, id: string, workerId: string): Promise<Generation> {
  const gen = await getGeneration(tx, id, { lock: true });
  if (gen.status !== "running" || gen.workerId !== workerId) {
    fail(409, `job is ${gen.status}${gen.workerId && gen.workerId !== workerId ? " by another worker" : ""}; stop`);
  }
  return gen;
}
