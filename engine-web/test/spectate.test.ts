// Friends & spectating (engine side): keypad code entry, ?room= auto-join, spectator mode, invites.
import { Package } from "@dreamsy/format";
import { describe, expect, it } from "vitest";
import { Game } from "../core/index.js";
import { touchControlsEnabled } from "../input/index.js";
import { fetchFriends, presenceLabel, sendInvite } from "../net/invites.js";
import { CodeEntry, KEYPAD_ROWS } from "../net/keypad.js";
import { LobbyModel, type LobbyConn } from "../net/lobby-model.js";
import { LoopbackRoom } from "../net/loopback.js";
import { CODE_ALPHABET, type RoomInfo } from "../net/protocol.js";

const logs = (g: Game) => g.logs.map((l) => l.text);
const mpDuel = () => Package.fromDir(new URL("../../games/examples/mp-duel", import.meta.url).pathname);

describe("keypad code entry", () => {
  it("only the code alphabet, 6 slots, backspace, auto-complete at 6", () => {
    const done: string[] = [];
    const c = new CodeEntry((code) => done.push(code));
    expect(c.press("0")).toBe(false); // look-alikes aren't keys
    expect(c.press("I")).toBe(false);
    expect(c.press("!")).toBe(false);
    for (const k of "ab") c.press(k);
    expect(c.slots()).toEqual(["A", "B", "", "", "", ""]);
    c.press("⌫");
    expect(c.value).toBe("A");
    for (const k of "BC23") c.press(k);
    expect(done).toEqual([]);
    c.press("4");
    expect(done).toEqual(["ABC234"]);
    expect(c.press("5")).toBe(false); // full
  });

  it("paste takes a code, a sentence or a share link", () => {
    const done: string[] = [];
    const c = new CodeEntry((code) => done.push(code));
    expect(c.paste("https://play.dreamsy.dev/?public=g_1&room=xk7p2q")).toBe("XK7P2Q");
    expect(c.paste("join my room: ABC234 !")).toBe("ABC234");
    expect(c.paste("ab")).toBe("AB");
    expect(done).toEqual(["XK7P2Q", "ABC234"]);
  });

  it("the keypad has every code character plus backspace, 6 per row", () => {
    const keys = KEYPAD_ROWS.flat();
    expect(keys.filter((k) => k !== "⌫").sort().join("")).toBe([...CODE_ALPHABET].sort().join(""));
    expect(keys).toContain("⌫");
    expect(KEYPAD_ROWS.every((r) => r.length <= 6)).toBe(true);
  });
});

function model(lb: LoopbackRoom, id: string, initial?: { code: string; spectate?: boolean }) {
  const starts: { conn: LobbyConn; room: RoomInfo }[] = [];
  const screens: string[] = [];
  const m: LobbyModel = new LobbyModel({
    gameKey: "local:test", max: 2, min: 1, initial,
    connect: async () => lb.connection(id, id.toUpperCase()),
    onStart: (conn, room) => starts.push({ conn, room }),
    onChange: () => { if (screens.at(-1) !== m.screen) screens.push(m.screen); },
  });
  return { m, starts, screens };
}

