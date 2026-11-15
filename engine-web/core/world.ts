import { getType, type EntityTypeDef, type PropDef, type Scene } from "@dreamsy/format";
import type { Emitter } from "./particles.js";
import type { TileGrid } from "./tilemap.js";

export type Vec = number[];

/** Normalized color: [r, g, b, a] in 0..1. */
export type RGBA = [number, number, number, number];

export function parseColor(v: unknown): RGBA | null {
  if (Array.isArray(v) && v.length >= 3) return [Number(v[0]), Number(v[1]), Number(v[2]), v.length > 3 ? Number(v[3]) : 1];
  if (typeof v !== "string") return null;
  let h = v.trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(h)) return null;
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
  return [n(0), n(2), n(4), h.length === 8 ? n(6) : 1];
}

export class Entity {
  /** Numeric handle used across the Luau boundary. */
  readonly handle: number;
  readonly def: EntityTypeDef;
  props: Record<string, unknown> = {};
  tags = new Set<string>();
  parent: Entity | null = null;
  children: Entity[] = [];
  alive = true;
  /** Bumped on every prop change; renderers diff against it. */
  rev = 0;
  /** Velocity stored until the physics body exists. */
  pendingVelocity: Vec | null = null;
  /** TileMap2D only: the live grid, and the tileset|data|tile_size it was loaded from. */
  tiles: TileGrid | null = null;
  tilesKey = "";
  /** Particles2D only: live particles (core-simulated). */
  emitter: Emitter | null = null;
  /** Sprite2D animation playback: resolved animation, seconds into it, finished (non-loop). */
  animName = "";
  animT = 0;
  animDone = false;
  /** Entity e:play() was called on (when it forwarded to a child sprite) — also gets animFinished. */
  animOwner: Entity | null = null;
  /** auto_flip without a body: last global x. */
  lastX = Number.NaN;

  constructor(
    handle: number,
    readonly id: string,
    readonly type: string,
    public name: string,
    public scripts: string[],
  ) {
    this.handle = handle;
    const def = getType(type);
    if (!def) throw new Error(`unknown entity type "${type}"`);
    this.def = def;
  }

  get<T = unknown>(key: string): T {
    if (key in this.props) return this.props[key] as T;
    const d = this.def.props[key];
    if (d?.type.kind === "color" && typeof d.default === "string") return parseColor(d.default) as T;
    return d?.default as T;
  }

  propDef(key: string): PropDef | undefined {
    return this.def.props[key];
  }

  get is2D(): boolean { return this.def.dimension === "2d"; }
}

/** Coerce/validate a value for a prop. Throws a message written for the script author. */
export function coerceProp(e: Entity, key: string, value: unknown, resolve: (h: number | string) => Entity | undefined): unknown {
  const def = e.propDef(key);
  if (!def) throw new Error(`${e.type} "${e.id}" has no property "${key}"`);
  const t = def.type;
  if (value === undefined || value === null) {
    if (t.kind === "asset" || t.kind === "entity") return undefined;
    return def.default;
  }
  const bad = (want: string) => new Error(`${e.type}.${key} expects ${want}, got ${describe(value)}`);
  switch (t.kind) {
    case "number":
    case "int": {
      if (typeof value !== "number" || Number.isNaN(value)) throw bad("a number");
      let n = t.kind === "int" ? Math.round(value) : value;
      if (t.min !== undefined && n < t.min) n = t.min;
      if (t.max !== undefined && n > t.max) n = t.max;
      return n;
    }
    case "bool":
      if (typeof value !== "boolean") throw bad("true/false");
      return value;
    case "string":
      if (typeof value === "number") return String(value);
      if (typeof value !== "string") throw bad("a string");
      return value;
    case "vec2":
      if (!Array.isArray(value) || value.length < 2) throw bad("a Vec2 (use vec2(x, y))");
      return [Number(value[0]), Number(value[1])];
    case "vec3":
      if (!Array.isArray(value) || value.length < 3) throw bad("a Vec3 (use vec3(x, y, z))");
      return [Number(value[0]), Number(value[1]), Number(value[2])];
    case "color": {
      const c = parseColor(value);
      if (!c) throw bad('a Color or "#rrggbb"');
      return c;
    }
    case "enum":
      if (typeof value !== "string" || !t.values.includes(value)) throw bad(`one of ${t.values.map((v) => `"${v}"`).join(", ")}`);
      return value;
    case "asset":
      if (typeof value !== "string" || !/^asset:[a-z][a-z0-9_]*$/.test(value)) throw bad('"asset:<id>"');
      return value;
    case "entity": {
      if (typeof value === "string" || typeof value === "number") {
        const target = resolve(value);
        if (!target) throw new Error(`${e.type}.${key}: no entity "${value}"`);
        return target.id;
      }
      throw bad("an Entity or entity id");
    }
  }
}

function describe(v: unknown): string {
  if (Array.isArray(v)) return v.length === 2 ? "Vec2" : v.length === 3 ? "Vec3" : "Color";
  return typeof v === "string" ? `"${v}"` : String(v);
}

/** Prop aliases: Sprite2D `color` is stored as `modulate`. */
export function propAlias(e: Entity, key: string): string {
  return key === "color" && e.type === "Sprite2D" ? "modulate" : key;
}

