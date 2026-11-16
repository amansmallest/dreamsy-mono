// RoomManager: lifecycle, quick match, teams, ready/start, relay routing, state/scores, results.
import { describe, expect, it } from "vitest";
import type { ClientMsg, ServerMsg } from "@dreamsy/engine/net";
import { RoomManager, type Peer } from "../src/rooms.js";

type FakePeer = Peer & { inbox: ServerMsg[]; last<T extends ServerMsg["t"]>(t: T): Extract<ServerMsg, { t: T }> | undefined; clear(): void };
let n = 0;
function peer(name = `p${++n}`): FakePeer {
  const inbox: ServerMsg[] = [];
  return {
    id: `id_${name}`, userId: `u_${name}`, name, inbox,
    send: (m) => inbox.push(structuredClone(m)),
    last: (t) => [...inbox].reverse().find((m) => m.t === t) as never,
    clear: () => { inbox.length = 0; },
  };
}

describe("rooms: create / join / full / leave", () => {
  it("creates a 6-char code room, joins by code (any case), fills up, migrates host, deletes when empty", () => {
    const rm = new RoomManager();
    const a = peer("ann"), b = peer("bo"), c = peer("cy");
    rm.handle(a, { t: "create", game: "g_1", max: 2 });
    const room = a.last("room")!.room;
    expect(room.code).toMatch(/^[A-Z2-9]{6}$/);
    expect(room.host).toBe(a.id);
    expect(room.players.map((p) => [p.name, p.team])).toEqual([["ann", "red"]]);
    rm.handle(b, { t: "join", code: room.code.toLowerCase() });
    expect(b.last("room")!.room.players.map((p) => [p.name, p.team])).toEqual([["ann", "red"], ["bo", "blue"]]);
    expect(a.last("room")!.room.players).toHaveLength(2);
    rm.handle(c, { t: "join", code: room.code });
    expect(c.last("error")!.code).toBe("full");
    rm.handle(c, { t: "join", code: "ZZZZZZ" });
    expect(c.last("error")!.code).toBe("not_found");
    rm.handle(a, { t: "leave" });
    expect(a.last("left")).toBeTruthy();
    expect(b.last("room")!.room.host).toBe(b.id);
    rm.disconnect(b);
    expect(rm.rooms.size).toBe(0);
  });

  it("clamps max to 8, rejects joining another game, and keeps one room per connection", () => {
    const rm = new RoomManager();
    const a = peer(), b = peer();
    rm.handle(a, { t: "create", game: "g_1", max: 50 });
    const code = a.last("room")!.room.code;
    expect(a.last("room")!.room.max).toBe(8);
    rm.handle(a, { t: "create", game: "g_1", max: 4 });
    expect(a.last("error")!.code).toBe("in_room");
    rm.handle(b, { t: "join", code, game: "g_2" });
    expect(b.last("error")!.code).toBe("wrong_game");
  });

  it("party: balanced teams, team switch, host starts only when everyone is ready, late join", () => {
    const rm = new RoomManager();
    const [a, b, c, d] = [peer(), peer(), peer(), peer()];
    rm.handle(a, { t: "create", game: "g", max: 8, min: 2 });
    const code = a.last("room")!.room.code;
    rm.handle(a, { t: "start" });
    expect(a.last("error")!.code).toBe("not_ready"); // min 2
    rm.handle(b, { t: "join", code });
    rm.handle(c, { t: "join", code });
    expect(c.last("room")!.room.players.map((p) => p.team)).toEqual(["red", "blue", "red"]);
    rm.handle(c, { t: "team", team: "blue" });
    expect(a.last("room")!.room.players.map((p) => p.team)).toEqual(["red", "blue", "blue"]);
    rm.handle(b, { t: "start" });
    expect(b.last("error")!.code).toBe("not_host");
    rm.handle(b, { t: "ready", v: true });
    rm.handle(a, { t: "start" });
    expect(a.last("error")!.code).toBe("not_ready");
    rm.handle(c, { t: "ready", v: true });
    rm.handle(a, { t: "start" });
    const s = c.last("start")!;
    expect(s.room.status).toBe("playing");
    expect(s.room.match).toBe(1);
    expect(s.you).toBe(c.id);
    expect(a.last("start")!.room.seed).toBe(s.room.seed);
    rm.handle(d, { t: "join", code });
    expect(d.last("start")!.room.players).toHaveLength(4); // dropped into the running match
    expect(a.last("room")!.room.players).toHaveLength(4);
  });
});

