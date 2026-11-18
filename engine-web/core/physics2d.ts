// Rapier 2D adapter. Works in pixel units with +y down (gravity = +980 px/s², like Godot).
// Rapier angles are CCW in y-up space, i.e. clockwise on a y-down screen — same as our `rotation`.
//
// 2.5D height (DREAMSY.MD §14.5), the same rules as the C++ engine (engine/src/physics/physics2d.h):
// entity props `z` (base height) and `height` (vertical extent); two shapes interact only when their
// z ranges overlap (height 0 = flat = interacts with everything; Rapier physics hooks); moving bodies
// fall with Z_GRAVITY × z_gravity_scale and land on the highest top (z + height) of a static/kinematic
// body or solid raised tile under their center; planar gravity applies in the "side" view only.
// engine-web draws in 2D (z is not drawn); the C++ engine renders the views.
import RAPIER from "@dimforge/rapier2d-compat";
import { apply, global2D, invert, mul, rotationOf, type Entity, type Mat2D } from "./world.js";

let ready: Promise<void> | null = null;
export function initRapier2D(): Promise<void> {
  ready ??= RAPIER.init();
  return ready;
}

export const GRAVITY_2D = 980;
export const Z_GRAVITY = 980;

const Z_HOOKS = RAPIER.ActiveHooks.FILTER_CONTACT_PAIRS | RAPIER.ActiveHooks.FILTER_INTERSECTION_PAIRS;

interface BodyRec {
  e: Entity;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  /** All colliders (TileMap2D has one per merged rectangle). */
  colliders: RAPIER.Collider[];
  kind: "static" | "dynamic" | "kinematic" | "area" | "tiles";
}

export interface ContactEvent {
  a: Entity; // receiver
  b: Entity; // other
  started: boolean;
}

/** 2.5D props (catalog defaults 0; types without them read as flat, on the ground). */
function zOf(e: Entity): { z: number; height: number; vz: number } {
  return { z: e.get<number>("z") ?? 0, height: e.get<number>("height") ?? 0, vz: e.get<number>("z_velocity") ?? 0 };
}

export class Physics2D {
  readonly world: RAPIER.World;
  private queue: RAPIER.EventQueue;
  private recs = new Map<Entity, BodyRec>();
  private byCollider = new Map<number, BodyRec>();
  /** Entities whose body must be (re)built before the next step. */
  private dirty = new Set<Entity>();
  /** TileMap2D ↔ entity contact counts (many colliders → one bodyEntered/bodyExited per entity pair). */
  private tilePairs = new Map<string, number>();
  /** Pairs active before a tilemap's colliders were rebuilt; re-confirmed silently by the new colliders. */
  private staleTilePairs = new Map<string, [Entity, Entity]>();

  /** z-range filter: only colliders of entities with a height carry the hook flags (see zHooks). */
  private hooks: RAPIER.PhysicsHooks = {
    filterContactPair: (c1, c2) => (this.zAllows(c1, c2) ? RAPIER.SolverFlags.COMPUTE_IMPULSE : null),
    filterIntersectionPair: (c1, c2) => this.zAllows(c1, c2),
  };

  /** Named collision layers (manifest [physics] layers); index = bit. `view`: planar gravity only in "side". */
  constructor(dt: number, readonly layers: readonly string[] = [], view: string = "side") {
    this.world = new RAPIER.World({ x: 0, y: view === "side" ? GRAVITY_2D : 0 });
    this.world.timestep = dt;
    this.world.lengthUnit = 32;
    this.queue = new RAPIER.EventQueue(true);
  }

  /** Rapier collision groups for an entity's `layer` / `mask` (unset = all 16 bits). Unknown names throw. */
  groups(e: Entity): number {
    const bits = (v: string, key: string) => {
      const names = v.split(",").map((x) => x.trim()).filter(Boolean);
      if (!names.length) return 0xffff;
      let b = 0;
      for (const n of names) {
        const i = this.layers.indexOf(n);
        if (i < 0) throw new Error(`${e.type} "${e.id}".${key}: unknown collision layer "${n}"${this.layers.length ? ` (layers: ${this.layers.join(", ")})` : " (declare [physics] layers in dreamsy.toml)"}`);
        b |= 1 << i;
      }
      return b;
    };
    const member = bits(e.get<string>("layer") ?? "", "layer"), filter = bits(e.get<string>("mask") ?? "", "mask");
    return ((member << 16) | filter) >>> 0;
  }

