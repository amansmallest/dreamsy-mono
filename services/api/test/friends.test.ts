import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { fail, type Config, type IdentityVerifier, type PushMessage } from "../src/context.js";
import { schema, type DB } from "../src/db/client.js";
import type { Presence, PresenceFetcher } from "../src/presence.js";
import { flushPushes } from "../src/push.js";
import { MemoryStorage } from "../src/storage.js";

/** docs/platform.md §13.4: friends, invites, presence. */

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

let app: ReturnType<typeof createApp>;
let pushed: PushMessage[];
let presence: Record<string, Presence>;
let presenceCalls: string[][];
let presenceFails: boolean;

beforeEach(async () => {
  const d = drizzle(new PGlite(), { schema });
  await migrate(d, { migrationsFolder: MIGRATIONS });
  pushed = [];
  presence = {};
  presenceCalls = [];
  presenceFails = false;
  const fetcher: PresenceFetcher = async (ids) => {
    presenceCalls.push(ids);
    if (presenceFails) throw new Error("down");
    return presence;
  };
  app = createApp({
    db: d as unknown as DB, storage: new MemoryStorage(), config, identity, presence: fetcher,
    pusher: async (messages) => { pushed.push(...messages); return messages.map(() => ({ status: "ok" as const })); },
  });
});

async function call(method: string, path: string, opts: { token?: string; json?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.json !== undefined) headers["content-type"] = "application/json";
  const res = await app.request(path, { method, headers, body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined });
  const text = await res.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch {}
  return { status: res.status, data };
}

async function user(handle: string) {
  const { data } = await call("POST", "/v1/auth/guest");
  const token = data.token as string;
  expect((await call("PATCH", "/v1/me", { token, json: { handle } })).status).toBe(200);
  await call("POST", "/v1/me/push-tokens", { token, json: { token: `ExponentPushToken[${handle}]`, platform: "ios" } });
  return { token, id: data.user.id as string, handle };
}

const request = (from: { token: string }, handle: string) => call("POST", "/v1/friends/requests", { token: from.token, json: { handle } });
const friendsOf = async (u: { token: string }) => (await call("GET", "/v1/me/friends", { token: u.token })).data;
const inbox = async (u: { token: string }) => (await call("GET", "/v1/me/notifications", { token: u.token })).data.items as any[];

async function befriend(a: { token: string; id: string }, b: { token: string; id: string; handle: string }) {
  expect((await request(a, b.handle)).status).toBe(201);
  expect((await call("POST", `/v1/friends/requests/${a.id}/accept`, { token: b.token })).status).toBe(200);
}

