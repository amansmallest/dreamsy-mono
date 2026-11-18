import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { Package, validatePackage } from "@dreamsy/format";
import { createApp } from "@dreamsy/api/app";
import { schema, type DB } from "@dreamsy/api/db";
import { MemoryStorage } from "@dreamsy/api/storage";
import type { Config, IdentityVerifier } from "@dreamsy/api/context";
import type { ImageGen } from "../src/images.js";
import type { AgentLLM, StructuredLLM } from "../src/models.js";
import type { Route } from "../src/route.js";
import { ApiClient, processJob } from "../src/worker.js";
import { simulate } from "../src/playtest.js";
import type { Playtester } from "../src/playtest.js";

/** Real engine simulation (Node, fast) + fake browser that returns a tiny JPEG. */
const browserCalls: number[][] = [];
const playtest: Playtester = {
  simulate,
  async browser(_pkg, _tl, shots) {
    browserCalls.push(shots);
    return { consoleErrors: [], scriptErrors: 0, shots: shots.map((t) => ({ t, jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) })) };
  },
};

// ---------- in-process API ----------

const config: Config = { jwtSecret: "x".repeat(40), workerToken: "wt", dailyGenerationQuota: 100, leaseSeconds: 60, maxAttempts: 3, ssePollMs: 10, starterStars: 500, creatorShare: 0.5, playPrice: 10000, playPassMinutes: 30, createPrice: 0, remixPrice: 0 };
const identity: IdentityVerifier = { async verify() { throw new Error("unused"); } };
const migrations = join(dirname(createRequire(import.meta.url).resolve("@dreamsy/api/app")), "../migrations");

let app: ReturnType<typeof createApp>;
let db: DB;
let api: ApiClient;

async function call(method: string, path: string, token: string, json?: unknown) {
  const res = await app.request(path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(json ? { "content-type": "application/json" } : {}) },
    body: json ? JSON.stringify(json) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) as any };
}

beforeEach(async () => {
  const d = drizzle(new PGlite(), { schema });
  await migrate(d, { migrationsFolder: migrations });
  db = d as unknown as DB;
  app = createApp({ db, storage: new MemoryStorage(), config, identity });
  api = new ApiClient("http://api.test", "wt", "test-worker", ((url: string, init: RequestInit) => app.request(url, init)) as typeof fetch);
});

async function newJob(prompt: string) {
  const { data: u } = await call("POST", "/v1/auth/guest", "");
  const token = u.token as string;
  const { data: g } = await call("POST", "/v1/games", token, { name: "Test" });
  const { data: gen } = await call("POST", `/v1/games/${g.game.id}/generations`, token, { prompt });
  const job = await api.claim();
  expect(job?.generation.id).toBe(gen.generation.id);
  return { token, gameId: g.game.id as string, genId: gen.generation.id as string, job: job! };
}

async function eventTypes(genId: string) {
  const rows = await db.select().from(schema.generationEvents);
  return rows.filter((r) => r.generationId === genId).map((r) => r.type).filter((t) => t !== "heartbeat");
}

// ---------- fakes ----------

const usage = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
let toolSeq = 0;
const tool = (name: string, input: unknown) => ({ type: "tool_use" as const, id: `tu_${toolSeq++}`, name, input });
const text = (t: string) => ({ type: "text" as const, text: t, citations: null });
function reply(model: string, content: unknown[], stop: string = "tool_use"): Anthropic.Beta.BetaMessage {
  return { id: "m", type: "message", role: "assistant", model, content, stop_reason: stop, stop_sequence: null, usage } as unknown as Anthropic.Beta.BetaMessage;
}

/** Scripted agent: each step sees the request and returns a reply. Records models used. */
function scripted(steps: ((p: any) => Anthropic.Beta.BetaMessage | Promise<Anthropic.Beta.BetaMessage>)[]): AgentLLM & { models: string[]; lastToolResults: () => string } {
  let i = 0;
  let last: any;
  return {
    models: [] as string[],
    lastToolResults() {
      const m = last.messages.at(-1);
      return JSON.stringify(m.content);
    },
    async turn(params) {
      last = params;
      this.models.push(params.model);
      const step = steps[i++];
      if (!step) throw new Error(`no scripted step #${i}`);
      return step(params);
    },
  };
}

