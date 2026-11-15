// 2D lighting model (Lighting2D darkness + Light2D lights). Core only describes the lights; render/lighting.ts
// draws them. Headless runs keep lights as plain entities (tweens, parenting, props all work).
import type { Game } from "./game.js";
import { global2D, type Entity, type RGBA } from "./world.js";

export const MAX_LIGHTS = 64;

export interface LightingState {
  /** Unlit color (0..1 rgb). */
  ambient: [number, number, number];
  darkness: number;
  vignette: number;
}

export interface LightSample { x: number; y: number; radius: number; color: [number, number, number]; intensity: number; falloff: number }

/** The scene's active Lighting2D (first visible one), or null = no darkness. */
export function lightingState(game: Game): LightingState | null {
  for (const e of game.world.walk()) {
    if (e.type !== "Lighting2D" || !game.effectiveVisible(e)) continue;
    const c = e.get<RGBA>("ambient");
    return { ambient: [c[0], c[1], c[2]], darkness: e.get<number>("darkness"), vignette: e.get<number>("vignette") };
  }
  return null;
}

/** Deterministic flicker multiplier in [1 - amount, 1] for a light at time t. */
export function flickerFactor(amount: number, speed: number, t: number, seed: number): number {
  if (amount <= 0) return 1;
  const a = t * speed + seed * 1.37;
  const n = (Math.sin(a * 2.1) + Math.sin(a * 3.7 + 1.3) * 0.6 + Math.sin(a * 7.3 + 4.1) * 0.3) / 1.9; // -1..1
  return 1 - amount * (0.5 + 0.5 * n);
}

/** Lit Light2Ds (enabled, visible, energy > 0), nearest to (cx, cy) first, at most MAX_LIGHTS. */
export function collectLights(game: Game, cx: number, cy: number, lights?: Entity[]): LightSample[] {
  const out: (LightSample & { d: number })[] = [];
  for (const e of lights ?? game.world.walk()) {
    if (e.type !== "Light2D" || !e.alive || !e.get<boolean>("enabled") || !game.effectiveVisible(e)) continue;
    const m = global2D(e);
    const scale = Math.hypot(m[0], m[1]);
    const intensity = e.get<number>("energy") * flickerFactor(e.get<number>("flicker"), e.get<number>("flicker_speed"), game.time, e.handle);
    if (intensity <= 0) continue;
    const c = e.get<RGBA>("color");
    const radius = e.get<number>("radius") * scale;
    out.push({ x: m[4], y: m[5], radius, color: [c[0], c[1], c[2]], intensity, falloff: e.get<number>("falloff"), d: Math.hypot(m[4] - cx, m[5] - cy) - radius });
  }
  out.sort((a, b) => a.d - b.d);
  return out.slice(0, MAX_LIGHTS).map(({ d: _d, ...l }) => l);
}

/** Light level (rgb, 0..1 each) at a world point — the same formula as the shader (no vignette). */
export function lightAt(state: LightingState, lights: LightSample[], x: number, y: number): [number, number, number] {
  const base = state.ambient.map((a) => 1 - state.darkness + state.darkness * a) as [number, number, number];
  const out: [number, number, number] = [...base];
  for (const l of lights) {
    const d = Math.hypot(x - l.x, y - l.y);
    if (d >= l.radius) continue;
    const k = Math.pow(1 - d / l.radius, l.falloff) * l.intensity;
    for (let i = 0; i < 3; i++) out[i] = out[i]! + l.color[i]! * k;
  }
  return out.map((v) => Math.min(1, v)) as [number, number, number];
}
