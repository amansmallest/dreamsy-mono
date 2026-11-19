import type Anthropic from "@anthropic-ai/sdk";
import { expandKits, type Package, type StylePreset, validatePackage } from "@dreamsy/format";
import { describeGame } from "../context/prompt.js";
import { kits } from "../context/kits.js";
import { tastePacks, type TastePack } from "../context/taste.js";
import { templateNote } from "../context/templates.js";
import type { Playtester } from "../engine/playtest.js";
import type { ImageGen } from "../llm/images.js";
import { recallForBuild, type BuildCtx, type RunTrace } from "../memory/lessons.js";
import type { Memory } from "../memory/memory.js";
import type { SpriteLibrary } from "../memory/sprites.js";
import type { Route } from "../pipeline/route.js";
import type { Emit, Workspace } from "./workspace.js";

type Block = Anthropic.Beta.BetaContentBlockParam;

export interface AgentInput {
  base: Package;
  prompt: string;
  images: { mediaType: string; base64: string }[];
  selection: string[];
  route: Route;
  assetIds?: string[];
  template?: string | null;
}

export interface Brief {
  manifest: ReturnType<typeof validatePackage>["manifest"];
  style: StylePreset;
  pack?: TastePack;
  packId?: string | null;
  kitIds: string[];
  kitDocs: { id: string; doc: string }[];
  first: Block[];
}

const image = (mediaType: string, data: string): Block => ({ type: "image", source: { type: "base64", media_type: mediaType as "image/png", data } });

function routeNote(input: AgentInput, kitIds: string[], pack: TastePack | undefined): string {
  const { route } = input;
  const packOps = pack ? `, style.pack "${pack.id}", style.palette ${JSON.stringify(pack.palette.slice(0, 32))}${pack.grid ? `, style.grid ${pack.grid}` : ""}` : "";
  const orientation = route.orientation ?? "portrait";
  if (route.kind === "new_game" && input.template) {
    return `${templateNote(input.template)}\nManifest: set_manifest name, description, orientation "${orientation}", style.preset "${route.style}"${packOps} (keep kits).`;
  }
  if (route.kind === "new_game") {
    return `This is a NEW game. Start with set_manifest ops: format "0", name, dimension "${route.dimension}", entry_scene "scenes/main.scene.json", orientation "${orientation}", style.preset "${route.style}"${packOps}${kitIds.length ? `, kits ${JSON.stringify(kitIds)}` : ""}. Then add_scene and build.`;
  }
  return `Request type: ${route.kind}. Change only what the request needs.`;
}

function assetScope(input: AgentInput, ws: Workspace): string {
  if (!input.assetIds?.length) return "";
  const current = input.assetIds.map((id) => {
    let file = "";
    try { file = JSON.parse(ws.pkg.text(`assets/${id}.meta.json`) ?? "{}").file ?? ""; } catch { file = ""; }
    const body = file.endsWith(".svg") ? ws.pkg.text(`assets/${file}`) : null;
    const shown = body ? body.slice(0, 20000) : file ? "(raster image — redraw it as an SVG with draw_sprite using the same id)" : "";
    return `### ${id}${file ? ` (assets/${file})` : " (does not exist)"}\n${shown}`;
  });
  return `\n\nSCOPED SPRITE EDIT — change ONLY these assets: ${input.assetIds.join(", ")}. Redraw each with draw_sprite using the SAME id (same viewBox/size unless the request is about size), keep the art style and palette, and do not touch any other file, entity or script. Current versions:\n${current.join("\n\n")}`;
}

async function recall(deps: { memory?: Memory; ctx?: BuildCtx; sprites?: SpriteLibrary; emit: Emit; trace: RunTrace }, prompt: string): Promise<string> {
  const { memory, ctx, sprites, emit, trace } = deps;
  if (!memory || !ctx) {
    return sprites ? "# Sprite library\nBefore drawing common objects (coins, hearts, gems, trees, UI icons), call find_sprites and adapt a match to this game's palette (draw_sprite with from = library id)." : "";
  }
  try {
    const r = await recallForBuild(memory, ctx, prompt, { spriteLibrary: !!sprites });
    const ids = r.hits.map((h) => h.item.id);
    const m = trace.memory;
    trace.memory = {
      ids: [...new Set([...m.ids, ...ids])],
      hits: Math.max(m.hits, r.hits.length),
      lessonsUsed: Math.max(m.lessonsUsed, r.lessonsUsed),
      remixUsed: Math.max(m.remixUsed, r.remixUsed),
      fromBuilds: Math.max(m.fromBuilds, r.fromBuilds),
    };
    await emit("memory", { hits: r.hits.length, lessonsUsed: r.lessonsUsed, remixUsed: r.remixUsed, fromBuilds: r.fromBuilds, ids, backend: memory.backend });
    return r.text;
  } catch (e) {
    await emit("note", { text: `memory recall skipped: ${(e as Error).message}` });
    return "";
  }
}

async function currentShot(base: Package, empty: boolean, playtest: Playtester): Promise<Block[]> {
  if (empty || !playtest.browser || !validatePackage(base).ok) return [];
  try {
    const shot = (await playtest.browser(base, [], [1.5])).shots[0];
    if (!shot) return [];
    return [{ type: "text", text: "Screenshot of the current game ~1.5s after start (no input):" }, image("image/jpeg", Buffer.from(shot.jpeg).toString("base64"))];
  } catch {
    return [];
  }
}

export async function buildBrief(deps: {
  input: AgentInput;
  ws: Workspace;
  images: ImageGen;
  playtest: Playtester;
  memory?: Memory;
  ctx?: BuildCtx;
  sprites?: SpriteLibrary;
  emit: Emit;
  trace: RunTrace;
}): Promise<Brief> {
  const { input, ws } = deps;
  const isNew = input.route.kind === "new_game";
  const game = describeGame(input.base);
  const manifest = validatePackage(input.base).manifest;
  const packId = isNew ? input.route.pack : manifest?.style.pack;
  const pack = packId ? tastePacks().get(packId) : undefined;
  const kitIds = isNew ? (input.route.kits ?? []) : (manifest?.kits ?? []);
  const kitDocs = expandKits(kitIds).map((id) => kits().get(id)).filter((k): k is NonNullable<typeof k> => !!k).map((k) => ({ id: k.id, doc: k.doc }));
  const style = isNew ? input.route.style ?? "clean" : ws.style().preset;

  const recalled = await recall(deps, input.prompt);
  const shot = await currentShot(input.base, game.empty, deps.playtest);
  const showRefs = pack?.refs.length && (isNew || input.route.kind === "asset" || input.route.kind === "feature");
  const refs: Block[] = showRefs
    ? [{ type: "text", text: `Reference art for the "${pack!.name}" house style (study, don't copy):` }, ...pack!.refs.map((r) => image(r.mediaType, r.base64))]
    : [];
  const selection = input.selection.length ? `\n\nThe player tapped these entities to scope the request:\n${ws.getEntities(input.selection)}` : "";
  const text = [
    `${game.text}\n\n# Player request\n${input.prompt}${assetScope(input, ws)}${selection}\n\n`,
    input.images.length ? "The images above are the player's references.\n" : "",
    routeNote(input, kitIds, pack),
    deps.images.available ? "" : "\nAI image generation is off: draw every sprite yourself with draw_sprite.",
    recalled ? `\n\n${recalled}` : "",
  ].join("");

  return {
    manifest, style, pack, packId, kitIds, kitDocs,
    first: [...refs, ...shot, ...input.images.slice(0, 6).map((img) => image(img.mediaType, img.base64)), { type: "text", text }],
  };
}
