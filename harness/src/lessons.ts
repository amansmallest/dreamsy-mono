import { z } from "zod";
import type { CostMeter } from "./models.js";
import { MODELS, type StructuredLLM } from "./models.js";
import { GLOBAL, memId, scope, type Memory, type MemoryHit, type MemoryItem } from "./memory.js";

/**
 * What the harness writes to and reads from Memory around each build round (retrieval, not
 * training): build lessons (global, no prompt text), remix records (user-scoped), outcomes (global).
 */

/** Facts collected while the agent runs; one per generate() call (shared across an escalation). */
export interface RunTrace {
  turns: number;
  reviews: { score: number; verdict: "ship" | "polish"; fixes: string[] }[];
  gateFailures: string[][];
  /** First finish's final gate: passed? null when finish was never called. */
  finalGatePassedFirstTry: boolean | null;
  playtestRuns: number;
  /** Distinct runtime script errors seen in playtests / final gates. */
  runtimeErrors: Set<string>;
  budgetHit: boolean;
  turnsHit: boolean;
  ops: Record<string, number>;
  reasons: string[];
  /** Sprites drawn this run (asset id → description / library id it was adapted from). */
  sprites: Map<string, { description?: string; from?: string }>;
  spritesReused: number;
  memory: { ids: string[]; hits: number; lessonsUsed: number; remixUsed: number; fromBuilds: number };
}

export function newTrace(): RunTrace {
  return {
    turns: 0, reviews: [], gateFailures: [], finalGatePassedFirstTry: null, playtestRuns: 0, runtimeErrors: new Set(),
    budgetHit: false, turnsHit: false, ops: {}, reasons: [], sprites: new Map(), spritesReused: 0,
    memory: { ids: [], hits: 0, lessonsUsed: 0, remixUsed: 0, fromBuilds: 0 },
  };
}

/** Who/what a build is about; drives scoping and boosts. */
export interface BuildCtx {
  userId?: string;
  gameId?: string;
  kind: string;
  kits: string[];
  pack: string | null;
  style: string;
  orientation: string | null;
  genre: string | null;
}

/** Foundation kits aren't genres. */
const FOUNDATION = new Set(["core", "progression", "juice", "combat", "ai", "procgen"]);
export const primaryKit = (kits: string[]) => kits.find((k) => !FOUNDATION.has(k)) ?? kits[0] ?? null;

const buildScopes = (c: BuildCtx) => [
  ...c.kits.map(scope.kit),
  ...(c.pack ? [scope.pack(c.pack)] : []),
  ...(c.genre ? [scope.genre(c.genre)] : []),
  ...(c.orientation ? [scope.orientation(c.orientation)] : []),
];

// ---------- recall ----------

const RECALL_CHARS = 6000; // ≈ 1.5k tokens

export async function recallForBuild(memory: Memory, ctx: BuildCtx, prompt: string, opts: { spriteLibrary: boolean }) {
  const boosts = { kits: ctx.kits, pack: ctx.pack ?? undefined, genre: ctx.genre ?? undefined, orientation: ctx.orientation ?? undefined, gameId: ctx.gameId };
  const query = [prompt.slice(0, 600), ...ctx.kits, ctx.pack ?? "", ctx.genre ?? ""].join(" ");
  const lessons = await memory.recall(query, { ...boosts, kinds: ["lesson"], limit: 8 });
  const remixes = ctx.kind !== "new_game" && ctx.userId
    ? await memory.recall(prompt.slice(0, 600), { ...boosts, userId: ctx.userId, kinds: ["remix"], limit: 4 })
    : [];
  const fromBuilds = lessons.reduce((a, h) => a + (h.item.weight ?? 1), 0) + remixes.length;

  const lines: string[] = [];
  if (lessons.length || remixes.length) {
    lines.push(`# What worked before (retrieved from ${fromBuilds} past build${fromBuilds === 1 ? "" : "s"} — advice, not rules; the request wins)`);
    if (lessons.length) {
      lines.push("Lessons:");
      for (const h of lessons) lines.push(`- [${topicOf(h.item)}${(h.item.weight ?? 1) > 1 ? ` ×${h.item.weight}` : ""}] ${h.item.text}`);
    }
    if (remixes.length) {
      lines.push("Your similar past edits and how they went:");
      for (const h of remixes) lines.push(`- ${h.item.text}`);
    }
  }
  if (opts.spriteLibrary) {
    lines.push(`${lines.length ? "\n" : ""}# Sprite library\nBefore drawing common objects (coins, hearts, gems, keys, trees, rocks, bushes, chests, UI icons, arrows, particles), call find_sprites. Adapt a good match to this game's palette and art bible and save it with draw_sprite (from = library id); never reuse a sprite from a different style pack without restyling it.`);
  }
  let text = lines.join("\n");
  if (text.length > RECALL_CHARS) text = `${text.slice(0, RECALL_CHARS)}…`;
  const hits: MemoryHit[] = [...lessons, ...remixes];
  return { text, hits, lessonsUsed: lessons.length, remixUsed: remixes.length, fromBuilds };
}