function router(route: Partial<Route>): StructuredLLM {
  return {
    async json({ system, model }) {
      if (system.includes("art director")) {
        return { value: { score: 8, verdict: "ship", fixes: [] } as never, usage, model };
      }
      if (system.startsWith("You route")) {
        return { value: { kind: "new_game", style: "pixel", dimension: "2d", orientation: null, pack: null, reason: "test", safe: true, ...route } as never, usage, model };
      }
      return { value: { line: "Built a tiny coin game" } as never, usage, model };
    },
  };
}

const fakeImages: ImageGen = {
  available: true,
  async generate(req) {
    return { bytes: new Uint8Array([137, 80, 78, 71, 1, 2, 3]), ext: "png", model: "fake-image", prompt: req.prompt };
  },
};

const NEW_GAME_OPS = [
  { op: "set_manifest", key: "format", value: "0" },
  { op: "set_manifest", key: "name", value: "Coin Hop" },
  { op: "set_manifest", key: "dimension", value: "2d" },
  { op: "set_manifest", key: "entry_scene", value: "scenes/main.scene.json" },
  { op: "set_manifest", key: "style.preset", value: "pixel" },
  { op: "add_scene", scene: "scenes/main.scene.json", root: { id: "world", type: "Node2D" } },
  { op: "add_entity", parent: "world", id: "camera", type: "Camera2D" },
  { op: "write_file", path: "scripts/client/player.luau", content: "onTick(function(dt) end)\n" },
  { op: "add_entity", parent: "world", id: "player", type: "Body2D", props: { body: "dynamic" }, scripts: ["scripts/client/player.luau"] },
];

// ---------- tests ----------