describe("lobby: keypad join and ?room= auto-join (loopback)", () => {
  it("typing the 6th key on the keypad joins the room and starts the game", async () => {
    const lb = new LoopbackRoom([{ id: "p1", name: "Ann" }], { mode: "party" });
    const { m, starts } = model(lb, "p2");
    await m.begin();
    expect(m.screen).toBe("menu");
    m.openKeypad();
    expect(m.screen).toBe("join");
    for (const k of "test4") m.code.press(k);
    expect(starts).toHaveLength(0);
    m.code.press("2");
    await new Promise((r) => setTimeout(r, 0));
    expect(starts).toHaveLength(1);
    expect(m.screen).toBe("playing");
    expect(lb.room.players.map((p) => p.id)).toEqual(["p1", "p2"]);
    const g = await Game.load(await mpDuel(), { net: starts[0]!.conn.link() });
    expect(g.errors).toEqual([]);
    expect(g.net.me?.team).toBe("blue");
  });

  it("a wrong code goes back to a cleared keypad with an error", async () => {
    const lb = new LoopbackRoom([{ id: "p1" }]);
    const { m } = model(lb, "p2");
    await m.begin();
    m.openKeypad();
    for (const k of "ZZZZZZ") m.code.press(k);
    await new Promise((r) => setTimeout(r, 0));
    expect(m.screen).toBe("join");
    expect(m.code.value).toBe("");
    expect(m.status).toBe("No room with that code.");
  });

  it("?room= joins right away without showing the menu; &spectate=1 watches", async () => {
    const lb = new LoopbackRoom([{ id: "p1", name: "Ann" }, { id: "p2", name: "Bo" }]);
    const a = model(lb, "p3", { code: "test42" });
    await a.m.begin();
    expect(a.screens).not.toContain("menu");
    expect(a.screens.at(-1)).toBe("playing");
    expect(a.starts[0]!.conn.spectator).toBe(false);
    const s = model(lb, "w1", { code: "TEST42", spectate: true });
    await s.m.begin();
    expect(s.screens).not.toContain("menu");
    expect(s.m.spectating).toBe(true);
    expect(s.starts[0]!.conn.spectator).toBe(true);
    expect(s.starts[0]!.conn.link().spectator).toBe(true);
    expect(lb.room.players).toHaveLength(3); // the spectator took no seat
    expect(lb.room.spectators).toBe(1);
  });
});

describe("spectator mode", () => {
  /** Bot: steer the local avatar toward the nearest orb. */
  function bot(g: Game) {
    const me = g.world.byId.get("hero");
    if (!me?.alive || me.get<boolean>("visible") === false) return;
    const [x, y] = me.get<number[]>("position");
    let best: number[] | null = null, bd = Infinity;
    for (const e of g.world.walk()) {
      if (e.type !== "Sprite2D" || e.parent !== g.world.root || e.get<number[]>("size")[0] !== 26) continue;
      const p = e.get<number[]>("position");
      const d = Math.hypot(p[0]! - x!, p[1]! - y!);
      if (d < bd) { bd = d; best = p; }
    }
    g.input.setAxis("move_x", best ? Math.sign(best[0]! - x!) * Math.min(1, Math.abs(best[0]! - x!) / 20) : 0);
    g.input.setAxis("move_y", best ? Math.sign(best[1]! - y!) * Math.min(1, Math.abs(best[1]! - y!) / 20) : 0);
  }

  it("mp-duel: players.local == nil, room.isSpectator, no crash, puppets for both players, scores + result, sends nothing", async () => {
    const pkg = (await mpDuel()).with("scripts/client/zz_spec.luau",
      `print("spec", players["local"] == nil, room.isSpectator, room.active, room.isHost, #players.all())`);
    const lb = new LoopbackRoom([{ id: "p1", name: "Ann" }, { id: "p2", name: "Bo" }], { seed: 3 });
    const a = await Game.load(pkg, { net: lb.link("p1"), seed: 3 });
    const b = await Game.load(pkg, { net: lb.link("p2"), seed: 3 });
    const s = await Game.load(pkg, { net: lb.spectate("w1"), seed: 3 });
    expect(s.errors).toEqual([]);
    expect(logs(s)).toContain("spec\ttrue\ttrue\ttrue\tfalse\t2");
    expect(logs(a)).toContain("spec\tfalse\tfalse\ttrue\ttrue\t2");
    expect(s.net.spectating).toBe(true);
    expect(touchControlsEnabled(s, true)).toBe(false);
    expect(touchControlsEnabled(a, true)).toBe(true);
    // no local avatar: the scene's player entity is hidden, its script never ran
    expect(s.world.byId.get("hero")!.get<boolean>("visible")).toBe(false);
    for (let i = 0; i < 30 * 62 && !a.net.result; i++) { lb.tick(1000 / 30); bot(a); bot(b); a.step(); b.step(); s.step(); }
    for (let i = 0; i < 5; i++) { lb.tick(33); a.step(); b.step(); s.step(); }
    expect(a.errors).toEqual([]);
    expect(s.errors).toEqual([]);
    expect(s.net.puppet("p1")).not.toBeNull();
    expect(s.net.puppet("p2")).not.toBeNull();
    expect(s.net.puppet("p1")!.get<boolean>("visible")).toBe(true);
    expect(s.net.result).toEqual(a.net.result);
    expect(s.net.room.scores).toEqual(a.net.room.scores);
    expect(lb.sent.some((x) => x.from === "w1")).toBe(false);
  });

  it("a following camera follows the watched player's puppet; HUD chips switch it", async () => {
    const scene = {
      format: "0", root: "world",
      entities: {
        world: { type: "Node2D", children: ["cam", "hero"] },
        cam: { type: "Camera2D", props: { current: true, follow: "hero", smoothing: 0 } },
        hero: { type: "Body2D", tags: ["player"], props: { position: [100, 100], body: "kinematic", size: [16, 16] }, children: ["spr"], scripts: ["scripts/client/hero.luau"] },
        spr: { type: "Sprite2D", props: { size: [16, 16] } },
      },
    };
    const files = {
      "dreamsy.toml": `format = "0"\nname = "Follow"\ndimension = "2d"\nentry_scene = "scenes/main.scene.json"\n[players]\nmin = 1\nmax = 2\n[server]\nmode = "rooms"\n[style]\npreset = "pixel"\npalette = ["#101020", "#3355ff", "#ffcc00", "#f0f0f0"]\n`,
      "scenes/main.scene.json": JSON.stringify(scene),
      "scripts/client/hero.luau": `
        local me = script.entity
        room.replicate(me)
        me.position = if players["local"].team == "red" then vec2(200, 300) else vec2(900, 500)`,
    };
    const lb = new LoopbackRoom([{ id: "p1" }, { id: "p2" }]);
    const a = await Game.load(Package.fromFiles(files), { net: lb.link("p1") });
    const b = await Game.load(Package.fromFiles(files), { net: lb.link("p2") });
    const s = await Game.load(Package.fromFiles(files), { net: lb.spectate("w1") });
    const run = (n: number) => { for (let i = 0; i < n; i++) { lb.tick(1000 / 60); a.step(); b.step(); s.step(); } };
    run(40);
    expect(s.errors).toEqual([]);
    expect(s.net.focusId).toBe("p1");
    let v = s.cameraView();
    expect(Math.round(v.x)).toBe(200);
    expect(Math.round(v.y)).toBe(300);
    s.net.setFocus("p2");
    run(5);
    v = s.cameraView();
    expect(Math.round(v.x)).toBe(900);
    expect(Math.round(v.y)).toBe(500);
  });
});

