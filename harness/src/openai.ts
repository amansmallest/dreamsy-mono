import type Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { MODELS, registerPrice, type AgentLLM } from "./models.js";

/**
 * OpenAI as the BUILDER (agent loop + content workers) behind the same AgentLLM seam as Claude.
 * Translates Anthropic-shaped turns ⇄ the OpenAI Responses API (reasoning + function tools).
 * Router, critic and lessons stay on Claude (StructuredLLM). "Fast mode" = service_tier "priority".
 *   OPENAI_API_KEY, OPENAI_BUILDER_MODEL (gpt-6.1-sol), OPENAI_WORKER_MODEL (gpt-6.1-terra), OPENAI_FAST (1)
 */
type B = Anthropic.Beta.BetaContentBlockParam;
type Item = Record<string, unknown>;

export const OPENAI_BUILDER = process.env.OPENAI_BUILDER_MODEL ?? "gpt-6.1-sol";
export const OPENAI_WORKER = process.env.OPENAI_WORKER_MODEL ?? "gpt-6.1-terra";
// Approximate $/MTok for budgeting only (override with OPENAI_PRICE_IN/OUT/CACHED).
const price = { in: Number(process.env.OPENAI_PRICE_IN ?? 5), out: Number(process.env.OPENAI_PRICE_OUT ?? 30), cacheRead: Number(process.env.OPENAI_PRICE_CACHED ?? 0.5) };
registerPrice(OPENAI_BUILDER, price);
registerPrice(OPENAI_WORKER, { in: price.in / 2, out: price.out / 2, cacheRead: price.cacheRead / 2 });

const mapModel = (m: string) => (m === MODELS.opus ? OPENAI_BUILDER : OPENAI_WORKER);
const img = (s: { type: string; media_type?: string; data?: string; url?: string }) =>
  s.type === "base64" ? `data:${s.media_type};base64,${s.data}` : s.url ?? "";
const textOf = (c: unknown): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b?.type === "text").map((b) => b.text).join("\n") : "";

function toInput(messages: BetaMessageStreamParams["messages"]): Item[] {
  const out: Item[] = [];
  for (const m of messages) {
    const blocks: B[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content as B[]);
    if (m.role === "assistant") {
      const texts: string[] = [];
      for (const b of blocks) {
        if (b.type === "thinking" && b.signature?.startsWith("oai:")) out.push(JSON.parse(b.signature.slice(4)));
        else if (b.type === "text" && b.text) texts.push(b.text);
        else if (b.type === "tool_use") out.push({ type: "function_call", call_id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) });
      }
      if (texts.length) out.push({ role: "assistant", content: [{ type: "output_text", text: texts.join("\n") }] });
      continue;
    }
    // user: tool results first (each call needs its output), then text + images (incl. tool screenshots)
    const parts: Item[] = [];
    for (const b of blocks) {
      if (b.type === "tool_result") {
        const pre = b.is_error ? "ERROR: " : "";
        out.push({ type: "function_call_output", call_id: b.tool_use_id, output: pre + (textOf(b.content) || "(no output)") });
        if (Array.isArray(b.content)) for (const c of b.content) if (c.type === "image") parts.push({ type: "input_image", image_url: img(c.source as never) });
      } else if (b.type === "text") parts.push({ type: "input_text", text: b.text });
      else if (b.type === "image") parts.push({ type: "input_image", image_url: img(b.source as never) });
      else if (b.type === "document" && b.source.type === "text") parts.push({ type: "input_text", text: b.source.data });
    }
    if (parts.length) out.push({ role: "user", content: parts.some((p) => p.type === "input_text") ? parts : [{ type: "input_text", text: "Screenshots:" }, ...parts] });
  }
  return out;
}

export function openaiLLM(apiKey: string): AgentLLM {
  const fast = process.env.OPENAI_FAST !== "0";
  return {
    async turn(params, signal, onProgress) {
      const model = mapModel(params.model);
      const system = typeof params.system === "string" ? params.system : (params.system ?? []).map((b) => b.text).join("\n\n");
      const effort = (params as { output_config?: { effort?: string } }).output_config?.effort;
      const body = {
        model,
        instructions: system,
        input: toInput(params.messages),
        tools: (params.tools ?? []).flatMap((t) => ("input_schema" in t
          ? [{ type: "function", name: t.name, description: t.description ?? "", parameters: t.input_schema, strict: false }] : [])),
        reasoning: { effort: effort === "low" || effort === "high" ? effort : "medium" },
        max_output_tokens: Math.min(params.max_tokens, 64000),
        store: false,
        include: ["reasoning.encrypted_content"],
        ...(fast ? { service_tier: "priority" } : {}),
      };
      onProgress?.({ kind: "thinking" });
      let res: Response | null = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        res = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.any([signal, AbortSignal.timeout(15 * 60_000)]),
        });
        if (res.status !== 429 && res.status < 500) break;
        await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      }
      const data = (await res!.json()) as any;
      if (!res!.ok || data.error) throw new Error(`openai ${res!.status}: ${data.error?.message ?? "request failed"}`);
      const content: Anthropic.Beta.BetaContentBlock[] = [];
      for (const o of data.output ?? []) {
        if (o.type === "reasoning" && o.encrypted_content) {
          content.push({ type: "thinking", thinking: "", signature: `oai:${JSON.stringify({ type: "reasoning", id: o.id, summary: o.summary ?? [], encrypted_content: o.encrypted_content })}` } as never);
        } else if (o.type === "message") {
          for (const c of o.content ?? []) {
            if (c.type === "output_text" && c.text) content.push({ type: "text", text: c.text, citations: null } as never);
            if (c.type === "refusal") content.push({ type: "text", text: c.refusal, citations: null } as never);
          }
        } else if (o.type === "function_call") {
          let input: unknown;
          try { input = JSON.parse(o.arguments || "{}"); } catch { throw new Error(`openai: tool input for ${o.name} is not valid JSON`); }
          onProgress?.({ kind: "tool", name: o.name });
          content.push({ type: "tool_use", id: o.call_id, name: o.name, input } as never);
        }
      }
      const cached = data.usage?.input_tokens_details?.cached_tokens ?? 0;
      const truncated = data.status === "incomplete" && data.incomplete_details?.reason === "max_output_tokens";
      return {
        id: data.id ?? "resp", type: "message", role: "assistant", model, content, container: null, context_management: null,
        stop_reason: truncated ? "max_tokens" : content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: (data.usage?.input_tokens ?? 0) - cached, output_tokens: data.usage?.output_tokens ?? 0,
          cache_read_input_tokens: cached, cache_creation_input_tokens: 0,
          speed: data.service_tier === "fast" || data.service_tier === "priority" ? "fast" : null,
        },
      } as unknown as Anthropic.Beta.BetaMessage;
    },
  };
}