describe("rooms: quick match 1v1", () => {
  it("pairs two players of the same game into a red/blue duel that starts immediately", () => {
    const rm = new RoomManager();
    const a = peer(), b = peer(), x = peer();
    rm.handle(a, { t: "quick", game: "g_race" });
    expect(a.last("queued")).toBeTruthy();
    rm.handle(x, { t: "quick", game: "g_other" });
    rm.handle(a, { t: "quick", game: "g_race" }); // re-queue is idempotent, never pairs with itself
    expect(a.last("start")).toBeUndefined();
    rm.handle(b, { t: "quick", game: "g_race" });
    const sa = a.last("start")!, sb = b.last("start")!;
    expect(sa.room.code).toBe(sb.room.code);
    expect(sa.room.mode).toBe("duel");
    expect(sa.room.players.map((p) => p.team)).toEqual(["red", "blue"]);
    expect(x.last("start")).toBeUndefined();
    expect(rm.queue.get("g_other")).toBe(x);
    rm.handle(x, { t: "cancel" });
    expect(rm.queue.size).toBe(0);
  });

  it("forfeit when the opponent leaves mid-match; rematch starts when both are ready", () => {
    const rm = new RoomManager();
    const a = peer(), b = peer(), c = peer();
    rm.handle(a, { t: "quick", game: "g" });
    rm.handle(b, { t: "quick", game: "g" });
    rm.handle(a, { t: "end", w: b.id });
    expect(a.last("ended")!.r).toMatchObject({ winner: b.id, team: "blue", draw: false, reason: "finish", match: 1 });
    a.clear(); b.clear();
    rm.handle(a, { t: "ready", v: true });
    expect(a.last("start")).toBeUndefined();
    rm.handle(b, { t: "ready", v: true });
    expect(a.last("start")!.room.match).toBe(2);
    rm.disconnect(b);
    expect(a.last("ended")!.r).toMatchObject({ winner: a.id, reason: "forfeit", match: 2 });
    // disconnecting while queued leaves the queue
    rm.handle(c, { t: "quick", game: "g2" });
    rm.disconnect(c);
    expect(rm.queue.size).toBe(0);
  });
});

