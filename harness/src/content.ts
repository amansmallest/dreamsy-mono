import type Anthropic from "@anthropic-ai/sdk";
import { checkSvg, type Package, validatePackage } from "@dreamsy/format";
import { z } from "zod";
import { CostMeter, MODELS, type AgentLLM } from "./models.js";
import type { Emit } from "./workspace.js";
import { contentValidator } from "./schemas.js";

/**
 * Parallel content builders (docs/kits.md §12.2 step 2). The director hands over a list of specs
 * (creatures, enemies, items, levels, NPCs…); N Sonnet workers each build a slice, writing only
 * files named after their own ids. Results are checked and merged into the director's package.
 */

export interface ContentItem { id: string; spec: string }
export interface ContentJob {
  /** e.g. "creatures", "enemies", "items", "levels", "npcs" — used for the data folder hint. */
  kind: string;
  /** Shared instructions: file format (from KIT.md), naming, art rules, balance targets. */
  guide: string;
  items: ContentItem[];
}

const ID = /^[a-z][a-z0-9_]{0,63}$/;
const WorkerFiles = z.object({ files: z.array(z.object({ path: z.string(), content: z.string() })).max(40) });
const WorkerSprite = z.object({ id: z.string(), svg: z.string().min(10) });

type Tool = Anthropic.Beta.BetaTool;
const WORKER_TOOLS: Tool[] = [
  {
    name: "read_files",
    description: "Read package files (notes.md, existing data files for reference).",
    strict: true,
    input_schema: { type: "object", properties: { paths: { type: "array", items: { type: "string" } } }, required: ["paths"], additionalProperties: false },
  },
  {
    name: "draw_sprite",
    description: "Draw an SVG sprite asset. Its id MUST start with one of your item ids (e.g. emberkit_front).",
    strict: true,
    input_schema: { type: "object", properties: { id: { type: "string" }, svg: { type: "string" } }, required: ["id", "svg"], additionalProperties: false },
  },
  {
    name: "write_files",
    description: "Write text files (JSON data, level .txt maps, Luau). Every path must be under data/ or scripts/ and its file name must start with one of your item ids.",
    input_schema: {
      type: "object",
      properties: { files: { type: "array", items: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
      required: ["files"],
    },
  },
  {
    name: "done",
    description: "Call when every item in your slice is complete.",
    strict: true,
    input_schema: { type: "object", properties: { note: { type: "string" } }, required: ["note"], additionalProperties: false },
  },
];

const WORKER_SYSTEM = `You are a content builder on a game team. The game director wrote a design bible (notes.md) and gave you a slice of content specs. Build exactly those items, with craft, following the bible's art direction and the file formats in the guide.
Rules:
- Only create files/sprites whose names start with one of YOUR item ids. Never edit other files.
- Data files must be valid JSON matching the guide's format exactly.
- Sprites: SVG with a viewBox, the game's palette only, consistent outline/shading with the bible. Draw every sprite the guide asks for per item.
- Be efficient: batch all files for an item in one write_files call; call done when finished.`;

function ownedBy(name: string, ids: string[]): boolean {
  const base = name.split("/").pop() ?? "";
  return ids.some((id) => base === id || base.startsWith(`${id}_`) || base.startsWith(`${id}.`) || base.startsWith(`${id}-`));
}

function allowedPath(path: string, ids: string[]): boolean {
  if (!/^(data|scripts\/(client|server|shared))\/[a-z0-9_\-/]+\.(json|txt|luau)$/.test(path)) return false;
  if (path.includes("..")) return false;
  return ownedBy(path, ids);
}

async function runWorker(args: {
  llm: AgentLLM;
  signal: AbortSignal;
  cost: CostMeter;
  base: Package;
  job: ContentJob;
  slice: ContentItem[];
  styleText: string;
  palette: string[];
}): Promise<{ files: Map<string, Uint8Array>; errors: string[] }> {
  const { llm, signal, cost, job, slice } = args;
  const ids = slice.map((i) => i.id);
  let pkg = args.base;
  const written = new Map<string, Uint8Array>();
  const errors: string[] = [];

  const messages: Anthropic.Beta.BetaMessageParam[] = [{
    role: "user",
    content: [{
      type: "text",
      text: [
        `# Design bible (notes.md)\n${(args.base.text("notes.md") ?? "(none)").slice(0, 20000)}`,
        `# Art style\n${args.styleText}\nPalette: ${args.palette.join(" ") || "(see bible)"}`,
        `# Guide for "${job.kind}"\n${job.guide}`,
        `# Your slice (${slice.length})\n${slice.map((i) => `## ${i.id}\n${i.spec}`).join("\n\n")}`,
      ].join("\n\n"),
    }],
  }];

  for (let turn = 1; turn <= 10; turn++) {
    if (signal.aborted) break;
    let msg: Anthropic.Beta.BetaMessage;
    try {
      msg = await llm.turn({
        model: MODELS.sonnet,
        max_tokens: 32000,
        cache_control: { type: "ephemeral" },
        system: WORKER_SYSTEM,
        tools: WORKER_TOOLS,
        messages,
        output_config: { effort: "medium" },
      }, signal);
    } catch (e) {
      errors.push(`worker error: ${(e as Error).message}`);
      break;
    }
    cost.add(msg.model, msg.usage);
    messages.push({ role: "assistant", content: msg.content as Anthropic.Beta.BetaContentBlockParam[] });
    const uses = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (!uses.length) break;

    let finished = false;
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const use of uses) {
      const res = (text: string, isError = false): Anthropic.Beta.BetaToolResultBlockParam =>
        ({ type: "tool_result", tool_use_id: use.id, content: text, ...(isError ? { is_error: true } : {}) });
      if (use.name === "read_files") {
        const paths = (use.input as { paths?: string[] }).paths ?? [];
        results.push(res(paths.slice(0, 20).map((p) => `=== ${p} ===\n${pkg.text(p) ?? "(does not exist)"}`).join("\n\n")));
      } else if (use.name === "draw_sprite") {
        const p = WorkerSprite.safeParse(use.input);
        if (!p.success || !ID.test(p.data.id) || !ownedBy(p.data.id, ids)) { results.push(res(`Rejected: sprite id must be lowercase_snake and start with one of ${ids.join(", ")}`, true)); continue; }
        const bad = checkSvg(p.data.svg);
        if (bad) { results.push(res(`Rejected SVG: ${bad}`, true)); continue; }
        const bytes = new TextEncoder().encode(p.data.svg);
        const meta = new TextEncoder().encode(JSON.stringify({ kind: "image", file: `${p.data.id}.svg`, source: { model: msg.model, prompt: "content builder" } }, null, 2) + "\n");
        written.set(`assets/${p.data.id}.svg`, bytes);
        written.set(`assets/${p.data.id}.meta.json`, meta);
        pkg = pkg.with(`assets/${p.data.id}.svg`, bytes).with(`assets/${p.data.id}.meta.json`, meta);
        results.push(res(`Saved sprite ${p.data.id} (asset:${p.data.id}).`));
      } else if (use.name === "write_files") {
        const p = WorkerFiles.safeParse(use.input);
        if (!p.success) { results.push(res(`Invalid input: ${p.error.message}`, true)); continue; }
        const out: string[] = [];
        for (const f of p.data.files) {
          if (!allowedPath(f.path, ids)) { out.push(`✗ ${f.path}: not allowed (must be under data/ or scripts/, named after one of ${ids.join(", ")})`); continue; }
          if (f.path.endsWith(".json")) {
            try { JSON.parse(f.content); } catch (e) { out.push(`✗ ${f.path}: invalid JSON (${(e as Error).message})`); continue; }
          }
          const bytes = new TextEncoder().encode(f.content);
          written.set(f.path, bytes);
          pkg = pkg.with(f.path, bytes);
          out.push(`✓ ${f.path}`);
        }
        results.push(res(out.join("\n"), out.some((l) => l.startsWith("✗"))));
      } else if (use.name === "done") {
        finished = true;
        results.push(res("ok"));
      } else {
        results.push(res("unknown tool", true));
      }
    }
    if (finished) break;
    messages.push({ role: "user", content: results });
  }
  return { files: written, errors };
}

/** Fan out, merge, validate. Returns the merged package and a report for the director. */
export async function buildContent(args: {
  llm: AgentLLM;
  emit: Emit;
  signal: AbortSignal;
  cost: CostMeter;
  pkg: Package;
  job: ContentJob;
  styleText: string;
  palette: string[];
  /** Kits the game uses: their JSON Schemas check the builders' data files. */
  kitIds?: string[];
  perWorker?: number;
  maxParallel?: number;
}): Promise<{ pkg: Package; report: string }> {
  const { job } = args;
  const items = job.items.filter((i) => ID.test(i.id));
  const rejected = job.items.filter((i) => !ID.test(i.id)).map((i) => i.id);
  const per = args.perWorker ?? 4;
  const slices: ContentItem[][] = [];
  for (let i = 0; i < items.length; i += per) slices.push(items.slice(i, i + per));

  let done = 0;
  await args.emit("content", { kind: job.kind, items: items.length, workers: slices.length, done: 0 });
  const maxParallel = args.maxParallel ?? 6;
  const results: Awaited<ReturnType<typeof runWorker>>[] = new Array(slices.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(maxParallel, slices.length) }, async () => {
    while (next < slices.length && !args.signal.aborted) {
      const idx = next++;
      results[idx] = await runWorker({ ...args, base: args.pkg, slice: slices[idx]! });
      done += slices[idx]!.length;
      await args.emit("content", { kind: job.kind, items: items.length, workers: slices.length, done });
    }
  }));

  // Merge: workers own disjoint ids, so files can't collide; later slices win on any overlap.
  let pkg = args.pkg;
  const lines: string[] = [];
  results.forEach((r, i) => {
    if (!r) return;
    for (const [path, bytes] of r.files) pkg = pkg.with(path, bytes);
    const ids = slices[i]!.map((s) => s.id);
    const files = [...r.files.keys()];
    for (const id of ids) {
      const mine = files.filter((f) => ownedBy(f, [id]));
      lines.push(mine.length ? `✓ ${id}: ${mine.join(", ")}` : `✗ ${id}: nothing written`);
    }
    for (const e of r.errors) lines.push(`! slice ${i + 1}: ${e}`);
  });
  if (rejected.length) lines.push(`✗ invalid ids (must be lowercase_snake): ${rejected.join(", ")}`);

  // Schema-check every data file the builders wrote against the game's kits.
  if (args.kitIds?.length) {
    const sv = contentValidator(args.kitIds);
    const bad: string[] = [];
    for (const r of results) {
      if (!r) continue;
      for (const path of r.files.keys()) {
        if (!path.endsWith(".json")) continue;
        let json: unknown;
        try { json = JSON.parse(pkg.text(path)!); } catch { continue; }
        const errs = sv.check(path, json);
        if (errs?.length) bad.push(`✗ ${path} does not match the kit schema:\n    ${errs.join("\n    ")}`);
      }
    }
    if (bad.length) lines.push(`Schema problems (${bad.length} files) — fix them or re-run those items:`, ...bad.slice(0, 20));
  }

  const v = validatePackage(pkg);
  const errs = v.issues.filter((x) => x.severity === "error");
  if (errs.length) lines.push(`Package now has ${errs.length} validation errors (fix with apply_ops):`, ...errs.slice(0, 20).map((x) => `- [${x.code}] ${x.file ?? ""} ${x.message}`));
  return { pkg, report: `Content "${job.kind}": ${items.length} items, ${slices.length} parallel workers.\n${lines.join("\n")}` };
}

