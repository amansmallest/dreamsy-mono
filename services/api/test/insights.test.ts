import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { strToU8, zipSync } from "fflate";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { type Config, type IdentityVerifier } from "../src/context.js";
import { schema, type DB } from "../src/db/client.js";
import { MemoryStorage } from "../src/storage.js";

const config: Config = {
  jwtSecret: "test-secret-test-secret-test-secret-123",
  workerToken: "worker-token",
  dailyGenerationQuota: 50,
  leaseSeconds: 60,
  maxAttempts: 1,
  ssePollMs: 10,
  starterStars: 500,
  creatorShare: 0.5,
  playPrice: 10000,
  playPassMinutes: 30,
  createPrice: 0, // pricing of builds/remixes is covered in notifications.test.ts
  remixPrice: 0,
};
const identity: IdentityVerifier = { async verify() { throw new Error("unused"); } };

let db: DB;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  const d = drizzle(new PGlite(), { schema });
  await migrate(d, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
  db = d as unknown as DB;
  app = createApp({ db, storage: new MemoryStorage(), config, identity });
});

async function call(method: string, path: string, opts: { token?: string; json?: unknown; form?: FormData } = {}) {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let body: BodyInit | undefined;
  if (opts.json !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(opts.json); }
  else if (opts.form) body = opts.form;
  const res = await app.request(path, { method, headers, body });
  const text = await res.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch {}
  return { status: res.status, data };
}

const W = { token: config.workerToken };
const guest = async () => (await call("POST", "/v1/auth/guest")).data.token as string;
const zip = () => zipSync({
  "dreamsy.toml": strToU8('format = "0"\nname = "T"\ndimension = "2d"\nentry_scene = "scenes/main.scene.json"\n[server]\nmode = "none"\n'),
  "scenes/main.scene.json": strToU8(JSON.stringify({ format: "0", root: "world", entities: { world: { type: "Node2D" } } })),
});

const metrics = (over: Record<string, unknown> = {}) => ({
  costUsd: 1.5, rounds: 1, turns: 12, minutes: 4, artScore: 7, artVerdict: "ship", playtestRuns: 3, runtimeErrorsFixed: 1,
  finalGatePassedFirstTry: true, memoryHits: 4, spritesReused: 1, spritesDrawn: 3, kit: "platformer", pack: "cozy", kind: "new_game",
  memoryIds: ["lesson_a", "lesson_b"], ...over,
});

/** One generation through the worker protocol: claim → metrics event → complete | fail. */
async function build(token: string, m: Record<string, unknown> | null, outcome: "complete" | "fail" = "complete") {
  const { data: g } = await call("POST", "/v1/games", { token, json: { name: "G" } });
  const { data: gen } = await call("POST", `/v1/games/${g.game.id}/generations`, { token, json: { prompt: "make a platformer" } });
  const claim = await call("POST", "/v1/worker/claim", { ...W, json: { workerId: "w" } });
  expect(claim.data.generation.id).toBe(gen.generation.id);
  if (m) {
    const ev = await call("POST", `/v1/worker/generations/${gen.generation.id}/events`, { ...W, json: { workerId: "w", type: "metrics", data: m } });
    expect(ev.status).toBe(200);
  }
  if (outcome === "complete") {
    const f = new FormData();
    f.set("workerId", "w");
    f.set("summary", "ok");
    f.set("package", new File([zip() as Uint8Array<ArrayBuffer>], "game.zip", { type: "application/zip" }));
    expect((await call("POST", `/v1/worker/generations/${gen.generation.id}/complete`, { ...W, form: f })).status).toBe(201);
  } else {
    expect((await call("POST", `/v1/worker/generations/${gen.generation.id}/fail`, { ...W, json: { workerId: "w", error: "nope" } })).status).toBe(200);
  }
  return { genId: gen.generation.id as string, gameId: g.game.id as string, claim: claim.data };
}