describe("rooms: in-match relay", () => {
  function duel() {
    const rm = new RoomManager();
    const a = peer(), b = peer(), c = peer();
    rm.handle(a, { t: "create", game: "g", max: 3 });
    const code = a.last("room")!.room.code;
    rm.handle(b, { t: "join", code });
    rm.handle(c, { t: "join", code });
    rm.handle(b, { t: "ready", v: true });
    rm.handle(c, { t: "ready", v: true });
    rm.handle(a, { t: "start" });
    for (const p of [a, b, c]) p.clear();
    return { rm, a, b, c };
  }

  it("relays avatar samples to the others with a server timestamp", () => {
    const { rm, a, b, c } = duel();
    rm.handle(b, { t: "st", s: ["scenes/main.scene.json", 1, 2, 0, 0, "", 1, "hero"] });
    expect(a.last("st")).toMatchObject({ id: b.id, s: ["scenes/main.scene.json", 1, 2, 0, 0, "", 1, "hero"] });
    expect(typeof c.last("st")!.ts).toBe("number");
    expect(b.last("st")).toBeUndefined();
  });

  it("routes events: host / others / one player", () => {
    const { rm, a, b, c } = duel();
    rm.handle(b, { t: "ev", n: "hit", to: "host", a: [1] });
    expect(a.last("ev")).toMatchObject({ from: b.id, n: "hit", to: "host", a: [1] });
    expect(c.last("ev")).toBeUndefined();
    a.clear();
    rm.handle(a, { t: "ev", n: "boom", to: "others", a: [] });
    expect(b.last("ev")!.n).toBe("boom");
    expect(c.last("ev")!.n).toBe("boom");
    expect(a.last("ev")).toBeUndefined();
    c.clear(); b.clear();
    rm.handle(a, { t: "ev", n: "dm", to: c.id, a: ["hi"] });
    expect(c.last("ev")!.a).toEqual(["hi"]);
    expect(b.last("ev")).toBeUndefined();
    rm.handle(a, { t: "ev", n: "dm", to: "nobody", a: [] });
    expect(a.last("error")!.code).toBe("bad_message");
  });

  it("state, authoritative score totals, first end wins, size limits", () => {
    const { rm, a, b, c } = duel();
    rm.handle(a, { t: "kv", k: "round", v: 2 });
    expect(b.last("kv")).toMatchObject({ k: "round", v: 2, from: a.id });
    rm.handle(a, { t: "score", k: "red", d: 2 });
    rm.handle(b, { t: "score", k: "red", d: 3 });
    expect(c.last("score")).toEqual({ t: "score", k: "red", v: 5 });
    expect(a.last("score")).toEqual({ t: "score", k: "red", v: 5 });
    rm.handle(a, { t: "score", k: "green", d: 1 });
    expect(a.last("error")!.code).toBe("bad_message");
    rm.handle(a, { t: "ev", n: "big", to: "others", a: ["x".repeat(5000)] });
    expect(a.last("error")!.code).toBe("too_large");
    rm.handle(b, { t: "end", w: "red" });
    rm.handle(c, { t: "end", w: c.id });
    const ended = a.inbox.filter((m) => m.t === "ended");
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ r: { team: "red", winner: null, draw: false, scores: { red: 5 } } });
    expect(rm.results(a.last("room")!.room.code)).toHaveLength(1);
    // after the match: game messages are dropped quietly
    b.clear();
    rm.handle(a, { t: "st", s: ["s", 0, 0, 0, 0, "", 1, "h"] });
    expect(b.last("st")).toBeUndefined();
  });
});

