import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq, sql } from "drizzle-orm";
import { strFromU8, strToU8, zipSync } from "fflate";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { fail, type Config, type IdentityVerifier } from "../src/context.js";
import { schema, type DB } from "../src/db/client.js";
import type { LiveFetcher, LiveRoom, LiveSnapshot } from "../src/presence.js";
import { DEFAULT_ONBOARDING_GAME_ID, ONBOARDING_MESSAGE } from "../src/routes/onboarding.js";
import { MemoryStorage } from "../src/storage.js";

/** Guided first experience: onboarding flag, free onboarding play, GET /v1/onboarding, GET /v1/live. */

const config: Config = {
  jwtSecret: "test-secret-test-secret-test-secret-123",
  workerToken: "worker-token",
  dailyGenerationQuota: 100,
  leaseSeconds: 60,
  maxAttempts: 2,
  ssePollMs: 10,
  starterStars: 1_000_000,
  creatorShare: 0.9,
  playPrice: 10_000,
  playPassMinutes: 30,
  createPrice: 0,
  remixPrice: 0,
};
const identity: IdentityVerifier = { async verify() { fail(401, "unused"); } };
const MIGRATIONS = fileURLToPath(new URL("../migrations", import.meta.url));

let db: DB;
let app: ReturnType<typeof createApp>;
let snapshot: LiveSnapshot;
let liveFails: "throw" | "hang" | "junk" | null;
let liveCalls: number;
const live: LiveFetcher = async () => {
  liveCalls++;
  if (liveFails === "throw") throw new Error("down");
  if (liveFails === "hang") return new Promise<never>(() => {});
  if (liveFails === "junk") return { nope: true } as never;
  return structuredClone(snapshot);
};

beforeEach(async () => {
  const d = drizzle(new PGlite(), { schema });
  await migrate(d, { migrationsFolder: MIGRATIONS });
  db = d as unknown as DB;
  delete config.onboardingGameId;
  snapshot = { online: 0, rooms: [] };
  liveFails = null;
  liveCalls = 0;
  app = createApp({ db, storage: new MemoryStorage(), config, identity, live });
});

async function call(method: string, path: string, opts: { token?: string; json?: unknown; form?: FormData } = {}) {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let body: BodyInit | undefined;
  if (opts.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.json);
  } else if (opts.form) body = opts.form;
  const res = await app.request(path, { method, headers, body });
  const text = strFromU8(new Uint8Array(await res.arrayBuffer()));
  let data: any = text;
  try { data = JSON.parse(text); } catch {}
  return { status: res.status, data };
}

async function guest() {
  const { data } = await call("POST", "/v1/auth/guest");
  return { token: data.token as string, id: data.user.id as string };
}

const W = { token: config.workerToken };
const manifest = (name: string) => `format = "0"\nname = "${name}"\ndimension = "2d"\nentry_scene = "scenes/main.scene.json"\n[server]\nmode = "none"\n`;
const makePackage = (m: string) => zipSync({
  "dreamsy.toml": strToU8(m),
  "scenes/main.scene.json": strToU8(JSON.stringify({ format: "0", root: "world", entities: { world: { type: "Node2D" } } })),
});

async function makeGame(token: string, name: string, publish = true) {
  const { data: g } = await call("POST", "/v1/games", { token, json: { name, visibility: "private" } });
  const gen = await call("POST", `/v1/games/${g.game.id}/generations`, { token, json: { prompt: "make it" } });
  await call("POST", "/v1/worker/claim", { ...W, json: { workerId: "w1" } });
  const f = new FormData();
  f.set("workerId", "w1");
  f.set("summary", "built");
  f.set("package", new File([makePackage(manifest(name)) as Uint8Array<ArrayBuffer>], "game.zip", { type: "application/zip" }));
  expect((await call("POST", `/v1/worker/generations/${gen.data.generation.id}/complete`, { ...W, form: f })).status).toBe(201);
  if (publish) expect((await call("POST", `/v1/games/${g.game.id}/publish`, { token, json: {} })).status).toBe(200);
  return g.game.id as string;
}

const play = (token: string, gameId: string) => call("POST", `/v1/games/${gameId}/play`, { token });
const balanceOf = async (token: string) => (await call("GET", "/v1/me/wallet", { token })).data.wallet.balance as number;

