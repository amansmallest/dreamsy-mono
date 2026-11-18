import { z } from "zod";
import { MODELS, type ModelId, type StructuredLLM, type Usage } from "./models.js";
import { packMenu, tastePacks } from "./taste.js";
import { kitMenu, kits } from "./kits.js";

export const Route = z.object({
  kind: z.enum(["new_game", "feature", "tweak", "asset", "reject"]),
  /** Style preset for new games when the user didn't specify one. */
  style: z.enum(["pixel", "blocky", "clean", "toon", "custom"]).nullable(),
  dimension: z.enum(["2d", "3d"]).nullable(),
  /** Phone layout for new games: portrait unless the game clearly needs a wide view (racing across, side-scrolling vistas, strategy maps). */
  orientation: z.enum(["portrait", "landscape"]).nullable(),
  /** New games start from the kit's template game unless the player explicitly asks for "from scratch". */
  fromScratch: z.boolean().nullable(),
  /** Genre kits to build on (new_game only), e.g. ["rpg"]; [] when none fits. */
  kits: z.array(z.string()).nullable(),
  /** House style pack id (new_game only) or null. */
  pack: z.string().nullable(),
  /** Short reason, shown in progress UI. */
  reason: z.string(),
  safe: z.boolean(),
});
export type Route = z.infer<typeof Route>;

export interface Plan {
  model: ModelId;
  effort: "low" | "medium" | "high";
  maxTurns: number;
  maxUsd: number;
  /** Model to escalate to if this one fails the final gate. */
  escalate: { model: ModelId; effort: "low" | "medium" | "high"; maxTurns: number; maxUsd: number } | null;
}

export const PLANS: Record<Exclude<Route["kind"], "reject">, Plan> = {
  new_game: { model: MODELS.opus, effort: "high", maxTurns: 60, maxUsd: 20, escalate: null },
  feature: { model: MODELS.opus, effort: "medium", maxTurns: 40, maxUsd: 20, escalate: { model: MODELS.opus, effort: "high", maxTurns: 30, maxUsd: 20 } },
  tweak: { model: MODELS.sonnet, effort: "low", maxTurns: 8, maxUsd: 0.3, escalate: { model: MODELS.opus, effort: "medium", maxTurns: 15, maxUsd: 1.5 } },
  asset: { model: MODELS.sonnet, effort: "medium", maxTurns: 20, maxUsd: 1.5, escalate: { model: MODELS.opus, effort: "medium", maxTurns: 25, maxUsd: 3 } },
};

const SYSTEM = () => `You route requests for Dreamsy, an app where players describe games and an AI builds them.
Classify the player's request against the current game state.

kind:
- new_game: the game is empty, or the player asks for a different game entirely.
- feature: new mechanics, levels, enemies, systems, UI flows, multiplayer behavior.
- tweak: change values/colors/text/sizes/positions/speeds, rename, small script fixes, remove things.
- asset: regenerate or tweak a few sprites/sounds only. A restyle of the whole game's look (new backgrounds, recomposed scenes, camera/zoom changes, many sprites) is a feature.
- reject: sexual content, real-world graphic violence or gore, hate, self-harm, harassment of real people, or anything illegal. Cartoon/game combat is fine.

style (new_game only, else null): pixel (retro 2D), blocky (voxel/Roblox-like), clean (flat minimal), toon (cel-shaded cartoon), custom (a distinct look the presets don't cover). Prefer what the player or their reference images imply; default clean.
dimension (new_game only, else null): always 2d — Dreamsy runs 2D games only for now; 3D-style requests become a top-down or side-view 2D game.
orientation (new_game only, else null): portrait by default (phone-first, one-handed); landscape only when the player asks or the genre clearly needs width (side-scrolling vistas, wide racing tracks, big strategy maps).
fromScratch (new_game only, else null): true ONLY if the player explicitly asks to build from scratch / an empty project; otherwise false.
kits (new_game only, else null): the genre kits the game should be built on — strongly prefer a kit when the genre matches (they provide tested systems and make 1–2 hour games possible). [] if none fits.
Available kits:
${kitMenu()}
pack (new_game only, else null): a house style pack id from the list below when one fits the request or the reference images (strongly prefer a pack — they carry curated art direction); null only if none fits.
safe: false only for reject.

House style packs:
${packMenu()}`;

export async function routeRequest(
  llm: StructuredLLM,
  args: { prompt: string; gameIsEmpty: boolean; gameSummary: string; images: { mediaType: string; base64: string }[] },
): Promise<{ route: Route; usage: Usage; model: string }> {
  const content = [
    ...args.images.slice(0, 4).map((img) => ({
      type: "image" as const,
      source: { type: "base64" as const, media_type: img.mediaType as "image/png", data: img.base64 },
    })),
    {
      type: "text" as const,
      text: `Current game: ${args.gameIsEmpty ? "EMPTY (nothing built yet)" : args.gameSummary}\n\nPlayer request:\n${args.prompt}`,
    },
  ];
  const { value, usage, model } = await llm.json({ model: MODELS.haiku, system: SYSTEM(), content, schema: Route, effort: "low" });
  const route = { ...value };
  // An empty game can only become a new game (the router still decides safety + style).
  if (args.gameIsEmpty && route.kind !== "reject") route.kind = "new_game";
  if (route.kind === "new_game") {
    route.style ??= "clean";
    route.dimension = "2d"; // 2D only until the 3D renderer ships (docs/runtime.md §4.3)
    route.orientation ??= "portrait";
    route.kits = (route.kits ?? []).filter((k) => kits().has(k));
    const pack = route.pack ? tastePacks().get(route.pack) : undefined;
    if (route.pack && !pack) route.pack = null;
    if (pack) route.style = pack.preset;
  }
  return { route, usage, model };
}
