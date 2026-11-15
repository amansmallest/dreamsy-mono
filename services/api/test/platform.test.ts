import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { fail, type Config, type IdentityVerifier } from "../src/context.js";
import { schema, type DB } from "../src/db/client.js";
import { MemoryStorage } from "../src/storage.js";

/** DREAMSY.MD §11 Platform v1 + worker checkpoints. */

const config: Config = {
  jwtSecret: "test-secret-test-secret-test-secret-123",
  workerToken: "worker-token",
  dailyGenerationQuota: 100,
  leaseSeconds: 60,
  maxAttempts: 2,
  ssePollMs: 10,
  starterStars: 500,
  creatorShare: 0.5,
};
const identity: IdentityVerifier = {
  async verify() { fail(401, "unused"); },
};

let db: DB;
let storage: MemoryStorage;
let app: ReturnType<typeof createApp>;
let outbox: { to: string; subject: string; text: string }[] = [];

beforeEach(async () => {
  const pg = new PGlite();
  const d = drizzle(pg, { schema });
  await migrate(d, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
  db = d as unknown as DB;
  storage = new MemoryStorage();
  outbox = [];
  app = createApp({ db, storage, config, identity, mailer: { send: async (m) => { outbox.push(m); } } });
});

// ---------- helpers ----------

async function call(method: string, path: string, opts: { token?: string; json?: unknown; form?: FormData } = {}) {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let body: BodyInit | undefined;
  if (opts.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.json);
  } else if (opts.form) body = opts.form;
  const res = await app.request(path, { method, headers, body });
  const buf = new Uint8Array(await res.arrayBuffer());
  let data: any = buf;
  try { data = JSON.parse(strFromU8(buf)); } catch {}
  return { status: res.status, data, res };
}

async function guest() {
  const { data } = await call("POST", "/v1/auth/guest");
  return { token: data.token as string, id: data.user.id as string };
}

const W = { token: config.workerToken };

const manifest = (name: string, extra = "") => `
format = "0"
name = "${name}"
dimension = "2d"
orientation = "portrait"
entry_scene = "scenes/main.scene.json"
[server]
mode = "none"
${extra}`;

const STORE = '[[store]]\nid = "vip"\nkind = "pass"\nname = "VIP"\nprice = 100\n\n[[store]]\nid = "gems"\nkind = "consumable"\nname = "Gems"\nprice = 50\n';

