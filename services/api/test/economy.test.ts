import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq, sql } from "drizzle-orm";
import { strFromU8, strToU8, zipSync } from "fflate";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { fail, type Config, type IdentityVerifier } from "../src/context.js";
import { schema, type DB } from "../src/db/client.js";
import { PLATFORM_USER_ID } from "../src/db/schema.js";
import { MemoryStorage } from "../src/storage.js";

/** DREAMSY.MD §11.6 pay-per-play coins economy. */

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
  createPrice: 0, // pricing of builds/remixes is covered in notifications.test.ts
  remixPrice: 0,
};
const identity: IdentityVerifier = { async verify() { fail(401, "unused"); } };
const MIGRATIONS = fileURLToPath(new URL("../migrations", import.meta.url));

let db: DB;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  const d = drizzle(new PGlite(), { schema });
  await migrate(d, { migrationsFolder: MIGRATIONS });
  db = d as unknown as DB;
  app = createApp({ db, storage: new MemoryStorage(), config, identity });
});
afterEach(() => { vi.useRealTimers(); });

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

function makePackage(m: string) {
  return zipSync({
    "dreamsy.toml": strToU8(m),
    "scenes/main.scene.json": strToU8(JSON.stringify({ format: "0", root: "world", entities: { world: { type: "Node2D" } } })),
  });
}

