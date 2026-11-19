import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { strFromU8, strToU8, zipSync } from "fflate";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { fail, type Config, type IdentityVerifier, type PushMessage, type PushTicket } from "../src/context.js";
import { schema, type DB } from "../src/db/client.js";
import { PLATFORM_USER_ID } from "../src/db/schema.js";
import { flushPushes } from "../src/push.js";
import { MemoryStorage } from "../src/storage.js";

/** docs/platform.md §11.6: create/remix prices, refunds, notifications, Expo push. */

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
  createPrice: 100_000,
  remixPrice: 25_000,
};
const identity: IdentityVerifier = { async verify() { fail(401, "unused"); } };
const MIGRATIONS = fileURLToPath(new URL("../migrations", import.meta.url));

let db: DB;
let app: ReturnType<typeof createApp>;
let pushed: PushMessage[][];
/** What the fake Expo returns per message (default ok). */
let ticketFor: (m: PushMessage) => PushTicket;

beforeEach(async () => {
  const d = drizzle(new PGlite(), { schema });
  await migrate(d, { migrationsFolder: MIGRATIONS });
  db = d as unknown as DB;
  pushed = [];
  ticketFor = () => ({ status: "ok", id: "t" });
  app = createApp({
    db, storage: new MemoryStorage(), config, identity,
    pusher: async (messages) => { pushed.push(messages); return messages.map((m) => ticketFor(m)); },
  });
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
  return { token: data.token as string, id: data.user.id as string, handle: data.user.handle as string };
}

const W = { token: config.workerToken };
const manifest = (name: string) => `format = "0"\nname = "${name}"\ndimension = "2d"\nentry_scene = "scenes/main.scene.json"\n[server]\nmode = "none"\n`;
const pkgFile = (m: string) => new File([zipSync({
  "dreamsy.toml": strToU8(m),
  "scenes/main.scene.json": strToU8(JSON.stringify({ format: "0", root: "world", entities: { world: { type: "Node2D" } } })),
}) as Uint8Array<ArrayBuffer>], "game.zip", { type: "application/zip" });

function result(name: string, extra = "") {
  const f = new FormData();
  f.set("workerId", "w1");
  f.set("summary", "built");
  f.set("package", pkgFile(manifest(name) + extra));
  return f;
}

const newGame = async (token: string, name: string) => (await call("POST", "/v1/games", { token, json: { name } })).data.game.id as string;
const generate = (token: string, gameId: string) => call("POST", `/v1/games/${gameId}/generations`, { token, json: { prompt: "make it" } });
const claim = () => call("POST", "/v1/worker/claim", { ...W, json: { workerId: "w1" } });
const complete = (genId: string, name: string, extra = "") =>
  call("POST", `/v1/worker/generations/${genId}/complete`, { ...W, form: result(name, extra) });

async function makeGame(token: string, name: string, extra = "") {
  const gameId = await newGame(token, name);
  const gen = await generate(token, gameId);
  expect(gen.status).toBe(201);
  await claim();
  expect((await complete(gen.data.generation.id, name, extra)).status).toBe(201);
  expect((await call("POST", `/v1/games/${gameId}/publish`, { token, json: {} })).status).toBe(200);
  return gameId;
}

const balanceOf = async (token: string) => (await call("GET", "/v1/me/wallet", { token })).data.wallet.balance as number;
const platformBalance = async () =>
  (await db.select().from(schema.wallets).where(eq(schema.wallets.userId, PLATFORM_USER_ID)))[0]!.balance;
const inbox = async (token: string, q = "") => (await call("GET", `/v1/me/notifications${q}`, { token })).data;
const ledgerKinds = async (userId: string) =>
  (await db.select().from(schema.ledger).where(eq(schema.ledger.userId, userId))).map((e) => [e.kind, e.delta]);

describe("create price", () => {
  it("charges the first build to the platform and refunds it exactly once on final failure", async () => {
    const u = await guest();
    const quota = (await call("GET", "/v1/me/quota", { token: u.token })).data;
    expect(quota).toMatchObject({ createPrice: 100_000, remixPrice: 25_000, quota: { createPrice: 100_000 } });
    expect((await call("GET", "/v1/me/wallet", { token: u.token })).data).toMatchObject({ createPrice: 100_000, wallet: { createPrice: 100_000 } });

    const gameId = await newGame(u.token, "Orb Duel");
    const gen = await generate(u.token, gameId);
    expect(gen.status).toBe(201);
    expect(gen.data.charged).toBe(100_000);
    expect(gen.data.generation).toMatchObject({ charged: 100_000, refunded: false });
    expect(await balanceOf(u.token)).toBe(900_000);
    expect(await platformBalance()).toBe(100_000);

    // A retryable failure requeues: no refund yet.
    await claim();
    const id = gen.data.generation.id;
    await call("POST", `/v1/worker/generations/${id}/fail`, { ...W, json: { workerId: "w1", error: "flaky", retryable: true } });
    expect(await balanceOf(u.token)).toBe(900_000);

    await claim();
    const failed = await call("POST", `/v1/worker/generations/${id}/fail`, { ...W, json: { workerId: "w1", error: "boom" } });
    expect(failed.data.generation).toMatchObject({ status: "failed", charged: 100_000, refunded: true });
    expect(await balanceOf(u.token)).toBe(1_000_000);
    expect(await platformBalance()).toBe(0);

    // Canceling the terminal job (or failing again) refunds nothing more.
    await call("POST", `/v1/generations/${id}/cancel`, { token: u.token });
    expect((await call("POST", `/v1/worker/generations/${id}/fail`, { ...W, json: { workerId: "w1", error: "again" } })).status).toBe(409);
    expect(await balanceOf(u.token)).toBe(1_000_000);
    expect((await ledgerKinds(u.id)).filter(([k]) => k !== "starter_grant")).toEqual([["create", -100_000], ["create_refund", 100_000]]);
  });

  it("refunds on cancel with no version, once; not after a checkpoint made a version", async () => {
    const u = await guest();
    const a = await newGame(u.token, "A");
    const genA = await generate(u.token, a);
    expect(await balanceOf(u.token)).toBe(900_000);
    const c1 = await call("POST", `/v1/generations/${genA.data.generation.id}/cancel`, { token: u.token });
    expect(c1.data.generation).toMatchObject({ status: "canceled", refunded: true });
    await call("POST", `/v1/generations/${genA.data.generation.id}/cancel`, { token: u.token });
    expect(await balanceOf(u.token)).toBe(1_000_000);

    // Retry the first build: charged again; a checkpoint commits v1, then the job fails → kept.
    const genB = await generate(u.token, a);
    expect(genB.data.charged).toBe(100_000);
    await claim();
    const cp = await call("POST", `/v1/worker/generations/${genB.data.generation.id}/checkpoint`, { ...W, form: result("A") });
    expect(cp.status).toBe(201);
    await call("POST", `/v1/worker/generations/${genB.data.generation.id}/fail`, { ...W, json: { workerId: "w1", error: "late" } });
    expect(await balanceOf(u.token)).toBe(900_000);
  });

  it("402s when broke, without queueing; edits of a built game are free", async () => {
    const u = await guest();
    await balanceOf(u.token); // creates the wallet if it wasn't there yet
    await db.update(schema.wallets).set({ balance: 50_000 }).where(eq(schema.wallets.userId, u.id));
    const gameId = await newGame(u.token, "Broke");
    const r = await generate(u.token, gameId);
    expect(r.status).toBe(402);
    expect(r.data).toEqual({ error: "insufficient_coins", balance: 50_000, price: 100_000 });
    expect((await call("GET", `/v1/games/${gameId}/generations`, { token: u.token })).data.generations).toHaveLength(0);

    const rich = await guest();
    const built = await makeGame(rich.token, "Built");
    expect(await balanceOf(rich.token)).toBe(900_000);
    const edit = await generate(rich.token, built);
    expect(edit.status).toBe(201);
    expect(edit.data.charged).toBe(0);
    expect(await balanceOf(rich.token)).toBe(900_000);
  });
});

describe("remix price", () => {
  it("pays the original owner 100%, notifies them; own remix is free", async () => {
    const owner = await guest();
    const fan = await guest();
    const gameId = await makeGame(owner.token, "Orb Duel");
    expect((await call("GET", `/v1/games/${gameId}`, { token: fan.token })).data.game.remixPrice).toBe(25_000);
    const ownerBefore = await balanceOf(owner.token);

    const r = await call("POST", `/v1/games/${gameId}/remix`, { token: fan.token });
    expect(r.status).toBe(201);
    expect(r.data).toMatchObject({ charged: 25_000, ownerEarned: 25_000 });
    expect(await balanceOf(fan.token)).toBe(975_000);
    expect(await balanceOf(owner.token)).toBe(ownerBefore + 25_000);
    expect(await ledgerKinds(fan.id)).toContainEqual(["remix", -25_000]);
    expect(await ledgerKinds(owner.id)).toContainEqual(["remix_earning", 25_000]);

    const n = (await inbox(owner.token)).items.find((x: any) => x.kind === "remix_earning");
    expect(n).toMatchObject({
      title: "You got paid",
      body: `@${fan.handle} remixed Orb Duel — +25K coins ($0.25)`,
      data: { gameId, remixGameId: r.data.game.id, fromUserId: fan.id, coins: 25_000 },
      read: false,
    });
    expect((await inbox(fan.token)).items.filter((x: any) => x.kind === "remix_earning")).toHaveLength(0);

    const own = await call("POST", `/v1/games/${gameId}/remix`, { token: owner.token });
    expect(own.data).toMatchObject({ charged: 0, ownerEarned: 0 });
    expect(await balanceOf(owner.token)).toBe(ownerBefore + 25_000);
  });

  it("402s when the remixer can't pay", async () => {
    const owner = await guest();
    const fan = await guest();
    const gameId = await makeGame(owner.token, "Pricey");
    await balanceOf(fan.token);
    await db.update(schema.wallets).set({ balance: 1_000 }).where(eq(schema.wallets.userId, fan.id));
    const r = await call("POST", `/v1/games/${gameId}/remix`, { token: fan.token });
    expect(r.status).toBe(402);
    expect(r.data).toEqual({ error: "insufficient_coins", balance: 1_000, price: 25_000 });
  });
});

describe("notifications", () => {
  it("build_done on checkpoint v1 and on complete; play_earning per pass; list, unread, read", async () => {
    const owner = await guest();
    const player = await guest();
    const gameId = await newGame(owner.token, "Orb Duel");
    const gen = await generate(owner.token, gameId);
    await claim();
    await call("POST", `/v1/worker/generations/${gen.data.generation.id}/checkpoint`, { ...W, form: result("Orb Duel") });
    await complete(gen.data.generation.id, "Orb Duel");
    await call("POST", `/v1/games/${gameId}/publish`, { token: owner.token, json: {} });

    let box = await inbox(owner.token);
    expect(box.items.map((x: any) => [x.kind, x.title, x.body, x.data])).toEqual([
      ["build_done", "Your game is ready", "Orb Duel v2 is playable", { gameId, version: 2 }],
      ["build_done", "Your game is ready", "Orb Duel v1 is playable", { gameId, version: 1 }],
    ]);
    expect(box.unread).toBe(2);

    // Paid play → one notification; a replay inside the pass → none; owner's own play → none.
    await call("POST", `/v1/games/${gameId}/play`, { token: player.token });
    await call("POST", `/v1/games/${gameId}/play`, { token: player.token });
    await call("POST", `/v1/games/${gameId}/play`, { token: owner.token });
    box = await inbox(owner.token);
    const earn = box.items.filter((x: any) => x.kind === "play_earning");
    expect(earn).toHaveLength(1);
    expect(earn[0]).toMatchObject({
      title: "You got paid",
      body: `@${player.handle} played Orb Duel — +9K coins ($0.09)`,
      data: { gameId, fromUserId: player.id, coins: 9_000 },
    });
    expect(box.unread).toBe(3);
    expect((await call("GET", "/v1/me/notifications/unread", { token: owner.token })).data).toEqual({ unread: 3 });

    // Pagination.
    const p1 = await inbox(owner.token, "?limit=2");
    expect(p1.items).toHaveLength(2);
    expect(p1.next).toBe(p1.items[1].id);
    const p2 = await inbox(owner.token, `?limit=2&cursor=${p1.next}`);
    expect(p2.items).toHaveLength(1);
    expect(p2.next).toBeNull();

    // Read some, then all. Others' ids are ignored.
    const mine = (await call("POST", "/v1/me/notifications/read", { token: owner.token, json: { ids: [earn[0].id] } })).data;
    expect(mine).toEqual({ unread: 2 });
    expect((await inbox(owner.token)).items.find((x: any) => x.id === earn[0].id).read).toBe(true);
    expect((await call("POST", "/v1/me/notifications/read", { token: player.token, json: { all: true } })).data).toEqual({ unread: 0 });
    expect((await call("GET", "/v1/me/notifications/unread", { token: owner.token })).data.unread).toBe(2);
    expect((await call("POST", "/v1/me/notifications/read", { token: owner.token, json: { all: true } })).data).toEqual({ unread: 0 });
    expect((await call("POST", "/v1/me/notifications/read", { token: owner.token, json: {} })).status).toBe(400);
  });

  it("sale and group_join notifications", async () => {
    const owner = await guest();
    const buyer = await guest();
    const gameId = await makeGame(owner.token, "Shop", '[[store]]\nid = "vip"\nkind = "pass"\nname = "VIP"\nprice = 1000\n');
    await call("POST", `/v1/games/${gameId}/store/purchase`, { token: buyer.token, json: { itemId: "vip", idempotencyKey: crypto.randomUUID() } });
    const sale = (await inbox(owner.token)).items.find((x: any) => x.kind === "sale");
    expect(sale).toMatchObject({ title: "You got paid", body: `@${buyer.handle} bought VIP in Shop — +900 coins`, data: { gameId, itemId: "vip", coins: 900 } });

    const g = (await call("POST", "/v1/groups", { token: owner.token, json: { name: "Singhs" } })).data.group;
    await call("POST", "/v1/groups/join", { token: buyer.token, json: { code: g.inviteCode } });
    await call("POST", "/v1/groups/join", { token: buyer.token, json: { code: g.inviteCode } }); // idempotent: no second
    const joins = (await inbox(owner.token)).items.filter((x: any) => x.kind === "group_join");
    expect(joins).toHaveLength(1);
    expect(joins[0]).toMatchObject({ title: "New family member", body: `@${buyer.handle} joined Singhs`, data: { groupId: g.id } });
    expect((await inbox(buyer.token)).items.filter((x: any) => x.kind === "group_join")).toHaveLength(0);
  });
});

describe("push", () => {
  it("sends Expo messages with title/body/badge/data after commit; drops DeviceNotRegistered tokens", async () => {
    const owner = await guest();
    const player = await guest();
    const good = "ExponentPushToken[good]";
    const dead = "ExponentPushToken[dead]";
    expect((await call("POST", "/v1/me/push-tokens", { token: owner.token, json: { token: good, platform: "ios" } })).data).toEqual({ ok: true });
    await call("POST", "/v1/me/push-tokens", { token: owner.token, json: { token: dead, platform: "android" } });
    expect((await call("POST", "/v1/me/push-tokens", { token: owner.token, json: { token: "nope", platform: "ios" } })).status).toBe(400);
    ticketFor = (m) => (m.to === dead ? { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } } : { status: "ok", id: "x" });

    const gameId = await makeGame(owner.token, "Orb Duel"); // build_done → push (badge 1)
    await flushPushes();
    expect(pushed.flat().map((m) => m.to).sort()).toEqual([dead, good]);
    expect(pushed.flat()[0]).toMatchObject({ title: "Your game is ready", body: "Orb Duel v1 is playable", sound: "default", badge: 1 });
    // The dead token is gone after the first send.
    expect((await db.select().from(schema.pushTokens)).map((t) => t.token)).toEqual([good]);

    pushed = [];
    await call("POST", `/v1/games/${gameId}/play`, { token: player.token });
    await flushPushes();
    expect(pushed).toHaveLength(1);
    const [msg] = pushed[0]!;
    const n = (await inbox(owner.token)).items[0];
    expect(msg).toEqual({
      to: good,
      title: "You got paid",
      body: `@${player.handle} played Orb Duel — +9K coins ($0.09)`,
      data: { gameId, fromUserId: player.id, coins: 9_000, kind: "play_earning", notificationId: n.id },
      sound: "default",
      badge: 2,
    });

    // A failing pusher never breaks the request.
    ticketFor = () => { throw new Error("expo down"); };
    const p2 = await guest();
    expect((await call("POST", `/v1/games/${gameId}/play`, { token: p2.token })).status).toBe(200);
    await flushPushes();

    // Token moves to whoever registers it last; DELETE removes only your own.
    await call("POST", "/v1/me/push-tokens", { token: player.token, json: { token: good, platform: "ios" } });
    expect((await db.select().from(schema.pushTokens))[0]!.userId).toBe(player.id);
    await call("DELETE", "/v1/me/push-tokens", { token: owner.token, json: { token: good } });
    expect(await db.select().from(schema.pushTokens)).toHaveLength(1);
    await call("DELETE", "/v1/me/push-tokens", { token: player.token, json: { token: good } });
    expect(await db.select().from(schema.pushTokens)).toHaveLength(0);
  });
});
