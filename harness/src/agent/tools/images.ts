import { z } from "zod";
import { defineTool } from "./tool.js";

export const generateImage = defineTool({
  name: "generate_image",
  label: "painting an asset",
  description: "Generate an image asset in the background in the game's art style. The asset exists immediately (placeholder) so you can reference \"asset:<id>\" right away. Use for sprites, textures, icons, backgrounds.",
  strict: true,
  input: z.object({
    id: z.string().describe("Asset id, lowercase_snake, e.g. cat_tower."),
    prompt: z.string().min(3).describe("What to draw: one subject, its pose/view, key details. Style is added automatically."),
    aspect: z.enum(["1:1", "16:9", "9:16", "4:3", "3:4"]),
  }),
  enabled: (ctx) => ctx.images.available,
  run: (d, { ws }) => ({ text: ws.generateImage(d) }),
});
