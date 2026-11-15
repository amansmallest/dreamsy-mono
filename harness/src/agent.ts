import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { type Package, validatePackage } from "@dreamsy/format";
import type { ImageGen } from "./images.js";
import { CostMeter, MODELS, type AgentLLM, type StructuredLLM } from "./models.js";
import { describeGame, systemBlocks } from "./prompt.js";
import type { Plan, Route } from "./route.js";
import { tastePacks } from "./taste.js";
import { templateNote } from "./templates.js";
import { kits } from "./kits.js";
import { expandKits } from "@dreamsy/format";
import { buildContent } from "./content.js";
import { artDirectorReview, formatCritique } from "./critique.js";
import { describeRun, SMOKE_TIMELINE, type Playtester, type TimelineStep } from "./playtest.js";
import { fmtIssue, Workspace, type Emit } from "./workspace.js";
import type { Memory } from "./memory.js";
import { formatSpriteHits, type SpriteLibrary } from "./sprites.js";
import { newTrace, recallForBuild, type BuildCtx, type RunTrace } from "./lessons.js";

type Tool = Anthropic.Beta.BetaTool;
type MessageParam = Anthropic.Beta.BetaMessageParam;
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;

const TOOLS: Tool[] = [
  {
    name: "read_files",
    description: "Read package files (scripts, scene JSON, data, dreamsy.toml, asset meta).",
    strict: true,
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: { paths: { type: "array", items: { type: "string" } } },
      required: ["paths"],
      additionalProperties: false,
    },
  },
  {
    name: "get_entities",
    description: "Full JSON (type, props, scripts, tags, children) of specific entities by id.",
    strict: true,
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: { ids: { type: "array", items: { type: "string" } } },
      required: ["ids"],
      additionalProperties: false,
    },
  },
  {
    name: "apply_ops",
    description: "Apply a batch of edit ops atomically (all or nothing), then validate the whole package. Returns the op error, or the validation issues to fix.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Short description of this batch, e.g. 'add player movement'." },
        ops: { type: "array", items: { type: "object" }, description: "Edit ops, see system prompt." },
      },
      required: ["reason", "ops"],
    },
  },
  {
    name: "draw_sprite",
    description: "Draw a sprite/texture/icon/background as SVG and save it as an image asset. Call again with the same id to redraw it. Reference as \"asset:<id>\".",
    strict: true,
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Asset id, lowercase_snake, e.g. fox_idle." },
        svg: { type: "string", description: "Complete <svg> document with a viewBox. Plain shapes/paths/gradients only." },
        description: { type: "string", description: "Optional one-line description of what it depicts (e.g. 'gold coin, front view, 16px pixel'); indexes it in the sprite library." },
        from: { type: "string", description: "Optional: the find_sprites library id (spr_…) this sprite was adapted from." },
      },
      required: ["id", "svg"],
      additionalProperties: false,
    },
  },
  {
    name: "find_sprites",
    description: "Search the shared sprite library (sprites from past well-reviewed builds) for something to adapt instead of drawing from scratch: coins, hearts, gems, trees, rocks, chests, UI icons, arrows… Returns ids, descriptions and SVG text. Adapt to this game's palette/art bible and save with draw_sprite (from = library id).",
    strict: true,
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you need, e.g. 'gold coin pickup' or 'heart health icon'." },
        pack: { type: "string", description: "Optional style pack id to prefer (defaults to this game's pack)." },
        limit: { type: "integer", description: "Max results (1-8, default 4)." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "generate_image",
    description: "Generate an image asset in the background in the game's art style. The asset exists immediately (placeholder) so you can reference \"asset:<id>\" right away. Use for sprites, textures, icons, backgrounds.",
    strict: true,
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Asset id, lowercase_snake, e.g. cat_tower." },
        prompt: { type: "string", description: "What to draw: one subject, its pose/view, key details. Style is added automatically." },
        aspect: { type: "string", enum: ["1:1", "16:9", "9:16", "4:3", "3:4"] },
      },
      required: ["id", "prompt", "aspect"],
      additionalProperties: false,
    },
  },
  {
    name: "playtest",
    description: "Run the game with scripted input and SEE it: returns script errors, logs, player position trace, and screenshots (1280x720) at the times you ask. Use after building something to check it renders and plays right; fix what you see.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        seconds: { type: "number", description: "How long to run (1-20)." },
        scene: { type: "string", description: "Optional: start in this scene (e.g. scenes/world_3.scene.json) instead of the entry scene." },
        sceneParams: { type: "object", description: "Optional: params for sceneParams() in that scene." },
        save: { type: "object", description: "Optional: preloaded save data (key → value) so the game starts mid-progress." },
        shots: { type: "array", items: { type: "number" }, description: "Screenshot times in seconds (max 4)." },
        timeline: {
          type: "array",
          description: 'Input steps, e.g. [{"t":0.5,"hold":["right"]},{"t":1,"press":["jump"]},{"t":3,"tap":[640,600]}]. Controls: left,right,up,down,jump,action,action2. tap = click at UI coords (1280x720).',
          items: {
            type: "object",
            properties: {
              t: { type: "number" },
              hold: { type: "array", items: { type: "string" } },
              release: { type: "array", items: { type: "string" } },
              press: { type: "array", items: { type: "string" } },
              tap: { type: "array", items: { type: "number" } },
            },
            required: ["t"],
          },
        },
      },
      required: ["seconds", "shots", "timeline"],
    },
  },
  {
    name: "build_content",
    description: "Hand bulk content to parallel content builders (Sonnet workers, ~4 items each, up to 6 at once): creatures, enemies, items, NPCs, levels, quests… Each item gets its own files named after its id. Give a precise guide (exact file format from the kit docs, paths like data/creatures/<id>.json, which sprites to draw per item, balance targets) and one detailed spec per item. Returns a per-item report; fix or re-run failures. Write notes.md (the bible) BEFORE calling this — builders read it.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", description: "e.g. creatures, enemies, items, levels, npcs" },
        guide: { type: "string" },
        items: { type: "array", items: { type: "object", properties: { id: { type: "string" }, spec: { type: "string" } }, required: ["id", "spec"] } },
      },
      required: ["kind", "guide", "items"],
    },
  },
  {
    name: "finish",
    description: "Call when the game is complete and valid. The package is checked once more; if it fails you get the errors back.",
    strict: true,
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: { summary: { type: "string", description: "One friendly line for the player describing what you built or changed." } },
      required: ["summary"],
      additionalProperties: false,
    },
  },
];