async function makeGame(token: string, name: string, publish = true) {
  const { data: g } = await call("POST", "/v1/games", { token, json: { name } });
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
const platformBalance = async () =>
  (await db.select().from(schema.wallets).where(eq(schema.wallets.userId, PLATFORM_USER_ID)))[0]!.balance;

describe("pay-per-play", () => {
  it("charges 10k, splits 9k/1k, ledger sums to zero, shows in earnings, wallet and views", async () => {
    const creator = await guest();
    const player = await guest();
    const gameId = await makeGame(creator.token, "Coin Run");

    const w = (await call("GET", "/v1/me/wallet", { token: player.token })).data.wallet;
    expect(w).toEqual({ balance: 1_000_000, currency: "coins", usd: 10, createPrice: 0 });
    expect((await call("GET", `/v1/games/${gameId}`, { token: player.token })).data.game.playPrice).toBe(10_000);
    const feed = await call("GET", "/v1/feed?tab=new", { token: player.token });
    expect(feed.data.games[0].playPrice).toBe(10_000);

    const quote = await call("GET", `/v1/games/${gameId}/play`, { token: player.token });
    expect(quote.data).toMatchObject({ free: false, reason: null, price: 10_000, pass: null });

    const r = await play(player.token, gameId);
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ charged: true, price: 10_000, balance: 990_000, creatorEarned: 9_000 });
    expect(r.data.pass.id).toMatch(/^pp_/);
    expect(new Date(r.data.pass.expiresAt).getTime() - Date.now()).toBeGreaterThan(29 * 60_000);

    expect(await balanceOf(player.token)).toBe(990_000);
    expect(await balanceOf(creator.token)).toBe(1_009_000);
    expect(await platformBalance()).toBe(1_000);

    const entries = await db.select().from(schema.ledger).where(eq(schema.ledger.passId, r.data.pass.id));
    expect(entries.map((e) => [e.kind, e.delta]).sort()).toEqual([["platform_fee", 1_000], ["play", -10_000], ["play_earning", 9_000]]);
    expect(entries.reduce((s, e) => s + e.delta, 0)).toBe(0);

    // counted once as a play, even if an old client also calls POST /plays
    expect((await call("POST", `/v1/games/${gameId}/plays`, { token: player.token, json: { version: 1 } })).data.counted).toBe(false);
    expect((await call("GET", `/v1/games/${gameId}`, { token: player.token })).data.game.stats.plays).toBe(1);

    const earnings = await call("GET", "/v1/me/earnings", { token: creator.token });
    expect(earnings.data).toEqual({
      totalCoins: 9_000, todayCoins: 9_000, paidPlays: 1,
      usd: { total: 0.09, today: 0.09 },
      games: [{ gameId, name: "Coin Run", coins: 9_000, plays: 1 }],
    });
    expect((await call("GET", "/v1/me/insights", { token: creator.token })).data.earnings.totalCoins).toBe(9_000);
  });

  it("is free for the owner", async () => {
    const creator = await guest();
    const gameId = await makeGame(creator.token, "Mine");
    const r = await play(creator.token, gameId);
    expect(r.data).toMatchObject({ charged: false, price: 10_000, balance: 1_000_000, creatorEarned: 0 });
    expect(r.data.pass.id).toBeTruthy();
    expect((await call("GET", `/v1/games/${gameId}/play`, { token: creator.token })).data).toMatchObject({ free: true, reason: "owner" });
    expect(await platformBalance()).toBe(0);
  });

  it("reuses the pass within 30 minutes and charges again after it expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const creator = await guest();
    const player = await guest();
    const gameId = await makeGame(creator.token, "Again");

    const first = await play(player.token, gameId);
    expect(first.data.charged).toBe(true);

    vi.setSystemTime(Date.now() + 29 * 60_000);
    const replay = await play(player.token, gameId);
    expect(replay.data).toMatchObject({ charged: false, balance: 990_000, creatorEarned: 0, pass: first.data.pass });
    expect((await call("GET", `/v1/games/${gameId}/play`, { token: player.token })).data).toMatchObject({ free: true, reason: "pass" });

    vi.setSystemTime(Date.now() + 2 * 60_000); // 31 minutes after the first start
    const later = await play(player.token, gameId);
    expect(later.data).toMatchObject({ charged: true, balance: 980_000, creatorEarned: 9_000 });
    expect(later.data.pass.id).not.toBe(first.data.pass.id);
    expect(await balanceOf(creator.token)).toBe(1_018_000);
  });

  it("402s with insufficient_coins when broke", async () => {
    const creator = await guest();
    const player = await guest();
    const gameId = await makeGame(creator.token, "Pricey");
    await call("GET", "/v1/me/wallet", { token: player.token }); // create the wallet
    await db.update(schema.wallets).set({ balance: 9_999 }).where(eq(schema.wallets.userId, player.id));

    const r = await play(player.token, gameId);
    expect(r.status).toBe(402);
    expect(r.data).toEqual({ error: "insufficient_coins", balance: 9_999, price: 10_000 });
    expect(await balanceOf(player.token)).toBe(9_999);
    expect(await balanceOf(creator.token)).toBe(1_000_000);
    expect(await db.select().from(schema.playPasses)).toEqual([]);
  });

  it("two simultaneous starts charge once", async () => {
    const creator = await guest();
    const player = await guest();
    const gameId = await makeGame(creator.token, "Race");
    const [a, b] = await Promise.all([play(player.token, gameId), play(player.token, gameId)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.data.charged, b.data.charged].filter(Boolean)).toHaveLength(1);
    expect(a.data.pass.id).toBe(b.data.pass.id);
    expect(await balanceOf(player.token)).toBe(990_000);
    expect(await balanceOf(creator.token)).toBe(1_009_000);
    expect(await platformBalance()).toBe(1_000);
  });

  it("drafts shared to a group are free for members; unshared drafts are 404", async () => {
    const mom = await guest();
    const kid = await guest();
    const stranger = await guest();
    const gameId = await makeGame(mom.token, "Draft", false);
    const grp = await call("POST", "/v1/groups", { token: mom.token, json: { name: "Fam" } });
    await call("POST", "/v1/groups/join", { token: kid.token, json: { code: grp.data.inviteCode } });
    expect((await play(kid.token, gameId)).status).toBe(404);
    expect((await call("POST", `/v1/groups/${grp.data.group.id}/games`, { token: mom.token, json: { gameId } })).status).toBe(201);

    const r = await play(kid.token, gameId);
    expect(r.data).toMatchObject({ charged: false, balance: 1_000_000, creatorEarned: 0 });
    expect((await play(stranger.token, gameId)).status).toBe(404);
    expect(await balanceOf(mom.token)).toBe(1_000_000);
  });

  it("store purchases split 90/10 with the platform", async () => {
    const creator = await guest();
    const player = await guest();
    const { data: g } = await call("POST", "/v1/games", { token: creator.token, json: { name: "Shop" } });
    const gen = await call("POST", `/v1/games/${g.game.id}/generations`, { token: creator.token, json: { prompt: "x" } });
    await call("POST", "/v1/worker/claim", { ...W, json: { workerId: "w1" } });
    const f = new FormData();
    f.set("workerId", "w1");
    f.set("package", new File([makePackage(manifest("Shop") + '[[store]]\nid = "vip"\nkind = "pass"\nname = "VIP"\nprice = 1000\n') as Uint8Array<ArrayBuffer>], "g.zip", { type: "application/zip" }));
    await call("POST", `/v1/worker/generations/${gen.data.generation.id}/complete`, { ...W, form: f });
    await call("POST", `/v1/games/${g.game.id}/publish`, { token: creator.token, json: {} });
    const p = await call("POST", `/v1/games/${g.game.id}/store/purchase`, { token: player.token, json: { itemId: "vip", idempotencyKey: crypto.randomUUID() } });
    expect(p.status).toBe(201);
    expect(await balanceOf(creator.token)).toBe(1_000_900);
    expect(await platformBalance()).toBe(100);
    const e = (await call("GET", "/v1/me/earnings", { token: creator.token })).data;
    expect(e).toMatchObject({ totalCoins: 900, paidPlays: 0, games: [{ gameId: g.game.id, coins: 900, plays: 0 }] });
  });
});

