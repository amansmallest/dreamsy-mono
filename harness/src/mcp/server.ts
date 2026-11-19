import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Package, STYLE_PRESETS, validatePackage, type StylePreset } from "@dreamsy/format";
import { finalGate } from "../agent/final-gate.js";
import { applyOps } from "../agent/tools/apply-ops.js";
import { getEntities, readFiles } from "../agent/tools/files.js";
import { playtest as playtestTool } from "../agent/tools/playtest.js";
import { drawSprite } from "../agent/tools/sprites.js";
import type { Tool, ToolCtx, ToolOutput } from "../agent/tools/tool.js";
import { Workspace } from "../agent/workspace.js";
import { kitMenu, kits } from "../context/kits.js";
import { describeGame, systemBlocks } from "../context/prompt.js";
import { packMenu, tastePacks } from "../context/taste.js";
import { kitTemplate, templateNote } from "../context/templates.js";
import { describeRun, enginePlaytester, type Playtester, type TimelineStep } from "../engine/playtest.js";
import { loadEnv } from "../env.js";
import { disabledImages } from "../llm/images.js";
import { CostMeter } from "../llm/models.js";
import { newTrace } from "../memory/lessons.js";
import { PLANS } from "../pipeline/plans.js";
import { expandKits } from "@dreamsy/format";

loadEnv();

const ROOT = resolve(process.env.DREAMSY_GAMES_DIR ?? process.cwd());
const INSTRUCTIONS = `Dreamsy builds 2D and 2.5D games that run in the Dreamsy C++ engine. You are the game designer and programmer; these tools are the engine.
Workflow: dreamsy_options (kits, styles, packs) → create_game → dreamsy_guide (the full format, entity catalog, Luau API and kit docs: read it before editing) → build with apply_ops and draw_sprite → playtest to see it → check_game until it passes → export_game.
Games are folders under ${ROOT}; every tool takes the game's path relative to it.`;

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type Result = { content: Content[]; isError?: boolean };

const text = (t: string, isError = false): Result => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });
const jpeg = (b: Uint8Array): Content => ({ type: "image", data: Buffer.from(b).toString("base64"), mimeType: "image/jpeg" });

function gameDir(path: string): string {
  const dir = resolve(ROOT, path);
  const rel = relative(ROOT, dir);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`games live under ${ROOT}; ${path} is outside it`);
  return dir;
}

async function load(path: string): Promise<{ dir: string; pkg: Package }> {
  const dir = gameDir(path);
  if (!existsSync(join(dir, "dreamsy.toml"))) throw new Error(`no game at ${path} (create_game first)`);
  return { dir, pkg: await Package.fromDir(dir) };
}

async function save(dir: string, before: Package, after: Package) {
  for (const p of before.paths()) if (!after.has(p)) await rm(join(dir, p), { force: true });
  for (const p of after.paths()) {
    const b = after.bytes(p)!;
    const old = before.bytes(p);
    if (old && old.byteLength === b.byteLength && old.every((x, i) => x === b[i])) continue;
    await mkdir(dirname(join(dir, p)), { recursive: true });
    await writeFile(join(dir, p), b);
  }
}

let playtester: Promise<Playtester> | null = null;
const engine = () => (playtester ??= enginePlaytester({ browser: process.env.PLAYTEST_BROWSER !== "0" }));

function context(ws: Workspace, pt: Playtester): ToolCtx {
  const manifest = validatePackage(ws.pkg).manifest;
  return {
    ws, playtest: pt, images: disabledImages, emit: async () => {}, signal: new AbortController().signal,
    cost: new CostMeter(), plan: PLANS.tweak, trace: newTrace(), kitIds: manifest?.kits ?? [],
    packId: manifest?.style.pack ?? null, pack: manifest?.style.pack ? tastePacks().get(manifest.style.pack) : undefined,
    state: { reviewed: true },
    llm: { turn: () => Promise.reject(new Error("no model in the MCP server")) },
  };
}

function toResult(out: ToolOutput): Result {
  return { content: [{ type: "text", text: out.text }, ...(out.images ?? []).map(jpeg)], ...(out.isError ? { isError: true } : {}) };
}

const server = new McpServer({ name: "dreamsy", version: "0.1.0" }, { instructions: INSTRUCTIONS });

function guarded<A>(fn: (args: A) => Promise<Result>) {
  return async (args: A): Promise<Result> => {
    try { return await fn(args); } catch (e) { return text((e as Error).message, true); }
  };
}