const TOOL_LABEL: Record<string, string> = {
  read_files: "reading files",
  get_entities: "inspecting entities",
  apply_ops: "building",
  draw_sprite: "drawing a sprite",
  find_sprites: "checking the sprite library",
  generate_image: "painting an asset",
  build_content: "building content in parallel",
  playtest: "playtesting",
  finish: "final check",
};

const Control = z.enum(["left", "right", "up", "down", "jump", "action", "action2"]);
const Step = z.object({
  t: z.number().min(0).max(20),
  hold: z.array(Control).optional(),
  release: z.array(Control).optional(),
  press: z.array(Control).optional(),
  tap: z.tuple([z.number(), z.number()]).optional(),
});

const Inputs = {
  read_files: z.object({ paths: z.array(z.string()).max(50) }),
  get_entities: z.object({ ids: z.array(z.string()).max(200) }),
  apply_ops: z.object({ reason: z.string(), ops: z.array(z.unknown()) }),
  draw_sprite: z.object({ id: z.string(), svg: z.string().min(10), description: z.string().max(300).optional(), from: z.string().max(40).optional() }),
  find_sprites: z.object({ query: z.string().min(1).max(300), pack: z.string().max(60).optional(), limit: z.number().int().min(1).max(8).optional() }),
  generate_image: z.object({ id: z.string(), prompt: z.string().min(3), aspect: z.enum(["1:1", "16:9", "9:16", "4:3", "3:4"]) }),
  build_content: z.object({ kind: z.string().min(1).max(40), guide: z.string().min(20), items: z.array(z.object({ id: z.string(), spec: z.string().min(5) })).min(1).max(120) }),
  playtest: z.object({
    seconds: z.number().min(1).max(20),
    shots: z.array(z.number().min(0).max(20)).max(4),
    timeline: z.array(Step).max(60),
    scene: z.string().regex(/^scenes\/[a-z0-9_\-/]+\.scene\.json$/).optional(),
    sceneParams: z.record(z.string(), z.unknown()).optional(),
    save: z.record(z.string(), z.unknown()).optional(),
  }),
  finish: z.object({ summary: z.string().min(1).max(300) }),
};

