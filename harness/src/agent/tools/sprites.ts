import { z } from "zod";
import { formatSpriteHits } from "../../memory/sprites.js";
import { defineTool } from "./tool.js";

export const drawSprite = defineTool({
  name: "draw_sprite",
  label: "drawing a sprite",
  description: "Draw a sprite/texture/icon/background as SVG and save it as an image asset. Call again with the same id to redraw it. Reference as \"asset:<id>\".",
  strict: true,
  input: z.object({
    id: z.string().describe("Asset id, lowercase_snake, e.g. fox_idle."),
    svg: z.string().min(10).describe("Complete <svg> document with a viewBox. Plain shapes/paths/gradients only."),
    description: z.string().max(300).optional().describe("Optional one-line description of what it depicts (e.g. 'gold coin, front view, 16px pixel'); indexes it in the sprite library."),
    from: z.string().max(40).optional().describe("Optional: the find_sprites library id (spr_…) this sprite was adapted from."),
  }),
  async run(d, { ws, sprites, packId, plan, trace, emit }) {
    const lib = d.from && sprites ? sprites.get(d.from) : null;
    const gamePack = ws.packId() ?? packId ?? null;
    if (lib && lib.meta.pack !== gamePack && lib.svg.trim() === d.svg.trim()) {
      return { text: `REJECTED: ${d.from} is from ${lib.meta.pack ? `the "${lib.meta.pack}" pack` : "another style"}; restyle it to this game's palette/outlines before saving. Nothing saved.`, isError: true };
    }
    const out = ws.drawSprite(d, plan.model);
    const ok = !out.startsWith("REJECTED") && !out.startsWith("Invalid") && !out.includes("use another id");
    if (ok) {
      const prev = trace.sprites.get(d.id);
      if (lib && !prev?.from) trace.spritesReused++;
      trace.sprites.set(d.id, { description: d.description ?? prev?.description, from: lib ? d.from : prev?.from });
      await emit("sprite", { id: d.id, ...(lib ? { from: d.from } : {}) });
    }
    return { text: out, isError: out.startsWith("REJECTED") };
  },
});

export const findSprites = defineTool({
  name: "find_sprites",
  label: "checking the sprite library",
  description: "Search the shared sprite library (sprites from past well-reviewed builds) for something to adapt instead of drawing from scratch: coins, hearts, gems, trees, rocks, chests, UI icons, arrows… Returns ids, descriptions and SVG text. Adapt to this game's palette/art bible and save with draw_sprite (from = library id).",
  strict: true,
  input: z.object({
    query: z.string().min(1).max(300).describe("What you need, e.g. 'gold coin pickup' or 'heart health icon'."),
    pack: z.string().max(60).optional().describe("Optional style pack id to prefer (defaults to this game's pack)."),
    limit: z.number().int().min(1).max(8).optional().describe("Max results (1-8, default 4)."),
  }),
  enabled: (ctx) => !!ctx.sprites,
  async run(d, { ws, sprites, packId, emit }) {
    const want = d.pack ?? ws.packId() ?? packId ?? null;
    try {
      const hits = await sprites!.find(d.query, { pack: want, style: ws.style().preset, limit: d.limit ?? 4 });
      await emit("sprites.found", { query: d.query.slice(0, 100), hits: hits.length });
      return { text: formatSpriteHits(hits, want) };
    } catch (e) {
      return { text: `Sprite library unavailable (${(e as Error).message}); draw it from scratch.`, isError: true };
    }
  },
});
