// Real sockets on an ephemeral port: auth, limits, quick match, and two engine Games playing a duel through the server.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import { Package } from "@dreamsy/format";
import { Game } from "@dreamsy/engine/core";
import { LIMITS, RoomClient, RoomError, type ServerMsg } from "@dreamsy/engine/net";
import { startGameServer, type GameServer } from "../src/server.js";

const SECRET = "test-secret-test-secret-test-secret-42";
const ITOKEN = "worker-token-for-tests";
let gs: GameServer;
let url: string;

const token = (sub: string, secret = SECRET) =>
  new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(sub).setIssuedAt().setExpirationTime("1h").sign(new TextEncoder().encode(secret));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Raw socket: resolves with every message until close. */
function rawSocket(): Promise<{ ws: WebSocket; msgs: ServerMsg[]; closed: Promise<number> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const msgs: ServerMsg[] = [];
    const closed = new Promise<number>((r) => { ws.onclose = (e) => r(e.code); });
    ws.onmessage = (e) => msgs.push(JSON.parse(String(e.data)));
    ws.onopen = () => resolve({ ws, msgs, closed });
    ws.onerror = () => reject(new Error("socket error"));
  });
}

beforeAll(async () => {
  gs = await startGameServer({ jwtSecret: SECRET, port: 0, host: "127.0.0.1", heartbeatMs: 60_000, log: () => {}, internalToken: ITOKEN });
  url = `ws://127.0.0.1:${gs.port}/rooms`;
});
afterAll(async () => { await gs?.close(); });

describe("auth", () => {
  it("rejects a token signed with another secret, and a first message that isn't hello", async () => {
    const bad = await token("u_1", "another-secret-another-secret-another");
    await expect(RoomClient.connect(url, bad)).rejects.toMatchObject({ code: "unauthorized" });
    await expect(RoomClient.connect(url, "not-a-jwt")).rejects.toBeInstanceOf(RoomError);
    const s = await rawSocket();
    s.ws.send(JSON.stringify({ t: "quick", game: "g" }));
    expect(await s.closed).toBe(4001);
    expect(s.msgs[0]).toMatchObject({ t: "error", code: "unauthorized" });
  });

  it("welcomes a valid token with a per-connection player id and the hello name", async () => {
    const t = await token("u_ann");
    const [c1, c2] = await Promise.all([RoomClient.connect(url, t, "Ann <3"), RoomClient.connect(url, t, "Ann")]);
    expect(c1.userId).toBe("u_ann");
    expect(c1.name).toBe("Ann 3");
    expect(c1.self).not.toBe(c2.self); // two tabs of one account = two players
    c1.close(); c2.close();
  });
});

describe("limits", () => {
  it("rejects oversized messages and rate-limits floods, then disconnects abusers", async () => {
    const s = await rawSocket();
    s.ws.send(JSON.stringify({ t: "hello", token: await token("u_flood") }));
    await sleep(100);
    s.ws.send(JSON.stringify({ t: "ping", c: 1, pad: "x".repeat(LIMITS.maxMessageBytes + 10) }));
    await sleep(50);
    expect(s.msgs.some((m) => m.t === "error" && m.code === "too_large")).toBe(true);
    for (let i = 0; i < 200; i++) s.ws.send(JSON.stringify({ t: "ping", c: i }));
    await sleep(150);
    const pongs = s.msgs.filter((m) => m.t === "pong").length;
    expect(pongs).toBeGreaterThan(LIMITS.msgsBurst - 10);
    expect(pongs).toBeLessThan(150);
    expect(s.msgs.some((m) => m.t === "error" && m.code === "rate_limited")).toBe(true);
    for (let i = 0; i < LIMITS.maxDrops + 50; i++) s.ws.send(JSON.stringify({ t: "ping", c: i }));
    expect(await s.closed).toBe(4008);
  });

  it("answers malformed messages with bad_message", async () => {
    const c = await RoomClient.connect(url, await token("u_x"));
    const err = c.waitFor((m): m is Extract<ServerMsg, { t: "error" }> => m.t === "error");
    c.send({ t: "st", s: ["only", "garbage"] } as never);
    await expect(err).resolves.toMatchObject({ code: "bad_message" });
    c.close();
  });
});

describe("rooms over sockets", () => {
  it("create → join by code → both see the room; leave updates the other", async () => {
    const [a, b] = await Promise.all([RoomClient.connect(url, await token("u_a"), "Mom"), RoomClient.connect(url, await token("u_b"), "Kid")]);
    const created = a.waitFor((m): m is Extract<ServerMsg, { t: "room" }> => m.t === "room");
    a.create("local:family", 4, { min: 2 });
    const code = (await created).room.code;
    const joined = a.waitFor((m): m is Extract<ServerMsg, { t: "room" }> => m.t === "room" && m.room.players.length === 2);
    b.join(code);
    expect((await joined).room.players.map((p) => [p.name, p.team])).toEqual([["Mom", "red"], ["Kid", "blue"]]);
    const left = a.waitFor((m): m is Extract<ServerMsg, { t: "room" }> => m.t === "room" && m.room.players.length === 1);
    b.close();
    expect((await left).room.host).toBe(a.self);
    a.close();
  });
});

