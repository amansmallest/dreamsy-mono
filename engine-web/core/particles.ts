// Particles2D simulation (core, deterministic): struct-of-arrays per emitter, world-space particles.
// The renderer only reads positions/ages; color and size are interpolated from the entity props.
import { Random } from "./random.js";
import type { Entity } from "./world.js";

export class Emitter {
  /** Live particle count. */
  n = 0;
  cap = 0;
  x = new Float32Array(0);
  y = new Float32Array(0);
  vx = new Float32Array(0);
  vy = new Float32Array(0);
  age = new Float32Array(0);
  life = new Float32Array(0);
  /** Fractional particles carried between ticks (rate × dt). */
  private acc = 0;
  readonly rng: Random;

  constructor(seed: number) {
    this.rng = new Random(seed);
  }

  private ensure(cap: number) {
    if (cap === this.cap) return;
    const grow = (a: Float32Array) => { const b = new Float32Array(cap); b.set(a.subarray(0, Math.min(this.n, cap))); return b; };
    this.x = grow(this.x); this.y = grow(this.y); this.vx = grow(this.vx); this.vy = grow(this.vy);
    this.age = grow(this.age); this.life = grow(this.life);
    this.cap = cap;
    this.n = Math.min(this.n, cap);
  }

  /** Emit `count` particles now (e:burst / rate). */
  emit(e: Entity, count: number, px: number, py: number, rotDeg: number) {
    this.ensure(e.get<number>("max_particles"));
    const dir = ((e.get<number>("direction") + rotDeg) * Math.PI) / 180;
    const spread = (e.get<number>("spread") * Math.PI) / 180;
    const speed = e.get<number>("speed"), sr = e.get<number>("speed_random");
    const life = e.get<number>("lifetime"), lr = e.get<number>("lifetime_random");
    const area = e.get<number[]>("emission_size");
    const r = this.rng;
    for (let k = 0; k < count && this.n < this.cap; k++) {
      const i = this.n++;
      const a = dir + (r.next() - 0.5) * spread;
      const v = speed * (1 - sr * r.next());
      this.x[i] = px + (r.next() - 0.5) * area[0]!;
      this.y[i] = py + (r.next() - 0.5) * area[1]!;
      this.vx[i] = Math.cos(a) * v;
      this.vy[i] = Math.sin(a) * v;
      this.age[i] = 0;
      this.life[i] = Math.max(0.02, life * (1 - lr * r.next()));
    }
  }

  /** One tick. (px, py) = emitter world position, rot = world rotation (deg), active = visible. */
  step(e: Entity, dt: number, px: number, py: number, rot: number, active: boolean) {
    this.ensure(e.get<number>("max_particles"));
    // age + integrate, compacting dead particles (order-preserving)
    const g = e.get<number[]>("gravity");
    const damp = Math.max(0, 1 - e.get<number>("damping") * dt);
    let w = 0;
    for (let i = 0; i < this.n; i++) {
      const age = this.age[i]! + dt;
      if (age >= this.life[i]!) continue;
      const vx = this.vx[i]! * damp + g[0]! * dt, vy = this.vy[i]! * damp + g[1]! * dt;
      this.x[w] = this.x[i]! + vx * dt;
      this.y[w] = this.y[i]! + vy * dt;
      this.vx[w] = vx; this.vy[w] = vy;
      this.age[w] = age; this.life[w] = this.life[i]!;
      w++;
    }
    this.n = w;
    if (active && e.get<boolean>("emitting")) {
      this.acc += e.get<number>("rate") * dt;
      const k = Math.floor(this.acc);
      if (k > 0) { this.acc -= k; this.emit(e, k, px, py, rot); }
    } else {
      this.acc = 0;
    }
  }

  clear() { this.n = 0; this.acc = 0; }
}
