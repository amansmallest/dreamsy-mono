import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { ImageGen } from "../../llm/images.js";
import type { AgentLLM, CostMeter, StructuredLLM } from "../../llm/models.js";
import type { Playtester } from "../../engine/playtest.js";
import type { SpriteLibrary } from "../../memory/sprites.js";
import type { RunTrace } from "../../memory/lessons.js";
import type { TastePack } from "../../context/taste.js";
import type { Plan } from "../../pipeline/plans.js";
import type { Emit, Workspace } from "../workspace.js";

export interface ToolCtx {
  ws: Workspace;
  llm: AgentLLM;
  critic?: StructuredLLM;
  images: ImageGen;
  playtest: Playtester;
  sprites?: SpriteLibrary;
  emit: Emit;
  signal: AbortSignal;
  cost: CostMeter;
  plan: Plan;
  trace: RunTrace;
  pack?: TastePack;
  packId?: string | null;
  kitIds: string[];
  state: { reviewed: boolean };
}

export interface ToolOutput {
  text: string;
  isError?: boolean;
  images?: Uint8Array[];
  finished?: string;
}

export interface Tool<S extends z.ZodType = z.ZodType> {
  name: string;
  label: string;
  description: string;
  strict?: boolean;
  input: S;
  enabled?: (ctx: ToolCtx) => boolean;
  run(input: z.infer<S>, ctx: ToolCtx): ToolOutput | Promise<ToolOutput>;
}

export const defineTool = <S extends z.ZodType>(t: Tool<S>): Tool<S> => t;

const DROP = new Set(["$schema", "minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minItems", "maxItems", "pattern", "additionalItems", "propertyNames"]);

function clean(node: unknown, strict: boolean): unknown {
  if (Array.isArray(node)) return node.map((n) => clean(n, strict));
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (DROP.has(k)) continue;
    if (k === "items" && Array.isArray(v)) out.items = clean(v[0], strict);
    else if (k === "additionalProperties" && typeof v === "object") continue;
    else out[k] = clean(v, strict);
  }
  if (out.properties && Object.keys(out.properties).length === 0) delete out.properties;
  if (out.type === "object" && out.properties) {
    if (strict) out.additionalProperties = false;
    else delete out.additionalProperties;
  }
  return out;
}

export function inputSchema(t: Tool): Anthropic.Beta.BetaTool["input_schema"] {
  return clean(z.toJSONSchema(t.input, { target: "draft-7", io: "input" }), !!t.strict) as Anthropic.Beta.BetaTool["input_schema"];
}

export function apiTool(t: Tool): Anthropic.Beta.BetaTool {
  return { name: t.name, description: t.description, ...(t.strict ? { strict: true } : {}), eager_input_streaming: true, input_schema: inputSchema(t) };
}
