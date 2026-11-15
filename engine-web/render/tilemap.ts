// TileMap2D rendering: the grid is cut into 32×32-tile chunks; each chunk is one merged BufferGeometry
// per tile kind (one draw call per kind per chunk, frustum-culled by three.js). Edits (setTile) rebuild
// only the touched chunk.
import * as THREE from "three";
import { TILE_CHUNK, type Entity, type TileGrid, type TileKind } from "../core/index.js";
import type { TextureCache } from "./textures.js";

interface Chunk {
  rev: number;
  group: THREE.Group;
  /** Sprite refs still loading when built; rebuilt once they arrive. */
  pending: string[];
}

export class TileMapView {
  readonly group = new THREE.Group();
  private grid: TileGrid | null = null;
  private ts = 0;
  private chunks = new Map<number, Chunk>();
  private materials = new Map<number, THREE.MeshBasicMaterial>();
  private renderOrder = 0;

  constructor(private textures: TextureCache, private screenScale: () => number) {}

  /** Called every frame: rebuild chunks whose tiles changed. */
  sync(e: Entity, renderOrder: number) {
    const grid = e.tiles;
    const ts = e.get<number>("tile_size");
    if (grid !== this.grid || ts !== this.ts) {
      this.clear();
      this.grid = grid;
      this.ts = ts;
    }
    if (grid) {
      for (let cy = 0; cy < grid.chunkRows; cy++) {
        for (let cx = 0; cx < grid.chunkCols; cx++) {
          const i = cy * grid.chunkCols + cx;
          const rev = grid.chunkRev[i]!;
          const ch = this.chunks.get(i);
          if (ch && ch.rev === rev && !(ch.pending.length && this.loaded(ch.pending))) continue;
          this.buildChunk(grid, cx, cy, rev);
        }
      }
    }
    if (renderOrder !== this.renderOrder) {
      this.renderOrder = renderOrder;
      this.group.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.renderOrder = renderOrder; });
    }
  }

  private loaded(refs: string[]): boolean {
    return refs.some((r) => this.textures.get(r, this.ts * this.screenScale()) !== undefined);
  }

  private material(k: TileKind): THREE.MeshBasicMaterial | null | undefined {
    let tex: THREE.Texture | null | undefined = null;
    if (k.sprite) {
      tex = this.textures.get(k.sprite, this.ts * this.screenScale());
      if (tex === undefined) return undefined; // still loading
    }
    if (!tex && !k.color) return null; // invisible tile
    let m = this.materials.get(k.index);
    if (!m) {
      m = new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
      this.materials.set(k.index, m);
    }
    const c = k.color ?? [1, 1, 1, 1];
    m.color.setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);
    m.opacity = c[3];
    if (m.map !== tex) { m.map = tex; m.needsUpdate = true; }
    return m;
  }

  private buildChunk(grid: TileGrid, cx: number, cy: number, rev: number) {
    const i = cy * grid.chunkCols + cx;
    const old = this.chunks.get(i);
    if (old) this.disposeChunk(old);
    const ts = this.ts;
    const byKind = new Map<number, number[]>(); // kind → cell indices
    const c1 = Math.min(grid.cols, (cx + 1) * TILE_CHUNK), r1 = Math.min(grid.rows, (cy + 1) * TILE_CHUNK);
    for (let r = cy * TILE_CHUNK; r < r1; r++) {
      for (let c = cx * TILE_CHUNK; c < c1; c++) {
        const k = grid.cells[r * grid.cols + c]!;
        if (!k) continue;
        let list = byKind.get(k);
        if (!list) byKind.set(k, (list = []));
        list.push(c, r);
      }
    }
    const chunk: Chunk = { rev, group: new THREE.Group(), pending: [] };
    for (const [ki, cells] of byKind) {
      const kind = grid.kinds[ki]!;
      const mat = this.material(kind);
      if (mat === undefined) { chunk.pending.push(kind.sprite!); continue; }
      if (mat === null) continue;
      const n = cells.length / 2;
      const pos = new Float32Array(n * 12), uv = new Float32Array(n * 8), idx = new Uint32Array(n * 6);
      for (let q = 0; q < n; q++) {
        const x0 = cells[q * 2]! * ts, y0 = cells[q * 2 + 1]! * ts, x1 = x0 + ts, y1 = y0 + ts;
        // y-down world; the renderer's root flips y, so the top edge (y0) samples v = 1
        pos.set([x0, y0, 0, x1, y0, 0, x1, y1, 0, x0, y1, 0], q * 12);
        uv.set([0, 1, 1, 1, 1, 0, 0, 0], q * 8);
        const b = q * 4;
        idx.set([b, b + 1, b + 2, b, b + 2, b + 3], q * 6);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, mat);
      mesh.renderOrder = this.renderOrder;
      chunk.group.add(mesh);
    }
    this.group.add(chunk.group);
    this.chunks.set(i, chunk);
  }

  private disposeChunk(ch: Chunk) {
    ch.group.removeFromParent();
    for (const o of ch.group.children) (o as THREE.Mesh).geometry.dispose();
  }

  /** Draw calls currently held (diagnostics). */
  get meshCount(): number {
    let n = 0;
    for (const c of this.chunks.values()) n += c.group.children.length;
    return n;
  }

  clear() {
    for (const c of this.chunks.values()) this.disposeChunk(c);
    this.chunks.clear();
  }

  dispose() {
    this.clear();
    for (const m of this.materials.values()) m.dispose();
    this.materials.clear();
    this.group.removeFromParent();
  }
}