export interface AgentInput {
  base: Package;
  prompt: string;
  images: { mediaType: string; base64: string }[];
  selection: string[];
  route: Route;
  assetIds?: string[];
  /** Genre kit whose template game the base package is (new games start from it by default). */
  template?: string | null;
}

export type AgentResult =
  | { ok: true; pkg: Package; summary: string; turns: number }
  | { ok: false; reason: "turns" | "budget" | "refusal" | "no_progress" | "error"; message: string; turns: number };

export async function runAgent(args: {
  llm: AgentLLM;
  images: ImageGen;
  emit: Emit;
  signal: AbortSignal;
  plan: Plan;
  cost: CostMeter;
  input: AgentInput;
  playtest: Playtester;
  /** Art director review before the first finish (needs a browser playtester). */
  critic?: StructuredLLM;
  /** Retrieval memory: past lessons/remix records go into the first message. */
  memory?: Memory;
  /** Who/what this build is (scoping for memory recall). */
  ctx?: BuildCtx;
  /** Shared sprite library → find_sprites tool. */
  sprites?: SpriteLibrary;
  /** Collects run facts for lessons and metrics. */
  trace?: RunTrace;
}): Promise<AgentResult> {
  const { llm, emit, signal, plan, cost, input, playtest } = args;
  const trace = args.trace ?? newTrace();
  let reviewed = !args.critic || !playtest.browser || input.route.kind === "tweak";
  const ws = new Workspace(input.base, args.images, emit, signal, input.images);

  // New games: seed manifest from the route so style is known before the first turn.
  const game = describeGame(input.base);
  const manifest = validatePackage(input.base).manifest;
  const packId = input.route.kind === "new_game" ? input.route.pack : manifest?.style.pack;
  const pack = packId ? tastePacks().get(packId) : undefined;
  const kitIds = input.route.kind === "new_game" ? (input.route.kits ?? []) : (manifest?.kits ?? []);
  // Include docs for dependency kits too (rpg → core, combat, …): Opus builds on all of them.
  const kitDocs = expandKits(kitIds).map((id) => kits().get(id)).filter((k): k is NonNullable<typeof k> => !!k).map((k) => ({ id: k.id, doc: k.doc }));
  const packOps = pack ? `, style.pack "${pack.id}", style.palette ${JSON.stringify(pack.palette.slice(0, 32))}${pack.grid ? `, style.grid ${pack.grid}` : ""}` : "";
  const routeNote = input.route.kind === "new_game" && input.template
    ? `${templateNote(input.template)}\nManifest: set_manifest name, description, orientation "${input.route.orientation ?? "portrait"}", style.preset "${input.route.style}"${packOps} (keep kits).`
    : input.route.kind === "new_game"
    ? `This is a NEW game. Start with set_manifest ops: format "0", name, dimension "${input.route.dimension}", entry_scene "scenes/main.scene.json", orientation "${input.route.orientation ?? "portrait"}", style.preset "${input.route.style}"${packOps}${kitIds.length ? `, kits ${JSON.stringify(kitIds)}` : ""}. Then add_scene and build.`
    : `Request type: ${input.route.kind}. Change only what the request needs.`;
  const style = input.route.kind === "new_game" ? input.route.style ?? "clean" : ws.style().preset;

  const assetScope = input.assetIds?.length
    ? `\n\nSCOPED SPRITE EDIT — change ONLY these assets: ${input.assetIds.join(", ")}. Redraw each with draw_sprite using the SAME id (same viewBox/size unless the request is about size), keep the art style and palette, and do not touch any other file, entity or script. Current versions:\n${input.assetIds.map((id) => { const meta = ws.pkg.text(`assets/${id}.meta.json`); let file = ""; try { file = JSON.parse(meta ?? "{}").file ?? ""; } catch { /* missing */ } const body = file.endsWith(".svg") ? ws.pkg.text(`assets/${file}`) : null; return `### ${id}${file ? ` (assets/${file})` : " (does not exist)"}\n${body ? body.slice(0, 20000) : file ? "(raster image — redraw it as an SVG with draw_sprite using the same id)" : ""}`; }).join("\n\n")}`
    : "";
  const selectionText = input.selection.length
    ? `\n\nThe player tapped these entities to scope the request:\n${ws.getEntities(input.selection)}`
    : "";
  const tools = TOOLS.filter((t) => (t.name !== "generate_image" || args.images.available) && (t.name !== "playtest" || playtest.browser) && (t.name !== "find_sprites" || !!args.sprites));

  // Retrieval memory: what worked in past builds of this kind (never blocks the build).
  let recalled = "";
  if (args.memory && args.ctx) {
    try {
      const r = await recallForBuild(args.memory, args.ctx, input.prompt, { spriteLibrary: !!args.sprites });
      recalled = r.text;
      const ids = r.hits.map((h) => h.item.id);
      trace.memory = { ids: [...new Set([...trace.memory.ids, ...ids])], hits: Math.max(trace.memory.hits, r.hits.length), lessonsUsed: Math.max(trace.memory.lessonsUsed, r.lessonsUsed), remixUsed: Math.max(trace.memory.remixUsed, r.remixUsed), fromBuilds: Math.max(trace.memory.fromBuilds, r.fromBuilds) };
      await emit("memory", { hits: r.hits.length, lessonsUsed: r.lessonsUsed, remixUsed: r.remixUsed, fromBuilds: r.fromBuilds, ids, backend: args.memory.backend });
    } catch (e) {
      await emit("note", { text: `memory recall skipped: ${(e as Error).message}` });
    }
  } else if (args.sprites) {
    recalled = "# Sprite library\nBefore drawing common objects (coins, hearts, gems, trees, UI icons), call find_sprites and adapt a match to this game's palette (draw_sprite with from = library id).";
  }

  // Edits start with a look at the current game.
  const currentShot: Anthropic.Beta.BetaContentBlockParam[] = [];
  if (!game.empty && playtest.browser && validatePackage(input.base).ok) {
    try {
      const run = await playtest.browser(input.base, [], [1.5]);
      const shot = run.shots[0];
      if (shot) {
        currentShot.push({ type: "text", text: "Screenshot of the current game ~1.5s after start (no input):" });
        currentShot.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: Buffer.from(shot.jpeg).toString("base64") } });
      }
    } catch { /* screenshot is a bonus; never block an edit on it */ }
  }

  const packRefs: Anthropic.Beta.BetaContentBlockParam[] = pack?.refs.length && (input.route.kind === "new_game" || input.route.kind === "asset" || input.route.kind === "feature")
    ? [
        { type: "text", text: `Reference art for the "${pack.name}" house style (study, don't copy):` },
        ...pack.refs.map((r) => ({ type: "image" as const, source: { type: "base64" as const, media_type: r.mediaType as "image/png", data: r.base64 } })),
      ]
    : [];

  const messages: MessageParam[] = [{
    role: "user",
    content: [
      ...packRefs,
      ...currentShot,
      ...input.images.slice(0, 6).map((img) => ({
        type: "image" as const,
        source: { type: "base64" as const, media_type: img.mediaType as "image/png", data: img.base64 },
      })),
      {
        type: "text" as const,
        text: `${game.text}\n\n# Player request\n${input.prompt}${assetScope}${selectionText}\n\n${input.images.length ? "The images above are the player's references.\n" : ""}${routeNote}${args.images.available ? "" : "\nAI image generation is off: draw every sprite yourself with draw_sprite."}${recalled ? `\n\n${recalled}` : ""}`,
      },
    ],
  }];

  let nudged = false;
  let jsonRetries = 0;
  // Fast mode: same Opus model, up to ~2.5x faster output at 2x price. DREAMSY_FAST=0 turns it off.
  // On a fast-mode rate limit we drop to standard speed for the rest of this run.
  let fast = process.env.DREAMSY_FAST !== "0" && plan.model === MODELS.opus;
  for (let turn = 1; turn <= plan.maxTurns; turn++) {
    if (signal.aborted) return { ok: false, reason: "error", message: "canceled", turns: turn };
    trace.turns++;

    let msg: Anthropic.Beta.BetaMessage;
    try {
      msg = await llm.turn({
      model: plan.model,
      // Automatic caching of the growing conversation (system + tools are cached via block breakpoints).
      cache_control: { type: "ephemeral" },
      max_tokens: 64000,
      system: systemBlocks(style, manifest, pack, kitDocs),
      tools,
      messages,
      output_config: { effort: plan.effort },
      ...(fast ? { speed: "fast" as const } : {}),
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    }, signal, (p) => {
      // Live progress during long turns (the app otherwise sees nothing for minutes).
      void emit("working", p.kind === "tool" ? { what: TOOL_LABEL[p.name] ?? p.name, turn } : { what: p.kind === "thinking" ? "thinking" : "writing", turn });
    });
      jsonRetries = 0;
    } catch (e) {
      if (fast && e instanceof Anthropic.RateLimitError) {
        fast = false;
        await emit("note", { text: "Fast mode is busy; continuing at standard speed." });
        turn--; trace.turns--;
        continue;
      }
      // With eager input streaming, a tool input that isn't parseable JSON rejects finalMessage().
      // Re-issue the turn (bounded); real API errors propagate.
      if (e instanceof Anthropic.APIError || signal.aborted || jsonRetries >= 2) throw e;
      jsonRetries++;
      await emit("note", { text: "Tool input was malformed; retrying the turn with smaller batches." });
      messages.push({ role: "user", content: [{ type: "text", text: "Your last response's tool input was cut off or not valid JSON, so nothing ran. Redo it in smaller apply_ops batches (≤ 40 ops each)." }] });
      // keep alternation valid: the previous message was a user turn; merge by replacing it
      const last = messages.pop()!;
      const prev = messages[messages.length - 1]!;
      if (prev.role === "user") {
        prev.content = [...(Array.isArray(prev.content) ? prev.content : [{ type: "text" as const, text: prev.content }]), ...(last.content as Anthropic.Beta.BetaContentBlockParam[])];
      } else messages.push(last);
      continue;
    }
    cost.add(msg.model, msg.usage);
    await emit("cost", { turn, ...cost.snapshot() });

    if (msg.stop_reason === "refusal") return { ok: false, reason: "refusal", message: "the model declined this request", turns: turn };
    if (cost.usd > plan.maxUsd) {
      // Keep the work if what's built so far is a valid, bootable game.
      trace.budgetHit = true;
      if (ws.opLog.length && (await finalGate(ws.pkg, playtest)).ok) {
        return { ok: true, pkg: ws.pkg, summary: "Partly done (budget reached) — say \"continue\" to finish.", turns: turn };
      }
      return { ok: false, reason: "budget", message: `cost cap $${plan.maxUsd} reached`, turns: turn };
    }

    for (const b of msg.content) {
      if (b.type === "text" && b.text.trim()) await emit(turn === 1 ? "plan" : "note", { text: b.text.trim().slice(0, 2000) });
    }
    messages.push({ role: "assistant", content: msg.content as Anthropic.Beta.BetaContentBlockParam[] });

    const uses = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (uses.length === 0) {
      // Ended without finish. Nudge once; then accept if valid.
      const v = validatePackage(ws.pkg);
      if (!nudged) {
        nudged = true;
        messages.push({ role: "user", content: [{ type: "text", text: v.ok ? "If the game is done, call finish with a summary. Otherwise keep building." : `The package has errors:\n${v.issues.filter((i) => i.severity === "error").map(fmtIssue).join("\n")}\nFix them, then call finish.` }] });
        continue;
      }
      if (v.ok && ws.opLog.length) return { ok: true, pkg: ws.pkg, summary: "Updated the game.", turns: turn };
      return { ok: false, reason: "no_progress", message: "the model stopped without a valid game", turns: turn };
    }

    const truncated = msg.stop_reason === "max_tokens";
    const results: ToolResult[] = [];
    let finished: string | null = null;

    for (const use of uses) {
      const res = (text: string, isError = false, images: Uint8Array[] = []): ToolResult => ({
        type: "tool_result",
        tool_use_id: use.id,
        content: images.length
          ? [{ type: "text", text }, ...images.map((jpeg) => ({ type: "image" as const, source: { type: "base64" as const, media_type: "image/jpeg" as const, data: Buffer.from(jpeg).toString("base64") } }))]
          : text,
        ...(isError ? { is_error: true } : {}),
      });
      if (truncated) { results.push(res("Output was cut off (max_tokens); nothing ran. Send smaller batches.", true)); continue; }
      const schema = Inputs[use.name as keyof typeof Inputs];
      const parsed = schema?.safeParse(use.input);
      if (!schema || !parsed?.success) { results.push(res(`Invalid input for ${use.name}: ${parsed?.error?.message ?? "unknown tool"}`, true)); continue; }

      switch (use.name) {
        case "read_files": results.push(res(ws.readFiles((parsed.data as z.infer<typeof Inputs.read_files>).paths))); break;
        case "get_entities": results.push(res(ws.getEntities((parsed.data as z.infer<typeof Inputs.get_entities>).ids))); break;
        case "apply_ops": {
          const d = parsed.data as z.infer<typeof Inputs.apply_ops>;
          const r = ws.applyOps(d.ops, d.reason);
          if (r.applied) {
            trace.reasons.push(d.reason.slice(0, 200));
            for (const o of d.ops as { op?: string }[]) if (typeof o?.op === "string") trace.ops[o.op] = (trace.ops[o.op] ?? 0) + 1;
            await emit("ops", {
              reason: d.reason,
              added: ws.stats.added, removed: ws.stats.removed, changed: ws.stats.changed, files: ws.stats.files.size,
              scripts: [...ws.stats.files].filter((f) => f.startsWith("scripts/")).length,
              errors: r.issues.filter((i) => i.severity === "error").length,
            });
          }
          results.push(res(r.text, !r.applied));
          break;
        }
        case "draw_sprite": {
          const d = parsed.data as z.infer<typeof Inputs.draw_sprite>;
          const lib = d.from && args.sprites ? args.sprites.get(d.from) : null;
          const gamePack = ws.packId() ?? packId ?? null;
          if (lib && lib.meta.pack !== gamePack && lib.svg.trim() === d.svg.trim()) {
            results.push(res(`REJECTED: ${d.from} is from ${lib.meta.pack ? `the "${lib.meta.pack}" pack` : "another style"}; restyle it to this game's palette/outlines before saving. Nothing saved.`, true));
            break;
          }
          const out = ws.drawSprite(d, plan.model);
          const ok = !out.startsWith("REJECTED") && !out.startsWith("Invalid") && !out.includes("use another id");
          if (ok) {
            const prev = trace.sprites.get(d.id);
            if (lib && !prev?.from) trace.spritesReused++;
            trace.sprites.set(d.id, { description: d.description ?? prev?.description, from: lib ? d.from : prev?.from });
            await emit("sprite", { id: d.id, ...(lib ? { from: d.from } : {}) });
          }
          results.push(res(out, out.startsWith("REJECTED")));
          break;
        }
        case "find_sprites": {
          const d = parsed.data as z.infer<typeof Inputs.find_sprites>;
          const want = d.pack ?? ws.packId() ?? packId ?? null;
          try {
            const hits = await args.sprites!.find(d.query, { pack: want, style: ws.style().preset, limit: d.limit ?? 4 });
            await emit("sprites.found", { query: d.query.slice(0, 100), hits: hits.length });
            results.push(res(formatSpriteHits(hits, want)));
          } catch (e) {
            results.push(res(`Sprite library unavailable (${(e as Error).message}); draw it from scratch.`, true));
          }
          break;
        }
        case "generate_image": results.push(res(ws.generateImage(parsed.data as z.infer<typeof Inputs.generate_image>))); break;
        case "build_content": {
          const d = parsed.data as z.infer<typeof Inputs.build_content>;
          if (!ws.pkg.has("notes.md")) { results.push(res("Write notes.md (the design bible) first — builders read it.", true)); break; }
          const styleInfo = ws.style();
          const r = await buildContent({
            llm, emit, signal, cost, pkg: ws.pkg, job: d,
            styleText: [pack ? `${pack.name}: ${pack.direction}` : "", `preset ${styleInfo.preset}`].filter(Boolean).join("\n"),
            palette: styleInfo.palette ?? pack?.palette ?? [],
            kitIds: validatePackage(ws.pkg).manifest?.kits ?? kitIds,
          });
          ws.pkg = r.pkg;
          results.push(res(r.report));
          break;
        }
        case "playtest": {
          const d = parsed.data as z.infer<typeof Inputs.playtest>;
          await ws.waitForImages(60_000);
          if (!validatePackage(ws.pkg).ok) { results.push(res("Fix the validation errors first; the game can't boot while the package is invalid.", true)); break; }
          await emit("playtest", { seconds: d.seconds, shots: d.shots.length });
          try {
            const tl = d.timeline as TimelineStep[];
            const [sim, view] = await Promise.all([
              playtest.simulate(ws.pkg, tl, d.seconds, { scene: d.scene, sceneParams: d.sceneParams, save: d.save }),
              playtest.browser!(ws.pkg, tl, d.shots.filter((t) => t <= d.seconds).slice(0, 4), { scene: d.scene, sceneParams: d.sceneParams, save: d.save }),
            ]);
            trace.playtestRuns++;
            for (const e of sim.errors) trace.runtimeErrors.add(`${e.script}${e.line ? `:${e.line}` : ""} ${e.message}`.slice(0, 300));
            const text = `Simulation (${d.seconds}s):\n${describeRun(sim)}\n\nScreenshots at ${view.shots.map((s) => `${s.t}s`).join(", ") || "(none)"}:${view.loadError ? `\nRENDERER LOAD FAILED: ${view.loadError}` : ""}${view.consoleErrors.length ? `\nEngine console errors: ${view.consoleErrors.slice(0, 5).join(" | ")}` : ""}`;
            results.push(res(text, false, view.shots.map((s) => s.jpeg)));
          } catch (e) {
            results.push(res(`Playtest infrastructure error (not your fault): ${(e as Error).message}`, true));
          }
          break;
        }
        case "finish": {
          await ws.waitForImages(90_000);
          const gate = await finalGate(ws.pkg, playtest);
          await emit("validate", { errors: gate.errors.length });
          trace.finalGatePassedFirstTry ??= gate.ok;
          if (!gate.ok) trace.gateFailures.push(gate.errors.slice(0, 15));
          for (const e of gate.errors) if (/^- (Runtime error|Game failed to boot)/.test(e)) trace.runtimeErrors.add(e.replace(/^- /, "").slice(0, 300));
          if (!gate.ok) { results.push(res(`Not finished — fix these first:\n${gate.errors.join("\n")}`, true)); break; }
          if (!reviewed) {
            reviewed = true;
            await emit("review", { phase: "art director" });
            try {
              const r = await artDirectorReview({ llm: args.critic!, playtest }, { pkg: ws.pkg, pack, notes: ws.pkg.text("notes.md") });
              if (r) {
                cost.add(r.model, r.usage);
                trace.reviews.push({ score: r.critique.score, verdict: r.critique.verdict, fixes: r.critique.fixes.slice(0, 8) });
                await emit("review.done", { score: r.critique.score, verdict: r.critique.verdict, fixes: r.critique.fixes.length });
                if (r.critique.verdict === "polish" && r.critique.fixes.length) { results.push(res(formatCritique(r.critique), true)); break; }
              }
            } catch (e) {
              await emit("note", { text: `art director review skipped: ${(e as Error).message}` });
            }
          }
          finished = (parsed.data as z.infer<typeof Inputs.finish>).summary;
          results.push(res("Done."));
          break;
        }
      }
    }

    if (finished !== null) return { ok: true, pkg: ws.pkg, summary: finished, turns: turn };

    const notes = ws.imageNotes();
    const content: (ToolResult | Anthropic.Beta.BetaTextBlockParam)[] = [...results];
    if (notes) content.push({ type: "text", text: notes });
    messages.push({ role: "user", content });
  }
  trace.turnsHit = true;
  return { ok: false, reason: "turns", message: `did not finish within ${plan.maxTurns} turns`, turns: plan.maxTurns };
}

/**
 * Everything that must hold before a version is committed: static validation, then the game must
 * boot and survive ~8s of generic input in the engine with zero script errors.
 */
export async function finalGate(pkg: Package, playtest: Playtester): Promise<{ ok: boolean; errors: string[] }> {
  const r = validatePackage(pkg);
  const errors = r.issues.filter((i) => i.severity === "error").map(fmtIssue);
  if (!r.manifest) errors.push("- dreamsy.toml is missing or invalid");
  if (errors.length || r.manifest?.dimension !== "2d") return { ok: errors.length === 0, errors };

  const run = await playtest.simulate(pkg, SMOKE_TIMELINE, 8);
  if (run.loadError) errors.push(`- Game failed to boot in the engine: ${run.loadError}`);
  for (const e of run.errors.slice(0, 15)) {
    errors.push(`- Runtime error during an 8s smoke run (move/jump/action): ${e.script}${e.line ? `:${e.line}` : ""} ${e.message}${e.count > 1 ? ` (×${e.count})` : ""}`);
  }
  return { ok: errors.length === 0, errors };
}
