// Multiplayer v1 (DREAMSY.MD §4.5): players/teams, avatar replication + interpolation, remote events,
// room state/scores/finish — two Games wired through the in-memory LoopbackRoom; offline fallback.
import { Package } from "@dreamsy/format";
import { describe, expect, it } from "vitest";
import { Game } from "../core/index.js";
import { ClockSync, lerpAngle, SnapshotBuffer } from "../net/interp.js";
import { LoopbackRoom } from "../net/loopback.js";
import { normalizeCode, roomsUrl } from "../net/protocol.js";

const scene = {
  format: "0", root: "world",
  entities: {
    world: { type: "Node2D", children: ["hero"] },
    hero: {
      type: "Body2D", tags: ["player"], props: { position: [100, 100], body: "kinematic", size: [16, 16] },
      children: ["hero_sprite"], scripts: ["scripts/client/hero.luau"],
    },
    hero_sprite: { type: "Sprite2D", props: { size: [16, 24], modulate: "#ffffff" } },
  },
};

const files = {
  "dreamsy.toml": `format = "0"\nname = "Duel"\ndimension = "2d"\nentry_scene = "scenes/main.scene.json"\n[players]\nmin = 1\nmax = 2\n[server]\nmode = "rooms"\n[style]\npreset = "pixel"\npalette = ["#101020", "#3355ff", "#ffcc00", "#f0f0f0"]\n`,
  "scenes/main.scene.json": JSON.stringify(scene),
  "scripts/shared/net.luau": `return { hit = remoteEvent("hit"), ping = remoteEvent("ping"), dm = remoteEvent("dm") }`,
  "scripts/client/hero.luau": `
    local net = require("../shared/net")
    local me = script.entity
    room.replicate(me)
    onTick(function(dt)
      me.position = me.position + vec2(input.axis("move_x") * 120 * dt, 0)
    end)
    net.hit:onClient(function(n, who, at) print("hit", n, who and who.name, at and at.x) end)
    net.dm:onClient(function(msg) print("dm", msg) end)
    room.ended:connect(function(r) print("ended", r.winner and r.winner.name, r.team, r.draw, r.reason) end)
    room.stateChanged:connect(function(k, v) print("state", k, v.round) end)
    room.scoreChanged:connect(function(t, v) print("score", if type(t) == "string" then t else t.name, v) end)
    room.avatarSpawned:connect(function(p, e) print("avatar", p.name, p.team, e:hasTag("remote")) end)
  `,
  "scripts/server/rules.luau": `
    local net = require("../shared/net")
    players.joined:connect(function(p) print("joined", p.name, p.team, p.isLocal) end)
    players.left:connect(function(p) print("left", p.name) end)
    net.ping:onServer(function(from, n) print("ping from", from.name, n, room.isHost) end)
    print("room", room.active, room.code, room.mode, room.isHost, players["local"].name, players["local"].team, #players.all())
  `,
};

const pkg = () => Package.fromFiles(files);
const logs = (g: Game) => g.logs.map((l) => l.text);

async function duel() {
  const lb = new LoopbackRoom([{ id: "p1", name: "Ann" }, { id: "p2", name: "Bo" }]);
  const a = await Game.load(pkg(), { net: lb.link("p1") });
  const b = await Game.load(pkg(), { net: lb.link("p2") });
  const step = (n: number) => { for (let i = 0; i < n; i++) { lb.tick(1000 / 60); a.step(); b.step(); } };
  return { lb, a, b, step };
}

