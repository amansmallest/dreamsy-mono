// Runtime tile grid for TileMap2D: parsed once from the package (format/src/tilemap.ts), edited by setTile.
import { EMPTY_TILES, resolveTileMap, type Package } from "@dreamsy/format";
import { parseColor, type RGBA } from "./world.js";

export const TILE_CHUNK = 32;

export interface TileKind {
  /** Index in TileGrid.kinds (0 = empty). */
  index: number;
  char: string;
  sprite?: string;
  /** Fill (no sprite) or tint (sprite). Undefined + no sprite = invisible tile. */
  color?: RGBA;
  solid: boolean;
  tags: string[];
}

export class TileGrid {
  readonly cells: Uint16Array;
  /** Bumped per chunk on edits (renderer diffs against it). */
  readonly chunkRev: Uint32Array;
  readonly chunkCols: number;
  readonly chunkRows: number;
  /** Bumped when solidity changes (physics rebuild). */
  solidRev = 0;
  rev = 0;

  constructor(readonly cols: number, readonly rows: number, readonly kinds: TileKind[], readonly byChar: Map<string, TileKind>) {
    this.cells = new Uint16Array(cols * rows);
    this.chunkCols = Math.ceil(cols / TILE_CHUNK);
    this.chunkRows = Math.ceil(rows / TILE_CHUNK);
    this.chunkRev = new Uint32Array(Math.max(1, this.chunkCols * this.chunkRows));
  }

  inBounds(c: number, r: number) { return c >= 0 && r >= 0 && c < this.cols && r < this.rows; }

  kindAt(c: number, r: number): TileKind | undefined {
    if (!this.inBounds(c, r)) return undefined;
    const k = this.cells[r * this.cols + c]!;
    return k ? this.kinds[k] : undefined;
  }

  /** Returns true if the cell changed. */
  set(c: number, r: number, kind: TileKind | undefined): boolean {
    if (!this.inBounds(c, r)) return false;
    const i = r * this.cols + c;
    const prev = this.cells[i]!;
    const next = kind?.index ?? 0;
    if (prev === next) return false;
    this.cells[i] = next;
    if ((this.kinds[prev]?.solid ?? false) !== (kind?.solid ?? false)) this.solidRev++;
    this.chunkRev[Math.floor(r / TILE_CHUNK) * this.chunkCols + Math.floor(c / TILE_CHUNK)]!++;
    this.rev++;
    return true;
  }

  clone(): TileGrid {
    const g = new TileGrid(this.cols, this.rows, this.kinds, this.byChar);
    g.cells.set(this.cells);
    return g;
  }

  /**
   * Solid tiles merged into rectangles [col, row, w, h]: maximal horizontal runs per row, then runs
   * with identical [start, end] stacked vertically. Every walkable top (and ceiling) surface is a whole
   * run of one rectangle, so bodies never snag on seams when sliding along floors.
   */
  solidRects(): [number, number, number, number][] {
    const out: [number, number, number, number][] = [];
    let open = new Map<number, [number, number, number, number]>(); // key: start*65536+end
    for (let r = 0; r < this.rows; r++) {
      const next = new Map<number, [number, number, number, number]>();
      let c = 0;
      while (c < this.cols) {
        if (!this.kinds[this.cells[r * this.cols + c]!]?.solid) { c++; continue; }
        const start = c;
        while (c < this.cols && this.kinds[this.cells[r * this.cols + c]!]?.solid) c++;
        const key = start * 65536 + c;
        const prev = open.get(key);
        if (prev) { prev[3]++; next.set(key, prev); open.delete(key); }
        else next.set(key, [start, r, c - start, 1]);
      }
      for (const rect of open.values()) out.push(rect);
      open = next;
    }
    for (const rect of open.values()) out.push(rect);
    return out;
  }
}

export interface TileLoadResult { grid?: TileGrid; errors: string[] }

/** Build a grid from a TileMap2D's tileset + data props. */
export function loadTileGrid(pkg: Pick<Package, "text">, tileset: string, data: string): TileLoadResult {
  const r = resolveTileMap(pkg, tileset, data);
  if (!r.tileset) return { errors: r.errors };
  const kinds: TileKind[] = [{ index: 0, char: ".", solid: false, tags: [] }];
  const byChar = new Map<string, TileKind>();
  for (const [ch, def] of Object.entries(r.tileset.tiles)) {
    if (EMPTY_TILES.has(ch) || ch.length !== 1) continue;
    const k: TileKind = {
      index: kinds.length, char: ch,
      sprite: def.sprite ?? undefined,
      color: def.color ? parseColor(def.color) ?? undefined : undefined,
      solid: def.solid ?? false,
      tags: def.tags ?? [],
    };
    kinds.push(k);
    byChar.set(ch, k);
  }
  const rows = Math.min(r.rows.length, 256), cols = Math.min(r.cols, 1024);
  const grid = new TileGrid(cols, rows, kinds, byChar);
  for (let y = 0; y < rows; y++) {
    const line = r.rows[y]!;
    for (let x = 0; x < Math.min(cols, line.length); x++) {
      const k = byChar.get(line[x]!);
      if (k) grid.cells[y * cols + x] = k.index;
    }
  }
  return { grid, errors: r.errors };
}
