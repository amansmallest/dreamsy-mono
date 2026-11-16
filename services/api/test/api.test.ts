import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { strToU8, zipSync } from "fflate";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { fail, type Config, type IdentityVerifier } from "../src/context.js";
import { schema, type DB } from "../src/db/client.js";
import { MemoryStorage } from "../src/storage.js";

const config: Config = {
  jwtSecret: "test-secret-test-secret-test-secret-123",
  workerToken: "worker-token",
  dailyGenerationQuota: 3,
  leaseSeconds: 60,
  maxAttempts: 2,
  ssePollMs: 10,
  starterStars: 500,
  creatorShare: 0.5,
  playPrice: 10000,
  playPassMinutes: 30,
  createPrice: 0, // pricing of builds/remixes is covered in notifications.test.ts
  remixPrice: 0,
};

/** Fake provider tokens look like "valid:<sub>". */
const identity: IdentityVerifier = {
  async verify(_provider, token) {
    if (!token.startsWith("valid:")) fail(401, "invalid token");
    return { subject: token.slice(6), email: null };
  },
};

let db: DB;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  const pg = new PGlite();
  const d = drizzle(pg, { schema });
  await migrate(d, { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
  db = d as unknown as DB;
  app = createApp({ db, storage: new MemoryStorage(), config, identity });
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
  const text = await res.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch {}
  return { status: res.status, data, res };
}

async function guest() {
  const { data } = await call("POST", "/v1/auth/guest");
  return data.token as string;
}

const W = { token: config.workerToken };

function makePackage(manifest: string, extra: Record<string, string> = {}) {
  const files: Record<string, Uint8Array> = {
    "dreamsy.toml": strToU8(manifest),
    "scenes/main.scene.json": strToU8(JSON.stringify({ format: "0", root: "world", entities: { world: { type: "Node2D" } } })),
  };
  for (const [k, v] of Object.entries(extra)) files[k] = strToU8(v);
  return zipSync(files);
}

const MANIFEST = `
format = "0"
name = "Tiny Clash"
dimension = "2d"
entry_scene = "scenes/main.scene.json"
[server]
mode = "none"
`;

function completeForm(workerId: string, zip: Uint8Array, summary = "built it") {
  const f = new FormData();
  f.set("workerId", workerId);
  f.set("summary", summary);
  f.set("package", new File([zip as Uint8Array<ArrayBuffer>], "game.zip", { type: "application/zip" }));
  return f;
}

async function newGameWithGeneration(token: string, prompt = "make a tower defense") {
  const { data: g } = await call("POST", "/v1/games", { token, json: { name: "My game", visibility: "private" } });
  const { data: gen, status } = await call("POST", `/v1/games/${g.game.id}/generations`, { token, json: { prompt } });
  expect(status).toBe(201);
  return { gameId: g.game.id as string, genId: gen.generation.id as string };
}

// ---------- tests ----------

describe("auth", () => {
  it("guest account + /me", async () => {
    const token = await guest();
    const me = await call("GET", "/v1/me", { token });
    expect(me.status).toBe(200);
    expect(me.data.user.handle).toMatch(/^dreamer_/);
    expect((await call("GET", "/v1/me")).status).toBe(401);
    expect((await call("GET", "/v1/me", { token: "garbage" })).status).toBe(401);
  });

  it("apple/google sign-in is find-or-create per provider subject", async () => {
    const a1 = await call("POST", "/v1/auth/apple", { json: { identityToken: "valid:apple-123" } });
    const a2 = await call("POST", "/v1/auth/apple", { json: { identityToken: "valid:apple-123" } });
    const g1 = await call("POST", "/v1/auth/google", { json: { idToken: "valid:apple-123" } });
    expect(a1.status).toBe(200);
    expect(a2.data.user.id).toBe(a1.data.user.id);
    expect(g1.data.user.id).not.toBe(a1.data.user.id); // same sub, different provider
    expect((await call("GET", "/v1/me", { token: a2.data.token })).data.user.id).toBe(a1.data.user.id);
    expect((await call("POST", "/v1/auth/google", { json: { idToken: "nope" } })).status).toBe(401);
  });

  it("supabase sign-in is find-or-create; avatar starts null and is saved via PATCH /v1/me", async () => {
    const s1 = await call("POST", "/v1/auth/supabase", { json: { accessToken: "valid:sb-1" } });
    const s2 = await call("POST", "/v1/auth/supabase", { json: { accessToken: "valid:sb-1" } });
    expect(s1.status).toBe(200);
    expect(s2.data.user.id).toBe(s1.data.user.id);
    expect(s1.data.user.avatar).toBeNull();
    expect((await call("POST", "/v1/auth/supabase", { json: { accessToken: "nope" } })).status).toBe(401);

    const avatar = { head: 1, hat: 2, eyes: 0, mouth: 3, extra: 0, body: 1 };
    const patched = await call("PATCH", "/v1/me", { token: s1.data.token, json: { avatar } });
    expect(patched.status).toBe(200);
    expect(patched.data.user.avatar).toEqual(avatar);
    expect((await call("GET", "/v1/me", { token: s1.data.token })).data.user.avatar).toEqual(avatar);
    const bad = await call("PATCH", "/v1/me", { token: s1.data.token, json: { avatar: { hat: -1 } } });
    expect(bad.status).toBe(400);
  });
});

describe("full generation flow", () => {
  it("prompt → worker claim → events → complete → version → publish → others play", async () => {
    const owner = await guest();

    // reference image
    const form = new FormData();
    form.set("file", new File([new Uint8Array([137, 80, 78, 71])], "ref.png", { type: "image/png" }));
    const up = await call("POST", "/v1/uploads", { token: owner, form });
    expect(up.status).toBe(201);

    const { data: g } = await call("POST", "/v1/games", { token: owner, json: { name: "Tiny Clash", visibility: "private" } });
    const gameId = g.game.id;
    const gen = await call("POST", `/v1/games/${gameId}/generations`, {
      token: owner,
      json: { prompt: "clash of clans but cats", imageIds: [up.data.upload.id] },
    });
    expect(gen.status).toBe(201);
    expect(gen.data.generation.baseVersion).toBe(0);

    // second generation on same game is refused while the first is active
    expect((await call("POST", `/v1/games/${gameId}/generations`, { token: owner, json: { prompt: "x" } })).status).toBe(409);

    // worker auth
    expect((await call("POST", "/v1/worker/claim", { json: { workerId: "w1" } })).status).toBe(401);

    const claim = await call("POST", "/v1/worker/claim", { ...W, json: { workerId: "w1" } });
    expect(claim.status).toBe(200);
    expect(claim.data.generation.id).toBe(gen.data.generation.id);
    expect(claim.data.base).toBeNull();
    expect(claim.data.images).toHaveLength(1);

    // nothing else queued
    expect((await call("POST", "/v1/worker/claim", { ...W, json: { workerId: "w2" } })).status).toBe(204);

    // worker can fetch the reference image
    const img = await call("GET", claim.data.images[0].url, W);
    expect(img.status).toBe(200);

    const genId = gen.data.generation.id;
    expect((await call("POST", `/v1/worker/generations/${genId}/events`, { ...W, json: { workerId: "w1", type: "plan", data: { steps: 3 } } })).status).toBe(200);
    expect((await call("POST", `/v1/worker/generations/${genId}/events`, { ...W, json: { workerId: "w2", type: "plan" } })).status).toBe(409);
    expect((await call("POST", `/v1/worker/generations/${genId}/events`, { ...W, json: { workerId: "w1", type: "succeeded" } })).status).toBe(400);

    // bad package rejected, job stays running
    const bad = await call("POST", `/v1/worker/generations/${genId}/complete`, { ...W, form: completeForm("w1", makePackage("name = 1")) });
    expect(bad.status).toBe(400);

    const done = await call("POST", `/v1/worker/generations/${genId}/complete`, { ...W, form: completeForm("w1", makePackage(MANIFEST)) });
    expect(done.status).toBe(201);
    expect(done.data.version.version).toBe(1);
    expect(done.data.generation.status).toBe("succeeded");

    // SSE replays the whole log and ends because the job is terminal
    const sse = await app.request(`/v1/generations/${genId}/events`, { headers: { authorization: `Bearer ${owner}` } });
    const text = await sse.text();
    expect([...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1])).toEqual(["queued", "started", "plan", "succeeded"]);

    // stranger can't see the draft
    const stranger = await guest();
    expect((await call("GET", `/v1/games/${gameId}`, { token: stranger })).status).toBe(404);
    expect((await call("GET", `/v1/games/${gameId}/versions/1/package`, { token: stranger })).status).toBe(404);

    // publish → visible + playable
    expect((await call("POST", `/v1/games/${gameId}/publish`, { token: owner, json: {} })).status).toBe(200);
    const pub = await call("GET", `/v1/games/${gameId}`, { token: stranger });
    expect(pub.data.game.publishedVersion).toBe(1);
    expect(pub.data.game.latestVersion).toBeUndefined();
    const pkg = await app.request(`/v1/games/${gameId}/versions/1/package`, { headers: { authorization: `Bearer ${stranger}` } });
    expect(pkg.status).toBe(200);
    expect(pkg.headers.get("content-type")).toBe("application/zip");
    const discover = await call("GET", "/v1/games", { token: stranger });
    expect(discover.data.games.map((x: any) => x.id)).toContain(gameId);

    // follow-up edit is based on v1 and the worker gets the base package
    const gen2 = await call("POST", `/v1/games/${gameId}/generations`, { token: owner, json: { prompt: "more cats", selection: ["tower_3"] } });
    expect(gen2.data.generation.baseVersion).toBe(1);
    const claim2 = await call("POST", "/v1/worker/claim", { ...W, json: { workerId: "w1" } });
    expect(claim2.data.base.version).toBe(1);
    expect((await app.request(claim2.data.base.packageUrl, { headers: { authorization: `Bearer ${W.token}` } })).status).toBe(200);
  });
});