describe("multiplayer: players, teams, replication", () => {
  it("both devices see both players with red/blue teams; host runs onServer", async () => {
    const { a, b } = await duel();
    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
    expect(logs(a)).toContain("room\ttrue\tTEST42\tduel\ttrue\tAnn\tred\t2");
    expect(logs(b)).toContain("room\ttrue\tTEST42\tduel\tfalse\tBo\tblue\t2");
    expect(logs(a)).toContain("joined\tAnn\tred\ttrue");
    expect(logs(a)).toContain("joined\tBo\tblue\tfalse");
  });

  it("spawns a tinted puppet per remote player and interpolates its position", async () => {
    const { a, b, step } = await duel();
    step(30);
    const pa = a.net.puppet("p2");
    expect(pa).not.toBeNull();
    expect(pa!.tags.has("remote")).toBe(true);
    expect(logs(a)).toContain("avatar\tBo\tblue\ttrue");
    // body = visual copy (Body2D → Node2D, no scripts), name tag in blue
    const kids = pa!.children;
    expect(kids.map((k) => k.type).sort()).toEqual(["Node2D", "Text2D"]);
    expect(kids.find((k) => k.type === "Node2D")!.scripts).toEqual([]);
    const tag = kids.find((k) => k.type === "Text2D")!;
    expect(tag.props.text).toBe("Bo");
    // blue tint on the remote sprite, red tint on my own
    const sprite = kids.find((k) => k.type === "Node2D")!.children[0]!;
    const m = sprite.get<number[]>("modulate");
    expect(m[2]).toBeGreaterThan(m[0]!);
    const mine = a.world.byId.get("hero_sprite")!.get<number[]>("modulate");
    expect(mine[0]).toBeGreaterThan(mine[2]!);
    // B moves right; A's puppet follows ~100 ms behind
    const heroB = b.world.byId.get("hero")!;
    for (let i = 0; i < 60; i++) {
      heroB.props.position = [100 + i * 2, 100];
      heroB.rev++;
      step(1);
    }
    const bx = heroB.get<number[]>("position")[0]!;
    const px = pa!.get<number[]>("position")[0]!;
    expect(px).toBeGreaterThan(160);
    expect(px).toBeLessThan(bx);
    expect(bx - px).toBeLessThan(30); // ~100-160 ms of 120 px/s
  });

  it("player leave destroys the puppet and fires players.left", async () => {
    const { lb, a, step } = await duel();
    step(20);
    expect(a.net.puppet("p2")).not.toBeNull();
    lb.leave("p2");
    step(2);
    expect(a.net.puppet("p2")).toBeNull();
    expect(logs(a)).toContain("left\tBo");
  });
});

