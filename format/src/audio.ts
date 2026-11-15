/**
 * Synthesized audio data files (no binary assets needed):
 *  - data/sfx/<id>.json   — one sfxr-style sound effect
 *  - data/music/<id>.json — a tiny chiptune tracker song (≤ 4 channels)
 * Shared by the validator and the engine. Ranges are documented in LUAU_API.md.
 */
import { z } from "zod";

export const SFX_PATH_RE = /^data\/sfx\/[a-z][a-z0-9_]*\.json$/;
export const MUSIC_PATH_RE = /^data\/music\/[a-z][a-z0-9_]*\.json$/;
export const sfxPath = (id: string) => `data/sfx/${id}.json`;
export const musicPath = (id: string) => `data/music/${id}.json`;

export const WAVES = ["square", "saw", "triangle", "sine", "noise"] as const;
export type Wave = (typeof WAVES)[number];

const n = (min: number, max: number, d: number) => z.number().min(min).max(max).default(d);

export const Sfx = z.strictObject({
  /** Oscillator shape. noise = white noise through a low-pass at `freq`. */
  wave: z.enum(WAVES).default("square"),
  /** Seconds to reach full volume. */
  attack: n(0, 2, 0),
  /** Seconds held at full volume. */
  sustain: n(0, 2, 0.1),
  /** Seconds to fade to silence. */
  decay: n(0, 3, 0.2),
  /** Start pitch in Hz (noise: low-pass cutoff). */
  freq: n(20, 8000, 440),
  /** Pitch change over the whole sound, in octaves (-1 = falls an octave, 2 = rises two). */
  slide: n(-4, 4, 0),
  /** Vibrato depth in semitones. */
  vibrato: n(0, 12, 0),
  /** Vibrato rate in Hz. */
  vibrato_speed: n(0, 40, 6),
  /** Square wave pulse width (0.5 = classic square, 0.125 = thin/nasal). */
  duty: n(0.05, 0.95, 0.5),
  /** 0..1. */
  volume: n(0, 1, 0.5),
});
export type Sfx = z.infer<typeof Sfx>;

export const NOTE_RE = /^([A-G])([#b]?)([0-8])$/;
const BAD_NOTE = (t: string) => `bad note "${t}": use "C0".."B8" (with optional # or b), "-" (hold) or "." (rest)`;
/** Either ["C4", "-", "."] or "C4 - ." (whitespace separated). */
const Notes = z.preprocess(
  (v) => (typeof v === "string" ? v.trim().split(/\s+/).filter(Boolean) : v),
  z.array(z.string().superRefine((t, ctx) => {
    if (!(t === "-" || t === "." || NOTE_RE.test(t))) ctx.addIssue({ code: "custom", message: BAD_NOTE(t) });
  })),
);

export const MusicChannel = z.strictObject({
  wave: z.enum(WAVES).default("square"),
  volume: n(0, 1, 0.4),
  duty: n(0.05, 0.95, 0.5),
  /** `steps` tokens per pattern; several patterns back to back (pattern i = tokens i*steps..). */
  notes: Notes,
});

export const Music = z.strictObject({
  /** Quarter notes per minute; one step is a 16th note. */
  bpm: z.number().min(40).max(240).default(120),
  /** Steps per pattern (16 = one 4/4 bar). */
  steps: z.number().int().min(1).max(256).default(16),
  channels: z.array(MusicChannel).min(1).max(4),
  /** Pattern indices to play in sequence (default: every pattern once, in order). */
  order: z.array(z.number().int().min(0).max(255)).min(1).max(256).optional(),
  loop: z.boolean().default(true),
});
export type Music = z.infer<typeof Music> & { channels: (z.infer<typeof MusicChannel> & { notes: string[] })[] };

export interface AudioParse<T> { value?: T; errors: string[] }

const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);

export function parseSfx(text: string): AudioParse<Sfx> {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { return { errors: [`not valid JSON: ${(e as Error).message}`] }; }
  const r = Sfx.safeParse(raw);
  if (!r.success) return { errors: issues(r.error) };
  const s = r.data;
  if (s.attack + s.sustain + s.decay > 5) return { value: s, errors: [`attack + sustain + decay is ${(s.attack + s.sustain + s.decay).toFixed(2)}s; max 5s`] };
  if (s.attack + s.sustain + s.decay === 0) return { value: s, errors: ["the sound has zero length (set sustain or decay)"] };
  return { value: s, errors: [] };
}

export function parseMusic(text: string): AudioParse<Music> {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { return { errors: [`not valid JSON: ${(e as Error).message}`] }; }
  const r = Music.safeParse(raw);
  if (!r.success) return { errors: issues(r.error) };
  const m = r.data as Music;
  const errors: string[] = [];
  const counts = m.channels.map((c, i) => {
    if (c.notes.length === 0 || c.notes.length % m.steps !== 0) errors.push(`channels.${i}.notes: has ${c.notes.length} notes; must be a multiple of steps (${m.steps})`);
    return Math.floor(c.notes.length / m.steps);
  });
  const patterns = Math.min(...counts);
  for (const p of m.order ?? []) {
    if (p >= patterns) { errors.push(`order: pattern ${p} does not exist (every channel has ${patterns} pattern${patterns === 1 ? "" : "s"}: 0..${patterns - 1})`); break; }
  }
  const total = (m.order?.length ?? patterns) * m.steps;
  if (total > 4096) errors.push(`song is ${total} steps; max 4096`);
  return { value: m, errors };
}

/** Song step sequence: pattern index per position in the song. */
export function songOrder(m: Music): number[] {
  if (m.order) return m.order;
  const patterns = Math.min(...m.channels.map((c) => Math.floor(c.notes.length / m.steps)));
  return Array.from({ length: Math.max(1, patterns) }, (_, i) => i);
}

const SEMI: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
/** "A4" → 440. */
export function noteFreq(note: string): number | null {
  const m = NOTE_RE.exec(note);
  if (!m) return null;
  const semis = SEMI[m[1]!]! + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0) + 12 * (Number(m[3]) + 1);
  return 440 * 2 ** ((semis - 69) / 12);
}
