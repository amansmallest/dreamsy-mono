// Tweens: animate entity props over time (deterministic, advanced by the fixed tick).
import type { Entity } from "./world.js";

const PI = Math.PI;
const c1 = 1.70158, c2 = c1 * 1.525, c3 = c1 + 1;

function bounceOut(t: number): number {
  const n1 = 7.5625, d1 = 2.75;
  if (t < 1 / d1) return n1 * t * t;
  if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
  if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
  return n1 * (t -= 2.625 / d1) * t + 0.984375;
}

/** Standard easings (easings.net). t in 0..1 → progress (back/elastic overshoot). */
export const EASINGS: Record<string, (t: number) => number> = {
  linear: (t) => t,
  quad_in: (t) => t * t,
  quad_out: (t) => 1 - (1 - t) * (1 - t),
  quad_in_out: (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2),
  cubic_in: (t) => t * t * t,
  cubic_out: (t) => 1 - (1 - t) ** 3,
  cubic_in_out: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  sine_in: (t) => 1 - Math.cos((t * PI) / 2),
  sine_out: (t) => Math.sin((t * PI) / 2),
  sine_in_out: (t) => -(Math.cos(PI * t) - 1) / 2,
  expo_in: (t) => (t === 0 ? 0 : 2 ** (10 * t - 10)),
  expo_out: (t) => (t === 1 ? 1 : 1 - 2 ** (-10 * t)),
  back_in: (t) => c3 * t * t * t - c1 * t * t,
  back_out: (t) => 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2,
  back_in_out: (t) => (t < 0.5 ? ((2 * t) ** 2 * ((c2 + 1) * 2 * t - c2)) / 2 : ((2 * t - 2) ** 2 * ((c2 + 1) * (t * 2 - 2) + c2) + 2) / 2),
  elastic_out: (t) => (t === 0 || t === 1 ? t : 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * ((2 * PI) / 3)) + 1),
  bounce_out: bounceOut,
};
export const EASING_NAMES = Object.keys(EASINGS);
export const DEFAULT_EASING = "quad_out";

export interface TweenTrack { key: string; from: number[]; to: number[]; kind: "number" | "vec2" | "color" }

export interface TweenRec {
  id: number;
  e: Entity;
  tracks: TweenTrack[];
  duration: number;
  delay: number;
  /** Seconds since creation. */
  t: number;
  ease: (t: number) => number;
  loop: boolean;
  yoyo: boolean;
}

/** Value at eased progress k for a track (colors clamp, others may overshoot). */
export function trackValue(tr: TweenTrack, k: number): unknown {
  const out = tr.from.map((f, i) => f + (tr.to[i]! - f) * k);
  if (tr.kind === "number") return out[0];
  if (tr.kind === "color") return out.map((x) => Math.max(0, Math.min(1, x)));
  return out;
}

/** Progress of a tween at its current time: [eased k, finished]. */
export function tweenProgress(tw: TweenRec): [number, boolean] {
  const local = tw.t - tw.delay;
  if (local < 0) return [-1, false];
  const d = Math.max(1e-6, tw.duration);
  if (!tw.loop) {
    if (!tw.yoyo) { const p = Math.min(1, local / d); return [p >= 1 ? 1 : tw.ease(p), p >= 1]; }
    // yoyo once: there (duration) and back (duration)
    const p = Math.min(1, local / (2 * d));
    return [p >= 1 ? 0 : tw.ease(p < 0.5 ? p * 2 : (1 - p) * 2), p >= 1];
  }
  const cycle = tw.yoyo ? 2 * d : d;
  const ph = local % cycle;
  const p = tw.yoyo ? (ph < d ? ph / d : 2 - ph / d) : ph / d;
  return [tw.ease(p), false];
}