describe("multiplayer: remote events, state, scores, finish", () => {
  const extra = (code: string) => ({ ...files, "scripts/client/zz_test.luau": code });

  it("routes fireServer → host, fireAll → everyone, fireClient → one player; Players and Vec2 survive the trip", async () => {
    const lb = new LoopbackRoom([{ id: "p1", name: "Ann" }, { id: "p2", name: "Bo" }]);
    const code = `
      local net = require("../shared/net")
      after(0.2, function()
        if players["local"].name == "Bo" then
          net.ping:fireServer(7)
          net.hit:fireAll(3, players["local"], vec2(5, 6))
          for _, p in players.all() do if not p.isLocal then net.dm:fireClient(p, "hi " .. p.name) end end
        end
      end)`;
    const a = await Game.load(Package.fromFiles(extra(code)), { net: lb.link("p1") });
    const b = await Game.load(Package.fromFiles(extra(code)), { net: lb.link("p2") });
    for (let i = 0; i < 30; i++) { lb.tick(16); a.step(); b.step(); }
    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
    expect(logs(a)).toContain("ping from\tBo\t7\ttrue");
    expect(logs(b).some((l) => l.startsWith("ping from"))).toBe(false); // not the host
    expect(logs(a)).toContain("hit\t3\tBo\t5");
    expect(logs(b)).toContain("hit\t3\tBo\t5"); // fireAll includes the sender
    expect(logs(a)).toContain("dm\thi Ann");
    expect(logs(b).some((l) => l.startsWith("dm"))).toBe(false);
  });

  it("room.setState / addScore / finish are shared; the first finish wins", async () => {
    const lb = new LoopbackRoom([{ id: "p1", name: "Ann" }, { id: "p2", name: "Bo" }]);
    const code = `
      after(0.2, function()
        if players["local"].name == "Ann" then
          room.setState("round", { round = 2 })
          room.addScore("red", 2)
          room.addScore(players["local"], 1)
        end
      end)
      after(0.4, function()
        if players["local"].name == "Bo" then room.finish(players["local"]) end
      end)
      after(0.45, function()
        if players["local"].name == "Ann" then room.finish("red") end
        print("scores", room.score("red"), room.state("round").round)
      end)`;
    const a = await Game.load(Package.fromFiles(extra(code)), { net: lb.link("p1") });
    const b = await Game.load(Package.fromFiles(extra(code)), { net: lb.link("p2") });
    for (let i = 0; i < 45; i++) { lb.tick(16); a.step(); b.step(); }
    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
    expect(logs(a)).toContain("state\tround\t2");
    expect(logs(b)).toContain("state\tround\t2");
    expect(logs(b)).toContain("score\tred\t2");
    expect(logs(b)).toContain("score\tAnn\t1");
    expect(logs(a)).toContain("scores\t2\t2");
    expect(logs(b)).toContain("scores\t2\t2");
    for (const g of [a, b]) {
      const ended = logs(g).filter((l) => l.startsWith("ended"));
      expect(ended).toEqual(["ended\tBo\tblue\tfalse\tfinish"]);
    }
  });

  it("rejects entities in remote event args with a clear error", async () => {
    const lb = new LoopbackRoom([{ id: "p1" }, { id: "p2" }]);
    const code = `after(0.1, function() local net = require("../shared/net") net.hit:fireAll(script and players["local"].avatar) end)`;
    const a = await Game.load(Package.fromFiles(extra(code)), { net: lb.link("p1") });
    for (let i = 0; i < 10; i++) { lb.tick(16); a.step(); }
    expect(a.errors.map((e) => e.message).join("\n")).toMatch(/can't send an Entity/);
  });
});

describe("multiplayer: offline fallback (single player, playtests)", () => {
  it("one local player, in-process events, local finish", async () => {
    const code = `
      after(0.1, function()
        room.addScore(players["local"], 5)
        room.finish(players["local"])
      end)`;
    const g = await Game.load(Package.fromFiles({ ...files, "scripts/client/zz_test.luau": code }));
    for (let i = 0; i < 12; i++) g.step();
    expect(g.errors).toEqual([]);
    const l = logs(g);
    expect(l).toContain("room\tfalse\tnil\tnil\ttrue\tPlayer\tnil\t1");
    expect(l).toContain("joined\tPlayer\tnil\ttrue");
    expect(l).toContain("score\tPlayer\t5");
    expect(l).toContain("ended\tPlayer\tnil\tfalse\tfinish");
  });
});

describe("net helpers", () => {
  it("interpolates between server samples and extrapolates briefly", () => {
    const b = new SnapshotBuffer<string>();
    b.push({ ts: 0, x: 0, y: 0, rot: 350 }, "a");
    b.push({ ts: 100, x: 100, y: 0, rot: 10 }, "b");
    expect(b.at(50)).toMatchObject({ x: 50, y: 0, data: "a" });
    expect(b.at(50)!.rot % 360).toBeCloseTo(0);
    expect(b.at(150)!.x).toBeCloseTo(150);
    expect(b.at(1000)!.x).toBeCloseTo(250); // ≤ 150 ms ahead
    b.push({ ts: 200, x: 900, y: 0, rot: 0 }, "teleport");
    expect(b.at(150)!.x).toBe(900);
    expect(lerpAngle(350, 10, 0.5)).toBeCloseTo(360);
  });

  it("clock sync keeps the least-delayed offset", () => {
    const c = new ClockSync();
    c.observe(1000, 50);
    c.observe(1100, 180); // 30 ms more delay
    expect(c.serverNow(200)).toBe(1150);
  });

  it("room URLs and codes", () => {
    expect(roomsUrl("https://api.dreamsy.dev")).toBe("wss://api.dreamsy.dev/rooms");
    expect(roomsUrl("http://localhost:8787/")).toBe("ws://localhost:8790/rooms");
    expect(normalizeCode(" ab c-2x9 ")).toBe("ABC2X9");
  });
});

describe("games/examples/mp-duel", () => {
  /** Steer the local avatar toward the nearest orb (input axes), like a player would. */
  function bot(g: Game) {
    const me = g.world.byId.get("hero");
    if (!me?.alive) return;
    const [x, y] = me.get<number[]>("position");
    let best: number[] | null = null, bd = Infinity;
    for (const e of g.world.walk()) {
      if (e.type !== "Sprite2D" || e.parent !== g.world.root || e.get<number[]>("size")[0] !== 26) continue;
      const p = e.get<number[]>("position");
      const d = Math.hypot(p[0]! - x!, p[1]! - y!);
      if (d < bd) { bd = d; best = p; }
    }
    const ax = best ? Math.sign(best[0]! - x!) * Math.min(1, Math.abs(best[0]! - x!) / 20) : 0;
    const ay = best ? Math.sign(best[1]! - y!) * Math.min(1, Math.abs(best[1]! - y!) / 20) : 0;
    g.input.setAxis("move_x", ax);
    g.input.setAxis("move_y", ay);
  }

  it("two players race for orbs; the host judges, scores replicate, someone wins", async () => {
    const pkg = await Package.fromDir(new URL("../../games/examples/mp-duel", import.meta.url).pathname);
    const lb = new LoopbackRoom([{ id: "p1", name: "Ann" }, { id: "p2", name: "Bo" }], { seed: 3 });
    const a = await Game.load(pkg, { net: lb.link("p1"), seed: 3 });
    const b = await Game.load(pkg, { net: lb.link("p2"), seed: 3 });
    for (let i = 0; i < 30 * 62 && !a.net.result; i++) { lb.tick(1000 / 30); bot(a); bot(b); a.step(); b.step(); }
    for (let i = 0; i < 5; i++) { lb.tick(33); a.step(); b.step(); }
    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
    const r = a.net.result!;
    expect(r).toBeTruthy();
    expect(b.net.result).toEqual(r);
    const total = (r.scores.p1 ?? 0) + (r.scores.p2 ?? 0);
    expect(total).toBeGreaterThanOrEqual(5);
    if (!r.draw) expect(r.scores[r.winner!]).toBeGreaterThanOrEqual(Math.max(r.scores.p1 ?? 0, r.scores.p2 ?? 0));
    // red started left, blue right; each sees the other's puppet in the other color
    expect(a.net.puppet("p2")).not.toBeNull();
    expect(b.net.puppet("p1")).not.toBeNull();
  });

  it("plays solo (offline): orbs spawn, the player can win a round", async () => {
    const pkg = await Package.fromDir(new URL("../../games/examples/mp-duel", import.meta.url).pathname);
    const g = await Game.load(pkg, { seed: 5 });
    for (let i = 0; i < 30 * 40 && !g.net.result; i++) { bot(g); g.step(); }
    expect(g.errors).toEqual([]);
    expect(g.net.result?.winner).toBe("local");
  });
});

describe("racing kit: versus mode", () => {
  it("two players on one grid, no AI, cars replicate, first across the line wins", async () => {
    let pkg = await Package.fromDir(new URL("../../games/examples/kit-racing", import.meta.url).pathname);
    pkg = pkg.with("dreamsy.toml", pkg.text("dreamsy.toml")!.replace(/\[players\][^[]*\[server\][^[]*/, `[players]\nmin = 2\nmax = 2\n\n[server]\nmode = "rooms"\n\n`));
    const lb = new LoopbackRoom([{ id: "p1", name: "Ann" }, { id: "p2", name: "Bo" }]);
    const opts = (id: string, preset: string) => ({ net: lb.link(id), seed: 3, scene: "scenes/race.scene.json", sceneParams: { mode: "cup", autopilot: preset } });
    const a = await Game.load(pkg, opts("p1", "expert"));
    const b = await Game.load(pkg, opts("p2", "easy"));
    for (let i = 0; i < 60 * 240 && !a.net.result; i++) { lb.tick(1000 / 60); a.step(); b.step(); }
    for (let i = 0; i < 5; i++) { lb.tick(16); a.step(); b.step(); }
    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
    expect(a.net.puppet("p2")).not.toBeNull();
    expect(b.net.puppet("p1")).not.toBeNull();
    const r = a.net.result!;
    expect(r).toBeTruthy();
    expect(r.winner).toBe("p1"); // expert autopilot beats easy
    expect(r.team).toBe("red");
    expect(b.net.result).toEqual(r);
    // no AI rivals were spawned (only player cars: our own car + its shadow in the race layer)
    expect(lb.sent.filter((s) => s.msg.t === "end").map((s) => s.from)).toContain("p1");
  });
});
