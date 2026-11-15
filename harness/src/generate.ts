import { type Package, validatePackage } from "@dreamsy/format";
import type { Memory } from "./memory.js";
import type { SpriteLibrary } from "./sprites.js";
import { humanizeId } from "./sprites.js";
import { newTrace, primaryKit, writeBuildMemory, type BuildCtx, type RunTrace } from "./lessons.js";
import { runAgent, type AgentResult } from "./agent.js";
import type { ImageGen } from "./images.js";
import { CostMeter, MODELS, type AgentLLM, type StructuredLLM } from "./models.js";
import { describeGame } from "./prompt.js";
import { PLANS, routeRequest, type Plan } from "./route.js";
import { z } from "zod";
import type { Emit } from "./workspace.js";
import type { Playtester } from "./playtest.js";
import { kitTemplate } from "./templates.js";

export interface GenerateInput {
  base: Package;
  prompt: string;
  images: { mediaType: string; base64: string }[];
  selection: string[];
  /** Sprite click-to-edit: only these assets may change. */
  assetIds?: string[];
  /** Who/where (from the job claim): scopes memory recall and remix records. */
  origin?: { userId?: string; gameId?: string; baseVersion?: number; remixOf?: { gameId: string; version: number } | null };
}

/** Per-round facts for metrics/graphs (worker aggregates rounds into the `metrics` event). */
export interface RoundStats {
  kind: string;
  kit: string | null;
  kits: string[];
  pack: string | null;
  turns: number;
  artScore: number | null;
  artVerdict: "ship" | "polish" | null;
  playtestRuns: number;
  runtimeErrorsFixed: number;
  finalGatePassedFirstTry: boolean | null;
  memoryHits: number;
  memoryIds: string[];
  lessonsUsed: number;
  lessonsWritten: number;
  spritesReused: number;
  spritesDrawn: number;
}

export type GenerateResult =
  | { ok: true; pkg: Package; summary: string; cost: ReturnType<CostMeter["snapshot"]>; thumbnail?: Uint8Array; kind: string; stats: RoundStats }
  | { ok: false; message: string; retryable: boolean; cost: ReturnType<CostMeter["snapshot"]>; stats: RoundStats };

function roundStats(ctx: BuildCtx, t: RunTrace, ok: boolean, spritesDrawn: number, lessonsWritten: number): RoundStats {
  const last = t.reviews.at(-1);
  return {
    kind: ctx.kind, kit: primaryKit(ctx.kits), kits: ctx.kits, pack: ctx.pack, turns: t.turns,
    artScore: last?.score ?? null, artVerdict: last?.verdict ?? null,
    playtestRuns: t.playtestRuns, runtimeErrorsFixed: ok ? t.runtimeErrors.size : 0,
    finalGatePassedFirstTry: t.finalGatePassedFirstTry,
    memoryHits: t.memory.hits, memoryIds: t.memory.ids, lessonsUsed: t.memory.lessonsUsed, lessonsWritten,
    spritesReused: t.spritesReused, spritesDrawn,
  };
}

/** SVG assets that are new or changed vs the base package. */
function changedSvgs(base: Package, pkg: Package): string[] {
  const same = (a?: Uint8Array, b?: Uint8Array) => !!a && !!b && a.byteLength === b.byteLength && a.every((x, i) => x === b[i]);
  return pkg.paths("assets/").filter((p) => p.endsWith(".svg") && !same(base.bytes(p), pkg.bytes(p)));
}

function fileDiff(base: Package, pkg: Package) {
  const same = (a?: Uint8Array, b?: Uint8Array) => !!a && !!b && a.byteLength === b.byteLength && a.every((x, i) => x === b[i]);
  const before = new Set(base.paths());
  const after = new Set(pkg.paths());
  return {
    added: [...after].filter((p) => !before.has(p)),
    changed: [...after].filter((p) => before.has(p) && !same(base.bytes(p), pkg.bytes(p))),
    removed: [...before].filter((p) => !after.has(p)),
  };
}

