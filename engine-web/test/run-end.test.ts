// Engine → host "runEnd" (guided first experience): leaderboard finish/submit, platform.runEnded, room ended,
// 3 s throttle, and the bridge (WebView + iframe parent).
import { Package } from "@dreamsy/format";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Game, MemoryLeaderboardHost, RUN_END_GAP_MS, type RunEnd } from "../core/index.js";
import { LoopbackRoom } from "../net/loopback.js";
import { postToHost, runEndMessage, type BridgeMessage } from "../dev/bridge.js";

const MANIFEST = `format = "0"\nname = "Runner"\ndimension = "2d"\nentry_scene = "scenes/main.scene.json"\n`;
const SCENE = JSON.stringify({ format: "0", root: "world", entities: { world: { type: "Node2D" } } });
const pkg = (script: string, manifest = MANIFEST) => Package.fromFiles({ "dreamsy.toml": manifest, "scenes/main.scene.json": SCENE, "scripts/client/main.luau": script });
const flush = () => new Promise((r) => setTimeout(r, 0));

async function load(script: string, opts: Parameters<typeof Game.load>[1] = {}) {
  const g = await Game.load(pkg(script), opts);
  const got: RunEnd[] = [];
  g.onRunEnd((ev) => got.push(ev));
  return { g, got };
}

let now = 1_000_000;
afterEach(() => { vi.restoreAllMocks(); });
const clock = () => { now += 100_000; vi.spyOn(Date, "now").mockImplementation(() => now); };

describe("runEnd from leaderboards", () => {
  it("leaderboard.submit resolves → reason submit with board, value, rank", async () => {
    clock();
    const leaderboard = new MemoryLeaderboardHost({ entries: [{ board: "score", order: "desc", user: "ann", value: 900 }] });
    const { g, got } = await load(`after(0.05, function() leaderboard.submit("score", 412) end)`, { leaderboard });
    for (let i = 0; i < 6; i++) g.step();
    await flush();
    expect(g.errors).toEqual([]);
    expect(got).toEqual([{ reason: "submit", board: "score", value: 412, rank: 2 }]);
  });

  it("leaderboard.finish resolves → reason finish with the time", async () => {
    clock();
    const { g, got } = await load(`leaderboard.start("fastest") after(0.5, function() leaderboard.finish("fastest") end)`);
    for (let i = 0; i < 40; i++) g.step();
    await flush();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ reason: "finish", board: "fastest", rank: 1 });
    expect(got[0]!.value).toBeCloseTo(0.5, 1);
  });

  it("a failed submit still ends the run (no rank)", async () => {
    clock();
    const leaderboard = new MemoryLeaderboardHost();
    leaderboard.submit = () => Promise.reject(new Error("offline"));
    const { g, got } = await load(`after(0.05, function() leaderboard.submit("score", 7) end)`, { leaderboard });
    for (let i = 0; i < 6; i++) g.step();
    await flush();
    expect(got).toEqual([{ reason: "submit", board: "score", value: 7 }]);
  });
});

describe("platform.runEnded", () => {
  it("defaults to gameover, keeps known reasons, maps unknown ones to gameover, rejects non-strings", async () => {
    for (const [arg, want] of [["", "gameover"], ['"quit"', "quit"], ['"finish"', "finish"], ['"dead"', "gameover"]] as const) {
      clock();
      const { g, got } = await load(`after(0.01, function() platform.runEnded(${arg}) end)`);
      for (let i = 0; i < 3; i++) g.step();
      expect(g.errors).toEqual([]);
      expect(got).toEqual([{ reason: want }]);
    }
    const { g } = await load(`after(0.01, function() platform.runEnded(5) end)`);
    for (let i = 0; i < 3; i++) g.step();
    expect(g.errors.map((e) => e.message).join("\n")).toMatch(/platform\.runEnded expects an optional reason string/);
  });

  it("throttles to one per 3 s (wall clock)", async () => {
    clock();
    const { g, got } = await load(`after(0.05, function() platform.runEnded("gameover") platform.runEnded("quit") end)`);
    for (let i = 0; i < 6; i++) g.step();
    expect(got).toEqual([{ reason: "gameover" }]);
    now += RUN_END_GAP_MS - 1;
    // still inside the window
    (g as unknown as { emitRunEnd(ev: RunEnd): void }).emitRunEnd({ reason: "quit" });
    expect(got).toHaveLength(1);
    now += 1;
    (g as unknown as { emitRunEnd(ev: RunEnd): void }).emitRunEnd({ reason: "quit" });
    expect(got).toEqual([{ reason: "gameover" }, { reason: "quit" }]);
  });
});

describe("runEnd from multiplayer", () => {
  it("room.ended → reason finish on every player", async () => {
    clock();
    const manifest = MANIFEST + `[players]\nmin = 1\nmax = 2\n[server]\nmode = "rooms"\n`;
    const lb = new LoopbackRoom([{ id: "p1", name: "Ann" }, { id: "p2", name: "Bo" }]);
    const code = `after(0.2, function() if players["local"].name == "Ann" then room.finish(players["local"]) end end)`;
    const a = await Game.load(pkg(code, manifest), { net: lb.link("p1") });
    const b = await Game.load(pkg(code, manifest), { net: lb.link("p2") });
    const ga: RunEnd[] = [], gb: RunEnd[] = [];
    a.onRunEnd((e) => ga.push(e));
    b.onRunEnd((e) => gb.push(e));
    for (let i = 0; i < 30; i++) { lb.tick(16); a.step(); b.step(); }
    expect(a.errors).toEqual([]);
    expect(ga).toEqual([{ reason: "finish" }]);
    expect(gb).toEqual([{ reason: "finish" }]);
  });
});

describe("host bridge", () => {
  const msg: BridgeMessage = runEndMessage({ reason: "submit", board: "score", value: 412, rank: 7 });

  it("posts JSON to the WebView and the object to an iframe parent", () => {
    const rn: string[] = [], parent: [unknown, string][] = [];
    postToHost({ ReactNativeWebView: { postMessage: (d) => rn.push(d) }, parent: { postMessage: (m, o) => parent.push([m, o]) } }, msg);
    expect(JSON.parse(rn[0]!)).toEqual({ type: "runEnd", reason: "submit", board: "score", value: 412, rank: 7 });
    expect(parent).toEqual([[{ type: "runEnd", reason: "submit", board: "score", value: 412, rank: 7 }, "*"]]);
  });

  it("top-level page (parent === window): no parent message; a throwing host is ignored", () => {
    const calls: unknown[] = [];
    const win: { parent?: { postMessage(m: unknown, o: string): void }; postMessage(m: unknown, o: string): void } = { postMessage: (m) => calls.push(m) };
    win.parent = win;
    postToHost(win, { type: "quit" });
    expect(calls).toEqual([]);
    expect(() => postToHost({ ReactNativeWebView: { postMessage: () => { throw new Error("gone"); } }, parent: { postMessage: () => { throw new Error("x"); } } }, { type: "ready" })).not.toThrow();
  });

  it("runEnd payload drops unset fields", () => {
    expect(runEndMessage({ reason: "gameover" })).toEqual({ type: "runEnd", reason: "gameover" });
  });
});
