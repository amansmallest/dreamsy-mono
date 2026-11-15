import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { Package } from "@dreamsy/format";
import { createApp } from "@dreamsy/api/app";
import { schema, type DB } from "@dreamsy/api/db";
import { MemoryStorage } from "@dreamsy/api/storage";
import type { Config, IdentityVerifier } from "@dreamsy/api/context";
import { simulate } from "@dreamsy/engine/playtest";
import type { ImageGen } from "../src/images.js";
import type { AgentLLM, StructuredLLM } from "../src/models.js";
import type { Route } from "../src/route.js";
import type { Playtester } from "../src/playtest.js";
import { ApiClient, processJob } from "../src/worker.js";
import { createMemory, GLOBAL, LocalMemory, scope, SupermemoryMemory, type MemoryItem } from "../src/memory.js";
import { consolidateLessons, newTrace, writeBuildMemory, type BuildCtx } from "../src/lessons.js";
import { SpriteLibrary, spriteLibId } from "../src/sprites.js";
import { loadEnv } from "../src/env.js";

// ---------- shared fakes (same style as harness.test.ts) ----------

const playtest: Playtester = {
  simulate,
  async browser(_pkg, _tl, shots) {
    return { errors: [], logs: [], toasts: [], entities: 1, consoleErrors: [], audio: { sfx: {}, music: [] }, shots: shots.map((t) => ({ t, jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) })) };
  },
};
const config: Config = { jwtSecret: "x".repeat(40), workerToken: "wt", dailyGenerationQuota: 100, leaseSeconds: 60, maxAttempts: 3, ssePollMs: 10, starterStars: 500, creatorShare: 0.5 };
const identity: IdentityVerifier = { async verify() { throw new Error("unused"); } };
const migrations = join(dirname(createRequire(import.meta.url).resolve("@dreamsy/api/app")), "../migrations");

let app: ReturnType<typeof createApp>;
let db: DB;
let api: ApiClient;
let memory: LocalMemory;
let dir: string;

async function call(method: string, path: string, token: string, json?: unknown) {
  const res = await app.request(path, { method, headers: { authorization: `Bearer ${token}`, ...(json ? { "content-type": "application/json" } : {}) }, body: json ? JSON.stringify(json) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) as any };
}

beforeEach(async () => {
  const d = drizzle(new PGlite(), { schema });
  await migrate(d, { migrationsFolder: migrations });
  db = d as unknown as DB;
  app = createApp({ db, storage: new MemoryStorage(), config, identity });
  api = new ApiClient("http://api.test", "wt", "test-worker", ((url: string, init: RequestInit) => app.request(url, init)) as typeof fetch);
  dir = mkdtempSync(join(tmpdir(), "dreamsy-mem-"));
  memory = new LocalMemory(join(dir, "memory", "memory.jsonl"));
});

async function newJob(prompt: string, token?: string, gameId?: string) {
  token ??= (await call("POST", "/v1/auth/guest", "")).data.token as string;
  gameId ??= (await call("POST", "/v1/games", token, { name: "Test" })).data.game.id as string;
  const { data: gen } = await call("POST", `/v1/games/${gameId}/generations`, token, { prompt });
  const job = await api.claim();
  expect(job?.generation.id).toBe(gen.generation.id);
  return { token, gameId, genId: gen.generation.id as string, job: job! };
}

async function events(genId: string) {
  return (await db.select().from(schema.generationEvents)).filter((r) => r.generationId === genId);
}

const usage = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
let toolSeq = 0;
const tool = (name: string, input: unknown) => ({ type: "tool_use" as const, id: `tu_${toolSeq++}`, name, input });
function reply(model: string, content: unknown[], stop = "tool_use"): Anthropic.Beta.BetaMessage {
  return { id: "m", type: "message", role: "assistant", model, content, stop_reason: stop, stop_sequence: null, usage } as unknown as Anthropic.Beta.BetaMessage;
}
function scripted(steps: ((p: any) => Anthropic.Beta.BetaMessage)[]): AgentLLM & { calls: any[] } {
  let i = 0;
  return {
    calls: [] as any[],
    async turn(params) {
      this.calls.push(params);
      const step = steps[i++];
      if (!step) throw new Error(`no scripted step #${i}`);
      return step(params);
    },
  };
}

