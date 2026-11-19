import type Anthropic from "@anthropic-ai/sdk";
import type { AgentLLM, StructuredLLM } from "./models.js";

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
    async json({ model, system, content, schema, effort, maxTokens }) {
      const { zodOutputFormat } = await import("@anthropic-ai/sdk/helpers/zod");
      const res = await client.messages.parse({
        model,
        max_tokens: maxTokens ?? 2000,
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