describe("insights", () => {
  it("claim carries userId + remixOf for memory scoping", async () => {
    const t = await guest();
    const me = (await call("GET", "/v1/me", { token: t })).data.user.id;
    const { claim } = await build(t, null);
    expect(claim.generation.userId).toBe(me);
    expect(claim.game.remixOf).toBeNull();
  });

  it("metrics event is validated and stored on the generation", async () => {
    const t = await guest();
    const { genId } = await build(t, metrics());
    const [row] = await db.select().from(schema.generations).where(eq(schema.generations.id, genId));
    expect(row!.metrics).toMatchObject({ costUsd: 1.5, artScore: 7, kit: "platformer", memoryIds: ["lesson_a", "lesson_b"] });

    // malformed metrics → 400, nothing stored
    const { data: g } = await call("POST", "/v1/games", { token: t, json: { name: "G2" } });
    const { data: gen } = await call("POST", `/v1/games/${g.game.id}/generations`, { token: t, json: { prompt: "x" } });
    await call("POST", "/v1/worker/claim", { ...W, json: { workerId: "w" } });
    const bad = await call("POST", `/v1/worker/generations/${gen.generation.id}/events`, { ...W, json: { workerId: "w", type: "metrics", data: { costUsd: -1 } } });
    expect(bad.status).toBe(400);
  });

  it("/v1/me/insights aggregates the caller's builds; /v1/insights/engine aggregates everyone's", async () => {
    const a = await guest();
    const b = await guest();
    await build(a, metrics({ artScore: 6, costUsd: 2, minutes: 5, memoryHits: 2, spritesReused: 0, spritesDrawn: 4 }));
    await build(a, metrics({ artScore: 8, costUsd: 1, minutes: 3, memoryHits: 6, spritesReused: 2, spritesDrawn: 2, kit: "rpg", finalGatePassedFirstTry: false }));
    await build(a, metrics({ artScore: null, artVerdict: null, kit: null }), "fail");
    await build(a, null); // succeeded without metrics: counted, not averaged
    await build(b, metrics({ artScore: 10, costUsd: 4, kit: "rpg" }));

    const mine = await call("GET", "/v1/me/insights?days=7", { token: a });
    expect(mine.status).toBe(200);
    expect(mine.data.days).toBe(7);
    expect(mine.data.daily).toHaveLength(7);
    const today = mine.data.daily.at(-1);
    expect(today).toEqual({
      date: new Date().toISOString().slice(0, 10),
      builds: 4, succeeded: 3, failed: 1,
      avgArtScore: 7, avgCostUsd: 1.5, avgMinutes: 4, avgMemoryHits: 4,
      spritesReusedPct: 25, // reused (0+2+1) / (reused 3 + drawn 4+2+3) = 3/12
    });
    expect(mine.data.daily[0]).toMatchObject({ builds: 0, succeeded: 0, failed: 0, avgArtScore: null, spritesReusedPct: null });
    expect(mine.data.byKit).toEqual([
      { kit: "none", builds: 1, avgArtScore: null, avgCostUsd: 1.5 },
      { kit: "platformer", builds: 1, avgArtScore: 6, avgCostUsd: 2 },
      { kit: "rpg", builds: 1, avgArtScore: 8, avgCostUsd: 1 },
    ]);
    expect(mine.data.totals).toMatchObject({
      builds: 4, succeeded: 3, failed: 1, withMetrics: 3, successRatePct: 75, totalCostUsd: 4.5,
      memoryHits: 12, spritesReused: 3, spritesDrawn: 9, finalGateFirstTryPct: 66.7,
    });

    const engine = await call("GET", "/v1/insights/engine", { token: b });
    expect(engine.data.days).toBe(30);
    expect(engine.data.totals).toMatchObject({ builds: 5, succeeded: 4, failed: 1, avgArtScore: 8 });
    expect(engine.data.byKit[0]).toEqual({ kit: "rpg", builds: 2, avgArtScore: 9, avgCostUsd: 2.5 });
    expect(JSON.stringify(engine.data)).not.toContain("make a platformer"); // no prompts / user data

    expect((await call("GET", "/v1/me/insights?days=0", { token: a })).status).toBe(400);
    expect((await call("GET", "/v1/insights/engine")).status).toBe(401);
  });
});