  private safeGroups(e: Entity): number {
    try { return this.groups(e); } catch { return 0xffffffff; }
  }

  static isPhysical(e: Entity): boolean {
    return e.type === "Body2D" || e.type === "Area2D" || e.type === "TileMap2D";
  }

  markDirty(e: Entity) {
    if (Physics2D.isPhysical(e)) this.dirty.add(e);
  }

  /** Ensure the body exists (built lazily so spawn() can set props first). */
  rec(e: Entity): BodyRec | undefined {
    if (this.dirty.has(e)) this.build(e);
    return this.recs.get(e);
  }

  flush() {
    for (const e of [...this.dirty]) this.build(e);
  }

  private build(e: Entity) {
    this.dirty.delete(e);
    const old = this.recs.get(e);
    let vel: { x: number; y: number } | null = null;
    if (old) {
      vel = old.body.linvel();
      this.removeRec(old);
    }
    if (!e.alive) return;
    if (e.type === "TileMap2D") { this.buildTiles(e, old !== undefined); return; }
    const isArea = e.type === "Area2D";
    const kind = isArea ? "area" : (e.get<string>("body") as BodyRec["kind"]);
    const m = global2D(e);
    const pos = { x: m[4], y: m[5] };
    let desc: RAPIER.RigidBodyDesc;
    if (kind === "dynamic") desc = RAPIER.RigidBodyDesc.dynamic().setCcdEnabled(true);
    else if (kind === "kinematic") desc = RAPIER.RigidBodyDesc.kinematicVelocityBased();
    else if (kind === "area") desc = RAPIER.RigidBodyDesc.kinematicPositionBased();
    else desc = RAPIER.RigidBodyDesc.fixed();
    desc.setTranslation(pos.x, pos.y).setRotation(rotationOf(m));
    if (!isArea) {
      desc.setGravityScale(e.get<number>("gravity_scale"));
      if (e.get<boolean>("lock_rotation")) desc.lockRotations();
    }
    const body = this.world.createRigidBody(desc);
    const sx = Math.hypot(m[0], m[1]) || 1, sy = Math.hypot(m[2], m[3]) || 1;
    const size = e.get<number[]>("size");
    const w = Math.max(0.5, size[0]! * sx), h = Math.max(0.5, size[1]! * sy);
    const shape = e.get<string>("shape");
    let cd: RAPIER.ColliderDesc;
    if (shape === "circle") cd = RAPIER.ColliderDesc.ball(w / 2);
    else if (shape === "capsule") {
      const r = w / 2;
      cd = RAPIER.ColliderDesc.capsule(Math.max(0.01, h / 2 - r), r);
    } else cd = RAPIER.ColliderDesc.cuboid(w / 2, h / 2);
    cd.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS).setCollisionGroups(this.safeGroups(e));
    if (isArea) {
      cd.setSensor(true).setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.ALL);
    } else {
      cd.setFriction(e.get<number>("friction")).setRestitution(e.get<number>("bounce"));
      if (kind === "dynamic") cd.setMass(e.get<number>("mass"));
      cd.setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.DEFAULT | RAPIER.ActiveCollisionTypes.KINEMATIC_FIXED);
    }
    if (zOf(e).height > 0) cd.setActiveHooks(Z_HOOKS);
    const collider = this.world.createCollider(cd, body);
    const rec: BodyRec = { e, body, collider, colliders: [collider], kind };
    this.recs.set(e, rec);
    this.byCollider.set(collider.handle, rec);
    const v = e.pendingVelocity ? { x: e.pendingVelocity[0]!, y: e.pendingVelocity[1]! } : vel;
    e.pendingVelocity = null;
    if (v && kind !== "static" && kind !== "area") body.setLinvel(v, true);
    this.applyEnabled(e);
  }

  /** One fixed body with a cuboid per merged solid rectangle (see TileGrid.solidRects). */
  private buildTiles(e: Entity, rebuilt: boolean) {
    if (rebuilt) {
      for (const [key, n] of this.tilePairs) {
        if (n > 0 && key.startsWith(`${e.handle}:`)) {
          const other = this.otherOf(key);
          if (other) this.staleTilePairs.set(key, [e, other]);
        }
        if (key.startsWith(`${e.handle}:`) || key.endsWith(`:${e.handle}`)) this.tilePairs.delete(key);
      }
    }
    const grid = e.tiles;
    if (!grid || !e.get<boolean>("collision")) return;
    const rects = grid.solidRects();
    if (rects.length === 0) return;
    const m = global2D(e);
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(m[4], m[5]).setRotation(rotationOf(m)));
    const sx = Math.hypot(m[0], m[1]) || 1, sy = Math.hypot(m[2], m[3]) || 1;
    const ts = e.get<number>("tile_size");
    const colliders: RAPIER.Collider[] = [];
    const groups = this.safeGroups(e);
    for (const [c, r, w, h] of rects) {
      const cd = RAPIER.ColliderDesc.cuboid((w * ts * sx) / 2, (h * ts * sy) / 2)
        .setTranslation((c + w / 2) * ts * sx, (r + h / 2) * ts * sy)
        .setFriction(0.5)
        .setCollisionGroups(groups)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
        .setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.DEFAULT | RAPIER.ActiveCollisionTypes.KINEMATIC_FIXED);
      if (zOf(e).height > 0) cd.setActiveHooks(Z_HOOKS);
      colliders.push(this.world.createCollider(cd, body));
    }
    const rec: BodyRec = { e, body, collider: colliders[0]!, colliders, kind: "tiles" };
    this.recs.set(e, rec);
    for (const c of colliders) this.byCollider.set(c.handle, rec);
    this.applyEnabled(e);
  }

  private otherOf(key: string): Entity | undefined {
    const h = Number(key.split(":")[1]);
    for (const r of this.recs.values()) if (r.e.handle === h) return r.e;
    return undefined;
  }

  /** Number of colliders a TileMap2D was merged into (perf diagnostics). */
  colliderCount(e: Entity): number {
    return this.recs.get(e)?.colliders.length ?? 0;
  }

  private removeRec(rec: BodyRec) {
    for (const c of rec.colliders) this.byCollider.delete(c.handle);
    this.recs.delete(rec.e);
    this.world.removeRigidBody(rec.body);
  }

  remove(e: Entity) {
    this.dirty.delete(e);
    const rec = this.recs.get(e);
    if (rec) this.removeRec(rec);
  }

  applyEnabled(e: Entity) {
    const rec = this.recs.get(e);
    if (rec) rec.body.setEnabled(e.get<boolean>("visible") !== false);
  }

  /** Teleport a body to its entity's current global transform (after a script set position/rotation). */
  syncTransform(e: Entity) {
    if (this.dirty.has(e)) return;
    const rec = this.recs.get(e);
    if (!rec) return;
    const m = global2D(e);
    if (rec.kind === "area") {
      rec.body.setNextKinematicTranslation({ x: m[4], y: m[5] });
      rec.body.setNextKinematicRotation(rotationOf(m));
    } else {
      rec.body.setTranslation({ x: m[4], y: m[5] }, true);
      rec.body.setRotation(rotationOf(m), true);
    }
  }

  getVelocity(e: Entity): number[] {
    const rec = this.rec(e);
    if (!rec) return e.pendingVelocity ?? [0, 0];
    const v = rec.body.linvel();
    return [v.x, v.y];
  }

  setVelocity(e: Entity, v: number[]) {
    const rec = this.rec(e);
    if (!rec) { e.pendingVelocity = [v[0]!, v[1]!]; return; }
    if (rec.kind === "dynamic" || rec.kind === "kinematic") rec.body.setLinvel({ x: v[0]!, y: v[1]! }, true);
  }

  applyImpulse(e: Entity, v: number[]) {
    const rec = this.rec(e);
    if (rec?.kind === "dynamic") rec.body.applyImpulse({ x: v[0]!, y: v[1]! }, true);
  }

  /** Touching something below (contact normal pointing down from this body, +y). */
  onFloor(e: Entity): boolean {
    const rec = this.rec(e);
    if (!rec || rec.kind === "area") return false;
    let floor = false;
    this.world.contactPairsWith(rec.collider, (other) => {
      if (floor || other.isSensor()) return;
      this.world.contactPair(rec.collider, other, (manifold, flipped) => {
        if (manifold.numSolverContacts() === 0 && manifold.numContacts() === 0) return;
        const n = manifold.normal();
        const ny = flipped ? -n.y : n.y;
        if (manifold.numContacts() > 0 && ny > 0.6) {
          // ignore contacts that are only predicted, not touching
          for (let i = 0; i < manifold.numContacts(); i++) {
            if (manifold.contactDist(i) < 0.5) { floor = true; break; }
          }
        }
      });
    });
    return floor;
  }

  // ---------- 2.5D height ----------

  /** A script changed `height`: colliders with a height carry the z-filter hook flags. */
  zHooks(e: Entity) {
    const rec = this.recs.get(e);
    if (!rec) return;
    const flags = zOf(e).height > 0 ? Z_HOOKS : RAPIER.ActiveHooks.NONE;
    for (const c of rec.colliders) c.setActiveHooks(flags);
  }

  private zAllows(c1: number, c2: number): boolean {
    const a = this.byCollider.get(c1)?.e, b = this.byCollider.get(c2)?.e;
    if (!a || !b) return true;
    const za = zOf(a), zb = zOf(b);
    if (za.height <= 0 || zb.height <= 0) return true; // flat shapes interact with everything
    return za.z < zb.z + zb.height && zb.z < za.z + za.height;
  }

  /** Does the body's footprint (or a solid tile of a tile map) contain the world point? */
  private covers(r: BodyRec, x: number, y: number): boolean {
    if (r.kind === "tiles") {
      const grid = r.e.tiles;
      if (!grid) return false;
      const [lx, ly] = apply(invert(global2D(r.e)), x, y);
      const ts = r.e.get<number>("tile_size");
      if (!(ts > 0)) return false;
      const col = Math.floor(lx / ts), row = Math.floor(ly / ts);
      return grid.kindAt(col, row)?.solid ?? false;
    }
    const b = this.aabb(r.e);
    return !!b && b[0] <= x && x <= b[2] && b[1] <= y && y <= b[3];
  }

  /** Ground height at (x, y) for something at height z: highest top ≤ z of a static/kinematic body or solid raised tile, else 0. */
  groundBelow(x: number, y: number, z: number, ignore?: Entity): number {
    let ground = 0;
    for (const r of this.recs.values()) {
      if (r.e === ignore || (r.kind !== "static" && r.kind !== "kinematic" && r.kind !== "tiles")) continue;
      if (!r.body.isEnabled()) continue;
      const s = zOf(r.e);
      if (s.height <= 0) continue;
      const top = s.z + s.height;
      if (top > z + 1e-6 || top <= ground) continue;
      if (this.covers(r, x, y)) ground = top;
    }
    return ground;
  }

  /** Ground height under a body's center (0 without a body). */
  groundOf(e: Entity): number {
    const rec = this.rec(e);
    if (!rec) return 0;
    const t = rec.body.translation();
    return this.groundBelow(t.x, t.y, zOf(e).z, e);
  }

  /** Resting on its ground (not moving up). */
  onGround(e: Entity): boolean {
    const z = zOf(e);
    return z.vz <= 0 && z.z <= this.groundOf(e) + 1e-6;
  }

  /** z gravity, jumps and landing for moving bodies (creation order; semi-implicit Euler). */
  private stepZ(dt: number) {
    for (const r of this.recs.values()) {
      if (r.kind !== "dynamic" && r.kind !== "kinematic") continue;
      const e = r.e;
      let { z, vz } = zOf(e);
      const height = zOf(e).height;
      if ((z === 0 && vz === 0 && height <= 0) || !r.body.isEnabled()) continue;
      const t = r.body.translation();
      const ground = this.groundBelow(t.x, t.y, z, e);
      if (z > ground || vz > 0) {
        vz -= Z_GRAVITY * (e.get<number>("z_gravity_scale") ?? 1) * dt;
        z += vz * dt;
        if (z <= ground) { z = ground; vz = 0; }
      } else {
        z = ground;
        vz = 0;
      }
      if (z !== e.get<number>("z")) { e.props.z = z; e.rev++; }
      if (vz !== e.get<number>("z_velocity")) e.props.z_velocity = vz;
    }
  }

  /** Step and write simulated transforms back to entities. Returns contact enter/exit events. */
  step(onMoved: (e: Entity) => void): ContactEvent[] {
    this.flush();
    this.world.step(this.queue, this.hooks);
    for (const rec of this.recs.values()) {
      if (rec.kind !== "dynamic" && rec.kind !== "kinematic") continue;
      if (rec.body.isSleeping()) continue;
      const t = rec.body.translation();
      const parentInv: Mat2D = invert(global2D(rec.e.parent));
      const [lx, ly] = apply(parentInv, t.x, t.y);
      const p = rec.e.get<number[]>("position");
      let changed = false;
      if (Math.abs(p[0]! - lx) > 1e-6 || Math.abs(p[1]! - ly) > 1e-6) {
        rec.e.props.position = [lx, ly];
        changed = true;
      }
      if (!rec.e.get<boolean>("lock_rotation")) {
        const parentRot = rotationOf(mul(global2D(rec.e.parent), [1, 0, 0, 1, 0, 0]));
        const deg = ((rec.body.rotation() - parentRot) * 180) / Math.PI;
        if (Math.abs(deg - rec.e.get<number>("rotation")) > 1e-6) {
          rec.e.props.rotation = deg;
          changed = true;
        }
      }
      if (changed) onMoved(rec.e);
    }
    this.stepZ(this.world.timestep);
    const events: ContactEvent[] = [];
    this.queue.drainCollisionEvents((h1, h2, started) => {
      const r1 = this.byCollider.get(h1), r2 = this.byCollider.get(h2);
      if (!r1 || !r2 || r1 === r2) return;
      const a1 = r1.kind === "area", a2 = r2.kind === "area";
      if (a1 && a2) return;
      if (r1.kind === "tiles" || r2.kind === "tiles") {
        const [t, o] = r1.kind === "tiles" ? [r1, r2] : [r2, r1];
        const key = `${t.e.handle}:${o.e.handle}`;
        const n = this.tilePairs.get(key) ?? 0;
        const next = Math.max(0, n + (started ? 1 : -1));
        this.tilePairs.set(key, next);
        if (started && n === 0 && this.staleTilePairs.delete(key)) return; // same contact, new colliders
        if ((started && n === 0) || (!started && n > 0 && next === 0)) {
          if (o.kind === "area") events.push({ a: o.e, b: t.e, started });
          else { events.push({ a: o.e, b: t.e, started }); events.push({ a: t.e, b: o.e, started }); }
        }
        return;
      }
      if (a1) events.push({ a: r1.e, b: r2.e, started });
      else if (a2) events.push({ a: r2.e, b: r1.e, started });
      else {
        events.push({ a: r1.e, b: r2.e, started });
        events.push({ a: r2.e, b: r1.e, started });
      }
    });
    for (const [key, [t, o]] of this.staleTilePairs) {
      this.staleTilePairs.delete(key);
      events.push({ a: o, b: t, started: false }, { a: t, b: o, started: false });
    }
    return events;
  }

  /** World-space AABB of a body's collider (for tile overlap queries). */
  aabb(e: Entity): [number, number, number, number] | null {
    const rec = this.recs.get(e);
    if (!rec || rec.kind === "tiles" || !rec.body.isEnabled()) return null;
    const t = rec.body.translation();
    const m = global2D(e);
    const sx = Math.hypot(m[0], m[1]) || 1, sy = Math.hypot(m[2], m[3]) || 1;
    const size = e.get<number[]>("size");
    let hw = (size[0]! * sx) / 2, hh = ((e.get<string>("shape") === "circle" ? size[0]! : size[1]!) * sy) / 2;
    const rot = rec.body.rotation();
    if (rot !== 0) {
      const c = Math.abs(Math.cos(rot)), s = Math.abs(Math.sin(rot));
      [hw, hh] = [hw * c + hh * s, hw * s + hh * c];
    }
    return [t.x - hw, t.y - hh, t.x + hw, t.y + hh];
  }

  /** Moving (dynamic/kinematic) bodies, for tile touch detection. */
  *movingBodies(): Generator<Entity> {
    for (const r of this.recs.values()) if ((r.kind === "dynamic" || r.kind === "kinematic") && r.body.isEnabled()) yield r.e;
  }

  dispose() {
    this.queue.free();
    this.world.free();
  }
}