// ---------------------------------------------------------------- two engine Games through the server
const files = {
  "dreamsy.toml": `format = "0"\nname = "Duel"\ndimension = "2d"\nentry_scene = "scenes/main.scene.json"\n[players]\nmin = 2\nmax = 2\n[server]\nmode = "rooms"\n[style]\npreset = "pixel"\npalette = ["#101020", "#3355ff", "#ffcc00", "#f0f0f0"]\n`,
  "scenes/main.scene.json": JSON.stringify({
    format: "0", root: "world",
    entities: {
      world: { type: "Node2D", children: ["hero"] },
      hero: { type: "Node2D", tags: ["player"], props: { position: [100, 100] }, children: ["s"], scripts: ["scripts/client/hero.luau"] },
      s: { type: "Sprite2D", props: { size: [16, 16] } },
    },
  }),
  "scripts/shared/net.luau": `return { tag = remoteEvent("tag") }`,
  "scripts/client/hero.luau": `
    local net = require("../shared/net")
    local me = script.entity
    room.replicate(me)
    local t = 0
    onTick(function(dt)
      t += dt
      if players["local"].team == "blue" then me.position = vec2(100 + t * 60, 100) end
    end)
    net.tag:onServer(function(from, n) print("tagged by", from.team, n) room.finish(from) end)
    room.ended:connect(function(r) print("winner", r.winner.team, r.reason) end)
    after(0.6, function() if players["local"].team == "blue" then net.tag:fireServer(1) end end)
  `,
};

describe("two Games, one duel, real sockets", () => {
  it("quick match pairs red vs blue; avatars replicate, fireServer reaches the host, the finish reaches both", async () => {
    const [a, b] = await Promise.all([RoomClient.connect(url, await token("u_red"), "Red"), RoomClient.connect(url, await token("u_blue"), "Blue")]);
    const isStart = (m: ServerMsg): m is Extract<ServerMsg, { t: "start" }> => m.t === "start";
    const [sa, sb] = [a.waitFor(isStart), b.waitFor(isStart)];
    a.quick("local:duel");
    await sleep(30);
    b.quick("local:duel");
    const [ra, rb] = await Promise.all([sa, sb]);
    expect(ra.room.code).toBe(rb.room.code);
    expect(ra.room.players.map((p) => p.team)).toEqual(["red", "blue"]);
    const endedA = a.waitFor((m): m is Extract<ServerMsg, { t: "ended" }> => m.t === "ended", 10_000);

    const ga = await Game.load(Package.fromFiles(files), { net: a.link() });
    const gb = await Game.load(Package.fromFiles(files), { net: b.link() });
    for (let i = 0; i < 70; i++) { await sleep(15); ga.step(); gb.step(); }
    expect(ga.errors).toEqual([]);
    expect(gb.errors).toEqual([]);
    // red's view of blue: a puppet moving right, behind blue's real position
    const puppet = ga.net.puppet(b.self)!;
    expect(puppet).toBeTruthy();
    const px = puppet.get<number[]>("position")[0]!;
    const bx = gb.world.byId.get("hero")!.get<number[]>("position")[0]!;
    expect(px).toBeGreaterThan(110);
    expect(px).toBeLessThanOrEqual(bx + 1);
    expect(gb.net.puppet(a.self)).toBeTruthy();
    // fireServer from blue ran on red (host), which finished the match for blue
    const la = ga.logs.map((l) => l.text), lbl = gb.logs.map((l) => l.text);
    expect(la).toContain("tagged by\tblue\t1");
    expect(lbl.some((l) => l.startsWith("tagged by"))).toBe(false);
    expect(la).toContain("winner\tblue\tfinish");
    expect(lbl).toContain("winner\tblue\tfinish");
    expect((await endedA).r).toMatchObject({ winner: b.self, team: "blue" });
    a.close(); b.close();
  });
});