const topicOf = (i: MemoryItem) => i.scopes.find((s) => s.startsWith("topic:"))?.slice(6) ?? i.kind;

// ---------- write ----------

const Lessons = z.object({
  genre: z.string().max(40),
  lessons: z.array(z.object({
    topic: z.enum(["art", "runtime", "playtest", "budget", "design", "content"]),
    text: z.string().min(10).max(320),
  })).max(4),
});

const LESSON_SYSTEM = `You write build lessons for an AI game builder's retrieval memory. Given the trace of one build, write 0–4 short, reusable, actionable lessons that would make the NEXT build of a similar game better or cheaper.
Good sources: art-director fixes the builder applied before shipping (what was wrong → what fixed it), runtime/script errors and what they had in common, final-gate failures, playtests, budget or turn-limit problems.
Rules: generic and transferable (no game names, no character names, no story, nothing from the player's request); imperative voice, ≤ 40 words each; skip anything obvious or one-off; return [] when nothing is worth remembering.
genre: one lowercase word for the game's genre (e.g. platformer, rpg, puzzle, runner, shooter), from the kits and design notes.`;

export interface RoundRecord {
  ctx: BuildCtx;
  trace: RunTrace;
  ok: boolean;
  failReason?: string;
  artScore: number | null;
  costUsd: number;
  prompt: string;
  /** Version this round edited (edits/remixes). */
  parent?: { gameId: string; version: number; remixOf?: { gameId: string; version: number } | null };
  filesChanged: { added: string[]; changed: string[]; removed: string[] };
  /** notes.md head, for genre/lessons context (never stored). */
  notes?: string;
  maxTurns: number;
  maxUsd: number;
}

/**
 * After a round: outcome (global), remix record (user-scoped, for edits), Haiku lessons (global, no
 * prompt text), then consolidation of any tag that grew past the threshold. Never throws.
 */
