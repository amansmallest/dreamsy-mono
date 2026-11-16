import { describe, expect, it } from "vitest";
import { failoverLLM, isOutOfCredit, type Provider } from "../src/failover.js";
import { OpenAIError } from "../src/openai.js";

const prov = (name: string, kind: Provider["kind"], fail?: Error): Provider & { calls: number } => {
  const p = {
    name, kind, calls: 0,
    agent: { turn: async () => { p.calls++; if (fail) throw fail; return { content: [], name } as never; } },
    json: { json: async () => { p.calls++; if (fail) throw fail; return { value: name, usage: { input_tokens: 0, output_tokens: 0 }, model: name } as never; } },
  };
  return p;
};
const params = { model: "m", max_tokens: 10, messages: [{ role: "user", content: [{ type: "thinking", thinking: "", signature: "oai:{}" }, { type: "text", text: "hi" }] }] } as never;

describe("model-account failover", () => {
  it("moves to the next account only on out-of-credit errors, and sticks", async () => {
    const a = prov("anthropic", "anthropic", new OpenAIError(429, "insufficient_quota", "quota"));
    const b = prov("openai", "openai", new OpenAIError(402, null, "billing"));
    const c = prov("openai-backup", "openai");
    const f = failoverLLM([a, b, c], () => {});
    expect(((await f.json({} as never)) as { value: string }).value).toBe("openai-backup");
    expect(f.current()).toBe("openai-backup");
    await f.turn(params, new AbortController().signal);
    expect(a.calls).toBe(1); expect(b.calls).toBe(1); expect(c.calls).toBe(2);
  });

  it("passes ordinary errors through without switching", async () => {
    const a = prov("anthropic", "anthropic", new OpenAIError(500, null, "server error"));
    const b = prov("openai", "openai");
    const f = failoverLLM([a, b], () => {});
    await expect(f.turn(params, new AbortController().signal)).rejects.toThrow("server error");
    expect(b.calls).toBe(0);
    expect(isOutOfCredit(new Error("nope"))).toBe(false);
    expect(isOutOfCredit(new OpenAIError(429, "rate_limit_exceeded", "slow down"))).toBe(false);
  });
});
