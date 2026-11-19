import { hostname } from "node:os";
import { Package } from "@dreamsy/format";
import { generate, type RoundStats } from "../pipeline/generate.js";
import type { Memory } from "../memory/memory.js";
import type { SpriteLibrary } from "../memory/sprites.js";
import type { ImageGen } from "../llm/images.js";
import type { AgentLLM, StructuredLLM } from "../llm/models.js";
import type { Playtester } from "../engine/playtest.js";

export class ApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    readonly workerId: string = `${hostname()}-${process.pid}`,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private async req(method: string, path: string, body?: unknown | FormData) {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` };
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
    return this.fetchFn(new URL(path, this.baseUrl).toString(), { method, headers, body: payload });
  }

  async claim(): Promise<Claim | null> {
    const res = await this.req("POST", "/v1/worker/claim", { workerId: this.workerId, provider: process.env.DREAMSY_PROVIDER === "openai" ? "openai" : "anthropic" });
    if (res.status === 204) return null;
    if (!res.ok) throw new Error(`claim failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as Claim;
  }

  async event(genId: string, type: string, data: unknown = {}): Promise<boolean> {
    const res = await this.req("POST", `/v1/worker/generations/${genId}/events`, { workerId: this.workerId, type, data });
    if (res.status === 409) return false;
    if (!res.ok) throw new Error(`event failed: ${res.status} ${await res.text()}`);
    return true;
  }

  async bytes(path: string): Promise<Uint8Array> {
    const res = await this.req("GET", path);
    if (!res.ok) throw new Error(`download ${path} failed: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async complete(genId: string, zip: Uint8Array, summary: string, thumbnail?: Uint8Array) {
    const f = new FormData();
    f.set("workerId", this.workerId);
    f.set("summary", summary);
    if (thumbnail) f.set("thumbnail", new File([thumbnail as Uint8Array<ArrayBuffer>], "thumb.jpg", { type: "image/jpeg" }));
    f.set("package", new File([zip as Uint8Array<ArrayBuffer>], "game.zip", { type: "application/zip" }));
    const res = await this.req("POST", `/v1/worker/generations/${genId}/complete`, f);
    if (!res.ok) throw new Error(`complete failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async checkpoint(genId: string, zip: Uint8Array, summary: string, thumbnail?: Uint8Array): Promise<{ version: number } | null> {
    const f = new FormData();
    f.set("workerId", this.workerId);
    f.set("summary", summary);
    f.set("package", new File([zip as Uint8Array<ArrayBuffer>], "game.zip", { type: "application/zip" }));
    if (thumbnail) f.set("thumbnail", new File([thumbnail as Uint8Array<ArrayBuffer>], "thumb.jpg", { type: "image/jpeg" }));
    const res = await this.req("POST", `/v1/worker/generations/${genId}/checkpoint`, f);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`checkpoint failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { version: { version: number } | number };
    return { version: typeof body.version === "number" ? body.version : body.version.version };
  }

  async fail(genId: string, error: string, retryable: boolean) {
    const res = await this.req("POST", `/v1/worker/generations/${genId}/fail`, { workerId: this.workerId, error, retryable });
    if (!res.ok && res.status !== 409) throw new Error(`fail failed: ${res.status} ${await res.text()}`);
  }
}

export interface Claim {
  generation: { id: string; gameId: string; prompt: string; selection: string[]; assetIds?: string[]; baseVersion: number; userId?: string };
  game?: { id: string; name: string; description?: string | null; remixOf?: { gameId: string; version: number } | null };
  leaseSeconds: number;
  base: { version: number; packageUrl: string } | null;
  images: { id: string; contentType: string; url: string }[];
}

export interface WorkerDeps {
  api: ApiClient;
  agentLLM: AgentLLM;
  jsonLLM: StructuredLLM;
  images: ImageGen;
  playtest: Playtester;
  memory?: Memory;
  sprites?: SpriteLibrary;
  maxRounds?: number;
  log?: (msg: string) => void;
}

const CONTINUE_PROMPT = "continue: build the next unchecked milestones in notes.md with the same quality, playtest them, and update notes.md";
const unchecked = (notes: string | undefined) => (notes?.match(/\[ \]/g) ?? []).length;
const checked = (notes: string | undefined) => (notes?.match(/\[x\]/gi) ?? []).length;

export interface JobMetrics {
  costUsd: number;
  rounds: number;
  turns: number;
  minutes: number;
  artScore: number | null;
  artVerdict: "ship" | "polish" | null;
  playtestRuns: number;
  runtimeErrorsFixed: number;
  finalGatePassedFirstTry: boolean | null;
  memoryHits: number;
  spritesReused: number;
  spritesDrawn: number;
  kit: string | null;
  pack: string | null;
  kind: string | null;
  memoryIds: string[];
}

export function jobMetrics(rounds: { stats: RoundStats; costUsd: number }[], startedAt: number): JobMetrics {
  const first = rounds[0]?.stats;
  const reviewed = rounds.map((r) => r.stats).filter((s) => s.artScore != null);
  const sum = (f: (s: RoundStats) => number) => rounds.reduce((a, r) => a + f(r.stats), 0);
  return {
    costUsd: Math.round(rounds.reduce((a, r) => a + r.costUsd, 0) * 10000) / 10000,
    rounds: rounds.length,
    turns: sum((s) => s.turns),
    minutes: Math.round((Date.now() - startedAt) / 600) / 100,
    artScore: reviewed.at(-1)?.artScore ?? null,
    artVerdict: reviewed.at(-1)?.artVerdict ?? null,
    playtestRuns: sum((s) => s.playtestRuns),
    runtimeErrorsFixed: sum((s) => s.runtimeErrorsFixed),
    finalGatePassedFirstTry: first?.finalGatePassedFirstTry ?? null,
    memoryHits: sum((s) => s.memoryHits),
    spritesReused: sum((s) => s.spritesReused),
    spritesDrawn: sum((s) => s.spritesDrawn),
    kit: first?.kit ?? null,
    pack: first?.pack ?? null,
    kind: first?.kind ?? null,
    memoryIds: [...new Set(rounds.flatMap((r) => r.stats.memoryIds))].slice(0, 100),
  };
}

export async function processJob(deps: WorkerDeps, job: Claim): Promise<"succeeded" | "failed" | "stopped"> {
  const { api } = deps;
  const log = deps.log ?? (() => {});
  const genId = job.generation.id;
  const abort = new AbortController();

  const emit = async (type: string, data: Record<string, unknown> = {}) => {
    if (abort.signal.aborted) return;
    try {
      if (!(await api.event(genId, type, data))) abort.abort();
    } catch (e) {
      log(`event ${type} failed: ${(e as Error).message}`);
    }
  };
  const heartbeat = setInterval(() => void emit("heartbeat"), Math.max(5, job.leaseSeconds / 3) * 1000);
  const startedAt = Date.now();
  const done: { stats: RoundStats; costUsd: number }[] = [];
  const sendMetrics = () => emit("metrics", { ...jobMetrics(done, startedAt) });

  try {
    const base = job.base ? Package.fromZip(await api.bytes(job.base.packageUrl)) : Package.empty();
    const images = await Promise.all(job.images.map(async (img) => ({
      mediaType: img.contentType,
      base64: Buffer.from(await api.bytes(img.url)).toString("base64"),
    })));

    const maxRounds = Math.max(1, deps.maxRounds ?? 1);
    const big = /^continue\b/i.test(job.generation.prompt);
    let pkg = base;
    let lastSummary = "";
    let lastThumb: Uint8Array | undefined;
    let committedThisJob = false;
    const roundSecs: number[] = [];
    let plannedRounds = maxRounds;
    let baseVersion = job.generation.baseVersion;

    for (let round = 1; ; round++) {
      const remaining = Math.max(1, plannedRounds - round + 1);
      const avg = roundSecs.length ? roundSecs.reduce((a, b) => a + b, 0) / roundSecs.length : (round === 1 && !job.base ? 600 : 420);
      await emit("eta", { etaSeconds: Math.round(avg * remaining), round, rounds: plannedRounds, phase: round === 1 ? "planning and building" : "building the next milestones" });
      const t0 = Date.now();
      const result = await generate(
        { agentLLM: deps.agentLLM, jsonLLM: deps.jsonLLM, images: deps.images, playtest: deps.playtest, emit, signal: abort.signal, memory: deps.memory, sprites: deps.sprites },
        {
          base: pkg, prompt: round === 1 ? job.generation.prompt : CONTINUE_PROMPT, images: round === 1 ? images : [], selection: round === 1 ? job.generation.selection : [], assetIds: round === 1 ? job.generation.assetIds ?? [] : [],
          origin: { userId: job.generation.userId, gameId: job.generation.gameId, baseVersion, remixOf: job.game?.remixOf ?? null },
        },
      );
      roundSecs.push((Date.now() - t0) / 1000);
      if (abort.signal.aborted) { log(`${genId}: stopped by API`); return "stopped"; }
      done.push({ stats: result.stats, costUsd: result.cost.usd });
      await emit("cost.final", { round, ...result.cost });

      if (!result.ok) {
        await sendMetrics();
        if (round === 1) {
          await api.fail(genId, result.message, result.retryable);
          log(`${genId}: failed — ${result.message}`);
          return "failed";
        }
        await api.complete(genId, pkg.toZip(), `${lastSummary} (stopped after round ${round - 1}: ${result.message})`, lastThumb);
        log(`${genId}: stopped after round ${round - 1} — ${result.message}`);
        return "succeeded";
      }

      pkg = result.pkg;
      lastSummary = result.summary;
      lastThumb = result.thumbnail ?? lastThumb;
      const notes = pkg.text("notes.md");
      const multiRound = maxRounds > 1 && (round > 1 || result.kind === "new_game" || big);
      if (round === 1 && multiRound) plannedRounds = Math.min(maxRounds, 1 + Math.ceil(unchecked(notes) / 2));
      const more = multiRound && round < maxRounds && unchecked(notes) > 0;

      if (more) {
        const cp = await api.checkpoint(genId, pkg.toZip(), result.summary, result.thumbnail);
        if (cp) {
          committedThisJob = true;
          baseVersion = cp.version;
          log(`${genId}: round ${round} saved as version ${cp.version} (${checked(notes)} milestones done, ${unchecked(notes)} left)`);
          continue;
        }
        log(`${genId}: API has no checkpoint endpoint; finishing after one round`);
      }
      await sendMetrics();
      await api.complete(genId, pkg.toZip(), result.summary, result.thumbnail);
      log(`${genId}: succeeded after ${round} round(s)${committedThisJob ? " with checkpoints" : ""}`);
      return "succeeded";
    }
  } catch (e) {
    if (abort.signal.aborted) return "stopped";
    const msg = (e as Error).message;
    log(`${genId}: error — ${msg}`);
    if (done.length) await sendMetrics().catch(() => {});
    await api.fail(genId, `internal error: ${msg}`, true).catch(() => {});
    return "failed";
  } finally {
    clearInterval(heartbeat);
  }
}

export async function runWorker(deps: WorkerDeps, opts: { concurrency: number; idleMs: number; signal: AbortSignal }) {
  const log = deps.log ?? console.log;
  const loop = async (slot: number) => {
    while (!opts.signal.aborted) {
      let job: Claim | null = null;
      try {
        job = await deps.api.claim();
      } catch (e) {
        log(`[${slot}] claim error: ${(e as Error).message}`);
      }
      if (!job) { await new Promise((r) => setTimeout(r, opts.idleMs)); continue; }
      log(`[${slot}] claimed ${job.generation.id}: ${job.generation.prompt.slice(0, 80)}`);
      await processJob(deps, job);
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency }, (_, i) => loop(i)));
}