describe("friend requests", () => {
  it("request → incoming/outgoing → accept → friends, with notifications + push", async () => {
    const ann = await user("ann");
    const bob = await user("bob");
    const r = await request(ann, "@Bob");
    expect(r.status).toBe(201);
    expect(r.data.request).toEqual({ id: bob.id, user: { id: bob.id, handle: "bob", avatar: null }, status: "pending", direction: "outgoing" });

    expect((await friendsOf(ann)).outgoing.map((x: any) => x.user.id)).toEqual([bob.id]);
    const bobs = await friendsOf(bob);
    expect(bobs.incoming.map((x: any) => x.user.handle)).toEqual(["ann"]);
    expect(typeof bobs.incoming[0].at).toBe("string");
    expect(bobs.friends).toEqual([]);

    const [req] = await inbox(bob);
    expect(req).toMatchObject({ kind: "friend_request", body: "@ann wants to be friends", data: { fromUserId: ann.id } });

    // Repeat request: idempotent, no second notification.
    expect((await request(ann, "bob")).status).toBe(201);
    expect((await inbox(bob)).length).toBe(1);

    const acc = await call("POST", `/v1/friends/requests/${ann.id}/accept`, { token: bob.token });
    expect(acc.status).toBe(200);
    expect(acc.data.friend).toMatchObject({ user: { id: ann.id, handle: "ann" }, presence: { status: "offline" } });
    expect(typeof acc.data.friend.since).toBe("string");

    const [accepted] = await inbox(ann);
    expect(accepted).toMatchObject({ kind: "friend_accept", body: "@bob accepted your friend request", data: { fromUserId: bob.id } });

    for (const u of [ann, bob]) {
      const f = await friendsOf(u);
      expect(f.friends.length).toBe(1);
      expect(f.incoming).toEqual([]);
      expect(f.outgoing).toEqual([]);
    }
    await flushPushes();
    expect(pushed.map((m) => [m.to, m.data.kind])).toEqual([
      ["ExponentPushToken[bob]", "friend_request"],
      ["ExponentPushToken[ann]", "friend_accept"],
    ]);
  });

  it("auto-accepts when the other side already asked", async () => {
    const ann = await user("ann");
    const bob = await user("bob");
    await request(ann, "bob");
    const r = await request(bob, "ann");
    expect(r.status).toBe(200);
    expect(r.data.friend.user.id).toBe(ann.id);
    expect((await friendsOf(ann)).friends[0].user.id).toBe(bob.id);
    expect((await inbox(ann))[0].kind).toBe("friend_accept");
  });

  it("decline, cancel, unfriend", async () => {
    const ann = await user("ann");
    const bob = await user("bob");
    await request(ann, "bob");
    expect((await call("POST", `/v1/friends/requests/${ann.id}/decline`, { token: bob.token })).data).toEqual({ ok: true });
    expect((await friendsOf(ann)).outgoing).toEqual([]);
    expect((await friendsOf(bob)).incoming).toEqual([]);

    await request(ann, "bob");
    expect((await call("DELETE", `/v1/friends/${bob.id}`, { token: ann.token })).data).toEqual({ ok: true }); // cancel
    expect((await friendsOf(bob)).incoming).toEqual([]);

    await befriend(ann, bob);
    expect((await call("DELETE", `/v1/friends/${ann.id}`, { token: bob.token })).status).toBe(200); // unfriend
    expect((await friendsOf(ann)).friends).toEqual([]);
    expect((await call("DELETE", `/v1/friends/${ann.id}`, { token: bob.token })).status).toBe(404);
  });

  it("404 / 409 / 400 cases", async () => {
    const ann = await user("ann");
    const bob = await user("bob");
    expect((await request(ann, "nobody")).status).toBe(404);
    expect((await request(ann, "ann")).status).toBe(400);
    expect((await call("POST", "/v1/friends/requests", { token: ann.token, json: {} })).status).toBe(400);
    expect((await call("POST", "/v1/friends/requests", { json: { handle: "bob" } })).status).toBe(401);
    // Nothing to accept / decline; can't accept your own outgoing request.
    expect((await call("POST", `/v1/friends/requests/${bob.id}/accept`, { token: ann.token })).status).toBe(404);
    expect((await call("POST", `/v1/friends/requests/${bob.id}/decline`, { token: ann.token })).status).toBe(404);
    await request(ann, "bob");
    expect((await call("POST", `/v1/friends/requests/${bob.id}/accept`, { token: ann.token })).status).toBe(404);
    expect((await call("POST", `/v1/friends/requests/${ann.id}/accept`, { token: bob.token })).status).toBe(200);
    expect((await request(ann, "bob")).status).toBe(409);
    expect((await request(bob, "ann")).status).toBe(409);
    expect((await call("POST", `/v1/friends/requests/${ann.id}/accept`, { token: bob.token })).status).toBe(409);
  });
});

describe("search", () => {
  it("handle prefix, excludes self, friendStatus, ≤ 20, LIKE wildcards are literal", async () => {
    const me = await user("sam");
    const friend = await user("sam_f");
    const inc = await user("sam_in");
    await user("sam_out");
    await user("samx");
    await user("tom");
    await befriend(me, friend);
    await request(inc, "sam");
    await request(me, "sam_out");

    const r = await call("GET", "/v1/users/search?q=SAM", { token: me.token });
    expect(r.status).toBe(200);
    expect(r.data.users.map((u: any) => [u.handle, u.friendStatus])).toEqual([
      ["sam_f", "friends"], ["sam_in", "incoming"], ["sam_out", "outgoing"], ["samx", "none"],
    ]);
    expect(Object.keys(r.data.users[0]).sort()).toEqual(["avatar", "friendStatus", "handle", "id"]);
    // "_" is literal, not a wildcard: "sam_" doesn't match "samx".
    expect((await call("GET", "/v1/users/search?q=sam_", { token: me.token })).data.users.map((u: any) => u.handle))
      .toEqual(["sam_f", "sam_in", "sam_out"]);
    expect((await call("GET", "/v1/users/search?q=", { token: me.token })).data.users).toEqual([]);
    expect((await call("GET", "/v1/users/search?q=sam")).status).toBe(401);

    for (let i = 0; i < 22; i++) await user(`zed${String(i).padStart(2, "0")}`);
    expect((await call("GET", "/v1/users/search?q=zed", { token: me.token })).data.users.length).toBe(20);
  });
});