describe("migration 0011_pay_per_play", () => {
  it("tops existing wallets up to 1,000,000 with a grant entry and seeds the platform account", async () => {
    // Apply migrations up to 0010 only, seed old-economy data, then apply the rest.
    const dir = mkdtempSync(join(tmpdir(), "dreamsy-mig-"));
    try {
      cpSync(MIGRATIONS, dir, { recursive: true });
      const journalPath = join(dir, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8"));
      journal.entries = journal.entries.filter((e: { tag: string }) => e.tag < "0011");
      writeFileSync(journalPath, JSON.stringify(journal));

      const d = drizzle(new PGlite(), { schema });
      await migrate(d, { migrationsFolder: dir });
      await d.execute(sql`insert into users (id, handle) values ('u_poor', 'poor'), ('u_rich', 'rich'), ('u_none', 'none')`);
      await d.execute(sql`insert into wallets (user_id, balance) values ('u_poor', 450), ('u_rich', 2000000)`);
      await d.execute(sql`insert into ledger (user_id, delta, balance_after, kind) values ('u_poor', 500, 500, 'starter_grant'), ('u_poor', -50, 450, 'purchase'), ('u_rich', 2000000, 2000000, 'starter_grant')`);

      await migrate(d, { migrationsFolder: MIGRATIONS });
      const wallets = await d.select().from(schema.wallets);
      const by = (id: string) => wallets.find((w) => w.userId === id)?.balance;
      expect([by("u_poor"), by("u_rich"), by(PLATFORM_USER_ID), by("u_none")]).toEqual([1_000_000, 2_000_000, 0, undefined]);

      const grants = await d.select().from(schema.ledger).where(eq(schema.ledger.kind, "grant"));
      expect(grants.map((g) => [g.userId, g.delta, g.balanceAfter])).toEqual([["u_poor", 999_550, 1_000_000]]);
      const poorSum = (await d.select().from(schema.ledger).where(eq(schema.ledger.userId, "u_poor"))).reduce((s, e) => s + e.delta, 0);
      expect(poorSum).toBe(1_000_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("spin-off royalties (one level)", () => {
  const remix = async (token: string, gameId: string) => {
    const r = await call("POST", `/v1/games/${gameId}/remix`, { token, json: {} });
    expect(r.status).toBe(201);
    const id = r.data.game.id as string;
    expect((await call("POST", `/v1/games/${id}/publish`, { token, json: {} })).status).toBe(200);
    return id;
  };
  const earned = async (token: string) => (await call("GET", "/v1/me/earnings", { token })).data.totalCoins as number;

  it("pays the direct parent's owner 1K out of the creator's share; grandparents get nothing", async () => {
    const original = await guest(), spin = await guest(), spin2 = await guest(), player = await guest();
    const base = await makeGame(original.token, "Orb Duel");
    const s1 = await remix(spin.token, base);        // spin-off of Orb Duel
    const s2 = await remix(spin2.token, s1);         // spin-off of the spin-off

    const r1 = await play(player.token, s1);
    expect(r1.data).toMatchObject({ charged: true, creatorEarned: 8_000 });
    const rows1 = await db.select().from(schema.ledger).where(eq(schema.ledger.passId, r1.data.pass.id));
    expect(rows1.map((e) => [e.kind, e.delta]).sort()).toEqual([["platform_fee", 1_000], ["play", -10_000], ["play_earning", 8_000], ["royalty", 1_000]]);
    expect(rows1.reduce((s, e) => s + e.delta, 0)).toBe(0);
    expect(await earned(original.token)).toBe(1_000);
    expect(await earned(spin.token)).toBe(8_000);

    const r2 = await play(player.token, s2);
    expect(r2.data.creatorEarned).toBe(8_000);
    expect(await earned(spin.token)).toBe(9_000);      // +1K royalty as the new "original"
    expect(await earned(original.token)).toBe(1_000);  // grandparent: nothing more
    expect(await earned(spin2.token)).toBe(8_000);

    const notes = (await call("GET", "/v1/me/notifications", { token: original.token })).data.items;
    expect(notes.some((n: { kind: string; body: string }) => n.kind === "royalty" && n.body.includes("spin-off of your Orb Duel"))).toBe(true);
  });

  it("no royalty when you spin off your own game", async () => {
    const owner = await guest(), player = await guest();
    const base = await makeGame(owner.token, "Solo");
    const s = await remix(owner.token, base);
    const r = await play(player.token, s);
    expect(r.data.creatorEarned).toBe(9_000);
    expect(await earned(owner.token)).toBe(9_000);
  });
});
