import Anthropic from "@anthropic-ai/sdk";
import { type Package, validatePackage } from "@dreamsy/format";
import { systemBlocks } from "../context/prompt.js";
import type { Playtester } from "../engine/playtest.js";
import type { ImageGen } from "../llm/images.js";
import { CostMeter, MODELS, type AgentLLM, type StructuredLLM } from "../llm/models.js";
import { newTrace, type BuildCtx, type RunTrace } from "../memory/lessons.js";
import type { Memory } from "../memory/memory.js";
import type { SpriteLibrary } from "../memory/sprites.js";
import type { Plan } from "../pipeline/plans.js";
import { buildBrief, type AgentInput } from "./brief.js";
import { finalGate } from "./final-gate.js";
import { apiTool, TOOLS, toolByName, type ToolCtx, type ToolOutput } from "./tools/index.js";
import { fmtIssue, Workspace, type Emit } from "./workspace.js";

export type { AgentInput } from "./brief.js";
export { finalGate } from "./final-gate.js";

type MessageParam = Anthropic.Beta.BetaMessageParam;
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;
type Block = Anthropic.Beta.BetaContentBlockParam;

export type AgentResult =
  | { ok: true; pkg: Package; summary: string; turns: number }
  | { ok: false; reason: "turns" | "budget" | "refusal" | "no_progress" | "error"; message: string; turns: number };

export interface AgentArgs {
  llm: AgentLLM;
  images: ImageGen;
  emit: Emit;
  signal: AbortSignal;
  plan: Plan;
  cost: CostMeter;
  input: AgentInput;
  playtest: Playtester;
  critic?: StructuredLLM;
  memory?: Memory;
  ctx?: BuildCtx;
  sprites?: SpriteLibrary;
  trace?: RunTrace;
}

const say = (text: string): MessageParam => ({ role: "user", content: [{ type: "text", text }] });

function toolResult(id: string, out: ToolOutput): ToolResult {
  const images = out.images ?? [];
  return {
    type: "tool_result",
    tool_use_id: id,
    content: images.length
      ? [{ type: "text", text: out.text }, ...images.map((jpeg) => ({ type: "image" as const, source: { type: "base64" as const, media_type: "image/jpeg" as const, data: Buffer.from(jpeg).toString("base64") } }))]
      : out.text,
    ...(out.isError ? { is_error: true } : {}),
  };
}

function appendToLastUser(messages: MessageParam[], msg: MessageParam) {
  const prev = messages[messages.length - 1];
  if (prev?.role !== "user") { messages.push(msg); return; }
  const prior = Array.isArray(prev.content) ? prev.content : [{ type: "text" as const, text: prev.content }];
  prev.content = [...prior, ...(msg.content as Block[])];
}

async function runTool(name: string, input: unknown, ctx: ToolCtx): Promise<ToolOutput> {
  const tool = toolByName.get(name);
  const parsed = tool?.input.safeParse(input);
  if (!tool || !parsed?.success) return { text: `Invalid input for ${name}: ${parsed?.error?.message ?? "unknown tool"}`, isError: true };
  return tool.run(parsed.data, ctx);
}