describe("presence", () => {
  it("friends list carries presence from the room server, online first; failure → offline", async () => {
    const me = await user("me_");
    const a = await user("alpha");
    const b = await user("bravo");
    const c = await user("charlie");
    for (const u of [a, b, c]) await befriend(me, u);
    presence = {
      [c.id]: { status: "in_match", gameId: "g1", gameName: "Orb Duel", roomCode: "ABC234", mode: "duel", players: 2, max: 2, spectatable: true },
      [b.id]: { status: "online" },
      stranger: { status: "online" },
    };
    presenceCalls = [];
    const f = await friendsOf(me);
    expect(presenceCalls.length).toBe(1);
    expect([...presenceCalls[0]!].sort()).toEqual([a.id, b.id, c.id].sort());
    expect(f.friends.map((x: any) => [x.user.handle, x.presence.status])).toEqual([
      ["charlie", "in_match"], ["bravo", "online"], ["alpha", "offline"],
    ]);
    expect(f.friends[0].presence).toEqual(presence[c.id]);

    presenceFails = true;
    expect((await friendsOf(me)).friends.map((x: any) => x.presence.status)).toEqual(["offline", "offline", "offline"]);
  });

  it("no friends → no room-server call", async () => {
    const me = await user("lonely");
    expect((await friendsOf(me)).friends).toEqual([]);
    expect(presenceCalls).toEqual([]);
  });
});

describe("game invites", () => {
  it("friends only; game_invite notification + push payload; 10/min", async () => {
    const ann = await user("ann");
    const bob = await user("bob");
    const eve = await user("eve");
    const game = (await call("POST", "/v1/games", { token: ann.token, json: { name: "Orb Duel" } })).data.game;
    const invite = (to: string, roomCode = "abc234") =>
      call("POST", "/v1/invites", { token: ann.token, json: { userId: to, gameId: game.id, roomCode } });

    expect((await invite(bob.id)).status).toBe(403); // not friends yet
    await request(ann, "bob");
    expect((await invite(bob.id)).status).toBe(403); // pending isn't enough
    await call("POST", `/v1/friends/requests/${ann.id}/accept`, { token: bob.token });
    await flushPushes();
    pushed = [];

    const t0 = Date.now();
    const r = await invite(bob.id);
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ ok: true });
    const [n] = await inbox(bob);
    expect(n).toMatchObject({
      kind: "game_invite", title: "Game invite", body: "@ann invited you to play Orb Duel",
      data: { gameId: game.id, roomCode: "ABC234", fromUserId: ann.id, spectate: false },
    });
    const exp = Date.parse(n.data.expiresAt);
    expect(exp - t0).toBeGreaterThanOrEqual(10 * 60 * 1000 - 1000);
    expect(exp - t0).toBeLessThanOrEqual(10 * 60 * 1000 + 5000);

    await flushPushes();
    expect(pushed.length).toBe(1);
    expect(pushed[0]).toMatchObject({
      to: "ExponentPushToken[bob]", title: "Game invite", body: "@ann invited you to play Orb Duel",
      data: { kind: "game_invite", gameId: game.id, roomCode: "ABC234", expiresAt: n.data.expiresAt, fromUserId: ann.id, spectate: false },
    });
    expect(pushed[0]!.data).not.toHaveProperty("version"); // draft without a published version

    // Bad inputs.
    expect((await call("POST", "/v1/invites", { token: ann.token, json: { userId: ann.id, gameId: game.id, roomCode: "ABC234" } })).status).toBe(400);
    expect((await invite(bob.id, "!!")).status).toBe(400);
    expect((await call("POST", "/v1/invites", { token: ann.token, json: { userId: bob.id, gameId: "nope", roomCode: "ABC234" } })).status).toBe(404);
    expect((await call("POST", "/v1/invites", { token: ann.token, json: { userId: eve.id, gameId: game.id, roomCode: "ABC234" } })).status).toBe(403);

    // Rate limit: 10 per minute per sender (1 already sent).
    for (let i = 0; i < 9; i++) expect((await invite(bob.id)).status).toBe(200);
    expect((await invite(bob.id)).status).toBe(429);
  });

  it("can't invite into a game you can't see", async () => {
    const ann = await user("ann");
    const bob = await user("bob");
    await befriend(ann, bob);
    const draft = (await call("POST", "/v1/games", { token: bob.token, json: { name: "Secret", visibility: "private" } })).data.game;
    expect((await call("POST", "/v1/invites", { token: ann.token, json: { userId: bob.id, gameId: draft.id, roomCode: "ABC234" } })).status).toBe(404);
  });
});
