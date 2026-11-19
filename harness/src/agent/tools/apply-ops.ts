import { z } from "zod";
import { defineTool } from "./tool.js";

export const applyOps = defineTool({
  name: "apply_ops",
  label: "building",
  description: "Apply a batch of edit ops atomically (all or nothing), then validate the whole package. Returns the op error, or the validation issues to fix.",
  input: z.object({
    reason: z.string().describe("Short description of this batch, e.g. 'add player movement'."),
    ops: z.array(z.looseObject({})).describe("Edit ops, see system prompt."),
  }),
  async run(d, { ws, trace, emit }) {
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
    return { text: r.text, isError: !r.applied };
  },
});
