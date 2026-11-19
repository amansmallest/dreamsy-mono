import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { AgentLLM, StructuredLLM } from "./models.js";
import { OpenAIError } from "./openai.js";

export type Provider = { name: string; kind: "anthropic" | "openai"; agent: AgentLLM; json: StructuredLLM };

const RETRY_PRIMARY_MS = 15 * 60_000;

export function isOutOfCredit(e: unknown): boolean {
  if (e instanceof OpenAIError) {
    return e.code === "insufficient_quota" || e.status === 401 || e.status === 402 || e.status === 403 || /quota|billing|credit/i.test(e.message);
  }
  if (e instanceof Anthropic.APIError) {
    const msg = `${e.message} ${JSON.stringify((e as { error?: unknown }).error ?? "")}`;
    return e.status === 401 || e.status === 402 || e.status === 403 || /credit balance|billing|insufficient.*(credit|fund)|quota/i.test(msg);
  }
  return false;
}

function forProvider(params: BetaMessageStreamParams, kind: Provider["kind"]): BetaMessageStreamParams {
  const keep = (b: { type: string; signature?: string }) =>
    b.type !== "thinking" || (kind === "openai" ? !!b.signature?.startsWith("oai:") : !b.signature?.startsWith("oai:"));
  return {
    ...params,
    messages: params.messages.map((m) => (typeof m.content === "string" ? m : { ...m, content: (m.content as { type: string; signature?: string }[]).filter(keep) as never })),
  };
}

export function failoverLLM(chain: Provider[], log: (msg: string) => void = (m) => console.error(m)): AgentLLM & StructuredLLM & { current(): string } {
  if (!chain.length) throw new Error("failoverLLM: empty chain");
  let idx = 0;
  let switchedAt = 0;
  const active = () => {
    if (idx > 0 && Date.now() - switchedAt > RETRY_PRIMARY_MS) { idx = 0; log(`[failover] retrying primary account ${chain[0]!.name}`); }
    return idx;
  };
  async function run<T>(call: (p: Provider) => Promise<T>): Promise<T> {
    for (let i = active(); i < chain.length; i++) {
      try {
        return await call(chain[i]!);
      } catch (e) {
        if (!isOutOfCredit(e) || i === chain.length - 1) throw e;
        log(`[failover] ${chain[i]!.name} unavailable (${(e as Error).message.slice(0, 120)}) → switching to ${chain[i + 1]!.name}`);
        idx = i + 1; switchedAt = Date.now();
      }
    }
    throw new Error("failover: no provider left");
  }
  return {
    current: () => chain[active()]!.name,
    turn: (params, signal, onProgress) => run((p) => p.agent.turn(forProvider(params, p.kind), signal, onProgress)),
    json: (args) => run((p) => p.json.json(args)),
  };
}