function editTool(tool: Tool, title: string) {
  const input = (tool.input as unknown as z.ZodObject).extend({ game: z.string().describe("Game folder, relative to the games directory.") });
  server.registerTool(tool.name, { title, description: tool.description, inputSchema: input.shape }, guarded(async (args: Record<string, unknown>) => {
    const { game, ...rest } = args as { game: string };
    const { dir, pkg } = await load(game);
    const ws = new Workspace(pkg, disabledImages, async () => {}, new AbortController().signal, []);
    const out = await tool.run(tool.input.parse(rest), context(ws, await engine()));
    if (ws.pkg !== pkg) await save(dir, pkg, ws.pkg);
    return toResult(out);
  }));
}

server.registerTool("dreamsy_options", {
  title: "List kits, styles and style packs",
  description: "What a new game can start from: genre kits (tested systems + a template game), art style presets and curated house style packs.",
  inputSchema: {},
}, guarded(async () => text(`# Genre kits\n${kitMenu()}\n\n# Style presets\n${STYLE_PRESETS.join(", ")}\n\n# House style packs\n${packMenu()}`)));

server.registerTool("dreamsy_guide", {
  title: "Builder guide",
  description: "The full builder reference for a game: package format and edit ops, entity catalog, Luau scripting API, art style, house style pack (with reference images) and the docs of the game's kits. Read it before building or editing.",
  inputSchema: { game: z.string().describe("Game folder, relative to the games directory.") },
}, guarded(async ({ game }) => {
  const { pkg } = await load(game);
  const manifest = validatePackage(pkg).manifest;
  const pack = manifest?.style.pack ? tastePacks().get(manifest.style.pack) : undefined;
  const kitDocs = expandKits(manifest?.kits ?? []).map((id) => kits().get(id)).filter((k): k is NonNullable<typeof k> => !!k).map((k) => ({ id: k.id, doc: k.doc }));
  const blocks = systemBlocks(manifest?.style.preset ?? "clean", manifest, pack, kitDocs);
  const refs = pack?.refs.map((r): Content => ({ type: "image", data: r.base64, mimeType: r.mediaType })) ?? [];
  const mcpNote = "# Using this guide through MCP\nEvery tool takes `game` (the folder). build_content, generate_image and find_sprites are not available here: draw sprites with draw_sprite and write content yourself. Where the guide says \"finish\", run check_game until it passes, then export_game.";
  return { content: [{ type: "text", text: `${mcpNote}\n\n${blocks.map((b) => b.text).join("\n\n")}` }, ...refs] };
}));

server.registerTool("create_game", {
  title: "Create a game",
  description: "Create a new game folder. With a genre kit it starts as the kit's working template game (reskin and rebuild it); without one it starts empty.",
  inputSchema: {
    game: z.string().describe("New game folder, relative to the games directory."),
    name: z.string().min(1),
    kit: z.string().optional().describe("Genre kit id from dreamsy_options."),
    style: z.enum(STYLE_PRESETS as [StylePreset, ...StylePreset[]]).optional(),
    pack: z.string().optional().describe("House style pack id from dreamsy_options."),
    orientation: z.enum(["portrait", "landscape"]).optional(),
  },
}, guarded(async ({ game, name, kit, style, pack, orientation }) => {
  const dir = gameDir(game);
  if (existsSync(dir) && (await readdir(dir)).length) throw new Error(`${game} already exists and is not empty`);
  const packDef = pack ? tastePacks().get(pack) : undefined;
  if (pack && !packDef) throw new Error(`unknown pack ${pack}`);
  const preset = style ?? packDef?.preset ?? "clean";
  const manifestOps = `set_manifest name "${name}", orientation "${orientation ?? "portrait"}", style.preset "${preset}"${packDef ? `, style.pack "${packDef.id}", style.palette ${JSON.stringify(packDef.palette.slice(0, 32))}` : ""}`;
  const template = kit ? await kitTemplate([kit]) : null;
  if (kit && !template) throw new Error(`kit ${kit} has no template game; create it without a kit and add "${kit}" to manifest kits`);
  await mkdir(dir, { recursive: true });
  if (template) {
    await template.pkg.with("dreamsy.toml", (template.pkg.text("dreamsy.toml") ?? "").replace(/^id\s*=.*\n/m, "")).toDir(dir);
    return text(`Created ${game} from the ${template.kit} kit template.\n${templateNote(template.kit)}\nFirst: ${manifestOps} (keep kits). Then call dreamsy_guide.`);
  }
  await writeFile(join(dir, "dreamsy.toml"), `format = "0"\nname = ${JSON.stringify(name)}\ndimension = "2d"\nentry_scene = "scenes/main.scene.json"\norientation = "${orientation ?? "portrait"}"\n\n[style]\npreset = "${preset}"\n${packDef ? `pack = "${packDef.id}"\n` : ""}`);
  return text(`Created an empty game at ${game}. It has a manifest but no scenes yet: add scenes/main.scene.json with add_scene, then build. Call dreamsy_guide first.`);
}));

