/**
 * Sprite animation sets — data/anims/<name>.json, attached to a Sprite2D via its `anims` prop:
 *
 *   { "run":  { "frames": ["asset:fox_run_1", "asset:fox_run_2"], "fps": 10, "loop": true },
 *     "jump": { "frames": ["asset:fox_jump"], "loop": false, "next": "idle" } }
 *
 * Shared by the validator and the engine (core advances frames deterministically per tick).
 */
import { z } from "zod";

export const ANIMS_PATH_RE = /^data\/anims\/[a-z][a-z0-9_]*\.json$/;
export const ANIM_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
export const MAX_ANIMS = 64;
export const MAX_ANIM_FRAMES = 128;

export const Anim = z.strictObject({
  /** Image assets, "asset:<id>", shown in order. */
  frames: z.array(z.string().regex(/^asset:[a-z][a-z0-9_]{0,63}$/, 'frames are "asset:<id>" image refs')).min(1).max(MAX_ANIM_FRAMES),
  /** Frames per second. */
  fps: z.number().min(0.5).max(60).default(10),
  /** Loop forever (default) or stop on the last frame. */
  loop: z.boolean().default(true),
  /** Non-looping only: animation to switch to when this one finishes (e.g. "idle"). */
  next: z.string().regex(ANIM_NAME_RE).optional(),
});
export type Anim = z.infer<typeof Anim>;
export type AnimSet = Record<string, Anim>;

export interface AnimsParse { value?: AnimSet; errors: string[] }

export function parseAnims(text: string): AnimsParse {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { return { errors: [`not valid JSON: ${(e as Error).message}`] }; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { errors: ['expected an object of animations, e.g. { "run": { "frames": ["asset:a", "asset:b"], "fps": 10 } }'] };
  const errors: string[] = [];
  const out: AnimSet = {};
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) errors.push("no animations defined");
  if (entries.length > MAX_ANIMS) errors.push(`at most ${MAX_ANIMS} animations`);
  for (const [name, def] of entries) {
    if (!ANIM_NAME_RE.test(name)) { errors.push(`animation name "${name}" must be lowercase_snake`); continue; }
    const r = Anim.safeParse(def);
    if (!r.success) { errors.push(`"${name}": ${r.error.issues.map((i) => `${i.path.join(".") || "(anim)"}: ${i.message}`).join("; ")}`); continue; }
    out[name] = r.data;
  }
  for (const [name, a] of Object.entries(out)) {
    if (a.next && !out[a.next]) errors.push(`"${name}".next: no animation "${a.next}"`);
  }
  return { value: out, errors };
}