/** route → agent (→ one escalation) → summary. Pure: no API calls, used by worker and local CLI. */
export async function generate(deps: {
  agentLLM: AgentLLM;
  jsonLLM: StructuredLLM;
  images: ImageGen;
  emit: Emit;
  signal: AbortSignal;
  playtest: Playtester;
  /** Retrieval memory (lessons, remix records, outcomes). Optional: absent = no memory. */
  memory?: Memory;
  /** Shared sprite library (find_sprites + storing shipped sprites). */
  sprites?: SpriteLibrary;
}, input: GenerateInput): Promise<GenerateResult> {
  const cost = new CostMeter();
  const game = describeGame(input.base);

  const { route, usage, model } = await routeRequest(deps.jsonLLM, {
    prompt: input.prompt,
    gameIsEmpty: game.empty,
    gameSummary: game.text.slice(0, 4000),
    images: input.images,
  });
  cost.add(model, usage);
  await deps.emit("route", { kind: route.kind, style: route.style, dimension: route.dimension, reason: route.reason });

  // Sprite-scoped edits are always cheap asset edits, whatever the wording.
  if (input.assetIds?.length && route.kind !== "reject" && route.safe) route.kind = "asset";

  const manifest = validatePackage(input.base).manifest;
  const isNew = route.kind === "new_game";
  const kits = isNew ? route.kits ?? [] : manifest?.kits ?? [];
  const ctx: BuildCtx = {
    userId: input.origin?.userId,
    gameId: input.origin?.gameId,
    kind: route.kind,
    kits,
    pack: (isNew ? route.pack : manifest?.style.pack) ?? null,
    style: (isNew ? route.style : manifest?.style.preset) ?? "clean",
    orientation: (isNew ? route.orientation : manifest ? manifest.orientation ?? "landscape" : null) ?? null,
    genre: primaryKit(kits),
  };
  const trace = newTrace();

  if (route.kind === "reject" || !route.safe) {
    return { ok: false, message: `Can't build that: ${route.reason}`, retryable: false, cost: cost.snapshot(), stats: roundStats(ctx, trace, false, 0, 0) };
  }

  // Default: new games start from the chosen genre kit's template game (fast first playable).
  let template: string | null = null;
  if (route.kind === "new_game" && !route.fromScratch && input.base.paths().length === 0) {
    const t = await kitTemplate(route.kits ?? []);
    if (t) {
      template = t.kit;
      input = { ...input, base: t.pkg.with("dreamsy.toml", (t.pkg.text("dreamsy.toml") ?? "").replace(/^id\s*=.*\n/m, "")) };
      await deps.emit("template", { kit: t.kit });
    }
  }

  const first = PLANS[route.kind];
  const attempts: Plan[] = [first];
  if (first.escalate) attempts.push({ ...first.escalate, escalate: null });

  let last: AgentResult | null = null;
  for (const [i, plan] of attempts.entries()) {
    if (i > 0) await deps.emit("escalate", { model: plan.model, because: last && !last.ok ? last.message : "" });
    last = await runAgent({ llm: deps.agentLLM, images: deps.images, emit: deps.emit, signal: deps.signal, playtest: deps.playtest, critic: deps.jsonLLM, plan, cost, input: { ...input, route, template }, memory: deps.memory, ctx, sprites: deps.sprites, trace });
    if (last.ok) break;
    // Only quality failures escalate; refusals/budget/cancel don't.
    if (last.reason !== "turns" && last.reason !== "no_progress") break;
  }

  // Remember this round (lessons, outcome, remix record). Best-effort; never fails the job.
  const remember = async (ok: boolean, pkg: Package, failReason?: string) => {
    if (!deps.memory || deps.signal.aborted) return 0;
    try {
      const r = await writeBuildMemory({ memory: deps.memory, llm: deps.jsonLLM, cost }, {
        ctx, trace, ok, failReason, artScore: trace.reviews.at(-1)?.score ?? null, costUsd: cost.usd, prompt: input.prompt,
        parent: input.origin?.gameId && input.base.has("dreamsy.toml")
          ? { gameId: input.origin.gameId, version: input.origin.baseVersion ?? 0, remixOf: input.origin.remixOf ?? null }
          : undefined,
        filesChanged: fileDiff(input.base, pkg),
        notes: pkg.text("notes.md"),
        maxTurns: first.maxTurns, maxUsd: first.maxUsd,
      });
      await deps.emit("memory.saved", { lessons: r.lessons, consolidated: r.consolidated, items: r.written.length });
      return r.lessons;
    } catch { return 0; }
  };

  if (!last || !last.ok) {
    const reason = last && !last.ok ? last.reason : "error";
    const message = last && !last.ok ? last.message : "no result";
    const lessonsWritten = reason === "error" && deps.signal.aborted ? 0 : await remember(false, input.base, `${reason}: ${message}`.slice(0, 200));
    return { ok: false, message, retryable: reason === "error", cost: cost.snapshot(), stats: roundStats(ctx, trace, false, Math.max(0, trace.sprites.size - trace.spritesReused), lessonsWritten) };
  }

  // Scoped sprite edits: keep ONLY changes to the chosen assets' files; drop anything else.
  if (input.assetIds?.length) {
    const owned = (path: string) => input.assetIds!.some((id) => new RegExp(`^assets/${id}\\.[a-z0-9.]+$`).test(path));
    let scoped = input.base;
    for (const path of new Set([...last.pkg.paths(), ...input.base.paths()])) {
      if (!owned(path)) continue;
      const after = last.pkg.bytes(path);
      scoped = after ? scoped.with(path, after) : scoped.without(path);
    }
    last = { ...last, pkg: scoped };
  }

  let summary = last.summary;
  try {
    const s = await deps.jsonLLM.json({
      model: MODELS.haiku,
      system: "Rewrite the builder's note as one short, friendly line (max 12 words) for a version history. No emojis.",
      content: `Player asked: ${input.prompt}\nBuilder's note: ${last.summary}`,
      schema: z.object({ line: z.string() }),
      effort: "low",
    });
    cost.add(s.model, s.usage);
    summary = s.value.line;
  } catch {
    // keep the builder's own summary
  }
  // Thumbnail for feeds: a quiet frame ~2.5s in (title screens make good covers).
  let thumbnail: Uint8Array | undefined;
  if (deps.playtest.browser) {
    try {
      thumbnail = (await deps.playtest.browser(last.pkg, [], [2.5])).shots[0]?.jpeg;
    } catch { /* thumbnails are best-effort */ }
  }

  // Shipped sprites → library, carrying this build's art score.
  const svgs = changedSvgs(input.base, last.pkg);
  if (deps.sprites && !deps.signal.aborted) {
    const style = validatePackage(last.pkg).manifest?.style;
    for (const path of svgs) {
      const assetId = path.slice("assets/".length, -".svg".length);
      const info = trace.sprites.get(assetId);
      try {
        await deps.sprites.store(last.pkg.text(path)!, {
          assetId,
          description: info?.description?.trim() || humanizeId(assetId),
          pack: style?.pack ?? ctx.pack,
          style: style?.preset ?? ctx.style,
          palette: style?.palette ?? [],
          kits: ctx.kits,
          gameId: ctx.gameId ?? null,
          score: trace.reviews.at(-1)?.score ?? null,
          from: info?.from ?? null,
        });
      } catch { /* library is best-effort */ }
    }
  }
  const reusedShipped = svgs.filter((p) => trace.sprites.get(p.slice(7, -4))?.from).length;
  const lessonsWritten = await remember(true, last.pkg);
  return { ok: true, pkg: last.pkg, summary, cost: cost.snapshot(), thumbnail, kind: route.kind, stats: { ...roundStats(ctx, trace, true, svgs.length - reusedShipped, lessonsWritten), spritesReused: reusedShipped } };
}