describe("rooms: spectators", () => {
  function match() {
    const rm = new RoomManager();
    const a = peer(), b = peer();
    rm.handle(a, { t: "create", game: "g", max: 2, min: 2 });
    const code = a.last("room")!.room.code;
    rm.handle(b, { t: "join", code });
    return { rm, a, b, code };
  }

  it("spectate joins as a watcher: not a player, not counted in max, sees spectators in room messages", () => {
    const { rm, a, b, code } = match();
    const s = peer("watcher"), late = peer();
    rm.handle(s, { t: "spectate", code: code.toLowerCase() });
    const rs = s.last("room")!;
    expect(rs.spectator).toBe(true);
    expect(rs.you).toBe(s.id);
    expect(rs.room.players.map((p) => p.id)).toEqual([a.id, b.id]);
    expect(rs.room.spectators).toBe(1);
    expect(a.last("room")!.room.spectators).toBe(1);
    expect(a.last("room")!.spectator).toBeUndefined();
    // the room is full for players (2/2) but the spectator didn't take a seat
    rm.handle(late, { t: "join", code });
    expect(late.last("error")!.code).toBe("full");
    rm.handle(s, { t: "spectate", code });
    expect(s.last("error")!.code).toBe("in_room");
    rm.handle(s, { t: "join", code });
    expect(s.last("error")!.code).toBe("in_room");
    rm.handle(late, { t: "spectate", code: "ZZZZZZ" });
    expect(late.last("error")!.code).toBe("not_found");
    rm.handle(late, { t: "spectate", code, game: "other" });
    expect(late.last("error")!.code).toBe("wrong_game");
    // leave: count goes down
    rm.handle(s, { t: "leave" });
    expect(s.last("left")).toBeTruthy();
    expect(a.last("room")!.room.spectators).toBe(0);
    expect(rm.room(code)!.players).toHaveLength(2);
  });

  it("a spectator can't send gameplay messages", () => {
    const { rm, a, b, code } = match();
    const s = peer();
    rm.handle(s, { t: "spectate", code });
    for (const m of [{ t: "ready", v: true }, { t: "start" }, { t: "team", team: "blue" }] as const) {
      s.clear();
      rm.handle(s, m);
      expect(s.last("error")!.code).toBe("spectator");
    }
    rm.handle(b, { t: "ready", v: true });
    rm.handle(a, { t: "start" });
    expect(rm.room(code)!.status).toBe("playing");
    a.clear(); b.clear();
    const msgs: ClientMsg[] = [
      { t: "ev", n: "x", to: "others", a: [] }, { t: "ev", n: "x", to: "host", a: [] }, { t: "kv", k: "k", v: 1 },
      { t: "score", k: "red", d: 5 }, { t: "end", w: "red" },
    ];
    for (const m of msgs) { s.clear(); rm.handle(s, m); expect(s.last("error")!.code).toBe("spectator"); }
    rm.handle(s, { t: "st", s: ["s", 1, 1, 0, 0, "", 1, "h"] }); // dropped quietly
    expect(a.inbox).toEqual([]);
    expect(b.inbox).toEqual([]);
    expect(rm.room(code)!.scores).toEqual({});
    expect(rm.room(code)!.status).toBe("playing");
  });

  it("receives everything players receive: start, st, ev to others, kv, score, ended, room", () => {
    const { rm, a, b, code } = match();
    const s = peer();
    rm.handle(s, { t: "spectate", code });
    rm.handle(b, { t: "ready", v: true });
    rm.handle(a, { t: "start" });
    const st = s.last("start")!;
    expect(st).toMatchObject({ spectator: true, you: s.id, room: { status: "playing", match: 1 } });
    rm.handle(a, { t: "st", s: ["s", 1, 2, 0, 0, "", 1, "h"] });
    expect(s.last("st")).toMatchObject({ id: a.id });
    rm.handle(a, { t: "ev", n: "orb", to: "others", a: [1] });
    expect(s.last("ev")).toMatchObject({ from: a.id, n: "orb" });
    s.clear();
    rm.handle(b, { t: "ev", n: "grab", to: "host", a: [1] });
    expect(s.last("ev")).toBeUndefined(); // host-only events stay with the host
    rm.handle(a, { t: "kv", k: "round", v: 3 });
    expect(s.last("kv")).toMatchObject({ k: "round", v: 3 });
    rm.handle(a, { t: "score", k: a.id, d: 2 });
    expect(s.last("score")).toEqual({ t: "score", k: a.id, v: 2 });
    rm.handle(a, { t: "end", w: a.id });
    expect(s.last("ended")!.r).toMatchObject({ winner: a.id, scores: { [a.id]: 2 } });
    expect(s.last("room")!.room.status).toBe("lobby");
  });

  it("late spectators get the running match, then the current state and scores at once", () => {
    const { rm, a, b, code } = match();
    rm.handle(b, { t: "ready", v: true });
    rm.handle(a, { t: "start" });
    rm.handle(a, { t: "kv", k: "round", v: 2 });
    rm.handle(b, { t: "score", k: "blue", d: 4 });
    const s = peer();
    rm.handle(s, { t: "spectate", code });
    const kinds = s.inbox.map((m) => m.t);
    expect(kinds).toEqual(["room", "start", "kv", "score"]);
    expect(s.last("start")!.room.state).toEqual({ round: 2 });
    expect(s.last("kv")).toMatchObject({ k: "round", v: 2 });
    expect(s.last("score")).toEqual({ t: "score", k: "blue", v: 4 });
  });

  it("caps spectators at 16 per room; a forfeit counts only players; spectators leave with the last player", () => {
    const { rm, a, b, code } = match();
    const ws = Array.from({ length: 16 }, () => peer());
    for (const w of ws) rm.handle(w, { t: "spectate", code });
    expect(rm.room(code)!.spectators).toBe(16);
    const x = peer();
    rm.handle(x, { t: "spectate", code });
    expect(x.last("error")!.code).toBe("full");
    rm.disconnect(ws[0]!);
    expect(rm.room(code)!.spectators).toBe(15);
    rm.handle(x, { t: "spectate", code });
    expect(x.last("room")!.room.spectators).toBe(16);
    rm.handle(b, { t: "ready", v: true });
    rm.handle(a, { t: "start" });
    rm.disconnect(b);
    expect(x.last("ended")!.r).toMatchObject({ winner: a.id, reason: "forfeit" });
    rm.disconnect(a);
    expect(x.last("left")).toBeTruthy();
    expect(rm.rooms.size).toBe(0);
    expect(rm.spectatorCount).toBe(0);
  });
});