function makePackage(m: string, extra: Record<string, string> = {}) {
  const files: Record<string, Uint8Array> = {
    "dreamsy.toml": strToU8(m),
    "scenes/main.scene.json": strToU8(JSON.stringify({ format: "0", root: "world", entities: { world: { type: "Node2D" } } })),
  };
  for (const [k, v] of Object.entries(extra)) files[k] = strToU8(v);
  return zipSync(files);
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

function resultForm(workerId: string, zip: Uint8Array, opts: { summary?: string; thumbnail?: Uint8Array; thumbType?: string } = {}) {
  const f = new FormData();
  f.set("workerId", workerId);
  f.set("summary", opts.summary ?? "built it");
  f.set("package", new File([zip as Uint8Array<ArrayBuffer>], "game.zip", { type: "application/zip" }));
  if (opts.thumbnail) f.set("thumbnail", new File([opts.thumbnail as Uint8Array<ArrayBuffer>], "thumb.jpg", { type: opts.thumbType ?? "image/jpeg" }));
  return f;
}

async function startGeneration(token: string, name = "My game") {
  const { data: g } = await call("POST", "/v1/games", { token, json: { name } });
  const gen = await call("POST", `/v1/games/${g.game.id}/generations`, { token, json: { prompt: "make it" } });
  await call("POST", "/v1/worker/claim", { ...W, json: { workerId: "w1" } });
  return { gameId: g.game.id as string, genId: gen.data.generation.id as string };
}

/** Create + build (+ publish) a game. */
async function makeGame(token: string, name: string, opts: { extra?: string; publish?: boolean; description?: string; thumbnail?: Uint8Array } = {}) {
  const { gameId, genId } = await startGeneration(token, name);
  if (opts.description) await call("PATCH", `/v1/games/${gameId}`, { token, json: { description: opts.description } });
  const done = await call("POST", `/v1/worker/generations/${genId}/complete`, {
    ...W, form: resultForm("w1", makePackage(manifest(name, opts.extra)), { thumbnail: opts.thumbnail }),
  });
  expect(done.status).toBe(201);
  if (opts.publish !== false) expect((await call("POST", `/v1/games/${gameId}/publish`, { token, json: {} })).status).toBe(200);
  return gameId;
}

const ids = (games: any[]) => games.map((g) => g.id);
const feed = (token: string, tab: string, q = "") => call("GET", `/v1/feed?tab=${tab}${q}`, { token });

// ---------- tests ----------

describe("feed", () => {
  it("orders per tab, paginates, and shows FeedGame shape", async () => {
    const alice = await guest();
    const a = await makeGame(alice.token, "Alpha");
    const b = await makeGame(alice.token, "Bravo");
    const c = await makeGame(alice.token, "Charlie");
    await makeGame(alice.token, "Draft", { publish: false });

    const p1 = await guest();
    const p2 = await guest();
    // a: 2 plays; b: 1 like (= 3 points); c: nothing
    await call("POST", `/v1/games/${a}/plays`, { token: p1.token, json: { version: 1 } });
    await call("POST", `/v1/games/${a}/plays`, { token: p2.token, json: { version: 1 } });
    await call("PUT", `/v1/games/${b}/like`, { token: p1.token });

    expect(ids((await feed(p1.token, "new")).data.games)).toEqual([c, b, a]);
    expect(ids((await feed(p1.token, "trending")).data.games)).toEqual([b, a, c]);
    expect(ids((await feed(p1.token, "top")).data.games)[0]).toBe(b);

    const page1 = await feed(p1.token, "new", "&limit=2");
    expect(ids(page1.data.games)).toEqual([c, b]);
    expect(page1.data.next).toBeTruthy();
    const page2 = await feed(p1.token, "new", `&limit=2&cursor=${page1.data.next}`);
    expect(ids(page2.data.games)).toEqual([a]);
    expect(page2.data.next).toBeNull();
    expect((await feed(p1.token, "new", "&cursor=garbage")).status).toBe(400);

    const item = (await feed(p1.token, "trending")).data.games[0];
    expect(item).toMatchObject({
      id: b, name: "Bravo", orientation: "portrait", thumbnailUrl: null,
      creator: { id: alice.id, handle: expect.stringMatching(/^dreamer_/) },
      stats: { plays: 0, likes: 1, remixes: 0 }, remixOf: null, viewer: { liked: true },
    });
    expect(item.publishedAt).toBeTruthy();
    expect(item.ownerId).toBeUndefined(); // FeedGame, not the owner view
    expect((await call("GET", "/v1/feed")).status).toBe(401);
    expect((await feed(p1.token, "bogus")).status).toBe(400);
  });

  it("following tab = games from creators you follow", async () => {
    const alice = await guest();
    const bob = await guest();
    const fan = await guest();
    const a = await makeGame(alice.token, "Alice game");
    await makeGame(bob.token, "Bob game");
    expect((await feed(fan.token, "following")).data.games).toEqual([]);

    expect((await call("PUT", `/v1/users/${alice.id}/follow`, { token: fan.token })).data.following).toBe(true);
    expect((await call("PUT", `/v1/users/${alice.id}/follow`, { token: fan.token })).status).toBe(200); // idempotent
    expect(ids((await feed(fan.token, "following")).data.games)).toEqual([a]);
    expect((await call("PUT", `/v1/users/${fan.id}/follow`, { token: fan.token })).status).toBe(400);
    expect((await call("PUT", "/v1/users/u_nope/follow", { token: fan.token })).status).toBe(404);

    const profile = await call("GET", `/v1/users/${alice.id}`, { token: fan.token });
    expect(profile.data).toMatchObject({
      user: { id: alice.id, bio: "" },
      stats: { games: 1, plays: 0, likes: 0, followers: 1, following: 0 },
      viewer: { following: true },
    });
    await call("DELETE", `/v1/users/${alice.id}/follow`, { token: fan.token });
    expect((await call("GET", `/v1/users/${alice.id}`, { token: fan.token })).data.viewer.following).toBe(false);
    expect((await feed(fan.token, "following")).data.games).toEqual([]);
  });
});

describe("search", () => {
  it("matches name, description and creator handle", async () => {
    const alice = await guest();
    await call("PATCH", "/v1/me", { token: alice.token, json: { handle: "catlady" } });
    const a = await makeGame(alice.token, "Space Cats");
    const bob = await guest();
    const b = await makeGame(bob.token, "Dungeon", { description: "a crawler with 100% more cats" });
    const s = (q: string) => call("GET", `/v1/search?q=${encodeURIComponent(q)}`, { token: bob.token });
    expect(ids((await s("cats")).data.games).sort()).toEqual([a, b].sort());
    expect(ids((await s("100%")).data.games)).toEqual([b]);
    expect(ids((await s("CATLADY")).data.games)).toEqual([a]);
    expect((await s("zzz")).data.games).toEqual([]);
    expect((await call("GET", "/v1/search?q=", { token: bob.token })).status).toBe(400);
  });
});

describe("plays + likes", () => {
  it("dedupes plays per user per hour", async () => {
    const owner = await guest();
    const g = await makeGame(owner.token, "Game");
    const p = await guest();
    const r1 = await call("POST", `/v1/games/${g}/plays`, { token: p.token, json: { version: 1 } });
    expect(r1.data).toEqual({ counted: true, stats: { plays: 1, likes: 0, remixes: 0 } });
    const r2 = await call("POST", `/v1/games/${g}/plays`, { token: p.token, json: { version: 1 } });
    expect(r2.data.counted).toBe(false);
    expect(r2.data.stats.plays).toBe(1);
    const q = await guest();
    expect((await call("POST", `/v1/games/${g}/plays`, { token: q.token, json: { version: 1 } })).data.stats.plays).toBe(2);
    // a different hour counts again
    await db.update(schema.plays).set({ hour: new Date(0) }).where(eq(schema.plays.userId, p.id));
    expect((await call("POST", `/v1/games/${g}/plays`, { token: p.token, json: { version: 1 } })).data.counted).toBe(true);

    expect((await call("POST", `/v1/games/${g}/plays`, { token: p.token, json: { version: 9 } })).status).toBe(404);
    const draft = await makeGame(owner.token, "Draft", { publish: false });
    expect((await call("POST", `/v1/games/${draft}/plays`, { token: p.token, json: { version: 1 } })).status).toBe(404);
    const [row] = await db.select().from(schema.games).where(eq(schema.games.id, g));
    expect(row!.trendingScore).toBeGreaterThan(0);
  });

  it("like/unlike is idempotent and shows in game views", async () => {
    const owner = await guest();
    const g = await makeGame(owner.token, "Game");
    const p = await guest();
    expect((await call("PUT", `/v1/games/${g}/like`, { token: p.token })).data).toEqual({ liked: true, stats: { plays: 0, likes: 1, remixes: 0 } });
    expect((await call("PUT", `/v1/games/${g}/like`, { token: p.token })).data.stats.likes).toBe(1);
    const view = (await call("GET", `/v1/games/${g}`, { token: p.token })).data.game;
    expect(view).toMatchObject({ viewer: { liked: true }, stats: { likes: 1 }, creator: { id: owner.id }, orientation: "portrait" });
    expect(view.latestVersion).toBeUndefined();
    expect((await call("GET", `/v1/games/${g}`, { token: owner.token })).data.game).toMatchObject({ viewer: { liked: false }, latestVersion: 1, hidden: false });
    expect((await call("DELETE", `/v1/games/${g}/like`, { token: p.token })).data).toMatchObject({ liked: false, stats: { likes: 0 } });
    expect((await call("DELETE", `/v1/games/${g}/like`, { token: p.token })).data.stats.likes).toBe(0);
  });
});

describe("remix", () => {
  it("copies the published package, strips store items, credits + counts the source", async () => {
    const owner = await guest();
    const src = await makeGame(owner.token, "Cat Clash", { extra: STORE, thumbnail: JPEG });
    const fan = await guest();

    const res = await call("POST", `/v1/games/${src}/remix`, { token: fan.token });
    expect(res.status).toBe(201);
    const remix = res.data.game;
    expect(remix).toMatchObject({
      name: "Cat Clash (remix)", ownerId: fan.id, status: "draft", latestVersion: 1,
      remixOf: { gameId: src, name: "Cat Clash", version: 1 },
      thumbnailUrl: `/v1/games/${remix.id}/versions/1/thumbnail`,
    });
    const v = (await call("GET", `/v1/games/${remix.id}/versions/1`, { token: fan.token })).data.version;
    expect(v.manifest.store).toEqual([]);
    const zip = await call("GET", `/v1/games/${remix.id}/versions/1/package`, { token: fan.token });
    const toml = strFromU8(unzipSync(zip.data)["dreamsy.toml"]!);
    expect(toml).not.toContain("store");
    expect(toml).toContain("Cat Clash");
    // no store items to sell in the copy
    expect((await call("GET", `/v1/games/${remix.id}/store`, { token: fan.token })).data.items).toEqual([]);

    const srcView = (await call("GET", `/v1/games/${src}`, { token: fan.token })).data.game;
    expect(srcView.stats.remixes).toBe(1);

    // published remix keeps the credit line in public views
    await call("POST", `/v1/games/${remix.id}/publish`, { token: fan.token, json: {} });
    expect((await call("GET", `/v1/public/games/${remix.id}`)).data.game.remixOf).toMatchObject({ gameId: src, name: "Cat Clash" });
    // ...and is listed under the source's spin-offs (drafts are not)
    const spinoffs = await call("GET", `/v1/games/${src}/remixes`, { token: fan.token });
    expect(spinoffs.status).toBe(200);
    expect(spinoffs.data.games.map((g: { id: string }) => g.id)).toEqual([remix.id]);
  });

  it("shares the blob when there is nothing to strip; owner remixes latest; drafts are private", async () => {
    const owner = await guest();
    const src = await makeGame(owner.token, "Plain");
    const fan = await guest();
    const r = (await call("POST", `/v1/games/${src}/remix`, { token: fan.token })).data.game;
    const sha = async (token: string, id: string) => (await call("GET", `/v1/games/${id}/versions/1`, { token })).data.version.sha256;
    expect(await sha(fan.token, r.id)).toBe(await sha(owner.token, src));

    const draft = await makeGame(owner.token, "Secret", { publish: false });
    expect((await call("POST", `/v1/games/${draft}/remix`, { token: fan.token })).status).toBe(404);
    expect((await call("POST", `/v1/games/${draft}/remix`, { token: owner.token })).status).toBe(201);
  });
});

describe("profiles", () => {
  it("PATCH /v1/me validates and enforces unique handles", async () => {
    const a = await guest();
    const b = await guest();
    const ok = await call("PATCH", "/v1/me", { token: a.token, json: { handle: "pixel_queen", bio: "I make cat games" } });
    expect(ok.status).toBe(200);
    expect(ok.data.user).toMatchObject({ handle: "pixel_queen", bio: "I make cat games" });
    expect((await call("PATCH", "/v1/me", { token: a.token, json: { handle: "pixel_queen" } })).status).toBe(200); // own handle
    expect((await call("PATCH", "/v1/me", { token: b.token, json: { handle: "pixel_queen" } })).status).toBe(409);
    for (const bad of ["ab", "Has_Caps", "way_too_long_handle_123", "no-dash"]) {
      expect((await call("PATCH", "/v1/me", { token: b.token, json: { handle: bad } })).status).toBe(400);
    }
    expect((await call("GET", `/v1/users/${a.id}`, { token: b.token })).data.user.handle).toBe("pixel_queen");
  });

  it("users/:id/games: published only for others, everything for self", async () => {
    const a = await guest();
    const pub = await makeGame(a.token, "Pub");
    const draft = await makeGame(a.token, "Draft", { publish: false });
    const b = await guest();
    expect(ids((await call("GET", `/v1/users/${a.id}/games`, { token: b.token })).data.games)).toEqual([pub]);
    const mine = (await call("GET", `/v1/users/${a.id}/games`, { token: a.token })).data.games;
    expect(ids(mine)).toEqual([draft, pub]);
    expect(mine[0].status).toBe("draft");
  });
});

describe("public sharing", () => {
  it("works without auth for published games; 404 for drafts and hidden", async () => {
    const owner = await guest();
    const g = await makeGame(owner.token, "Shared", { thumbnail: JPEG });
    const pub = await call("GET", `/v1/public/games/${g}`);
    expect(pub.status).toBe(200);
    expect(pub.data.game).toMatchObject({ id: g, publishedVersion: 1, thumbnailUrl: `/v1/games/${g}/versions/1/thumbnail`, remixOf: null });
    expect(pub.data.game.viewer).toBeUndefined();
    const pkg = await call("GET", `/v1/public/games/${g}/package`);
    expect(pkg.status).toBe(200);
    expect(pkg.res.headers.get("content-type")).toBe("application/zip");

    const draft = await makeGame(owner.token, "Draft", { publish: false });
    expect((await call("GET", `/v1/public/games/${draft}`)).status).toBe(404);
    expect((await call("GET", `/v1/public/games/${draft}/package`)).status).toBe(404);
    expect((await call("GET", "/v1/public/games/g_nope")).status).toBe(404);

    await db.update(schema.games).set({ hidden: true }).where(eq(schema.games.id, g));
    expect((await call("GET", `/v1/public/games/${g}`)).status).toBe(404);
    expect((await call("GET", `/v1/public/games/${g}/package`)).status).toBe(404);
  });
});

describe("thumbnails", () => {
  it("worker uploads a JPEG; public for the published version, owner-only otherwise", async () => {
    const owner = await guest();
    const g = await makeGame(owner.token, "Thumb", { thumbnail: JPEG });
    const t = await call("GET", `/v1/games/${g}/versions/1/thumbnail`); // no auth
    expect(t.status).toBe(200);
    expect(t.res.headers.get("content-type")).toBe("image/jpeg");
    expect([...t.data]).toEqual([...JPEG]);
    expect((await feed(owner.token, "new")).data.games[0].thumbnailUrl).toBe(`/v1/games/${g}/versions/1/thumbnail`);

    // v2 (unpublished) has a thumbnail too: owner only
    const gen = await call("POST", `/v1/games/${g}/generations`, { token: owner.token, json: { prompt: "v2" } });
    await call("POST", "/v1/worker/claim", { ...W, json: { workerId: "w1" } });
    const thumb2 = new Uint8Array([0xff, 0xd8, 0xff, 9, 9]);
    await call("POST", `/v1/worker/generations/${gen.data.generation.id}/complete`, { ...W, form: resultForm("w1", makePackage(manifest("Thumb v2")), { thumbnail: thumb2 }) });
    expect((await call("GET", `/v1/games/${g}/versions/2/thumbnail`)).status).toBe(404);
    expect((await call("GET", `/v1/games/${g}/versions/2/thumbnail`, { token: owner.token })).status).toBe(200);
    expect((await call("GET", `/v1/games/${g}`, { token: owner.token })).data.game.thumbnailUrl).toBe(`/v1/games/${g}/versions/2/thumbnail`);
    // other routes under /v1/games/* still need auth
    expect((await call("GET", `/v1/games/${g}/versions/1`)).status).toBe(401);
  });

  it("rejects non-JPEG and oversized thumbnails; no thumbnail → 404", async () => {
    const owner = await guest();
    const { genId, gameId } = await startGeneration(owner.token);
    const zip = makePackage(manifest("X"));
    const png = new Uint8Array([137, 80, 78, 71]);
    expect((await call("POST", `/v1/worker/generations/${genId}/complete`, { ...W, form: resultForm("w1", zip, { thumbnail: png }) })).status).toBe(415);
    const big = new Uint8Array(2 * 1024 * 1024 + 1); big.set([0xff, 0xd8, 0xff]);
    expect((await call("POST", `/v1/worker/generations/${genId}/complete`, { ...W, form: resultForm("w1", zip, { thumbnail: big }) })).status).toBe(413);
    expect((await call("POST", `/v1/worker/generations/${genId}/complete`, { ...W, form: resultForm("w1", zip) })).status).toBe(201);
    expect((await call("GET", `/v1/games/${gameId}/versions/1/thumbnail`, { token: owner.token })).status).toBe(404);
  });
});

describe("marketplace", () => {
  it("lists store items of published games with sales", async () => {
    const owner = await guest();
    const g = await makeGame(owner.token, "Shop", { extra: STORE });
    await makeGame(owner.token, "Hidden shop", { extra: STORE, publish: false });
    const p = await guest();
    await call("POST", `/v1/games/${g}/store/purchase`, { token: p.token, json: { itemId: "gems", idempotencyKey: crypto.randomUUID() } });
    await call("POST", `/v1/games/${g}/store/purchase`, { token: p.token, json: { itemId: "gems", idempotencyKey: crypto.randomUUID() } });

    const popular = await call("GET", "/v1/marketplace?sort=popular", { token: p.token });
    expect(popular.data.items).toEqual([
      { gameId: g, gameName: "Shop", itemId: "gems", kind: "consumable", name: "Gems", description: "", price: 50, sales: 2 },
      { gameId: g, gameName: "Shop", itemId: "vip", kind: "pass", name: "VIP", description: "", price: 100, sales: 0 },
    ]);
    expect(popular.data.next).toBeNull();
    const byPrice = await call("GET", "/v1/marketplace?sort=price&limit=1", { token: p.token });
    expect(byPrice.data.items.map((i: any) => i.itemId)).toEqual(["gems"]);
    const page2 = await call("GET", `/v1/marketplace?sort=price&limit=1&cursor=${byPrice.data.next}`, { token: p.token });
    expect(page2.data.items.map((i: any) => i.itemId)).toEqual(["vip"]);
    expect(page2.data.next).toBeNull();
  });
});

describe("reports", () => {
  it("3 distinct reporters hide the game from feeds, search and marketplace", async () => {
    const owner = await guest();
    const g = await makeGame(owner.token, "Bad game", { extra: STORE });
    expect((await call("POST", `/v1/games/${g}/report`, { token: owner.token, json: { reason: "x" } })).status).toBe(400);
    const r1 = await guest();
    await call("POST", `/v1/games/${g}/report`, { token: r1.token, json: { reason: "spam" } });
    await call("POST", `/v1/games/${g}/report`, { token: r1.token, json: { reason: "spam again" } }); // same reporter
    const r2 = await guest();
    expect((await call("POST", `/v1/games/${g}/report`, { token: r2.token, json: { reason: "gross" } })).data).toEqual({ ok: true });
    expect(ids((await feed(r2.token, "new")).data.games)).toEqual([g]);
    expect((await call("POST", `/v1/games/${g}/report`, { token: r2.token, json: {} })).status).toBe(400);

    const r3 = await guest();
    await call("POST", `/v1/games/${g}/report`, { token: r3.token, json: { reason: "bad" } });
    expect((await feed(r3.token, "new")).data.games).toEqual([]);
    expect((await call("GET", "/v1/search?q=bad", { token: r3.token })).data.games).toEqual([]);
    expect((await call("GET", "/v1/marketplace", { token: r3.token })).data.items).toEqual([]);
    expect((await call("GET", `/v1/games/${g}`, { token: owner.token })).data.game.hidden).toBe(true);
  });
});

describe("worker checkpoints + eta", () => {
  it("checkpoints commit playable versions and move the base; complete builds on them", async () => {
    const owner = await guest();
    const { gameId, genId } = await startGeneration(owner.token);
    const cp = (n: number) => call("POST", `/v1/worker/generations/${genId}/checkpoint`, {
      ...W, form: resultForm("w1", makePackage(manifest(`Round ${n}`)), { summary: `round ${n}`, thumbnail: JPEG }),
    });
    const c1 = await cp(1);
    expect(c1.status).toBe(201);
    expect(c1.data.version.version).toBe(1);
    expect((await cp(2)).data.version.version).toBe(2);

    const gen = (await call("GET", `/v1/generations/${genId}`, { token: owner.token })).data.generation;
    expect(gen).toMatchObject({ status: "running", baseVersion: 2 });

    // a checkpoint is a normal version: publish it and others can play it mid-build
    await call("POST", `/v1/games/${gameId}/publish`, { token: owner.token, json: { version: 2 } });
    const stranger = await guest();
    expect((await call("GET", `/v1/games/${gameId}/versions/2/package`, { token: stranger.token })).status).toBe(200);
    expect((await call("GET", `/v1/games/${gameId}/versions/2/thumbnail`)).status).toBe(200);

    // other worker can't checkpoint
    const other = await call("POST", `/v1/worker/generations/${genId}/checkpoint`, { ...W, form: resultForm("w2", makePackage(manifest("x"))) });
    expect(other.status).toBe(409);

    const done = await call("POST", `/v1/worker/generations/${genId}/complete`, { ...W, form: resultForm("w1", makePackage(manifest("Final"))) });
    expect(done.status).toBe(201);
    expect(done.data.version.version).toBe(3);
    expect(done.data.generation).toMatchObject({ status: "succeeded", resultVersion: 3 });

    const sse = await app.request(`/v1/generations/${genId}/events`, { headers: { authorization: `Bearer ${owner.token}` } });
    expect([...(await sse.text()).matchAll(/^event: (.+)$/gm)].map((m) => m[1])).toEqual(["queued", "started", "checkpoint", "checkpoint", "succeeded"]);
    // workers can't forge checkpoint events
    expect((await call("POST", `/v1/worker/generations/${genId}/events`, { ...W, json: { workerId: "w1", type: "checkpoint" } })).status).toBe(400);
  });

  it("stale base is rejected", async () => {
    const owner = await guest();
    const { gameId, genId } = await startGeneration(owner.token);
    await call("POST", `/v1/worker/generations/${genId}/checkpoint`, { ...W, form: resultForm("w1", makePackage(manifest("r1"))) });
    await db.update(schema.games).set({ latestVersion: 5 }).where(eq(schema.games.id, gameId));
    const res = await call("POST", `/v1/worker/generations/${genId}/checkpoint`, { ...W, form: resultForm("w1", makePackage(manifest("r2"))) });
    expect(res.status).toBe(409);
    expect(res.data.error).toMatch(/stale/);
  });

  it("eta events update etaSeconds + progress", async () => {
    const owner = await guest();
    const { genId } = await startGeneration(owner.token);
    const ev = (data: unknown) => call("POST", `/v1/worker/generations/${genId}/events`, { ...W, json: { workerId: "w1", type: "eta", data } });
    expect((await ev({ etaSeconds: 120, round: 2, rounds: 5, phase: "art" })).status).toBe(200);
    const gen = (await call("GET", `/v1/generations/${genId}`, { token: owner.token })).data.generation;
    expect(gen).toMatchObject({ etaSeconds: 120, progress: { round: 2, rounds: 5, phase: "art" } });
    expect((await ev({ etaSeconds: "soon" })).status).toBe(400);
    const done = await call("POST", `/v1/worker/generations/${genId}/complete`, { ...W, form: resultForm("w1", makePackage(manifest("x"))) });
    expect(done.data.generation.etaSeconds).toBeNull();
  });
});

describe("demo sign-in bypass", () => {
  it("lets *_demo and special names in, same account every time; rejects others", async () => {
    const a = await call("POST", "/v1/auth/demo", { json: { username: "Judge_Demo" } });
    expect(a.status).toBe(200);
    expect(a.data.user.handle).toBe("judge_demo");
    const b = await call("POST", "/v1/auth/demo", { json: { username: "judge_demo" } });
    expect(b.data.user.id).toBe(a.data.user.id);
    const me = await call("GET", "/v1/me", { token: b.data.token });
    expect(me.data.user.id).toBe(a.data.user.id);
    expect((await call("POST", "/v1/auth/demo", { json: { username: "demo" } })).status).toBe(200);
    expect((await call("POST", "/v1/auth/demo", { json: { username: "apoorv" } })).status).toBe(403);
    expect((await call("POST", "/v1/auth/demo", { json: { username: "x" } })).status).toBe(400);
  });
});

describe("email code sign-in (own, via mailer)", () => {
  const codeOf = (m: { text: string }) => m.text.match(/\b(\d{6})\b/)![1]!;

  it("sends a code, verifies it once, same account next time, links an existing same-email user", async () => {
    // Existing user from an old Supabase sign-in with this email.
    const [old] = await db.insert(schema.users).values({ id: "u_old", handle: "oldtimer" }).returning();
    await db.insert(schema.authIdentities).values({ provider: "supabase", subject: "sb-1", userId: old!.id, email: "Ada@Example.com" });

    expect((await call("POST", "/v1/auth/email/start", { json: { email: " ada@example.com " } })).status).toBe(200);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.to).toBe("ada@example.com");
    const code = codeOf(outbox[0]!);
    expect((await call("POST", "/v1/auth/email/verify", { json: { email: "ada@example.com", code: code === "000000" ? "000001" : "000000" } })).status).toBe(400);
    const ok = await call("POST", "/v1/auth/email/verify", { json: { email: "ada@example.com", code } });
    expect(ok.status).toBe(200);
    expect(ok.data.user.id).toBe("u_old");
    expect((await call("GET", "/v1/me", { token: ok.data.token })).data.user.handle).toBe("oldtimer");
    // Code is single-use.
    expect((await call("POST", "/v1/auth/email/verify", { json: { email: "ada@example.com", code } })).status).toBe(400);
    // Immediate resend is rate limited.
    expect((await call("POST", "/v1/auth/email/start", { json: { email: "ada@example.com" } })).status).toBe(429);
  });

  it("new email → new account; locks after 5 wrong tries", async () => {
    await call("POST", "/v1/auth/email/start", { json: { email: "new@example.com" } });
    const code = codeOf(outbox.at(-1)!);
    const wrong = code === "111111" ? "222222" : "111111";
    for (let i = 0; i < 5; i++) expect((await call("POST", "/v1/auth/email/verify", { json: { email: "new@example.com", code: wrong } })).status).toBe(400);
    expect((await call("POST", "/v1/auth/email/verify", { json: { email: "new@example.com", code } })).status).toBe(400);
    expect((await call("POST", "/v1/auth/email/start", { json: { email: "bad" } })).status).toBe(400);
  });
});