export async function writeBuildMemory(deps: { memory: Memory; llm: StructuredLLM; cost?: CostMeter; consolidateAbove?: number }, r: RoundRecord): Promise<{ lessons: number; consolidated: number; written: string[]; errors: string[] }> {
  const { memory } = deps;
  const written: string[] = [];
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const t = r.trace;
  const kitTxt = r.ctx.kits.length ? r.ctx.kits.join("+") : "no kit";
  const errors: string[] = [];
  const put = async (item: MemoryItem) => {
    try { await memory.remember(item); written.push(item.id); } catch (e) { errors.push((e as Error).message); }
  };

  // Genre + lessons first (genre tags the other records too).
  let lessons: z.infer<typeof Lessons>["lessons"] = [];
  const notable = t.reviews.some((v) => v.fixes.length) || t.gateFailures.length > 0 || t.runtimeErrors.size > 0 || t.budgetHit || t.turnsHit || !r.ok;
  if (notable) {
    try {
      const res = await deps.llm.json({
        model: MODELS.haiku,
        system: LESSON_SYSTEM,
        content: traceText(r),
        schema: Lessons,
        effort: "low",
      });
      deps.cost?.add(res.model, res.usage);
      const parsed = Lessons.safeParse(res.value);
      if (parsed.success) {
        lessons = parsed.data.lessons;
        r.ctx.genre ??= parsed.data.genre.toLowerCase().replace(/[^a-z0-9-]/g, "") || null;
      }
    } catch { /* lessons are best-effort */ }
  }

  const tags = buildScopes(r.ctx);
  for (const [i, l] of lessons.entries()) {
    await put({
      id: memId("lesson", stamp, String(i)),
      kind: "lesson",
      text: l.text,
      scopes: [GLOBAL, ...tags, `topic:${l.topic}`],
      score: r.artScore,
      weight: 1,
      data: { kind: r.ctx.kind, ok: r.ok },
    });
  }

  // Outcome: global, no prompt text.
  await put({
    id: memId("outcome", stamp),
    kind: "outcome",
    text: `${r.ctx.kind} build (${kitTxt}${r.ctx.pack ? `, ${r.ctx.pack} pack` : ""}${r.ctx.genre && !r.ctx.kits.includes(r.ctx.genre) ? `, ${r.ctx.genre}` : ""}): ${r.ok ? "succeeded" : `failed (${r.failReason ?? "error"})`}, art ${r.artScore ?? "n/a"}/10, ${t.turns} turns, $${r.costUsd.toFixed(2)}`,
    scopes: [GLOBAL, ...tags],
    score: r.artScore,
    data: { ok: r.ok, artScore: r.artScore, costUsd: r.costUsd, turns: t.turns, kind: r.ctx.kind },
  });

  // Remix record: edits/remixes only; holds the instruction → scoped to its user (and game).
  if (r.ctx.kind !== "new_game" && r.ctx.userId && r.parent) {
    const opsTxt = Object.entries(t.ops).map(([k, n]) => `${k}×${n}`).join(", ") || "no ops";
    const files = [...r.filesChanged.added.map((f) => `+${f}`), ...r.filesChanged.changed.map((f) => `~${f}`), ...r.filesChanged.removed.map((f) => `-${f}`)];
    const playtestOk = r.ok && t.runtimeErrors.size === 0 ? "playtest clean" : r.ok ? `fixed ${t.runtimeErrors.size} runtime error(s)` : "did not pass";
    await put({
      id: memId("remix", stamp),
      kind: "remix",
      text: `"${r.prompt.slice(0, 300)}" (${r.ctx.kind}) → ${r.ok ? "succeeded" : `failed: ${r.failReason ?? "error"}`}; art ${r.artScore ?? "n/a"}/10; ${playtestOk}; ${opsTxt}; files ${files.slice(0, 12).join(" ") || "none"}`,
      scopes: [scope.user(r.ctx.userId), ...(r.ctx.gameId ? [scope.game(r.ctx.gameId)] : []), ...tags],
      score: r.artScore,
      data: {
        parent: r.parent, instruction: r.prompt.slice(0, 2000), kind: r.ctx.kind,
        patch: { ops: t.ops, reasons: t.reasons.slice(0, 20), files: r.filesChanged },
        result: { succeeded: r.ok, artScore: r.artScore, playtestOk: r.ok, runtimeErrorsFixed: r.ok ? t.runtimeErrors.size : 0 },
      },
    });
  }

  // Recursive part: tags that grew past the threshold get merged into fewer, stronger lessons.
  let consolidated = 0;
  if (lessons.length) {
    for (const tag of tags.filter((s) => s.startsWith("kit:") || s.startsWith("pack:") || s.startsWith("genre:"))) {
      try { consolidated += await consolidateLessons({ ...deps }, tag, deps.consolidateAbove ?? 12); } catch (e) { errors.push((e as Error).message); }
    }
  }
  return { lessons: lessons.length, consolidated, written, errors };
}