describe("presence", () => {
  it("online / in_room / in_match per user id, offline 60 s after the last connection closes", () => {
    let now = 1_000_000;
    const rm = new RoomManager({ now: () => now });
    const a = peer("pa"), b = peer("pb"), s = peer("ps"), a2 = { ...peer("pa2"), userId: "u_pa" };
    expect(rm.presence(["u_pa"])).toEqual({ u_pa: { status: "offline" } });
    for (const p of [a, a2, b, s]) rm.connect(p);
    expect(rm.presence(["u_pa", "u_zz"])).toEqual({ u_pa: { status: "online" }, u_zz: { status: "offline" } });
    rm.handle(a, { t: "create", game: "g_duel", max: 2, min: 2 });
    const code = a.last("room")!.room.code;
    expect(rm.presence(["u_pa"]).u_pa).toEqual({ status: "in_room", gameId: "g_duel", roomCode: code, mode: "party", players: 1, max: 2, spectatable: true });
    rm.handle(b, { t: "join", code });
    rm.handle(s, { t: "spectate", code });
    rm.handle(b, { t: "ready", v: true });
    rm.handle(a, { t: "start" });
    const pr = rm.presence(["u_pa", "u_pb", "u_ps"]);
    expect(pr.u_pa).toMatchObject({ status: "in_match", roomCode: code, players: 2, max: 2 });
    expect(pr.u_pb!.status).toBe("in_match");
    expect(pr.u_ps).toEqual({ status: "online" }); // watching isn't playing
    // the second tab closing doesn't matter; the last connection closing → online for 60 s, then offline
    rm.disconnect(a2);
    expect(rm.presence(["u_pa"]).u_pa!.status).toBe("in_match");
    rm.disconnect(a);
    expect(rm.presence(["u_pa"]).u_pa).toEqual({ status: "online" });
    now += 59_000;
    expect(rm.presence(["u_pa"]).u_pa!.status).toBe("online");
    now += 2_000;
    expect(rm.presence(["u_pa"]).u_pa!.status).toBe("offline");
  });
});

describe("live", () => {
  it("lists rooms as lobby / running and counts distinct users online within 60 s", () => {
    let now = 2_000_000;
    const rm = new RoomManager({ now: () => now });
    const a = peer("la"), b = peer("lb"), s = peer("ls"), a2 = { ...peer("la2"), userId: "u_la" };
    for (const p of [a, a2, b, s]) rm.connect(p);
    expect(rm.live()).toEqual({ online: 3, rooms: [] });
    rm.handle(a, { t: "create", game: "g_l", max: 2, min: 2 });
    const code = a.last("room")!.room.code;
    expect(rm.live().rooms).toEqual([{ code, gameId: "g_l", mode: "party", state: "lobby", players: ["u_la"], max: 2, spectators: 0, spectatable: true }]);
    rm.handle(b, { t: "join", code });
    rm.handle(s, { t: "spectate", code });
    rm.handle(b, { t: "ready", v: true });
    rm.handle(a, { t: "start" });
    expect(rm.live().rooms).toEqual([{ code, gameId: "g_l", mode: "party", state: "running", players: ["u_la", "u_lb"], max: 2, spectators: 1, spectatable: true }]);
    rm.disconnect(s);
    expect(rm.live().online).toBe(3); // within the grace window
    now += 61_000;
    expect(rm.live().online).toBe(2);
  });
});