server.registerTool("game_outline", {
  title: "Game outline",
  description: "Manifest, scene trees (ids, types, names), scripts and data files of a game, plus its validation issues.",
  inputSchema: { game: z.string() },
}, guarded(async ({ game }) => text(describeGame((await load(game)).pkg).text)));

editTool(readFiles, "Read game files");
editTool(getEntities, "Read entities");
editTool(applyOps, "Edit the game");
editTool(drawSprite, "Draw a sprite");

server.registerTool("playtest", {
  title: "Playtest",
  description: `${playtestTool.description} Screenshots need the web player build (engine/README.md); without it you get the simulation only.`,
  inputSchema: (playtestTool.input as unknown as z.ZodObject).extend({ game: z.string() }).shape,
}, guarded(async (args: Record<string, unknown>) => {
  const { game, ...rest } = args as { game: string };
  const d = playtestTool.input.parse(rest);
  const { pkg } = await load(game);
  if (!validatePackage(pkg).ok) return text("Fix the validation errors first (game_outline lists them).", true);
  const pt = await engine();
  const tl = d.timeline as TimelineStep[];
  const start = { scene: d.scene, sceneParams: d.sceneParams, save: d.save };
  const [sim, view] = await Promise.all([
    pt.simulate(pkg, tl, d.seconds, start),
    pt.browser ? pt.browser(pkg, tl, d.shots.filter((t) => t <= d.seconds).slice(0, 4), start) : Promise.resolve(null),
  ]);
  const shots = view ? `\n\nScreenshots at ${view.shots.map((s) => `${s.t}s`).join(", ") || "(none)"}${view.loadError ? `\nRENDERER LOAD FAILED: ${view.loadError}` : ""}` : "\n\n(no screenshots: web player not built or PLAYTEST_BROWSER=0)";
  return { content: [{ type: "text", text: `Simulation (${d.seconds}s):\n${describeRun(sim)}${shots}` }, ...(view?.shots ?? []).map((s) => jpeg(s.jpeg))] };
}));

server.registerTool("check_game", {
  title: "Check the game",
  description: "The release check: the package must validate and survive an 8 second smoke run (move, jump, action) in the engine with no script errors.",
  inputSchema: { game: z.string() },
}, guarded(async ({ game }) => {
  const gate = await finalGate((await load(game)).pkg, await engine());
  return gate.ok ? text("Passed: valid, boots, no script errors in the smoke run.") : text(`Not ready:\n${gate.errors.join("\n")}`, true);
}));

server.registerTool("export_game", {
  title: "Export the game",
  description: "Pack the game into a Dreamsy pack (.dpk): one file anyone can play in the Dreamsy web player (?pkg=<url>) or publish.",
  inputSchema: { game: z.string(), out: z.string().optional().describe("Output .dpk path, relative to the games directory; default <game>.dpk next to the folder.") },
}, guarded(async ({ game, out }) => {
  const { dir, pkg } = await load(game);
  const gate = await finalGate(pkg, await engine());
  if (!gate.ok) return text(`Run check_game and fix these first:\n${gate.errors.join("\n")}`, true);
  const file = out ? gameDir(out) : `${dir}.dpk`;
  const bytes = pkg.toPack();
  await writeFile(file, bytes);
  return text(`Wrote ${file} (${(bytes.byteLength / 1024).toFixed(0)} KB, package id ${pkg.contentHash().slice(0, 16)}).\nPlay it: serve the folder holding the .dpk and open the web player with ?pkg=<its url>, or run python3 engine/tools/make_play_page.py <game folder> for a local picker.`);
}));

server.registerPrompt("build_game", {
  title: "Build a game",
  description: "Start building a Dreamsy game from an idea.",
  argsSchema: { idea: z.string().describe("What the game is about."), game: z.string().optional().describe("Folder name.") },
}, ({ idea, game }) => ({
  messages: [{ role: "user", content: { type: "text", text: `Build this game with the Dreamsy tools: ${idea}\nFolder: ${game ?? "pick a short kebab-case name"}.\n${INSTRUCTIONS}\nPlaytest often and look at the screenshots; finish when check_game passes, then export_game.` } }],
}));

await server.connect(new StdioServerTransport());
console.error(`dreamsy mcp: games in ${ROOT}`);