describe("onboarding flag", () => {
  it("new accounts start with onboardedAt null; POST /v1/me/onboarding stamps it once", async () => {
    const u = await guest();
    expect((await call("GET", "/v1/me", { token: u.token })).data.user.onboardedAt).toBeNull();
    expect((await call("POST", "/v1/me/onboarding", { token: u.token, json: { done: false } })).status).toBe(400);
    expect((await call("POST", "/v1/me/onboarding", { json: { done: true } })).status).toBe(401);
    const r = await call("POST", "/v1/me/onboarding", { token: u.token, json: { done: true } });
    expect(r.status).toBe(200);
    expect(r.data.user.id).toBe(u.id);
    const at = r.data.user.onboardedAt as string;
    expect(Date.now() - new Date(at).getTime()).toBeLessThan(10_000);
    expect((await call("GET", "/v1/me", { token: u.token })).data.user.onboardedAt).toBe(at);
    // idempotent: keeps the first timestamp
    expect((await call("POST", "/v1/me/onboarding", { token: u.token, json: { done: true } })).data.user.onboardedAt).toBe(at);
  });

  it("migration 0014 marks existing accounts onboarded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dreamsy-mig-"));
    try {
      cpSync(MIGRATIONS, dir, { recursive: true });
      const journalPath = join(dir, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8"));
      journal.entries = journal.entries.filter((e: { tag: string }) => e.tag < "0014");
      writeFileSync(journalPath, JSON.stringify(journal));
      const d = drizzle(new PGlite(), { schema });
      await migrate(d, { migrationsFolder: dir });
      await d.execute(sql`insert into users (id, handle) values ('u_old', 'old')`);
      await migrate(d, { migrationsFolder: MIGRATIONS });
      await d.execute(sql`insert into users (id, handle) values ('u_new', 'new')`);
      const rows = await d.select().from(schema.users);
      const by = (id: string) => rows.find((u) => u.id === id)!;
      expect(by("u_old").onboardedAt).toBeInstanceOf(Date);
      expect(by("u_new").onboardedAt).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("GET /v1/onboarding", () => {
  it("returns the configured published game; 404 when it's missing or unpublished", async () => {
    const u = await guest();
    expect((await call("GET", "/v1/onboarding")).status).toBe(401);
    expect((await call("GET", "/v1/onboarding", { token: u.token })).status).toBe(404); // default id doesn't exist here
    const creator = await guest();
    const draft = await makeGame(creator.token, "Draft Dash", false);
    config.onboardingGameId = draft;
    expect((await call("GET", "/v1/onboarding", { token: u.token })).status).toBe(404);
    const gameId = await makeGame(creator.token, "Tidal Dash");
    config.onboardingGameId = gameId;
    const r = await call("GET", "/v1/onboarding", { token: u.token });
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ gameId, gameName: "Tidal Dash", version: 1, message: ONBOARDING_MESSAGE });
    expect(DEFAULT_ONBOARDING_GAME_ID).toBe("g_01m7ggga6ks9nt0ce6chvtnav3");
  });
});

describe("free onboarding play", () => {
  it("is free (reason onboarding) until onboarding is done, then charges normally", async () => {
    const creator = await guest();
    const gameId = await makeGame(creator.token, "Tidal Dash");
    const other = await makeGame(creator.token, "Not Onboarding");
    config.onboardingGameId = gameId;
    const u = await guest();

    expect((await call("GET", `/v1/games/${gameId}/play`, { token: u.token })).data).toMatchObject({ free: true, reason: "onboarding" });
    const first = await play(u.token, gameId);
    expect(first.status).toBe(200);
    expect(first.data).toMatchObject({ charged: false, reason: "onboarding", balance: 1_000_000, creatorEarned: 0 });
    expect(await balanceOf(u.token)).toBe(1_000_000);
    // other games still cost coins for a new account
    expect((await play(u.token, other)).data).toMatchObject({ charged: true, reason: null });

    await call("POST", "/v1/me/onboarding", { token: u.token, json: { done: true } });
    expect((await call("GET", `/v1/games/${gameId}/play`, { token: u.token })).data).toMatchObject({ free: false, reason: null });
    // the free onboarding pass is not reused for a paid start
    const paid = await play(u.token, gameId);
    expect(paid.data).toMatchObject({ charged: true, reason: null, price: 10_000, creatorEarned: 9_000 });
    expect(paid.data.pass.id).not.toBe(first.data.pass.id);
    expect(await balanceOf(u.token)).toBe(1_000_000 - 20_000);
  });

  it("existing (onboarded) users pay for the onboarding game", async () => {
    const creator = await guest();
    const gameId = await makeGame(creator.token, "Tidal Dash");
    config.onboardingGameId = gameId;
    const u = await guest();
    await db.update(schema.users).set({ onboardedAt: new Date() }).where(eq(schema.users.id, u.id));
    expect((await play(u.token, gameId)).data).toMatchObject({ charged: true });
  });
});

describe("GET /v1/live", () => {
  const room = (r: Partial<LiveRoom> & Pick<LiveRoom, "code" | "gameId" | "players">): LiveRoom =>
    ({ mode: "party", state: "lobby", max: 4, spectators: 0, spectatable: true, ...r });

  it("one entry per other player: lobbies with space, then running matches, then full lobbies", async () => {
    const creator = await guest();
    const g1 = await makeGame(creator.token, "Duel Game");
    const g2 = await makeGame(creator.token, "Party Game");
    const hiddenDraft = await makeGame(creator.token, "Secret Draft", false);
    const [me, a, b, c, d, e] = [await guest(), await guest(), await guest(), await guest(), await guest(), await guest()];
    await db.update(schema.users).set({ handle: "alice", avatar: { hair: 2 } }).where(eq(schema.users.id, a.id));
    snapshot = {
      online: 9,
      rooms: [
        room({ code: "RUN111", gameId: g1, mode: "duel", state: "running", players: [b.id, c.id], max: 2, spectators: 1 }),
        room({ code: "FULL22", gameId: g2, players: [d.id, e.id], max: 2, spectatable: false }),
        room({ code: "LOB333", gameId: g2, players: [a.id, me.id], max: 4 }),
        room({ code: "DRAFT4", gameId: hiddenDraft, players: [e.id], max: 4 }),
        room({ code: "GHOST5", gameId: g2, players: ["u_deleted"], max: 4 }),
      ],
    };
    const r = await call("GET", "/v1/live", { token: me.token });
    expect(r.status).toBe(200);
    expect(r.data.online).toBe(9);
    expect(r.data.playing.map((p: any) => [p.user.id, p.roomCode])).toEqual([
      [a.id, "LOB333"], [b.id, "RUN111"], [c.id, "RUN111"], [d.id, "FULL22"], [e.id, "FULL22"],
    ]);
    expect(r.data.playing[0]).toEqual({
      user: { id: a.id, handle: "alice", avatar: { hair: 2 } }, gameId: g2, gameName: "Party Game", mode: "party",
      players: 2, max: 4, roomCode: "LOB333", status: "in_room", spectatable: true, joinable: true,
    });
    expect(r.data.playing[1]).toMatchObject({ gameName: "Duel Game", mode: "duel", players: 2, max: 2, status: "in_match", spectatable: true, joinable: false });
    expect(r.data.playing[3]).toMatchObject({ status: "in_room", spectatable: false, joinable: false });
    // featured: published games by trending (drafts excluded), at most 6, as feed cards
    expect(r.data.featured.map((g: any) => g.name).sort()).toEqual(["Duel Game", "Party Game"]);
    expect(r.data.featured[0]).toHaveProperty("viewer");
  });

  it("caps at 30 entries and features at most 6 games", async () => {
    const creator = await guest();
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push(await makeGame(creator.token, `Game ${i}`));
    const players: string[] = [];
    for (let i = 0; i < 8; i++) players.push((await guest()).id);
    snapshot = { online: 40, rooms: [0, 1, 2, 3].map((i) => room({ code: `ROOM${i}0`, gameId: ids[i]!, players, max: 8 })) };
    const r = await call("GET", "/v1/live", { token: (await guest()).token });
    expect(r.data.playing).toHaveLength(30);
    expect(r.data.featured).toHaveLength(6);
  }, 30_000);

  it("room server down, slow or junk: online 0, no players, featured still returned", async () => {
    const creator = await guest();
    await makeGame(creator.token, "Still Featured");
    const u = await guest();
    for (const mode of ["throw", "junk", "hang"] as const) {
      liveFails = mode;
      const t0 = Date.now();
      const r = await call("GET", "/v1/live", { token: u.token });
      expect(r.status).toBe(200);
      expect(r.data.online).toBe(0);
      expect(r.data.playing).toEqual([]);
      expect(r.data.featured.map((g: any) => g.name)).toEqual(["Still Featured"]);
      if (mode === "hang") expect(Date.now() - t0).toBeLessThan(3_000);
    }
    expect(liveCalls).toBe(3);
    expect((await call("GET", "/v1/live")).status).toBe(401);
  }, 30_000);
});