describe("job lifecycle", () => {
  it("cancel makes the worker stop", async () => {
    const owner = await guest();
    const { genId } = await newGameWithGeneration(owner);
    await call("POST", "/v1/worker/claim", { ...W, json: { workerId: "w1" } });
    expect((await call("POST", `/v1/generations/${genId}/cancel`, { token: owner })).data.generation.status).toBe("canceled");
    expect((await call("POST", `/v1/worker/generations/${genId}/events`, { ...W, json: { workerId: "w1", type: "log" } })).status).toBe(409);
    expect((await call("POST", `/v1/worker/generations/${genId}/complete`, { ...W, form: completeForm("w1", makePackage(MANIFEST)) })).status).toBe(409);
  });

  it("expired lease is reclaimed by another worker, then gives up after maxAttempts", async () => {
    const owner = await guest();
    const { genId } = await newGameWithGeneration(owner);
    const expire = () => db.update(schema.generations).set({ leaseExpiresAt: new Date(0) }).where(eq(schema.generations.id, genId));

    await call("POST", "/v1/worker/claim", { ...W, json: { workerId: "w1" } });
    await expire();
    const re = await call("POST", "/v1/worker/claim", { ...W, json: { workerId: "w2" } });
    expect(re.data.generation.id).toBe(genId);
    expect(re.data.generation.attempts).toBe(2);
    // old worker lost it
    expect((await call("POST", `/v1/worker/generations/${genId}/events`, { ...W, json: { workerId: "w1", type: "log" } })).status).toBe(409);

    await expire();
    expect((await call("POST", "/v1/worker/claim", { ...W, json: { workerId: "w3" } })).status).toBe(204);
    expect((await call("GET", `/v1/generations/${genId}`, { token: owner })).data.generation.status).toBe("failed");
  });

  it("retryable failure requeues; non-retryable fails", async () => {
    const owner = await guest();
    const { genId } = await newGameWithGeneration(owner);
    await call("POST", "/v1/worker/claim", { ...W, json: { workerId: "w1" } });
    const r1 = await call("POST", `/v1/worker/generations/${genId}/fail`, { ...W, json: { workerId: "w1", error: "rate limited", retryable: true } });
    expect(r1.data.generation.status).toBe("queued");
    await call("POST", "/v1/worker/claim", { ...W, json: { workerId: "w1" } });
    const r2 = await call("POST", `/v1/worker/generations/${genId}/fail`, { ...W, json: { workerId: "w1", error: "rate limited", retryable: true } });
    expect(r2.data.generation.status).toBe("failed"); // attempts exhausted
  });

  it("daily quota", async () => {
    const owner = await guest();
    for (let i = 0; i < 3; i++) {
      const { genId } = await newGameWithGeneration(owner);
      await call("POST", `/v1/generations/${genId}/cancel`, { token: owner });
    }
    const { data: g } = await call("POST", "/v1/games", { token: owner, json: { name: "x" } });
    expect((await call("POST", `/v1/games/${g.game.id}/generations`, { token: owner, json: { prompt: "x" } })).status).toBe(429);
  });

  it("revert creates a new version from an old package", async () => {
    const owner = await guest();
    const { gameId, genId } = await newGameWithGeneration(owner);
    await call("POST", "/v1/worker/claim", { ...W, json: { workerId: "w1" } });
    await call("POST", `/v1/worker/generations/${genId}/complete`, { ...W, form: completeForm("w1", makePackage(MANIFEST)) });
    const gen2 = await call("POST", `/v1/games/${gameId}/generations`, { token: owner, json: { prompt: "v2" } });
    await call("POST", "/v1/worker/claim", { ...W, json: { workerId: "w1" } });
    await call("POST", `/v1/worker/generations/${gen2.data.generation.id}/complete`, {
      ...W, form: completeForm("w1", makePackage(MANIFEST, { "scripts/server/main.luau": "print('v2')" })),
    });

    const rev = await call("POST", `/v1/games/${gameId}/revert`, { token: owner, json: { version: 1 } });
    expect(rev.status).toBe(201);
    expect(rev.data.version.version).toBe(3);
    const versions = await call("GET", `/v1/games/${gameId}/versions`, { token: owner });
    expect(versions.data.versions.map((v: any) => v.sha256)[0]).toBe(versions.data.versions[2].sha256);
  });

  it("async server mode requires deterministic", async () => {
    const owner = await guest();
    const { genId } = await newGameWithGeneration(owner);
    await call("POST", "/v1/worker/claim", { ...W, json: { workerId: "w1" } });
    const res = await call("POST", `/v1/worker/generations/${genId}/complete`, {
      ...W, form: completeForm("w1", makePackage(MANIFEST.replace('mode = "none"', 'mode = "async"'))),
    });
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/deterministic/);
  });
});

