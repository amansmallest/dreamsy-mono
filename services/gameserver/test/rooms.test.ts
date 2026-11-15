// RoomManager: lifecycle, quick match, teams, ready/start, relay routing, state/scores, results.
import { describe, expect, it } from "vitest";
import type { ServerMsg } from "@dreamsy/engine/net";
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
