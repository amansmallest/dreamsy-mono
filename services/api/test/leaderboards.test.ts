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

/** DREAMSY.MD §13 leaderboards, ghosts, groups. */

const config: Config = {
  jwtSecret: "test-secret-test-secret-test-secret-123",
  workerToken: "worker-token",
  dailyGenerationQuota: 100,
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
  const { data: g } = await call("POST", "/v1/games", { token, json: { name, visibility: "private" } });
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


const ghost = (n = 3) => ({ v: 1, hz: 10, scene: "scenes/main.scene.json", frames: Array.from({ length: n }, (_, i) => [i, i * 2, 0, i % 4]) });
const submit = (token: string, gameId: string, json: any) => call("POST", `/v1/games/${gameId}/runs`, { token, json: { version: 1, ...json } });
const board = (token: string, gameId: string, b: string, q = "") => call("GET", `/v1/games/${gameId}/leaderboards/${b}${q}`, { token });

describe("runs + leaderboards", () => {
  it("ranks asc boards, keeps one best per user, ties by earlier best", async () => {
    const a = await guest(); const b = await guest(); const c = await guest();
    const gameId = await makeGame(a.token, "Race");
    let r = await submit(a.token, gameId, { value: 30 });
    expect(r.status).toBe(201);
    expect(r.data).toMatchObject({ rank: 1, best: 30, personalBest: true, run: { board: "fastest", order: "asc", value: 30, version: 1, hasGhost: false } });
    r = await submit(b.token, gameId, { value: 20 });
    expect(r.data).toMatchObject({ rank: 1, best: 20, personalBest: true });
    r = await submit(c.token, gameId, { value: 30 });
    expect(r.data).toMatchObject({ rank: 3, best: 20, personalBest: true }); // tie with a, a was first
    r = await submit(a.token, gameId, { value: 35 }); // slower: not a PB
    expect(r.data).toMatchObject({ rank: 3, best: 20, personalBest: false }); // where it would place among the others
    r = await submit(a.token, gameId, { value: 10 });
    expect(r.data).toMatchObject({ rank: 1, best: 10, personalBest: true });

    const lb = await board(c.token, gameId, "fastest");
    expect(lb.status).toBe(200);
    expect(lb.data.order).toBe("asc");
    expect(lb.data.entries.map((e: any) => [e.rank, e.user.id, e.value])).toEqual([[1, a.id, 10], [2, b.id, 20], [3, c.id, 30]]);
    expect(lb.data.me).toMatchObject({ rank: 3, value: 30 });

    const mine = await board(a.token, gameId, "fastest", "?scope=me");
    expect(mine.data.entries.map((e: any) => e.value)).toEqual([10, 30, 35]);
    expect(mine.data.me).toMatchObject({ rank: 1, value: 10 });

    const list = await call("GET", `/v1/games/${gameId}/leaderboards`, { token: b.token });
    expect(list.data.boards).toEqual([expect.objectContaining({ board: "fastest", order: "asc", players: 3, best: 10 })]);
  });

  it("ranks desc boards and fixes the order on first submit", async () => {
    const a = await guest(); const b = await guest();
    const gameId = await makeGame(a.token, "Score");
    expect((await submit(a.token, gameId, { board: "score", order: "desc", value: 100 })).data).toMatchObject({ rank: 1, best: 100, personalBest: true });
    expect((await submit(b.token, gameId, { board: "score", value: 250 })).data).toMatchObject({ rank: 1, best: 250, personalBest: true });
    expect((await submit(a.token, gameId, { board: "score", value: 90 })).data).toMatchObject({ rank: 2, personalBest: false });
    expect((await submit(a.token, gameId, { board: "score", order: "asc", value: 5 })).status).toBe(409);
    const lb = await board(a.token, gameId, "score");
    expect(lb.data.order).toBe("desc");
    expect(lb.data.entries.map((e: any) => e.value)).toEqual([250, 100]);
    const empty = await board(a.token, gameId, "nothing_yet");
    expect(empty.data).toMatchObject({ board: "nothing_yet", order: "asc", entries: [] });
    expect(empty.data.me).toBeUndefined();
  });

  it("stores the ghost only for the best run and drops the old one", async () => {
    const a = await guest(); const b = await guest();
    const gameId = await makeGame(a.token, "Ghosty");
    const first = await submit(a.token, gameId, { value: 40, ghost: ghost(5) });
    expect(first.data.run.hasGhost).toBe(true);
    const firstKey = `ghosts/${first.data.run.id}.json`;
    expect(storage.objects.has(firstKey)).toBe(true);

    const slower = await submit(a.token, gameId, { value: 50, ghost: ghost() });
    expect(slower.data.run.hasGhost).toBe(false);
    expect(storage.objects.has(`ghosts/${slower.data.run.id}.json`)).toBe(false);

    const g = await call("GET", `/v1/runs/${first.data.run.id}/ghost`, { token: b.token });
    expect(g.status).toBe(200);
    expect(g.data.frames).toHaveLength(5);
    expect((await call("GET", `/v1/runs/${first.data.run.id}/ghost`)).status).toBe(200); // published: public

    const faster = await submit(a.token, gameId, { value: 30, ghost: ghost(7) });
    expect(faster.data).toMatchObject({ personalBest: true, run: { hasGhost: true } });
    expect(storage.objects.has(firstKey)).toBe(false);
    expect((await call("GET", `/v1/runs/${first.data.run.id}/ghost`, { token: b.token })).status).toBe(404);
    expect((await call("GET", `/v1/runs/${faster.data.run.id}/ghost`, { token: b.token })).data.frames).toHaveLength(7);

    const lb = await board(b.token, gameId, "fastest");
    expect(lb.data.entries[0]).toMatchObject({ runId: faster.data.run.id, hasGhost: true });

    // PB without a ghost: the old ghost is dropped too
    await submit(a.token, gameId, { value: 20 });
    expect(storage.objects.has(`ghosts/${faster.data.run.id}.json`)).toBe(false);
  });

  it("validates board, value, version and ghost", async () => {
    const a = await guest();
    const gameId = await makeGame(a.token, "Strict");
    expect((await submit(a.token, gameId, { board: "Bad Name", value: 10 })).status).toBe(400);
    expect((await submit(a.token, gameId, { board: "x".repeat(41), value: 10 })).status).toBe(400);
    expect((await submit(a.token, gameId, { value: 0.5 })).status).toBe(400);
    expect((await submit(a.token, gameId, { value: 6 * 3600 + 1 })).status).toBe(400);
    expect((await submit(a.token, gameId, { value: 10, version: 9 })).status).toBe(400);
    expect((await submit(a.token, gameId, { board: "pts", order: "desc", value: 1e13 })).status).toBe(400);
    expect((await submit(a.token, gameId, { value: 10, ghost: { v: 2, hz: 10, scene: "s", frames: [] } })).status).toBe(400);
    expect((await submit(a.token, gameId, { value: 10, ghost: { v: 1, hz: 10, scene: "s", frames: [[1, 2, 3]] } })).status).toBe(400);
    const big = { v: 1, hz: 10, scene: "s", frames: Array.from({ length: 12_000 }, () => [123.456789, 654.321987, 1, 12]) };
    expect((await submit(a.token, gameId, { value: 10, ghost: big })).status).toBe(413);
    expect((await board(a.token, gameId, "Bad-Board")).status).toBe(400);
    expect((await board(a.token, gameId, "fastest", "?scope=everyone")).status).toBe(400);
  });

  it("hides draft boards from strangers and rate-limits submits", async () => {
    const a = await guest(); const b = await guest();
    const gameId = await makeGame(a.token, "Secret", { publish: false });
    expect((await submit(b.token, gameId, { value: 10 })).status).toBe(404);
    expect((await board(b.token, gameId, "fastest")).status).toBe(404);
    const own = await submit(a.token, gameId, { value: 10, ghost: ghost() });
    expect(own.status).toBe(201);
    expect((await call("GET", `/v1/runs/${own.data.run.id}/ghost`, { token: b.token })).status).toBe(404);
    expect((await call("GET", `/v1/runs/${own.data.run.id}/ghost`)).status).toBe(404);
    for (let i = 1; i < 30; i++) expect((await submit(a.token, gameId, { value: 10 + i })).status).toBe(201);
    expect((await submit(a.token, gameId, { value: 99 })).status).toBe(429);
  });
});

describe("groups", () => {
  async function makeGroup(token: string, name = "Family") {
    const r = await call("POST", "/v1/groups", { token, json: { name } });
    expect(r.status).toBe(201);
    return { id: r.data.group.id as string, code: r.data.inviteCode as string };
  }

  it("creates, joins by code, lists members, rotates code, leaves and deletes", async () => {
    const mom = await guest(); const kid = await guest(); const stranger = await guest();
    const g = await makeGroup(mom.token);
    expect(g.code).toMatch(/^[A-Z2-9]{8}$/);
    const joined = await call("POST", "/v1/groups/join", { token: kid.token, json: { code: g.code.toLowerCase() } });
    expect(joined.status).toBe(200);
    expect(joined.data.group).toMatchObject({ id: g.id, memberCount: 2, role: "member" });
    expect((await call("POST", "/v1/groups/join", { token: kid.token, json: { code: g.code } })).data.group.memberCount).toBe(2);
    expect((await call("POST", "/v1/groups/join", { token: kid.token, json: { code: "ZZZZZZZZ" } })).status).toBe(404);
    expect((await call("POST", "/v1/groups/join", { token: kid.token, json: { code: "abc" } })).status).toBe(400);

    const detail = await call("GET", `/v1/groups/${g.id}`, { token: kid.token });
    expect(detail.data.members.map((m: any) => [m.user.id, m.role])).toEqual([[mom.id, "owner"], [kid.id, "member"]]);
    expect((await call("GET", `/v1/groups/${g.id}`, { token: stranger.token })).status).toBe(404);
    expect((await call("GET", "/v1/me/groups", { token: kid.token })).data.groups.map((x: any) => x.id)).toEqual([g.id]);

    expect((await call("POST", `/v1/groups/${g.id}/invite-code`, { token: kid.token })).status).toBe(403);
    const rotated = await call("POST", `/v1/groups/${g.id}/invite-code`, { token: mom.token });
    expect(rotated.data.inviteCode).not.toBe(g.code);
    expect((await call("POST", "/v1/groups/join", { token: stranger.token, json: { code: g.code } })).status).toBe(404);

    expect((await call("DELETE", `/v1/groups/${g.id}`, { token: kid.token })).status).toBe(403);
    expect((await call("POST", `/v1/groups/${g.id}/leave`, { token: kid.token })).status).toBe(200);
    expect((await call("GET", "/v1/me/groups", { token: kid.token })).data.groups).toEqual([]);
    expect((await call("DELETE", `/v1/groups/${g.id}`, { token: mom.token })).status).toBe(200);
    expect((await call("GET", `/v1/groups/${g.id}`, { token: mom.token })).status).toBe(404);
  });

  it("caps groups at 50 members and hands ownership on when the owner leaves", async () => {
    const owner = await guest();
    const g = await makeGroup(owner.token);
    const first = await guest();
    await call("POST", "/v1/groups/join", { token: first.token, json: { code: g.code } });
    const rows = [];
    for (let i = 0; i < 48; i++) {
      const id = `u_fill${i}`;
      rows.push({ id, handle: `fill${i}` });
    }
    await db.insert(schema.users).values(rows);
    await db.insert(schema.groupMembers).values(rows.map((u) => ({ groupId: g.id, userId: u.id })));
    const late = await guest();
    const full = await call("POST", "/v1/groups/join", { token: late.token, json: { code: g.code } });
    expect(full.status).toBe(409);

    expect((await call("POST", `/v1/groups/${g.id}/leave`, { token: owner.token })).status).toBe(200);
    const detail = await call("GET", `/v1/groups/${g.id}`, { token: first.token });
    expect(detail.data.group).toMatchObject({ ownerId: first.id, role: "owner", memberCount: 49 });
  });

  it("shares drafts with members, who can then play and race on them", async () => {
    const mom = await guest(); const kid = await guest(); const stranger = await guest();
    const g = await makeGroup(mom.token);
    await call("POST", "/v1/groups/join", { token: kid.token, json: { code: g.code } });
    const gameId = await makeGame(mom.token, "Draft race", { publish: false });

    expect((await call("GET", `/v1/games/${gameId}`, { token: kid.token })).status).toBe(404);
    expect((await call("GET", `/v1/games/${gameId}/versions/1/package`, { token: kid.token })).status).toBe(404);
    expect((await call("POST", `/v1/groups/${g.id}/games`, { token: kid.token, json: { gameId } })).status).toBe(404); // not kid's draft
    expect((await call("POST", `/v1/groups/${g.id}/games`, { token: stranger.token, json: { gameId } })).status).toBe(404);

    const shared = await call("POST", `/v1/groups/${g.id}/games`, { token: mom.token, json: { gameId } });
    expect(shared.status).toBe(201);
    expect(shared.data.game).toMatchObject({ id: gameId, status: "draft", latestVersion: 1 });

    const view = await call("GET", `/v1/games/${gameId}`, { token: kid.token });
    expect(view.data.game).toMatchObject({ id: gameId, latestVersion: 1, shared: true });
    expect((await call("GET", `/v1/games/${gameId}/versions/1`, { token: kid.token })).status).toBe(200);
    expect((await call("GET", `/v1/games/${gameId}/versions/1/package`, { token: kid.token })).status).toBe(200);
    expect((await call("POST", `/v1/games/${gameId}/plays`, { token: kid.token, json: { version: 1 } })).status).toBe(200);
    expect((await call("GET", `/v1/games/${gameId}`, { token: stranger.token })).status).toBe(404);
    expect((await call("GET", `/v1/games/${gameId}/versions/1/package`, { token: stranger.token })).status).toBe(404);

    const list = await call("GET", `/v1/groups/${g.id}/games`, { token: kid.token });
    expect(list.data.games).toEqual([expect.objectContaining({ id: gameId, sharedBy: expect.objectContaining({ id: mom.id }) })]);
    expect((await call("GET", `/v1/groups/${g.id}/games`, { token: stranger.token })).status).toBe(404);

    // group scope ranks only members
    await call("POST", "/v1/groups/join", { token: stranger.token, json: { code: g.code } });
    expect((await submit(kid.token, gameId, { value: 12 })).status).toBe(201);
    expect((await submit(mom.token, gameId, { value: 15 })).status).toBe(201);
    await call("POST", `/v1/groups/${g.id}/leave`, { token: stranger.token });
    expect((await submit(stranger.token, gameId, { value: 5 })).status).toBe(404);

    const lb = await board(mom.token, gameId, "fastest", `?scope=group:${g.id}`);
    expect(lb.data.entries.map((e: any) => [e.rank, e.user.id])).toEqual([[1, kid.id], [2, mom.id]]);
    expect(lb.data.me).toMatchObject({ rank: 2, value: 15 });
    expect((await board(stranger.token, gameId, "fastest", `?scope=group:${g.id}`)).status).toBe(404);

    // unshare: strangers-turned-ex-members and kid lose access
    expect((await call("DELETE", `/v1/groups/${g.id}/games/${gameId}`, { token: kid.token })).status).toBe(403);
    expect((await call("DELETE", `/v1/groups/${g.id}/games/${gameId}`, { token: mom.token })).status).toBe(200);
    expect((await call("GET", `/v1/games/${gameId}`, { token: kid.token })).status).toBe(404);
  });

  it("scopes a public board to a group's members", async () => {
    const a = await guest(); const b = await guest(); const c = await guest();
    const gameId = await makeGame(a.token, "Public race");
    const g = await makeGroup(b.token);
    await call("POST", "/v1/groups/join", { token: c.token, json: { code: g.code } });
    await submit(a.token, gameId, { value: 5 });
    await submit(b.token, gameId, { value: 9 });
    await submit(c.token, gameId, { value: 7 });
    const pub = await board(c.token, gameId, "fastest");
    expect(pub.data.me.rank).toBe(2);
    const grp = await board(c.token, gameId, "fastest", `?scope=group:${g.id}`);
    expect(grp.data.entries.map((e: any) => e.user.id)).toEqual([c.id, b.id]);
    expect(grp.data.me.rank).toBe(1);
  });
});