/** Router + art director + summary + lesson writer + consolidator. */
function jsonLLM(route: Partial<Route>, opts: { review?: { score: number; verdict: "ship" | "polish"; fixes: string[] }; lessons?: { topic: string; text: string }[]; seen?: string[] } = {}): StructuredLLM {
  return {
    async json({ system, model, content }) {
      if (system.includes("art director")) return { value: (opts.review ?? { score: 8, verdict: "ship", fixes: [] }) as never, usage, model };
      if (system.startsWith("You route")) return { value: { kind: "new_game", style: "pixel", dimension: "2d", orientation: null, kits: [], pack: null, reason: "test", safe: true, ...route } as never, usage, model };
      if (system.includes("build lessons")) {
        opts.seen?.push(typeof content === "string" ? content : JSON.stringify(content));
        return { value: { genre: "platformer", lessons: opts.lessons ?? [] } as never, usage, model };
      }
      return { value: { line: "Built it" } as never, usage, model };
    },
  };
}

const fakeImages: ImageGen = { available: false, async generate() { throw new Error("off"); } };

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

const lesson = (id: string, text: string, scopes: string[], extra: Partial<MemoryItem> = {}): MemoryItem => ({ id, kind: "lesson", text, scopes: [GLOBAL, ...scopes], ...extra });
const svg = (fill: string, size = 16) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect x="4" y="4" width="8" height="8" fill="${fill}"/></svg>`;

// ---------- memory: local backend ----------

describe("local memory", () => {
  it("ranks by keyword + kit/pack overlap, deterministically, and persists across instances", async () => {
    await memory.remember(lesson("l_rpg", "Zoom the camera to 3x so pixel sprites read on phones", [scope.kit("rpg")]));
    await memory.remember(lesson("l_plat", "Zoom the camera to 3x so pixel sprites read on phones", [scope.kit("platformer"), scope.pack("cozy-forest")]));
    await memory.remember(lesson("l_coyote", "Add coyote time and jump buffering to the platformer controller", [scope.kit("platformer")]));
    await memory.remember(lesson("l_hud", "Anchor the HUD top-left, away from the pause button", []));

    const a = await memory.recall("camera zoom", { kits: ["platformer"], pack: "cozy-forest" });
    expect(a[0]!.item.id).toBe("l_plat"); // same text as l_rpg, but kit + pack overlap wins
    expect(a[1]!.item.id).toBe("l_rpg");
    const b = await memory.recall("jump buffering controller", { kits: ["platformer"] });
    expect(b[0]!.item.id).toBe("l_coyote");
    expect(await memory.recall("camera zoom", { kits: ["platformer"], pack: "cozy-forest" })).toEqual(a); // deterministic

    // required scopes filter
    expect((await memory.recall("", { scopes: [scope.kit("rpg")] })).map((h) => h.item.id)).toEqual(["l_rpg"]);

    // persisted log replays; forget is persisted too
    await memory.forget(["l_hud"]);
    const again = new LocalMemory(memory.file);
    expect(again.all().map((i) => i.id).sort()).toEqual(["l_coyote", "l_plat", "l_rpg"]);
  });

  it("privacy: user-scoped items are only recalled for their user", async () => {
    await memory.remember({ id: "r_alice", kind: "remix", text: "make the dragon breathe ice", scopes: [scope.user("u_alice"), scope.game("g1")] });
    await memory.remember(lesson("l_g", "dragon bosses need a telegraphed wind-up", []));
    expect((await memory.recall("dragon")).map((h) => h.item.id)).toEqual(["l_g"]);
    expect((await memory.recall("dragon", { userId: "u_bob" })).map((h) => h.item.id)).toEqual(["l_g"]);
    expect((await memory.recall("dragon", { userId: "u_alice" })).map((h) => h.item.id)).toContain("r_alice");
  });

  it("createMemory picks Supermemory only when the key is set", () => {
    expect(createMemory({ dir, env: {} }).backend).toBe("local");
    expect(createMemory({ dir, env: { SUPERMEMORY_API_KEY: "k" } }).backend).toBe("supermemory");
  });
});

// ---------- memory: Supermemory client shape (fake fetch) ----------

describe("supermemory client", () => {
  it("adds with one privacy container + metadata scopes, searches per container with filters, re-checks privacy, deletes", async () => {
    const reqs: { method: string; url: string; body: any }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      const body = init.body ? JSON.parse(init.body as string) : null;
      reqs.push({ method: init.method!, url, body });
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk");
      if (url.endsWith("/v3/search")) {
        const leaked = { documentId: "d2", score: 0.9, metadata: { memId: "r_eve", kind: "remix", scopes: ["user:u_eve"] }, content: "secret prompt" };
        const ok = { documentId: "d1", score: 0.8, metadata: { memId: "l1", kind: "lesson", scopes: [GLOBAL, "kit:rpg"], weight: 2, score: 8 }, content: "lesson text" };
        return new Response(JSON.stringify({ results: body.containerTag === "dreamsy_global" ? [ok, leaked] : [], total: 1, timing: 1 }));
      }
      if (init.method === "DELETE") return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ id: "doc", status: "queued" }));
    }) as typeof fetch;
    const sm = new SupermemoryMemory("sk", "https://sm.test", fetchFn);

    await sm.remember({ id: "remix_1", kind: "remix", text: "make it red", scopes: [scope.user("u_1"), scope.game("g_1")], data: { a: 1 } });
    expect(reqs[0]).toMatchObject({ method: "POST", url: "https://sm.test/v3/documents", body: { content: "make it red", containerTag: "dreamsy_user_u_1", customId: "remix_1", metadata: { memId: "remix_1", kind: "remix", scopes: ["user:u_1", "game:g_1"], data: '{"a":1}' } } });

    const hits = await sm.recall("rpg lessons", { userId: "u_1", kinds: ["lesson"], scopes: ["kit:rpg"], limit: 3 });
    const searches = reqs.filter((r) => r.url.endsWith("/v3/search"));
    expect(searches.map((s) => s.body.containerTag)).toEqual(["dreamsy_global", "dreamsy_user_u_1"]);
    expect(searches[0]!.body.filters).toEqual({ AND: [{ OR: [{ key: "kind", value: "lesson" }] }, { key: "scopes", value: "kit:rpg", filterType: "array_contains" }] });
    expect(hits.map((h) => h.item.id)).toEqual(["l1"]); // eve's remix never surfaces, even if the server returned it
    expect(hits[0]!.item).toMatchObject({ text: "lesson text", weight: 2, score: 8 });

    await sm.forget(["remix_1"]);
    expect(reqs.at(-1)).toMatchObject({ method: "DELETE", url: "https://sm.test/v3/documents/remix_1" });
  });
});

// ---------- recall → prompt, lessons, remix records, consolidation ----------

describe("memory in the build loop", () => {
  it("recalls lessons into the first message, emits `memory`, and reports metrics with the ids used", async () => {
    await memory.remember(lesson("l_plat_1", "Give the player coyote time; jumps felt unfair without it", [scope.kit("platformer"), "topic:design"], { weight: 3, score: 8 }));
    await memory.remember(lesson("l_rpg_1", "Battle menus need 96px tap targets", [scope.kit("rpg")]));
    for (let i = 0; i < 12; i++) await memory.remember(lesson(`l_noise_${i}`, `unrelated tycoon tip ${i} about idle generators`, [scope.kit("tycoon")]));

    const { genId, job } = await newJob("a platformer about a frog");
    const llm = scripted([(p) => {
      const text = p.messages[0].content.at(-1).text as string;
      expect(text).toContain("# What worked before (retrieved from");
      expect(text).toContain("[design ×3] Give the player coyote time");
      expect(text.indexOf("coyote")).toBeLessThan(text.indexOf("tycoon tip") === -1 ? Infinity : text.indexOf("tycoon tip"));
      expect(text).not.toContain("Battle menus"); // other kits rank below / out
      return reply("claude-opus-5-5", [tool("apply_ops", { reason: "x", ops: NEW_GAME_OPS }), tool("finish", { summary: "ok" })]);
    }]);
    expect(await processJob({ api, agentLLM: llm, jsonLLM: jsonLLM({ kits: ["platformer"] }), images: fakeImages, playtest, memory }, job)).toBe("succeeded");

    const evs = await events(genId);
    const mem = evs.find((e) => e.type === "memory")!.data as any;
    expect(mem.lessonsUsed).toBeGreaterThan(0);
    expect(mem.ids[0]).toBe("l_plat_1");
    expect(mem.backend).toBe("local");
    const metrics = evs.find((e) => e.type === "metrics")!.data as any;
    expect(metrics).toMatchObject({ rounds: 1, kit: "platformer", kind: "new_game", memoryHits: mem.hits, artScore: 8, artVerdict: "ship", finalGatePassedFirstTry: true });
    expect(metrics.memoryIds).toContain("l_plat_1");
    const [row] = await db.select().from(schema.generations);
    expect(row!.metrics).toMatchObject({ kit: "platformer", memoryHits: mem.hits });
  });

  it("writes Haiku lessons (no prompt text), an outcome, and user-scoped remix records for edits", async () => {
    const seen: string[] = [];
    const llmJson = jsonLLM({ kits: ["platformer"] }, {
      review: { score: 6, verdict: "polish", fixes: ["Sprites read tiny — zoom the camera to 3x"] },
      lessons: [{ topic: "art", text: "Pixel platformers: set Camera2D zoom 3x before the first art review; 1x reads tiny." }],
      seen,
    });
    const first = await newJob("a platformer starring Sir Hopsalot the frog");
    const llm = scripted([
      () => reply("claude-opus-5-5", [tool("apply_ops", { reason: "x", ops: NEW_GAME_OPS }), tool("finish", { summary: "v1" })]),
      (p) => {
        expect(JSON.stringify(p.messages.at(-1).content)).toContain("ART DIRECTOR REVIEW");
        return reply("claude-opus-5-5", [tool("apply_ops", { reason: "zoom", ops: [{ op: "set_props", id: "camera", props: { zoom: 3 } }] }), tool("finish", { summary: "zoomed" })]);
      },
    ]);
    expect(await processJob({ api, agentLLM: llm, jsonLLM: llmJson, images: fakeImages, playtest, memory }, first.job)).toBe("succeeded");

    expect(seen[0]).toContain("zoom the camera to 3x");
    expect(seen[0]).not.toContain("Hopsalot"); // the lesson writer never sees the prompt
    const lessons = memory.all().filter((i) => i.kind === "lesson");
    expect(lessons).toHaveLength(1);
    expect(lessons[0]!.scopes).toEqual(expect.arrayContaining([GLOBAL, "kit:platformer", "genre:platformer", "orientation:portrait", "topic:art"]));
    expect(lessons[0]!.score).toBe(6);
    const outcome = memory.all().find((i) => i.kind === "outcome")!;
    expect(outcome.text).toMatch(/new_game build \(platformer\): succeeded, art 6\/10/);
    for (const i of memory.all().filter((x) => !x.scopes.some((s) => s.startsWith("user:")))) expect(i.text).not.toContain("Hopsalot");
    expect((await events(first.genId)).find((e) => e.type === "memory.saved")).toBeTruthy();

    // An edit → a remix record scoped to that user + game, recalled into their next edit only.
    const me = (await call("GET", "/v1/me", first.token)).data.user.id as string;
    const edit = await newJob("make Sir Hopsalot jump higher", first.token, first.gameId);
    expect(edit.job.generation.userId).toBe(me);
    await processJob({ api, agentLLM: scripted([() => reply("claude-sonnet-5-5", [tool("apply_ops", { reason: "jump", ops: [{ op: "set_props", id: "player", props: { gravity_scale: 0.5 } }] }), tool("finish", { summary: "higher" })])]), jsonLLM: jsonLLM({ kind: "tweak", style: null, dimension: null }), images: fakeImages, playtest, memory }, edit.job);
    const remix = memory.all().find((i) => i.kind === "remix")!;
    expect(remix.scopes).toEqual(expect.arrayContaining([scope.user(me), scope.game(first.gameId)]));
    expect(remix.data).toMatchObject({ parent: { gameId: first.gameId, version: 1 }, instruction: "make Sir Hopsalot jump higher", patch: { ops: { set_props: 1 } }, result: { succeeded: true } });
    expect((remix.data as any).patch.files.changed).toContain("scenes/main.scene.json");

    const again = await newJob("make Sir Hopsalot jump even higher", first.token, first.gameId);
    const llm3 = scripted([(p) => {
      const text = p.messages[0].content.at(-1).text as string;
      expect(text).toContain("Your similar past edits");
      expect(text).toContain("make Sir Hopsalot jump higher");
      return reply("claude-sonnet-5-5", [tool("apply_ops", { reason: "j", ops: [{ op: "set_props", id: "player", props: { gravity_scale: 0.4 } }] }), tool("finish", { summary: "ok" })]);
    }]);
    expect(await processJob({ api, agentLLM: llm3, jsonLLM: jsonLLM({ kind: "tweak", style: null, dimension: null }), images: fakeImages, playtest, memory }, again.job)).toBe("succeeded");
    // another user never sees it
    expect((await memory.recall("make Sir Hopsalot jump higher", { userId: "u_other", kinds: ["remix"] }))).toHaveLength(0);
  });

  it("consolidates a tag past the threshold into fewer, heavier lessons and supersedes the old ones", async () => {
    for (let i = 0; i < 6; i++) await memory.remember(lesson(`zoom_${i}`, `Zoom pixel cameras to 3x (variant ${i})`, [scope.kit("rpg"), "topic:art"], { score: 6 + (i % 2) }));
    for (let i = 0; i < 4; i++) await memory.remember(lesson(`err_${i}`, `Nil-check entity lookups before use (${i})`, [scope.kit("rpg"), "topic:runtime"]));
    const merger: StructuredLLM = {
      async json({ model, content }) {
        expect(String(content)).toContain("[zoom_0]");
        return { value: { lessons: [
          { text: "Pixel games: zoom the camera to 3x at setup.", topic: "art", supersedes: ["zoom_0", "zoom_1", "zoom_2", "zoom_3", "zoom_4", "zoom_5"] },
          { text: "Nil-check findEntity results.", topic: "runtime", supersedes: ["err_0", "err_1", "nope"] },
        ] } as never, usage, model };
      },
    };
    expect(await consolidateLessons({ memory, llm: merger }, "kit:rpg", 12)).toBe(0); // under threshold: no-op
    const removed = await consolidateLessons({ memory, llm: merger }, "kit:rpg", 8);
    expect(removed).toBe(6); // 6→1 and 2→1
    const left = memory.all().filter((i) => i.kind === "lesson");
    expect(left).toHaveLength(4); // 2 merged + err_2, err_3 untouched
    const zoom = left.find((i) => i.text.startsWith("Pixel games"))!;
    expect(zoom.weight).toBe(6);
    expect(zoom.score).toBe(6.5);
    expect(zoom.scopes).toEqual(expect.arrayContaining([GLOBAL, "kit:rpg", "topic:art"]));
    expect(left.map((i) => i.id)).toEqual(expect.arrayContaining(["err_2", "err_3"]));
    // merged lessons rank first (evidence boost)
    expect((await memory.recall("zoom camera", { kits: ["rpg"] }))[0]!.item.id).toBe(zoom.id);
  });

  it("writeBuildMemory triggers consolidation when a tag grows past the threshold", async () => {
    for (let i = 0; i < 3; i++) await memory.remember(lesson(`old_${i}`, `old lesson ${i}`, [scope.kit("runner")]));
    let merged = false;
    const llm: StructuredLLM = {
      async json({ system, model }) {
        if (system.includes("build lessons")) return { value: { genre: "runner", lessons: [{ topic: "budget", text: "Batch level data into one apply_ops call to save turns." }] } as never, usage, model };
        merged = true;
        return { value: { lessons: [{ text: "merged lesson text", topic: "design", supersedes: ["old_0", "old_1", "old_2"] }] } as never, usage, model };
      },
    };
    const ctx: BuildCtx = { kind: "new_game", kits: ["runner"], pack: null, style: "pixel", orientation: "portrait", genre: "runner" };
    const trace = newTrace();
    trace.turnsHit = true;
    const r = await writeBuildMemory({ memory, llm, consolidateAbove: 3 }, { ctx, trace, ok: false, failReason: "turns", artScore: null, costUsd: 1, prompt: "secret", filesChanged: { added: [], changed: [], removed: [] }, maxTurns: 60, maxUsd: 6 });
    expect(r.errors).toEqual([]);
    expect(r.lessons).toBe(1);
    expect(merged).toBe(true);
    expect(memory.all().filter((i) => i.kind === "lesson").map((i) => i.text).sort()).toEqual(["Batch level data into one apply_ops call to save turns.", "merged lesson text"].sort());
  });
});

// ---------- sprite library ----------

describe("sprite library", () => {
  it("stores shipped sprites with score + finds same-pack, well-scored ones first", async () => {
    const lib = new SpriteLibrary(memory, join(dir, "sprites"));
    const coinA = await lib.store(svg("#ffd700"), { assetId: "coin", description: "gold coin pickup", pack: "cozy-forest", style: "pixel", palette: [], kits: [], gameId: "g1", score: 8 });
    await lib.store(svg("#ffcc00"), { assetId: "coin_b", description: "gold coin pickup", pack: "neon-night", style: "pixel", palette: [], kits: [], gameId: "g2", score: 9 });
    await lib.store(svg("#111111"), { assetId: "coin_bad", description: "gold coin pickup", pack: "cozy-forest", style: "pixel", palette: [], kits: [], gameId: "g3", score: 3 });
    await lib.store(svg("#ff0000"), { assetId: "heart", description: "red heart health icon", pack: "cozy-forest", style: "pixel", palette: [], kits: [], gameId: "g1", score: 8 });
    expect(coinA).toBe(spriteLibId(svg("#ffd700")));
    expect(lib.get(coinA)!.meta).toMatchObject({ viewBox: "0 0 16 16", width: 16, pack: "cozy-forest", score: 8 });

    const hits = await lib.find("gold coin", { pack: "cozy-forest", limit: 3 });
    expect(hits.map((h) => h.meta.assetId)).toEqual(["coin", "coin_b", "heart"]); // low scorer excluded; same pack first
    expect(hits[0]!.samePack).toBe(true);
    expect(hits[1]!.samePack).toBe(false);

    // re-storing the same SVG keeps the best score
    await lib.store(svg("#ffd700"), { assetId: "coin", description: "x", pack: "cozy-forest", style: "pixel", palette: [], kits: [], gameId: "g9", score: 5 });
    expect(lib.get(coinA)!.meta).toMatchObject({ score: 8, description: "gold coin pickup" });
  });

  it("find_sprites tool → adapt with draw_sprite(from) → reuse counted, copy across packs rejected, shipped sprites stored", async () => {
    const lib = new SpriteLibrary(memory, join(dir, "sprites"));
    const same = await lib.store(svg("#ffd700"), { assetId: "coin", description: "gold coin pickup", pack: "cozy-forest", style: "pixel", palette: [], kits: [], gameId: "g0", score: 8 });
    const other = await lib.store(svg("#00ffff"), { assetId: "gem", description: "gold coin pickup neon", pack: "neon-night", style: "pixel", palette: [], kits: [], gameId: "g0", score: 9 });

    const { genId, job } = await newJob("a cozy forest coin game");
    const llm = scripted([
      (p) => {
        expect(p.tools.map((t: any) => t.name)).toContain("find_sprites");
        expect(p.messages[0].content.at(-1).text).toContain("call find_sprites");
        return reply("claude-opus-5-5", [tool("apply_ops", { reason: "x", ops: [...NEW_GAME_OPS, { op: "set_manifest", key: "style.pack", value: "cozy-forest" }] }), tool("find_sprites", { query: "gold coin" })]);
      },
      (p) => {
        const r = JSON.stringify(p.messages.at(-1).content);
        expect(r).toContain(same);
        expect(r).toContain("same pack");
        expect(r).toContain("DIFFERENT PACK (neon-night)");
        return reply("claude-opus-5-5", [
          tool("draw_sprite", { id: "coin", svg: svg("#e8b04a"), description: "gold coin, cozy palette", from: same }),
          tool("draw_sprite", { id: "gem", svg: svg("#00ffff"), from: other }), // verbatim copy across packs
          tool("draw_sprite", { id: "tree", svg: svg("#2f6b3a"), description: "pine tree" }),
        ]);
      },
      (p) => {
        const r = JSON.stringify(p.messages.at(-1).content);
        expect(r).toContain("Saved sprite \\\"coin\\\"");
        expect(r).toContain("REJECTED: " + other);
        return reply("claude-opus-5-5", [tool("finish", { summary: "ok" })]);
      },
    ]);
    expect(await processJob({ api, agentLLM: llm, jsonLLM: jsonLLM({ pack: "cozy-forest" }), images: fakeImages, playtest, memory, sprites: lib }, job)).toBe("succeeded");

    const metrics = (await events(genId)).find((e) => e.type === "metrics")!.data as any;
    expect(metrics).toMatchObject({ spritesReused: 1, spritesDrawn: 1, pack: "cozy-forest" });
    const stored = lib.get(spriteLibId(svg("#e8b04a")))!.meta;
    expect(stored).toMatchObject({ assetId: "coin", description: "gold coin, cozy palette", pack: "cozy-forest", score: 8, from: same });
    expect(lib.get(spriteLibId(svg("#2f6b3a")))!.meta.description).toBe("pine tree");
    expect(Package).toBeDefined();
  });
});

// ---------- live Supermemory smoke (only with SUPERMEMORY_API_KEY in the repo-root .env) ----------

loadEnv();
const liveKey = process.env.SUPERMEMORY_API_KEY;
describe.skipIf(!liveKey)("supermemory live smoke", () => {
  it("add → search → delete", async () => {
    const sm = new SupermemoryMemory(liveKey!);
    const id = `smoke_${Date.now().toString(36)}`;
    await sm.remember({ id, kind: "lesson", text: `Dreamsy smoke test ${id}: zoom pixel cameras to 3x`, scopes: [GLOBAL, "kit:smoke"] });
    let found = false;
    for (let i = 0; i < 20 && !found; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      found = (await sm.recall(`smoke test ${id} zoom pixel cameras`, { kinds: ["lesson"], scopes: ["kit:smoke"], limit: 5 })).some((h) => h.item.id === id);
    }
    await sm.forget([id]);
    expect(found).toBe(true);
  }, 120_000);
});