describe("quota + structured errors", () => {
  it("reports quota and returns structured 409/429 bodies", async () => {
    const owner = await guest();
    expect((await call("GET", "/v1/me/quota", { token: owner })).data.quota).toMatchObject({ limit: 3, used: 0, remaining: 3, resetsAt: null });
    const { gameId, genId } = await newGameWithGeneration(owner);
    const dup = await call("POST", `/v1/games/${gameId}/generations`, { token: owner, json: { prompt: "x" } });
    expect(dup.status).toBe(409);
    expect(dup.data.activeGenerationId).toBe(genId);
    await call("POST", `/v1/generations/${genId}/cancel`, { token: owner });
    for (let i = 0; i < 2; i++) {
      const { genId: g } = await newGameWithGeneration(owner);
      await call("POST", `/v1/generations/${g}/cancel`, { token: owner });
    }
    const { data: g } = await call("POST", "/v1/games", { token: owner, json: { name: "x" } });
    const over = await call("POST", `/v1/games/${g.game.id}/generations`, { token: owner, json: { prompt: "x" } });
    expect(over.status).toBe(429);
    expect(over.data.quota.remaining).toBe(0);
    expect(over.data.quota.resetsAt).toBeTruthy();
  });
});

describe("stars store", () => {
  const STORE = MANIFEST + '[[store]]\nid = "vip"\nkind = "pass"\nname = "VIP"\nprice = 100\n\n[[store]]\nid = "gems"\nkind = "consumable"\nname = "Gems"\nprice = 450\n';

  async function publishedStoreGame() {
    const owner = await guest();
    const { gameId, genId } = await newGameWithGeneration(owner);
    await call("POST", "/v1/worker/claim", { ...W, json: { workerId: "w1" } });
    await call("POST", `/v1/worker/generations/${genId}/complete`, { ...W, form: completeForm("w1", makePackage(STORE)) });
    await call("POST", `/v1/games/${gameId}/publish`, { token: owner, json: {} });
    return { owner, gameId };
  }
  const buy = (token: string, gameId: string, itemId: string, key = crypto.randomUUID()) =>
    call("POST", `/v1/games/${gameId}/store/purchase`, { token, json: { itemId, idempotencyKey: key } });

  it("starter grant, purchase, creator share, pass uniqueness, idempotency, insufficient funds, consume", async () => {
    const { owner, gameId } = await publishedStoreGame();
    const player = await guest();
    expect((await call("GET", "/v1/me/wallet", { token: player })).data.wallet.balance).toBe(500);

    const store = await call("GET", `/v1/games/${gameId}/store`, { token: player });
    expect(store.data.items.map((i: any) => i.id)).toEqual(["vip", "gems"]);

    const key = crypto.randomUUID();
    const p1 = await buy(player, gameId, "vip", key);
    expect(p1.status).toBe(201);
    expect(p1.data.balance).toBe(400);
    expect((await buy(player, gameId, "vip", key)).status).toBe(200); // same key → replay, no double charge
    expect((await call("GET", "/v1/me/wallet", { token: player })).data.wallet.balance).toBe(400);
    expect((await buy(player, gameId, "vip")).status).toBe(409); // pass already owned

    const tooMuch = await buy(player, gameId, "gems");
    expect(tooMuch.status).toBe(402);
    expect(tooMuch.data.balance).toBe(400);

    // creator earned 50% of 100 on top of their own starter grant
    expect((await call("GET", "/v1/me/wallet", { token: owner })).data.wallet.balance).toBe(550);
    // creator buys own items for free (testing)
    const own = await buy(owner, gameId, "gems");
    expect(own.data.purchase.price).toBe(0);

    const rich = await guest();
    const g = await buy(rich, gameId, "gems");
    expect(g.status).toBe(201);
    let owned = (await call("GET", `/v1/games/${gameId}/store`, { token: rich })).data.owned;
    expect(owned.unconsumed).toEqual([{ purchaseId: g.data.purchase.id, itemId: "gems" }]);
    expect((await call("POST", `/v1/games/${gameId}/store/consume`, { token: rich, json: { purchaseId: g.data.purchase.id } })).status).toBe(200);
    expect((await call("POST", `/v1/games/${gameId}/store/consume`, { token: rich, json: { purchaseId: g.data.purchase.id } })).status).toBe(409);
    owned = (await call("GET", `/v1/games/${gameId}/store`, { token: rich })).data.owned;
    expect(owned.unconsumed).toEqual([]);

    // ledger is consistent: sum of deltas == balance
    const w = (await call("GET", "/v1/me/wallet", { token: player })).data;
    expect(w.recent.reduce((s: number, e: any) => s + e.delta, 0)).toBe(w.wallet.balance);
  });

  it("drafts have no public store", async () => {
    const owner = await guest();
    const { gameId } = await newGameWithGeneration(owner);
    const stranger = await guest();
    expect((await call("GET", `/v1/games/${gameId}/store`, { token: stranger })).status).toBe(404);
  });
});