/** Normalize scene-file prop values (colors to RGBA etc.). Invalid values fall back to defaults with a warning. */
export function normalizeSceneProps(e: Entity, raw: Record<string, unknown>, warn: (msg: string) => void, resolve: (h: number | string) => Entity | undefined, deferEntityRefs: [Entity, string, unknown][]) {
  for (const [k, v] of Object.entries(raw)) {
    const def = e.propDef(k);
    if (!def) { warn(`${e.id}: unknown prop "${k}" on ${e.type}`); continue; }
    if (def.type.kind === "entity") { deferEntityRefs.push([e, k, v]); continue; }
    try {
      e.props[propAlias(e, k)] = coerceProp(e, k, v, resolve);
    } catch (err) {
      warn(`${e.id}: ${(err as Error).message}`);
    }
  }
}

export class World {
  readonly byId = new Map<string, Entity>();
  readonly byHandle = new Map<number, Entity>();
  root!: Entity;
  /** Bumped whenever entities are added/removed/reparented. */
  structureRev = 0;
  private nextHandle = 1;
  private nextAuto = 1;

  create(id: string | null, type: string, name?: string, scripts: string[] = []): Entity {
    if (id === null) {
      do id = `rt_${this.nextAuto++}`; while (this.byId.has(id));
    } else if (this.byId.has(id)) {
      throw new Error(`duplicate entity id "${id}"`);
    }
    const e = new Entity(this.nextHandle++, id, type, name ?? id, scripts);
    this.byId.set(id, e);
    this.byHandle.set(e.handle, e);
    this.structureRev++;
    return e;
  }

  attach(child: Entity, parent: Entity | null, index?: number) {
    if (child.parent) {
      const sib = child.parent.children;
      const i = sib.indexOf(child);
      if (i >= 0) sib.splice(i, 1);
    }
    child.parent = parent;
    if (parent) {
      if (index === undefined || index < 0 || index > parent.children.length) parent.children.push(child);
      else parent.children.splice(index, 0, child);
    }
    this.structureRev++;
  }

  /** Removes the subtree; returns removed entities (children first). */
  remove(e: Entity): Entity[] {
    const out: Entity[] = [];
    const walk = (x: Entity) => {
      for (const c of [...x.children]) walk(c);
      out.push(x);
    };
    walk(e);
    if (e.parent) this.attach(e, null);
    for (const x of out) {
      x.alive = false;
      this.byId.delete(x.id);
      this.byHandle.delete(x.handle);
    }
    this.structureRev++;
    return out;
  }

  /** Depth-first, tree order. */
  *walk(from: Entity = this.root): Generator<Entity> {
    yield from;
    for (const c of from.children) yield* this.walk(c);
  }

  tagged(tag: string): Entity[] {
    const out: Entity[] = [];
    for (const e of this.walk()) if (e.tags.has(tag)) out.push(e);
    return out;
  }

  get count(): number { return this.byId.size; }

  /** Remove every entity (scene change). Handles are never reused, so stale script references fail cleanly. */
  clear(): Entity[] {
    const out = this.root ? this.remove(this.root) : [];
    this.byId.clear();
    this.byHandle.clear();
    this.structureRev++;
    return out;
  }

  loadScene(scene: Scene, warn: (msg: string) => void): Entity[] {
    const created: Entity[] = [];
    const refs: [Entity, string, unknown][] = [];
    const build = (id: string, parent: Entity | null) => {
      const src = scene.entities[id];
      if (!src) { warn(`missing entity "${id}"`); return; }
      if (!getType(src.type)) { warn(`${id}: unknown type "${src.type}" (skipped)`); return; }
      const e = this.create(id, src.type, src.name, src.scripts ?? []);
      for (const t of src.tags ?? []) e.tags.add(t);
      normalizeSceneProps(e, src.props ?? {}, warn, (h) => this.resolve(h), refs);
      if (parent) this.attach(e, parent); else this.root = e;
      created.push(e);
      for (const c of src.children ?? []) build(c, e);
    };
    build(scene.root, null);
    for (const [e, k, v] of refs) {
      if (v === null || v === undefined) continue;
      const t = this.resolve(v as string);
      if (t) e.props[k] = t.id; else warn(`${e.id}.${k}: no entity "${String(v)}"`);
    }
    return created;
  }

  resolve(h: number | string): Entity | undefined {
    return typeof h === "number" ? this.byHandle.get(h) : this.byId.get(h);
  }
}

// ---------- 2D transforms ----------

/** Affine 2D: [a, b, c, d, tx, ty] maps (x,y) → (a x + c y + tx, b x + d y + ty). */
export type Mat2D = [number, number, number, number, number, number];
export const IDENTITY: Mat2D = [1, 0, 0, 1, 0, 0];

export function local2D(e: Entity): Mat2D {
  const def = e.def.props;
  if (!("position" in def) || e.def.dimension !== "2d") return IDENTITY;
  const p = e.get<number[]>("position");
  const r = ((e.get<number>("rotation") ?? 0) * Math.PI) / 180;
  const s = e.get<number[]>("scale") ?? [1, 1];
  const cos = Math.cos(r), sin = Math.sin(r);
  return [cos * s[0]!, sin * s[0]!, -sin * s[1]!, cos * s[1]!, p[0]!, p[1]!];
}

export function mul(m: Mat2D, n: Mat2D): Mat2D {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function invert(m: Mat2D): Mat2D {
  const det = m[0] * m[3] - m[1] * m[2] || 1e-12;
  const a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

export function apply(m: Mat2D, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function global2D(e: Entity | null): Mat2D {
  let m: Mat2D = IDENTITY;
  for (let x = e; x; x = x.parent) m = mul(local2D(x), m);
  return m;
}

export function rotationOf(m: Mat2D): number {
  return Math.atan2(m[1], m[0]);
}
