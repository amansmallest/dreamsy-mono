import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Package } from "@dreamsy/format";
import { MODELS, type StructuredLLM, type Usage } from "./models.js";
import { SMOKE_TIMELINE, type Playtester } from "./playtest.js";
import type { TastePack } from "./taste.js";

export const Critique = z.object({
  /** 1–10 against the references / a polished indie game of this genre. */
  score: z.number().int().min(1).max(10),
  verdict: z.enum(["ship", "polish"]),
  /** Concrete, actionable visual/feel fixes, most important first. */
  fixes: z.array(z.string()).max(8),
});
export type Critique = z.infer<typeof Critique>;

const SYSTEM = `You are the art director of a game studio known for tasteful, polished indie games.
You review screenshots of a game in progress against the style references (when given) and the game's art bible.
Judge like a demanding art director: composition (does every screen read as a composed illustration that fills the frame?), scale (are characters/tiles big and crisp enough?), palette discipline, consistency of outlines/shading/light, detail density, readability of the player and threats, UI hierarchy and typography, and whether it looks like it matches the references' level of craft.
Return at most 8 concrete fixes the builder can execute with sprites/entities/scripts (e.g. "zoom camera to 3x — sprites read tiny", "foreground: add a strip of dark-teal crops overlapping the bottom 40px", "HUD panel covers the player's lane on the left; move it top-right and shrink to 60%").
verdict "ship" only if score >= 8 and nothing important is wrong.`;

/** Screenshots the game, compares against the pack references, returns fixes. */
export async function artDirectorReview(deps: { llm: StructuredLLM; playtest: Playtester }, args: {
  pkg: Package;
  pack?: TastePack;
  notes?: string;
}): Promise<{ critique: Critique; usage: Usage; model: string; shots: number } | null> {
  if (!deps.playtest.browser) return null;
  const run = await deps.playtest.browser(args.pkg, SMOKE_TIMELINE, [1, 3.5, 6.5]);
  if (!run.shots.length) return null;

  const content: Anthropic.ContentBlockParam[] = [];
  if (args.pack?.refs.length) {
    content.push({ type: "text", text: `Style references for the "${args.pack.name}" house style:` });
    for (const r of args.pack.refs) content.push({ type: "image", source: { type: "base64", media_type: r.mediaType as "image/png", data: r.base64 } });
    content.push({ type: "text", text: `Art direction:\n${args.pack.direction}` });
  }
  content.push({ type: "text", text: "Screenshots of the game (start, ~3.5s, ~6.5s of play):" });
  for (const s of run.shots) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: Buffer.from(s.jpeg).toString("base64") } });
  if (args.notes) content.push({ type: "text", text: `The game's notes.md (art bible + design):\n${args.notes.slice(0, 6000)}` });
  content.push({ type: "text", text: "Review it." });

  const { value, usage, model } = await deps.llm.json({ model: MODELS.opus, system: SYSTEM, content, schema: Critique, effort: "medium" });
  return { critique: value, usage, model, shots: run.shots.length };
}

export function formatCritique(c: Critique): string {
  return [
    `ART DIRECTOR REVIEW — score ${c.score}/10 (${c.verdict}).`,
    c.verdict === "ship" ? "Looks good. Apply any quick wins below if cheap, then finish." : "Not finished yet — apply these fixes, playtest to check them, then call finish again:",
    ...c.fixes.map((f, i) => `${i + 1}. ${f}`),
  ].join("\n");
}
