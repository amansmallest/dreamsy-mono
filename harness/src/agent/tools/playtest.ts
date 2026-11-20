import { z } from "zod";
import { validatePackage } from "@dreamsy/format";
import { describeRun, type TimelineStep } from "../../engine/playtest.js";
import { defineTool } from "./tool.js";

const Control = z.enum(["left", "right", "up", "down", "jump", "action", "action2"]);
const Step = z.object({
  t: z.number().min(0).max(20),
  hold: z.array(Control).optional(),
  release: z.array(Control).optional(),
  press: z.array(Control).optional(),
  // [x, y] as a plain array: tuple schemas (array-form "items") are rejected by some MCP clients (ChatGPT).
  tap: z.array(z.number()).length(2).describe("[x, y] in reference pixels.").optional(),
});

export const playtest = defineTool({
  name: "playtest",
  label: "playtesting",
  description: "Run the game with scripted input and SEE it: returns script errors, logs, player position trace, and screenshots (1280x720) at the times you ask. Use after building something to check it renders and plays right; fix what you see.",
  input: z.object({
    seconds: z.number().min(1).max(20).describe("How long to run (1-20)."),
    scene: z.string().regex(/^scenes\/[a-z0-9_\-/]+\.scene\.json$/).optional().describe("Optional: start in this scene (e.g. scenes/world_3.scene.json) instead of the entry scene."),
    sceneParams: z.record(z.string(), z.unknown()).optional().describe("Optional: params for sceneParams() in that scene."),
    save: z.record(z.string(), z.unknown()).optional().describe("Optional: preloaded save data (key → value) so the game starts mid-progress."),
    shots: z.array(z.number().min(0).max(20)).max(4).describe("Screenshot times in seconds (max 4)."),
    timeline: z.array(Step).max(60).describe('Input steps, e.g. [{"t":0.5,"hold":["right"]},{"t":1,"press":["jump"]},{"t":3,"tap":[640,600]}]. Controls: left,right,up,down,jump,action,action2. tap = click at UI coords (1280x720).'),
  }),
  enabled: (ctx) => !!ctx.playtest.browser,
  async run(d, { ws, playtest: pt, trace, emit }) {
    await ws.waitForImages(60_000);
    if (!validatePackage(ws.pkg).ok) return { text: "Fix the validation errors first; the game can't boot while the package is invalid.", isError: true };
    await emit("playtest", { seconds: d.seconds, shots: d.shots.length });
    try {
      const tl = d.timeline as TimelineStep[];
      const start = { scene: d.scene, sceneParams: d.sceneParams, save: d.save };
      const [sim, view] = await Promise.all([
        pt.simulate(ws.pkg, tl, d.seconds, start),
        pt.browser!(ws.pkg, tl, d.shots.filter((t) => t <= d.seconds).slice(0, 4), start),
      ]);
      trace.playtestRuns++;
      for (const e of sim.errors) trace.runtimeErrors.add(`${e.script}${e.line ? `:${e.line}` : ""} ${e.message}`.slice(0, 300));
      const text = `Simulation (${d.seconds}s):\n${describeRun(sim)}\n\nScreenshots at ${view.shots.map((s) => `${s.t}s`).join(", ") || "(none)"}:${view.loadError ? `\nRENDERER LOAD FAILED: ${view.loadError}` : ""}${view.consoleErrors.length ? `\nEngine console errors: ${view.consoleErrors.slice(0, 5).join(" | ")}` : ""}`;
      return { text, images: view.shots.map((s) => s.jpeg) };
    } catch (e) {
      return { text: `Playtest infrastructure error (not your fault): ${(e as Error).message}`, isError: true };
    }
  },
});
