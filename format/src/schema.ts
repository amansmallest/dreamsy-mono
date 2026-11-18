import { z } from "zod";

export const FORMAT_VERSION = "0";

/** Entity and asset ids: lowercase snake, stable forever, unique across the whole package. */
export const ID_RE = /^[a-z][a-z0-9_]{0,63}$/;
export const Id = z.string().regex(ID_RE, "id must be lowercase snake_case, start with a letter, ≤64 chars");

// ---------- manifest (dreamsy.toml) ----------

/** 2.5D view modes (docs/engine.md §14.5). */
export const VIEW_MODES = ["side", "topdown", "oblique", "iso"] as const;
export type ViewMode = (typeof VIEW_MODES)[number];

export const Manifest = z.strictObject({
  format: z.literal(FORMAT_VERSION),
  id: z.string().optional(),
  name: z.string().min(1).max(80),
  description: z.string().max(2000).optional(),
  dimension: z.enum(["2d", "3d"]),
  /** Phone layout (docs/platform.md §11.1). Absent = "landscape" (older games); new games default to portrait. */
  orientation: z.enum(["portrait", "landscape"]).optional(),
  /**
   * 2.5D view mode (docs/engine.md §14.5), 2D games only. Absent = "side". Scenes may override it.
   * side: x right, y down, planar gravity (platformers). topdown / oblique / iso: y is depth (no planar
   * gravity), entities have a height `z`; oblique draws z upward, iso projects onto a 2:1 diamond.
   */
  view: z.enum(VIEW_MODES).optional(),
  entry_scene: z.string().regex(/^scenes\/[a-z0-9_\-/]+\.scene\.json$/, "entry_scene must be scenes/<name>.scene.json"),
  players: z.strictObject({
    min: z.number().int().min(1).default(1),
    max: z.number().int().min(1).max(200).default(1),
  }).default({ min: 1, max: 1 }),
  server: z.strictObject({
    mode: z.enum(["none", "rooms", "persistent", "async"]).default("none"),
    tick_rate: z.number().int().min(1).max(120).default(30),
    deterministic: z.boolean().default(false),
  }).default({ mode: "none", tick_rate: 30, deterministic: false }),
  /** Engine kits this game uses (docs/kits.md §12.1), e.g. ["rpg"]; validated against KITS. */
  kits: z.array(z.string()).max(8).optional(),
  avatar: z.strictObject({ enabled: z.boolean().default(false) }).default({ enabled: false }),
  /**
   * Named collision layers (≤ 16) for Body2D/Area2D/TileMap2D `layer` / `mask` props.
   * Entities without `layer`/`mask` are on, and collide with, every layer.
   */
  physics: z.strictObject({
    layers: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, "layer names must be lowercase_snake"))
      .max(16, "at most 16 collision layers")
      .refine((a) => new Set(a).size === a.length, "layer names must be unique")
      .default([]),
  }).optional(),
  /** Theme for platform UI (pause/settings menus). Engine derives defaults from style.palette. */
  ui: z.strictObject({
    primary: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    background: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    text: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    panel: z.enum(["pixel", "rounded", "sharp", "outlined"]).optional(),
    font: z.enum(["pixel", "rounded", "bold", "serif"]).optional(),
  }).optional(),
  /**
   * Items players can buy with Stars (platform currency). `pass` = owned forever (VIP, extra levels,
   * skins); `consumable` = bought repeatedly and used up by the game (gem packs, revives).
   */
  store: z.array(z.strictObject({
    id: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "store item id must be lowercase_snake"),
    kind: z.enum(["pass", "consumable"]),
    name: z.string().min(1).max(40),
    description: z.string().max(200).default(""),
    price: z.number().int().min(1).max(100_000),
    icon: z.string().regex(/^asset:[a-z][a-z0-9_]{0,63}$/).optional(),
  })).max(50).default([]),
  /** Art style (see styles.ts). Drives the harness, asset prompts and engine render hints. */
  style: z.strictObject({
    preset: z.enum(["pixel", "blocky", "clean", "toon", "custom"]),
    /** House style pack (taste/packs/<pack>.md): curated art direction + references. */
    pack: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/).optional(),
    /** Optional fixed palette, e.g. ["#1a1c2c", "#5d275d"]. */
    palette: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).max(32).optional(),
    /** Free-form style direction; required for "custom". */
    notes: z.string().max(2000).optional(),
    /** Asset ids of style reference images inside the package. */
    references: z.array(z.string()).max(8).optional(),
    /** Pixel preset only: grid size in pixels. */
    grid: z.union([z.literal(8), z.literal(16), z.literal(32)]).optional(),
  }).default({ preset: "clean" }),
});
export type Manifest = z.infer<typeof Manifest>;

export type Orientation = "portrait" | "landscape";
/** Engine orientation: absent = "landscape" (games made before §11.1). */
export const orientationOf = (m: Pick<Manifest, "orientation">): Orientation => m.orientation ?? "landscape";
/** Reference screen (short side 720): portrait 720×1280, landscape 1280×720. */
/** A scene's view mode: its own `view`, else the manifest's, else "side". */
export const viewOf = (m: Pick<Manifest, "view">, scene?: { view?: ViewMode }): ViewMode => scene?.view ?? m.view ?? "side";
export function referenceSize(m: Pick<Manifest, "orientation">): [number, number] {
  return orientationOf(m) === "portrait" ? [720, 1280] : [1280, 720];
}

// ---------- scenes (scenes/*.scene.json) ----------

export const ScriptPath = z.string().regex(
  /^scripts\/(client|server)\/[a-z0-9_\-/]+\.luau$/,
  "entity scripts must be scripts/client/*.luau or scripts/server/*.luau",
);

export const Entity = z.strictObject({
  type: z.string(),
  /** Human label shown in the editor; ids are for machines. */
  name: z.string().max(100).optional(),
  props: z.record(z.string(), z.unknown()).optional(),
  scripts: z.array(ScriptPath).optional(),
  tags: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).optional(),
  /** Ordered child ids. Parent is derived; never stored. */
  children: z.array(z.string()).optional(),
});
export type Entity = z.infer<typeof Entity>;

export const Scene = z.strictObject({
  format: z.literal(FORMAT_VERSION),
  root: z.string(),
  /** Overrides the manifest's `view` for this scene (e.g. an iso map scene in an oblique game). */
  view: z.enum(VIEW_MODES).optional(),
  entities: z.record(z.string(), Entity),
});
export type Scene = z.infer<typeof Scene>;

// ---------- assets (assets/<id>.meta.json) ----------

export const ASSET_EXTENSIONS = {
  image: ["png", "jpg", "webp", "svg"],
  mesh: ["glb"],
  audio: ["ogg", "mp3", "wav"],
  font: ["ttf", "otf"],
} as const;

export const AssetMeta = z.strictObject({
  kind: z.enum(["image", "mesh", "audio", "font"]),
  /** File name inside assets/, e.g. "tower.png". */
  file: z.string().regex(/^[a-z][a-z0-9_]*\.[a-z0-9]+$/),
  /** Provenance — how it was made. */
  source: z.strictObject({
    model: z.string().optional(),
    prompt: z.string().optional(),
    seed: z.number().int().optional(),
    references: z.array(z.string()).optional(),
    handmade: z.boolean().optional(),
  }).optional(),
  license: z.string().optional(),
});
export type AssetMeta = z.infer<typeof AssetMeta>;