describe("spectating over sockets", () => {
  it("a spectator watches a running duel: gets start + relays, can't play, isn't a player", async () => {
    const [a, b, s] = await Promise.all([
      RoomClient.connect(url, await token("u_sa"), "A"), RoomClient.connect(url, await token("u_sb"), "B"), RoomClient.connect(url, await token("u_ss"), "Watcher"),
    ]);
    const isStart = (m: ServerMsg): m is Extract<ServerMsg, { t: "start" }> => m.t === "start";
    const started = Promise.all([a.waitFor(isStart), b.waitFor(isStart)]);
    a.quick("local:spec");
    await sleep(30);
    b.quick("local:spec");
    const [ra] = await started;
    const sStart = s.waitFor(isStart);
    s.spectate(ra.room.code.toLowerCase(), "local:spec");
    const st = await sStart;
    expect(st.spectator).toBe(true);
    expect(s.spectator).toBe(true);
    expect(st.room.players.map((p) => p.name)).toEqual(["A", "B"]);
    expect(st.room.spectators).toBe(1);
    const link = s.link();
    expect(link.spectator).toBe(true);
    // relays reach the spectator
    a.send({ t: "kv", k: "round", v: 1 });
    a.send({ t: "st", s: ["s", 5, 6, 0, 0, "", 1, "h"] });
    await sleep(80);
    const got = link.poll().map((m) => m.t);
    expect(got).toContain("kv");
    expect(got).toContain("st");
    // gameplay messages are refused
    const err = s.waitFor((m): m is Extract<ServerMsg, { t: "error" }> => m.t === "error");
    s.send({ t: "score", k: "red", d: 1 });
    await expect(err).resolves.toMatchObject({ code: "spectator" });
    a.close(); b.close(); s.close();
  });
});

describe("GET /internal/presence", () => {
  const presence = (users: string, tok?: string) =>
    fetch(`http://127.0.0.1:${gs.port}/internal/presence?users=${users}`, { headers: tok ? { "x-internal-token": tok } : {} });

  it("needs the worker token", async () => {
    expect((await presence("u_x")).status).toBe(401);
    expect((await presence("u_x", "wrong")).status).toBe(401);
    const ok = await presence("u_never_seen", ITOKEN);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ presence: { u_never_seen: { status: "offline" } } });
  });

  it("reports online / in_room for connected users", async () => {
    const [a, b] = await Promise.all([RoomClient.connect(url, await token("u_pres_a"), "A"), RoomClient.connect(url, await token("u_pres_b"), "B")]);
    const created = a.waitFor((m): m is Extract<ServerMsg, { t: "room" }> => m.t === "room");
    a.create("g_presence", 4);
    const code = (await created).room.code;
    const res = await presence("u_pres_a,u_pres_b,u_nobody", ITOKEN);
    expect(await res.json()).toEqual({ presence: {
      u_pres_a: { status: "in_room", gameId: "g_presence", roomCode: code, mode: "party", players: 1, max: 4, spectatable: true },
      u_pres_b: { status: "online" },
      u_nobody: { status: "offline" },
    } });
    a.close(); b.close();
  });

  it("is disabled without a configured token", async () => {
    const other = await startGameServer({ jwtSecret: SECRET, port: 0, host: "127.0.0.1", log: () => {} });
    const res = await fetch(`http://127.0.0.1:${other.port}/internal/presence?users=u_x`, { headers: { "x-internal-token": "" } });
    expect(res.status).toBe(503);
    await other.close();
  });
});

describe("GET /internal/live", () => {
  const live = (tok?: string) => fetch(`http://127.0.0.1:${gs.port}/internal/live`, { headers: tok ? { "x-internal-token": tok } : {} });

  it("needs the worker token", async () => {
    expect((await live()).status).toBe(401);
    expect((await live("wrong")).status).toBe(401);
    expect((await live(ITOKEN)).status).toBe(200);
    const other = await startGameServer({ jwtSecret: SECRET, port: 0, host: "127.0.0.1", log: () => {} });
    expect((await fetch(`http://127.0.0.1:${other.port}/internal/live`, { headers: { "x-internal-token": "x" } })).status).toBe(503);
    await other.close();
  });

  it("lists rooms (lobby / running) and counts distinct online users", async () => {
    const before = (await (await live(ITOKEN)).json()) as { online: number };
    const [a, a2, b, c] = await Promise.all([
      RoomClient.connect(url, await token("u_live_a"), "A"), RoomClient.connect(url, await token("u_live_a"), "A2"),
      RoomClient.connect(url, await token("u_live_b"), "B"), RoomClient.connect(url, await token("u_live_c"), "C"),
    ]);
    const created = a.waitFor((m): m is Extract<ServerMsg, { t: "room" }> => m.t === "room");
    a.create("g_live", 4);
    const code = (await created).room.code;
    const res = await live(ITOKEN);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { online: number; rooms: { gameId: string }[] };
    expect(body.online).toBe(before.online + 3); // a's two tabs count once
    expect(body.rooms.filter((r) => r.gameId === "g_live")).toEqual([
      { code, gameId: "g_live", mode: "party", state: "lobby", players: ["u_live_a"], max: 4, spectators: 0, spectatable: true },
    ]);
    a.close(); a2.close(); b.close(); c.close();
  });
});