describe("invite friends", () => {
  const target = { api: "https://api.x/", token: "tok", gameId: "g_1" };
  it("lists friends online / in a room first; unavailable on 404", async () => {
    const calls: [string, RequestInit | undefined][] = [];
    const ok = (async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return new Response(JSON.stringify({ friends: [
        { user: { id: "u1", handle: "zed" }, presence: { status: "offline" } },
        { user: { id: "u2", handle: "amy" }, presence: { status: "online" } },
        { user: { id: "u3", handle: "bo" }, presence: { status: "in_room", roomCode: "ABC234", gameName: "Orb Duel" } },
      ], incoming: [], outgoing: [] }));
    }) as typeof fetch;
    const list = await fetchFriends(target, ok);
    expect(list!.map((f) => f.user.handle)).toEqual(["bo", "amy", "zed"]);
    expect(calls[0]![0]).toBe("https://api.x/v1/me/friends");
    expect((calls[0]![1]!.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(presenceLabel(list![0]!.presence, "ABC234")).toBe("In this room");
    expect(presenceLabel(list![0]!.presence, "XXXXXX")).toBe("In Orb Duel lobby");
    expect(await fetchFriends(target, (async () => new Response("", { status: 404 })) as typeof fetch)).toBeNull();
  });

  it("POST /v1/invites {userId, gameId, roomCode}", async () => {
    let body: unknown = null;
    const f = (async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://api.x/v1/invites");
      body = JSON.parse(String(init!.body));
      return new Response(JSON.stringify({ ok: true }));
    }) as typeof fetch;
    expect(await sendInvite(target, "u2", "ABC234", f)).toBe("ok");
    expect(body).toEqual({ userId: "u2", gameId: "g_1", roomCode: "ABC234" });
  });
});
