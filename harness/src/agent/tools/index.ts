import { applyOps } from "./apply-ops.js";
import { buildContent } from "./content.js";
import { getEntities, readFiles } from "./files.js";
import { finish } from "./finish.js";
import { generateImage } from "./images.js";
import { composeMusic } from "./music.js";
import { playtest } from "./playtest.js";
import { drawSprite, findSprites } from "./sprites.js";
import type { Tool } from "./tool.js";

export const TOOLS: Tool[] = [readFiles, getEntities, applyOps, drawSprite, findSprites, generateImage, composeMusic, playtest, buildContent, finish] as Tool[];
export const toolByName = new Map(TOOLS.map((t) => [t.name, t]));
export { apiTool, type Tool, type ToolCtx, type ToolOutput } from "./tool.js";