describe("worker end to end", () => {
  it("new game: route → build (fix a validation error) → image → finish → version committed", async () => {
    const { token, gameId, genId, job } = await newJob("a pixel game where a frog collects coins");
    const llm = scripted([
      () => reply("claude-opus-5-5", [
        text("Plan: frog platformer with coins."),
        // second op batch has a bad prop → validator error reported back
        tool("apply_ops", { reason: "scaffold", ops: [...NEW_GAME_OPS, { op: "add_entity", parent: "world", id: "coin_1", type: "Area2D", props: { radius: 4 } }] }),
        tool("generate_image", { id: "coin", prompt: "a gold coin", aspect: "1:1" }),
      ]),
      (p) => {
        const results = JSON.stringify(p.messages.at(-1).content);
        expect(results).toContain('no prop \\"radius\\"');
        expect(results).toContain('Generating \\"coin\\"');
        return reply("claude-opus-5-5", [
          tool("apply_ops", { reason: "fix coin", ops: [
            { op: "set_props", id: "coin_1", props: { radius: null, size: [12, 12] } },
            { op: "add_entity", parent: "coin_1", id: "coin_1_sprite", type: "Sprite2D", props: { texture: "asset:coin" } },
            { op: "add_entity", parent: "world", id: "hud", type: "UIText", props: { text: "Coins: 0" } },
          ] }),
          tool("finish", { summary: "Frog coin game" }),
        ]);
      },
    ]);

    const outcome = await processJob({ api, agentLLM: llm, jsonLLM: router({}), images: fakeImages, playtest }, job);
    expect(outcome).toBe("succeeded");
    expect(llm.models).toEqual(["claude-opus-5-5", "claude-opus-5-5"]);

    const versions = await call("GET", `/v1/games/${gameId}/versions`, token);
    expect(versions.data.versions).toHaveLength(1);
    expect(versions.data.versions[0].summary).toBe("Built a tiny coin game");

    const zip = await app.request(`/v1/games/${gameId}/versions/1/package`, { headers: { authorization: `Bearer ${token}` } });
    const pkg = Package.fromZip(new Uint8Array(await zip.arrayBuffer()));
    expect(validatePackage(pkg).ok).toBe(true);
    expect(Array.from(pkg.bytes("assets/coin.png")!)).toEqual([137, 80, 78, 71, 1, 2, 3]); // real image replaced placeholder
    expect(JSON.parse(pkg.text("assets/coin.meta.json")!).source.model).toBe("fake-image");

    const types = await eventTypes(genId);
    for (const t of ["route", "plan", "ops", "asset.started", "asset.done", "validate", "cost", "cost.final", "succeeded"]) {
      expect(types).toContain(t);
    }
  });

  it("draw_sprite stores safe SVG and rejects unsafe SVG", async () => {
    const { token, gameId, job } = await newJob("pixel frog game");
    const good = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges"><rect x="4" y="4" width="8" height="8" fill="#38b764"/></svg>';
    const llm = scripted([
      () => reply("claude-opus-5-5", [
        tool("draw_sprite", { id: "frog", svg: good }),
        tool("draw_sprite", { id: "evil", svg: '<svg viewBox="0 0 1 1"><script>x</script></svg>' }),
        tool("apply_ops", { reason: "scaffold", ops: [...NEW_GAME_OPS, { op: "add_entity", parent: "player", id: "player_art", type: "Sprite2D", props: { texture: "asset:frog", size: [16, 16] } }] }),
      ]),
      (p) => {
        const r = JSON.stringify(p.messages.at(-1).content);
        expect(r).toContain('Saved sprite \\"frog\\"');
        expect(r).toContain("REJECTED: contains a disallowed element");
        return reply("claude-opus-5-5", [tool("finish", { summary: "frog" })]);
      },
    ]);
    expect(await processJob({ api, agentLLM: llm, jsonLLM: router({}), images: fakeImages, playtest }, job)).toBe("succeeded");
    const zip = await app.request(`/v1/games/${gameId}/versions/1/package`, { headers: { authorization: `Bearer ${token}` } });
    const pkg = Package.fromZip(new Uint8Array(await zip.arrayBuffer()));
    expect(pkg.text("assets/frog.svg")).toBe(good);
    expect(pkg.has("assets/evil.svg")).toBe(false);
  });

  it("runtime script errors block finish; playtest returns screenshots; edits start with a screenshot", async () => {
    const { token, gameId, job } = await newJob("make a game");
    const broken = NEW_GAME_OPS.map((o) => o.op === "write_file" ? { ...o, content: "onTick(function(dt)\n  local hero = nil\n  hero.position = vec2(1, 2)\nend)\n" } : o);
    const llm = scripted([
      () => reply("claude-opus-5-5", [tool("apply_ops", { reason: "x", ops: broken }), tool("finish", { summary: "done" })]),
      (p) => {
        const r = JSON.stringify(p.messages.at(-1).content);
        expect(r).toContain("Runtime error during an 8s smoke run");
        expect(r).toContain("player.luau:3");
        return reply("claude-opus-5-5", [
          tool("apply_ops", { reason: "fix", ops: [{ op: "edit_file", path: "scripts/client/player.luau", old: "  local hero = nil\n", new: "  local hero = script.entity\n" }] }),
          tool("playtest", { seconds: 3, shots: [1, 2.5], timeline: [{ t: 0.2, hold: ["right"] }, { t: 1, press: ["jump"] }] }),
        ]);
      },
      (p) => {
        const content = p.messages.at(-1).content;
        const result = content.find((b: any) => b.type === "tool_result" && Array.isArray(b.content));
        expect(result.content[0].text).toContain("No script errors");
        expect(result.content.filter((b: any) => b.type === "image")).toHaveLength(2);
        return reply("claude-opus-5-5", [tool("finish", { summary: "fixed" })]);
      },
    ]);
    expect(await processJob({ api, agentLLM: llm, jsonLLM: router({}), images: fakeImages, playtest }, job)).toBe("succeeded");

    // an edit on the committed game starts with a screenshot of it
    browserCalls.length = 0;
    await call("POST", `/v1/games/${gameId}/generations`, token, { prompt: "make it red" });
    const job2 = (await api.claim())!;
    const llm2 = scripted([(p) => {
      const first = p.messages[0].content;
      expect(first[0].text).toContain("Screenshot of the current game");
      expect(first[1].type).toBe("image");
      return reply("claude-sonnet-5-5", [tool("apply_ops", { reason: "red", ops: [{ op: "set_props", id: "player", props: { gravity_scale: 2 } }] }), tool("finish", { summary: "ok" })]);
    }]);
    expect(await processJob({ api, agentLLM: llm2, jsonLLM: router({ kind: "tweak", style: null, dimension: null }), images: fakeImages, playtest }, job2)).toBe("succeeded");
    expect(browserCalls).toContainEqual([1.5]);
  });

  it("recovers when streamed tool input fails to parse", async () => {
    const { job } = await newJob("make a game");
    const llm = scripted([
      () => { throw new SyntaxError("Unable to parse tool parameter JSON from model"); },
      (p) => {
        expect(JSON.stringify(p.messages.at(-1).content)).toContain("not valid JSON");
        return reply("claude-opus-5-5", [tool("apply_ops", { reason: "x", ops: NEW_GAME_OPS }), tool("finish", { summary: "ok" })]);
      },
    ]);
    expect(await processJob({ api, agentLLM: llm, jsonLLM: router({}), images: fakeImages, playtest }, job)).toBe("succeeded");
    expect(llm.models).toHaveLength(2);
  });

  it("multi-round: checkpoints a playable version per round, then completes when milestones are done", async () => {
    const { token, gameId, genId, job } = await newJob("make a vast game");
    const notes = (done: number) => ["# Plan", ...[1, 2, 3, 4].map((i) => `- [${i <= done ? "x" : " "}] milestone ${i}`)].join("\n");
    const llm = scripted([
      () => reply("claude-opus-5-5", [tool("apply_ops", { reason: "m1", ops: [...NEW_GAME_OPS, { op: "write_file", path: "notes.md", content: notes(2) }] }), tool("finish", { summary: "round 1" })]),
      (p) => {
        expect(JSON.stringify(p.messages[0].content)).toContain("continue: build the next unchecked milestones");
        return reply("claude-opus-5-5", [tool("apply_ops", { reason: "m3-4", ops: [{ op: "write_file", path: "notes.md", content: notes(4) }] }), tool("finish", { summary: "round 2" })]);
      },
    ]);
    const outcome = await processJob({ api, agentLLM: llm, jsonLLM: router({}), images: fakeImages, playtest, maxRounds: 4 }, job);
    expect(outcome).toBe("succeeded");
    expect(llm.models).toHaveLength(2);
    const versions = (await call("GET", `/v1/games/${gameId}/versions`, token)).data.versions;
    expect(versions.map((v: any) => v.version)).toEqual([2, 1]); // round 1 = checkpoint v1, round 2 = complete v2
    const types = await eventTypes(genId);
    expect(types.filter((t) => t === "eta")).toHaveLength(2);
    expect(types).toContain("checkpoint");
    const gen = (await call("GET", `/v1/generations/${genId}`, token)).data.generation;
    expect(gen.status).toBe("succeeded");
    expect(gen.resultVersion).toBe(2);
  });

  it("build_content fans specs out to builders and merges only their own files", async () => {
    const { token, gameId, job } = await newJob("a creature game");
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="8" height="8" fill="#f80"/></svg>';
    const llm = scripted([
      () => reply("claude-opus-5-5", [
        tool("apply_ops", { reason: "bible", ops: [...NEW_GAME_OPS, { op: "write_file", path: "notes.md", content: "# Bible\n- [ ] m1" }] }),
        tool("build_content", { kind: "creatures", guide: "Write data/creatures/<id>.json as {id,name,hp}. Draw <id>_front.", items: [{ id: "emberkit", spec: "fire fox, hp 40" }, { id: "dewlet", spec: "water drop, hp 35" }] }),
      ]),
      (p) => {
        expect(p.model).toBe("claude-sonnet-5-5");
        expect(JSON.stringify(p.messages[0].content)).toContain("emberkit");
        return reply("claude-sonnet-5-5", [
          tool("write_files", { files: [
            { path: "data/creatures/emberkit.json", content: '{"id":"emberkit","name":"Emberkit","hp":40}' },
            { path: "data/creatures/dewlet.json", content: '{"id":"dewlet","name":"Dewlet","hp":35}' },
            { path: "data/creatures/sneaky.json", content: "{}" },
          ] }),
          tool("draw_sprite", { id: "emberkit_front", svg }),
          tool("done", { note: "ok" }),
        ]);
      },
      (p) => {
        const r = JSON.stringify(p.messages.at(-1).content);
        expect(r).toContain("✓ emberkit");
        expect(r).toContain("✓ dewlet");
        return reply("claude-opus-5-5", [tool("finish", { summary: "creatures in" })]);
      },
    ]);
    expect(await processJob({ api, agentLLM: llm, jsonLLM: router({}), images: fakeImages, playtest }, job)).toBe("succeeded");
    const zip = await app.request(`/v1/games/${gameId}/versions/1/package`, { headers: { authorization: `Bearer ${token}` } });
    const pkg = Package.fromZip(new Uint8Array(await zip.arrayBuffer()));
    expect(JSON.parse(pkg.text("data/creatures/emberkit.json")!).hp).toBe(40);
    expect(pkg.has("assets/emberkit_front.svg")).toBe(true);
    expect(pkg.has("data/creatures/sneaky.json")).toBe(false); // not one of the worker's ids
  });

  it("sprite-scoped edit changes only the chosen asset", async () => {
    // base game with a shield sprite
    const first = await newJob("make a game");
    const blue = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#00f"/></svg>';
    const red = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#f00"/></svg>';
    await processJob({ api, agentLLM: scripted([() => reply("claude-opus-5-5", [tool("draw_sprite", { id: "shield", svg: blue }), tool("apply_ops", { reason: "x", ops: NEW_GAME_OPS }), tool("finish", { summary: "ok" })])]), jsonLLM: router({}), images: fakeImages, playtest }, first.job);

    const { data: gen } = await call("POST", `/v1/games/${first.gameId}/generations`, first.token, { prompt: "make the shield red", assetIds: ["shield"] });
    const job = (await api.claim())!;
    expect(job.generation.assetIds).toEqual(["shield"]);
    const llm = scripted([(p) => {
      const text = JSON.stringify(p.messages[0].content);
      expect(text).toContain("SCOPED SPRITE EDIT");
      expect(text).toContain("fill=\\\"#00f\\\""); // current SVG is shown to the model
      // the model also (wrongly) touches another file — it must be dropped
      return reply("claude-sonnet-5-5", [
        tool("draw_sprite", { id: "shield", svg: red }),
        tool("apply_ops", { reason: "oops", ops: [{ op: "set_props", id: "player", props: { gravity_scale: 3 } }] }),
        tool("finish", { summary: "red shield" }),
      ]);
    }]);
    expect(await processJob({ api, agentLLM: llm, jsonLLM: router({ kind: "tweak", style: null, dimension: null }), images: fakeImages, playtest }, job)).toBe("succeeded");
    expect(llm.models).toEqual(["claude-sonnet-5-5"]); // routed as a cheap asset edit
    const zip = await app.request(`/v1/games/${first.gameId}/versions/2/package`, { headers: { authorization: `Bearer ${first.token}` } });
    const pkg = Package.fromZip(new Uint8Array(await zip.arrayBuffer()));
    expect(pkg.text("assets/shield.svg")).toBe(red);
    const scene = JSON.parse(pkg.text("scenes/main.scene.json")!);
    expect(scene.entities.player.props.gravity_scale).toBeUndefined(); // unrelated change dropped
    void gen;
  });

  it("new games start from the chosen kit's template by default; 'from scratch' opts out", async () => {
    // default: rpg kit → the rpg template game is the base
    const { token, gameId, genId, job } = await newJob("a cozy creature-catching rpg about moths");
    const llm = scripted([(p) => {
      const first = JSON.stringify(p.messages[0].content);
      expect(first).toContain('KIT TEMPLATE');
      expect(first).toContain('the \\"rpg\\" KIT TEMPLATE');
      return reply("claude-opus-5-5", [
        tool("apply_ops", { reason: "make it ours", ops: [{ op: "set_manifest", key: "name", value: "Moth Keepers" }, { op: "write_file", path: "notes.md", content: "# Moth Keepers\n- [x] first playable" }] }),
        tool("finish", { summary: "reskinned" }),
      ]);
    }]);
    const out = await processJob({ api, agentLLM: llm, jsonLLM: router({ kits: ["rpg"], fromScratch: false } as never), images: fakeImages, playtest }, job);
    expect(out).toBe("succeeded");
    const zip = await app.request(`/v1/games/${gameId}/versions/1/package`, { headers: { authorization: `Bearer ${token}` } });
    const pkg = Package.fromZip(new Uint8Array(await zip.arrayBuffer()));
    expect(validatePackage(pkg).manifest?.name).toBe("Moth Keepers");
    expect(validatePackage(pkg).manifest?.kits).toEqual(["rpg"]);
    expect(pkg.paths("data/creatures/").length).toBeGreaterThan(0); // template content came along
    expect(await eventTypes(genId)).toContain("template");

    // opt out: from scratch → empty base, normal new-game instructions
    const second = await newJob("a creature rpg from scratch");
    const llm2 = scripted([(p) => {
      const first = JSON.stringify(p.messages[0].content);
      expect(first).not.toContain("KIT TEMPLATE");
      expect(first).toContain("This is a NEW game");
      return reply("claude-opus-5-5", [tool("apply_ops", { reason: "x", ops: NEW_GAME_OPS }), tool("finish", { summary: "ok" })]);
    }]);
    expect(await processJob({ api, agentLLM: llm2, jsonLLM: router({ kits: ["rpg"], fromScratch: true } as never), images: fakeImages, playtest }, second.job)).toBe("succeeded");
  });

  it("finish is refused while the package is invalid", async () => {
    const { job } = await newJob("make a game");
    const llm = scripted([
      () => reply("claude-opus-5-5", [tool("apply_ops", { reason: "partial", ops: NEW_GAME_OPS.slice(0, 4) }), tool("finish", { summary: "done" })]),
      (p) => {
        expect(JSON.stringify(p.messages.at(-1).content)).toContain("Not finished");
        return reply("claude-opus-5-5", [tool("apply_ops", { reason: "rest", ops: NEW_GAME_OPS.slice(4) }), tool("finish", { summary: "done" })]);
      },
    ]);
    expect(await processJob({ api, agentLLM: llm, jsonLLM: router({}), images: fakeImages, playtest }, job)).toBe("succeeded");
  });

  it("player cancel mid-run stops the worker without committing", async () => {
    const { token, gameId, genId, job } = await newJob("make a game");
    const llm = scripted([
      async () => {
        await call("POST", `/v1/generations/${genId}/cancel`, token);
        return reply("claude-opus-5-5", [text("building"), tool("apply_ops", { reason: "x", ops: NEW_GAME_OPS })]);
      },
      () => reply("claude-opus-5-5", [tool("finish", { summary: "should never run" })]),
    ]);
    expect(await processJob({ api, agentLLM: llm, jsonLLM: router({}), images: fakeImages, playtest }, job)).toBe("stopped");
    expect(llm.models).toHaveLength(1);
    expect((await call("GET", `/v1/games/${gameId}/versions`, token)).data.versions).toHaveLength(0);
  });

  it("tweak on Sonnet escalates to Opus after no progress", async () => {
    // first commit a base version
    const first = await newJob("make a game");
    await processJob({
      api,
      agentLLM: scripted([() => reply("claude-opus-5-5", [tool("apply_ops", { reason: "x", ops: NEW_GAME_OPS }), tool("finish", { summary: "ok" })])]),
      jsonLLM: router({}),
      images: fakeImages,
      playtest,
    }, first.job);

    const { data: gen } = await call("POST", `/v1/games/${first.gameId}/generations`, first.token, { prompt: "make the player faster", selection: ["player"] });
    const job = (await api.claim())!;
    expect(job.base?.version).toBe(1);
    const llm = scripted([
      (p) => {
        // selection is expanded for the model
        expect(JSON.stringify(p.messages[0].content)).toContain('\\"player\\": {');
        return reply("claude-sonnet-5-5", [text("hmm")], "end_turn");
      },
      () => reply("claude-sonnet-5-5", [text("still thinking")], "end_turn"),
      () => reply("claude-opus-5-5", [tool("apply_ops", { reason: "speed", ops: [{ op: "edit_file", path: "scripts/client/player.luau", old: "onTick(function(dt) end)", new: "local SPEED = 200\nonTick(function(dt) end)" }] }), tool("finish", { summary: "faster" })]),
    ]);
    expect(await processJob({ api, agentLLM: llm, jsonLLM: router({ kind: "tweak", style: null, dimension: null }), images: fakeImages, playtest }, job)).toBe("succeeded");
    expect(llm.models).toEqual(["claude-sonnet-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]);
    expect(await eventTypes(gen.generation.id)).toContain("escalate");
  });

  it("rejected prompts fail without running the builder", async () => {
    const { token, genId, job } = await newJob("something not allowed");
    const llm = scripted([]);
    expect(await processJob({ api, agentLLM: llm, jsonLLM: router({ kind: "reject", safe: false, reason: "not allowed" }), images: fakeImages, playtest }, job)).toBe("failed");
    expect(llm.models).toHaveLength(0);
    const g = await call("GET", `/v1/generations/${genId}`, token);
    expect(g.data.generation.status).toBe("failed");
    expect(g.data.generation.error).toMatch(/not allowed/);
  });
});