export async function runAgent(args: AgentArgs): Promise<AgentResult> {
  const { llm, emit, signal, plan, cost, input, playtest } = args;
  const trace = args.trace ?? newTrace();
  const ws = new Workspace(input.base, args.images, emit, signal, input.images);
  const brief = await buildBrief({ ...args, ws, trace });

  const ctx: ToolCtx = {
    ws, llm, critic: args.critic, images: args.images, playtest, sprites: args.sprites, emit, signal, cost, plan, trace,
    pack: brief.pack, packId: brief.packId, kitIds: brief.kitIds,
    state: { reviewed: !args.critic || !playtest.browser || input.route.kind === "tweak" },
  };
  const tools = TOOLS.filter((t) => !t.enabled || t.enabled(ctx)).map(apiTool);
  const system = systemBlocks(brief.style, brief.manifest, brief.pack, brief.kitDocs);
  const messages: MessageParam[] = [{ role: "user", content: brief.first }];

  let nudged = false;
  let cutOffs = 0;
  let jsonRetries = 0;
  let fast = process.env.DREAMSY_FAST !== "0" && plan.model === MODELS.opus;

  for (let turn = 1; turn <= plan.maxTurns; turn++) {
    if (signal.aborted) return { ok: false, reason: "error", message: "canceled", turns: turn };
    trace.turns++;

    let msg: Anthropic.Beta.BetaMessage;
    try {
      msg = await llm.turn({
        model: plan.model,
        cache_control: { type: "ephemeral" },
        max_tokens: 64000,
        system,
        tools,
        messages,
        output_config: { effort: plan.effort },
        ...(fast ? { speed: "fast" as const } : {}),
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      }, signal, (p) => {
        const what = p.kind === "tool" ? toolByName.get(p.name)?.label ?? p.name : p.kind === "thinking" ? "thinking" : "writing";
        void emit("working", { what, turn });
      });
      jsonRetries = 0;
    } catch (e) {
      if (fast && e instanceof Anthropic.RateLimitError) {
        fast = false;
        await emit("note", { text: "Fast mode is busy; continuing at standard speed." });
        turn--; trace.turns--;
        continue;
      }
      if (e instanceof Anthropic.APIError || signal.aborted || jsonRetries >= 2) throw e;
      jsonRetries++;
      await emit("note", { text: "Tool input was malformed; retrying the turn with smaller batches." });
      appendToLastUser(messages, say("Your last response's tool input was cut off or not valid JSON, so nothing ran. Redo it in smaller apply_ops batches (≤ 40 ops each)."));
      continue;
    }
    cost.add(msg.model, msg.usage);
    await emit("cost", { turn, ...cost.snapshot() });

    if (msg.stop_reason === "refusal") return { ok: false, reason: "refusal", message: "the model declined this request", turns: turn };
    if (cost.usd > Math.min(plan.maxUsd, Number(process.env.DREAMSY_ROUND_MAX_USD) || Infinity)) {
      trace.budgetHit = true;
      if (ws.opLog.length && (await finalGate(ws.pkg, playtest)).ok) {
        return { ok: true, pkg: ws.pkg, summary: "Partly done (budget reached) — say \"continue\" to finish.", turns: turn };
      }
      return { ok: false, reason: "budget", message: `cost cap $${plan.maxUsd} reached`, turns: turn };
    }

    for (const b of msg.content) {
      if (b.type === "text" && b.text.trim()) await emit(turn === 1 ? "plan" : "note", { text: b.text.trim().slice(0, 2000) });
    }
    messages.push({ role: "assistant", content: msg.content as Block[] });

    const uses = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (uses.length === 0 && msg.stop_reason === "max_tokens" && cutOffs < 3) {
      cutOffs++;
      messages.push(say("You ran out of output space before calling any tool, so nothing was built. Stop planning: act now with apply_ops / draw_sprite / build_content in small batches (≤ 40 ops), and build the game in stages."));
      continue;
    }
    if (uses.length === 0) {
      const v = validatePackage(ws.pkg);
      if (!nudged) {
        nudged = true;
        messages.push(say(v.ok ? "If the game is done, call finish with a summary. Otherwise keep building." : `The package has errors:\n${v.issues.filter((i) => i.severity === "error").map(fmtIssue).join("\n")}\nFix them, then call finish.`));
        continue;
      }
      if (v.ok && ws.opLog.length) return { ok: true, pkg: ws.pkg, summary: "Updated the game.", turns: turn };
      return { ok: false, reason: "no_progress", message: "the model stopped without a valid game", turns: turn };
    }

    const truncated = msg.stop_reason === "max_tokens";
    const results: ToolResult[] = [];
    let finished: string | null = null;
    for (const use of uses) {
      const out = truncated
        ? { text: "Output was cut off (max_tokens); nothing ran. Send smaller batches.", isError: true }
        : await runTool(use.name, use.input, ctx);
      if (out.finished !== undefined) finished = out.finished;
      results.push(toolResult(use.id, out));
    }
    if (finished !== null) return { ok: true, pkg: ws.pkg, summary: finished, turns: turn };

    const notes = ws.imageNotes();
    const left = plan.maxTurns - turn;
    const wrap = left === 3 ? "Only 3 turns left: stop adding features, make sure the game works, update notes.md with what is left, and call finish." : "";
    const extra = [notes, wrap].filter(Boolean).join("\n\n");
    messages.push({ role: "user", content: extra ? [...results, { type: "text", text: extra }] : results });
  }
  trace.turnsHit = true;
  // Keep finished work that just ran out of turns before calling finish (same rule as the budget cap).
  if (ws.opLog.length && (await finalGate(ws.pkg, playtest)).ok) {
    return { ok: true, pkg: ws.pkg, summary: "Partly done (turn limit reached) — say \"continue\" to finish.", turns: plan.maxTurns };
  }
  return { ok: false, reason: "turns", message: `did not finish within ${plan.maxTurns} turns`, turns: plan.maxTurns };
}
