import { z } from "zod";
import { artDirectorReview, formatCritique } from "../critique.js";
import { finalGate } from "../final-gate.js";
import { defineTool } from "./tool.js";

export const finish = defineTool({
  name: "finish",
  label: "final check",
  description: "Call when the game is complete and valid. The package is checked once more; if it fails you get the errors back.",
  strict: true,
  input: z.object({ summary: z.string().min(1).max(300).describe("One friendly line for the player describing what you built or changed.") }),
  async run(d, { ws, playtest, trace, emit, cost, critic, pack, state }) {
    await ws.waitForImages(90_000);
    const gate = await finalGate(ws.pkg, playtest);
    await emit("validate", { errors: gate.errors.length });
    trace.finalGatePassedFirstTry ??= gate.ok;
    if (!gate.ok) trace.gateFailures.push(gate.errors.slice(0, 15));
    for (const e of gate.errors) if (/^- (Runtime error|Game failed to boot)/.test(e)) trace.runtimeErrors.add(e.replace(/^- /, "").slice(0, 300));
    if (!gate.ok) return { text: `Not finished — fix these first:\n${gate.errors.join("\n")}`, isError: true };
    if (!state.reviewed) {
      state.reviewed = true;
      await emit("review", { phase: "art director" });
      try {
        const r = await artDirectorReview({ llm: critic!, playtest }, { pkg: ws.pkg, pack, notes: ws.pkg.text("notes.md") });
        if (r) {
          cost.add(r.model, r.usage);
          trace.reviews.push({ score: r.critique.score, verdict: r.critique.verdict, fixes: r.critique.fixes.slice(0, 8) });
          await emit("review.done", { score: r.critique.score, verdict: r.critique.verdict, fixes: r.critique.fixes.length });
          if (r.critique.verdict === "polish" && r.critique.fixes.length) return { text: formatCritique(r.critique), isError: true };
        }
      } catch (e) {
        await emit("note", { text: `art director review skipped: ${(e as Error).message}` });
      }
    }
    return { text: "Done.", finished: d.summary };
  },
});