function traceText(r: RoundRecord): string {
  const t = r.trace;
  return [
    `Build: ${r.ctx.kind}; kits ${r.ctx.kits.join(", ") || "none"}; pack ${r.ctx.pack ?? "none"}; style ${r.ctx.style}; orientation ${r.ctx.orientation ?? "?"}`,
    `Outcome: ${r.ok ? "shipped" : `failed — ${r.failReason ?? "error"}`}; turns ${t.turns}/${r.maxTurns}; cost $${r.costUsd.toFixed(2)} of $${r.maxUsd}${t.budgetHit ? " (BUDGET HIT)" : ""}${t.turnsHit ? " (TURN LIMIT HIT)" : ""}`,
    t.reviews.length ? `Art director reviews:\n${t.reviews.map((v) => `- score ${v.score}/10 ${v.verdict}${v.fixes.length ? `; fixes the builder then applied before shipping:\n${v.fixes.map((f) => `    • ${f}`).join("\n")}` : ""}`).join("\n")}` : "Art director: not run",
    t.gateFailures.length ? `Final gate failures (${t.gateFailures.length}):\n${t.gateFailures.flat().slice(0, 15).join("\n")}` : "Final gate: passed first try",
    t.runtimeErrors.size ? `Runtime script errors seen (all fixed if shipped):\n${[...t.runtimeErrors].slice(0, 15).map((e) => `- ${e}`).join("\n")}` : "",
    `Playtests: ${t.playtestRuns}; op batches: ${t.reasons.length}; sprites drawn ${t.sprites.size} (adapted from library ${t.spritesReused})`,
    r.notes ? `Design notes (head, for genre only):\n${r.notes.slice(0, 1200)}` : "",
  ].filter(Boolean).join("\n\n");
}

// ---------- consolidation ----------

const Merged = z.object({
  lessons: z.array(z.object({
    text: z.string().min(10).max(320),
    topic: z.enum(["art", "runtime", "playtest", "budget", "design", "content"]),
    /** ids of the input lessons this one replaces (≥ 1). */
    supersedes: z.array(z.string()).min(1),
  })).max(20),
});

const MERGE_SYSTEM = `You maintain the lesson memory of an AI game builder. You get lessons (id, evidence count, text) that share a tag. Merge duplicates and near-duplicates into fewer, stronger, more specific lessons; drop vague or contradicted ones by superseding them with the better lesson. Keep each ≤ 40 words, imperative, generic. Every output lesson lists the input ids it replaces. Lessons you don't mention are kept as-is.`;

/** When `tag` has more than `threshold` lessons, merge them with Haiku and supersede the originals. Returns lessons removed. */
export async function consolidateLessons(deps: { memory: Memory; llm: StructuredLLM; cost?: CostMeter }, tag: string, threshold = 12): Promise<number> {
  const all = await deps.memory.recall(tag.split(":")[1] ?? tag, { kinds: ["lesson"], scopes: [tag], limit: 200 });
  if (all.length <= threshold) return 0;
  const byId = new Map(all.map((h) => [h.item.id, h.item]));
  const res = await deps.llm.json({
    model: MODELS.haiku,
    system: MERGE_SYSTEM,
    content: `Tag: ${tag}\n\n${all.map((h) => `[${h.item.id}] (×${h.item.weight ?? 1}, ${topicOf(h.item)}) ${h.item.text}`).join("\n")}`,
    schema: Merged,
    effort: "low",
  });
  deps.cost?.add(res.model, res.usage);
  const parsed = Merged.safeParse(res.value);
  if (!parsed.success) return 0;

  const used = new Set<string>();
  let removed = 0;
  const stamp = Date.now().toString(36);
  for (const [i, m] of parsed.data.lessons.entries()) {
    const sources = [...new Set(m.supersedes)].filter((id) => byId.has(id) && !used.has(id));
    if (!sources.length) continue;
    const src = sources.map((id) => byId.get(id)!);
    const scopes = [...new Set(src.flatMap((s) => s.scopes.filter((x) => !x.startsWith("topic:") && !x.startsWith("user:"))))];
    const scores = src.map((s) => s.score).filter((s): s is number => s != null);
    await deps.memory.remember({
      id: memId("lesson", "c", stamp, String(i)),
      kind: "lesson",
      text: m.text,
      scopes: [...new Set([GLOBAL, ...scopes, `topic:${m.topic}`])],
      score: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length * 10) / 10 : null,
      weight: src.reduce((a, s) => a + (s.weight ?? 1), 0),
      data: { supersedes: sources },
    });
    await deps.memory.forget(sources);
    for (const id of sources) used.add(id);
    removed += sources.length - 1;
  }
  return removed;
}
