/**
 * TileMap2D data: tilesets (data/tilesets/<name>.json) and grids (inline text or data/levels/<name>.txt).
 * Shared by the validator and the engine so both read tiles exactly the same way.
 *
 * Grid text: one line per row (top row first), one character per tile (left to right).
 * "." and " " are always empty. Short rows are padded with empty tiles. Trailing blank lines are ignored.
 */
import { z } from "zod";
import type { Package } from "./package.js";

export const TILESET_PATH_RE = /^data\/tilesets\/[a-z0-9_\-]+\.json$/;
export const LEVEL_PATH_RE = /^data\/levels\/[a-z0-9_\-/]+\.txt$/;
export const GRID_FILE_PREFIX = "file:";
export const MAX_TILEMAP_COLS = 1024;
export const MAX_TILEMAP_ROWS = 256;
/** Characters that always mean "no tile". */
export const EMPTY_TILES = new Set([".", " "]);
/** Tile characters a tileset may define: printable ASCII except space. */
export const TILE_CHAR_RE = /^[!-~]$/;

const TAG_RE = /^[a-z][a-z0-9_]*$/;
const COLOR_RE = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export const TileDef = z.strictObject({
  /** "asset:<id>" image drawn stretched to the tile; null/omitted = no sprite. */
  sprite: z.string().regex(/^asset:[a-z][a-z0-9_]*$/, 'sprite must be "asset:<id>" or null').nullable().optional(),
  /** Fill color when there is no sprite; tint when there is. */
  color: z.string().regex(COLOR_RE, 'color must be "#rrggbb" or "#rrggbbaa"').optional(),
  /** Blocks bodies. Default false. */
  solid: z.boolean().optional(),
  /** Reported by tagsAt() and tileTouched (e.g. "spike", "breakable"). */
  tags: z.array(z.string().regex(TAG_RE, "tags are lowercase_snake")).max(16).optional(),
});
export type TileDef = z.infer<typeof TileDef>;

export const Tileset = z.strictObject({
  tiles: z.record(z.string(), TileDef),
});
export type Tileset = z.infer<typeof Tileset>;

export interface TilesetResult {
  tileset?: Tileset;
  /** Problems (each a full sentence for the model). */
  errors: string[];
  warnings: string[];
}

/** Parse + check a tileset file's text. */
export function parseTileset(text: string): TilesetResult {
  const errors: string[] = [], warnings: string[] = [];
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { return { errors: [`not valid JSON: ${(e as Error).message}`], warnings }; }
  const r = Tileset.safeParse(raw);
  if (!r.success) return { errors: [r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")], warnings };
  for (const [ch, def] of Object.entries(r.data.tiles)) {
    if (EMPTY_TILES.has(ch)) {
      if (def.sprite || def.color || def.solid || def.tags?.length) warnings.push(`tile "${ch}" is always empty; its sprite/color/solid/tags are ignored`);
      continue;
    }
    if (!TILE_CHAR_RE.test(ch)) errors.push(`tile key ${JSON.stringify(ch)} must be exactly one printable ASCII character (e.g. "#", "G", "^")`);
  }
  return { tileset: r.data, errors, warnings };
}

/** Split grid text into rows: handles \r\n, drops trailing blank lines. */
export function gridRows(text: string): string[] {
  const rows = text.replace(/\r/g, "").split("\n");
  while (rows.length && rows[rows.length - 1]!.trim() === "") rows.pop();
  return rows;
}

export interface GridSource {
  /** The grid text. */
  text?: string;
  /** data/levels/... when `data` is "file:<path>". */
  file?: string;
  error?: string;
}

/** Resolve a TileMap2D `data` prop to its grid text (inline or file:). */
export function gridSource(pkg: Pick<Package, "text">, data: string): GridSource {
  if (!data.startsWith(GRID_FILE_PREFIX)) return { text: data };
  const file = data.slice(GRID_FILE_PREFIX.length).trim();
  if (!LEVEL_PATH_RE.test(file)) return { file, error: `data "${data}": level files must be "file:data/levels/<name>.txt"` };
  const text = pkg.text(file);
  if (text === undefined) return { file, error: `level file ${file} does not exist` };
  return { file, text };
}

export interface ResolvedTileMap {
  tileset?: Tileset;
  rows: string[];
  cols: number;
  errors: string[];
  warnings: string[];
}

/** Load tileset + grid for a TileMap2D and check every grid character. */
export function resolveTileMap(pkg: Pick<Package, "text">, tilesetPath: string, data: string): ResolvedTileMap {
  const out: ResolvedTileMap = { rows: [], cols: 0, errors: [], warnings: [] };
  if (!tilesetPath) out.errors.push(`tileset is not set (use "data/tilesets/<name>.json")`);
  else if (!TILESET_PATH_RE.test(tilesetPath)) out.errors.push(`tileset "${tilesetPath}" must be "data/tilesets/<name>.json"`);
  else {
    const text = pkg.text(tilesetPath);
    if (text === undefined) out.errors.push(`tileset ${tilesetPath} does not exist`);
    else {
      const t = parseTileset(text);
      out.tileset = t.tileset;
      out.errors.push(...t.errors.map((e) => `${tilesetPath}: ${e}`));
    }
  }
  const src = gridSource(pkg, data);
  if (src.error) { out.errors.push(src.error); return out; }
  const rows = gridRows(src.text ?? "");
  out.rows = rows;
  out.cols = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const where = src.file ?? "data";
  if (rows.length === 0) out.warnings.push(`${where}: the grid is empty`);
  if (rows.length > MAX_TILEMAP_ROWS || out.cols > MAX_TILEMAP_COLS) {
    out.errors.push(`${where}: grid is ${out.cols}×${rows.length} tiles; max ${MAX_TILEMAP_COLS}×${MAX_TILEMAP_ROWS} (split the level into scenes)`);
  }
  if (out.tileset) {
    const unknown = new Map<string, [number, number]>();
    rows.forEach((row, r) => {
      for (let c = 0; c < row.length; c++) {
        const ch = row[c]!;
        if (EMPTY_TILES.has(ch) || ch in out.tileset!.tiles || unknown.has(ch)) continue;
        unknown.set(ch, [r + 1, c + 1]);
      }
    });
    for (const [ch, [line, col]] of [...unknown].slice(0, 8)) {
      out.errors.push(`${where}: character ${JSON.stringify(ch)} (first at line ${line}, column ${col}) is not defined in ${tilesetPath}; add it to "tiles" or use "." for empty`);
    }
  }
  return out;
}