describe("cors", () => {
  it("answers preflight for the engine origin", async () => {
    const res = await app.request("/v1/games/x/store", { method: "OPTIONS", headers: { origin: "http://10.0.0.126:2005", "access-control-request-method": "GET", "access-control-request-headers": "authorization" } });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-headers")).toContain("authorization");
  });
});

describe("owner views include the active build", () => {
  it("activeGeneration is set while a build runs and null after", async () => {
    const owner = await guest();
    const { gameId, genId } = await newGameWithGeneration(owner);
    const mine = await call("GET", "/v1/me/games", { token: owner });
    expect(mine.data.games.find((g: any) => g.id === gameId).activeGeneration.id).toBe(genId);
    await call("POST", `/v1/generations/${genId}/cancel`, { token: owner });
    const after = await call("GET", `/v1/games/${gameId}`, { token: owner });
    expect(after.data.game.activeGeneration).toBeNull();
  });
});

describe("assets + activity (web dashboard)", () => {
  it("lists assets with provenance, serves files, scopes generations to assets, and lists activity", async () => {
    const owner = await guest();
    const { gameId, genId } = await newGameWithGeneration(owner);
    await call("POST", "/v1/worker/claim", { ...W, json: { workerId: "w1" } });
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#f00"/></svg>';
    const zip = makePackage(MANIFEST, {
      "assets/shield.svg": svg,
      "assets/shield.meta.json": JSON.stringify({ kind: "image", file: "shield.svg", source: { model: "claude-opus-5-5", prompt: "a round shield" } }),
    });
    expect((await call("POST", `/v1/worker/generations/${genId}/complete`, { ...W, form: completeForm("w1", zip) })).status).toBe(201);

    const list = await call("GET", `/v1/games/${gameId}/versions/1/assets`, { token: owner });
    expect(list.data.assets).toEqual([expect.objectContaining({ id: "shield", kind: "image", file: "shield.svg", prompt: "a round shield", model: "claude-opus-5-5" })]);
    const file = await app.request(list.data.assets[0].url, { headers: { authorization: `Bearer ${owner}` } });
    expect(file.headers.get("content-type")).toBe("image/svg+xml");
    expect(await file.text()).toBe(svg);

    // drafts are private
    const stranger = await guest();
    expect((await call("GET", `/v1/games/${gameId}/versions/1/assets`, { token: stranger })).status).toBe(404);
    expect((await app.request(`/v1/games/${gameId}/versions/1/assets`)).status).toBe(401); // signed-out → games router auth

    // scoped edit carries assetIds through to the worker
    const gen = await call("POST", `/v1/games/${gameId}/generations`, { token: owner, json: { prompt: "make the shield red", assetIds: ["shield"] } });
    expect(gen.data.generation.assetIds).toEqual(["shield"]);
    const claim = await call("POST", "/v1/worker/claim", { ...W, json: { workerId: "w1" } });
    expect(claim.data.generation.assetIds).toEqual(["shield"]);
    expect((await call("POST", `/v1/games/${gameId}/generations`, { token: owner, json: { prompt: "x", assetIds: ["Bad Id"] } })).status).toBe(400);

    const act = await call("GET", "/v1/me/activity", { token: owner });
    expect(act.data.items.map((i: any) => i.generation.prompt)).toEqual(["make the shield red", "make a tower defense"]);
    expect(act.data.items[0].game.id).toBe(gameId);
  });
});
