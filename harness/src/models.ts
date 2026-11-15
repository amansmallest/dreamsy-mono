import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages";

export const MODELS = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
} as const;
export type ModelId = (typeof MODELS)[keyof typeof MODELS];

/** $ per million tokens (input, output, cache read). Approximate; for budgeting/telemetry only. */
const PRICES: Record<ModelId, { in: number; out: number; cacheRead: number }> = {
  "claude-opus-5-5": { in: 4, out: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { in: 2, out: 10, cacheRead: 0.1 },
  "claude-haiku-5-5": { in: 0.1, out: 0.5, cacheRead: 0.01 },
};

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export class CostMeter {
  tokensIn = 0;
  tokensOut = 0;
  cacheRead = 0;
  usd = 0;

  add(model: string, u: Usage & { speed?: string | null }) {
    const base = PRICES[model as ModelId] ?? PRICES["claude-opus-5-5"];
    // Fast mode bills 2x ($8/$40 per MTok on Opus 5.5).
    const k = u.speed === "fast" ? 2 : 1;
    const p = { in: base.in * k, out: base.out * k, cacheRead: base.cacheRead * k };
    const read = u.cache_read_input_tokens ?? 0;
    const write = u.cache_creation_input_tokens ?? 0;
    this.tokensIn += u.input_tokens + read + write;
    this.tokensOut += u.output_tokens;
    this.cacheRead += read;
    this.usd += (u.input_tokens * p.in + write * p.in * 1.25 + read * p.cacheRead + u.output_tokens * p.out) / 1e6;
  }

  snapshot() {
    return { tokensIn: this.tokensIn, tokensOut: this.tokensOut, cacheRead: this.cacheRead, usd: Math.round(this.usd * 10000) / 10000 };
  }
}

/** Seam for tests: one streamed agent turn → final message. */
export type TurnProgress = { kind: "thinking" } | { kind: "text" } | { kind: "tool"; name: string };

export interface AgentLLM {
  turn(params: BetaMessageStreamParams, signal: AbortSignal, onProgress?: (p: TurnProgress) => void): Promise<Anthropic.Beta.BetaMessage>;
}

/** Seam for tests: one structured-output call. */
export interface StructuredLLM {
  json<T>(args: { model: ModelId; system: string; content: Anthropic.MessageParam["content"]; schema: import("zod").ZodType<T>; effort?: "low" | "medium" | "high" }): Promise<{ value: T; usage: Usage; model: string }>;
}

export function anthropicLLM(client: Anthropic): AgentLLM & StructuredLLM {
  return {
    async turn(params, signal, onProgress) {
      const stream = client.beta.messages.stream(params, { signal });
      if (onProgress) {
        stream.on("streamEvent", (ev) => {
          if (ev.type !== "content_block_start") return;
          const b = ev.content_block;
          if (b.type === "thinking") onProgress({ kind: "thinking" });
          else if (b.type === "text") onProgress({ kind: "text" });
          else if (b.type === "tool_use") onProgress({ kind: "tool", name: b.name });
        });
      }
      return stream.finalMessage();
    },
    async json({ model, system, content, schema, effort }) {
      const { zodOutputFormat } = await import("@anthropic-ai/sdk/helpers/zod");
      const res = await client.messages.parse({
        model,
        max_tokens: 2000,
        system,
        messages: [{ role: "user", content }],
        output_config: { format: zodOutputFormat(schema as never), ...(effort ? { effort } : {}) },
      });
      if (res.stop_reason === "refusal") throw new Error("model refused");
      if (res.parsed_output == null) throw new Error("structured output did not parse");
      return { value: res.parsed_output as never, usage: res.usage, model };
    },
  };
}
