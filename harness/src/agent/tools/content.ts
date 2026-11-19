import { z } from "zod";
import { validatePackage } from "@dreamsy/format";
import { buildContent as runContentBuilders } from "../content.js";
import { defineTool } from "./tool.js";

export const buildContent = defineTool({
  name: "build_content",
  label: "building content in parallel",
  description: "Hand bulk content to parallel content builders (Sonnet workers, ~4 items each, up to 6 at once): creatures, enemies, items, NPCs, levels, quests… Each item gets its own files named after its id. Give a precise guide (exact file format from the kit docs, paths like data/creatures/<id>.json, which sprites to draw per item, balance targets) and one detailed spec per item. Returns a per-item report; fix or re-run failures. Write notes.md (the bible) BEFORE calling this — builders read it.",
  input: z.object({
    kind: z.string().min(1).max(40).describe("e.g. creatures, enemies, items, levels, npcs"),
    guide: z.string().min(20),
    items: z.array(z.object({ id: z.string(), spec: z.string().min(5) })).min(1).max(120),
  }),
  async run(d, { ws, llm, emit, signal, cost, pack, kitIds }) {
    if (!ws.pkg.has("notes.md")) return { text: "Write notes.md (the design bible) first — builders read it.", isError: true };
    const style = ws.style();
    const r = await runContentBuilders({
      llm, emit, signal, cost, pkg: ws.pkg, job: d,
      styleText: [pack ? `${pack.name}: ${pack.direction}` : "", `preset ${style.preset}`].filter(Boolean).join("\n"),
      palette: style.palette ?? pack?.palette ?? [],
      kitIds: validatePackage(ws.pkg).manifest?.kits ?? kitIds,
    });
    ws.pkg = r.pkg;
    return { text: r.report };
  },
});
