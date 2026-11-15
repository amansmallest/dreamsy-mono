// Web Audio for data/sfx (sfxr-style synth) and data/music (chiptune sequencer, ≤ 4 channels).
// The core records sfx.play / music.play into game.audioQueue; AudioEngine.update() drains it each frame.
// iOS Safari: the AudioContext only starts inside a user gesture, so we resume it on the first
// pointer/key/touch event (sfx requested before that are dropped; the current song starts on unlock).
import { noteFreq, songOrder, type Music, type Sfx, type Wave } from "@dreamsy/format";
import type { Game } from "../core/index.js";

const MASTER = 0.6;
const LOOKAHEAD = 0.2; // seconds of music scheduled ahead
const TICK_MS = 25;

// ---------------------------------------------------------------- synthesis (works on any BaseAudioContext)

const pulseCache = new WeakMap<BaseAudioContext, Map<number, PeriodicWave>>();
/** Band-limited pulse wave with the given duty cycle. */
function pulseWave(ctx: BaseAudioContext, duty: number): PeriodicWave {
  let m = pulseCache.get(ctx);
  if (!m) pulseCache.set(ctx, (m = new Map()));
  const key = Math.round(duty * 100) / 100;
  let w = m.get(key);
  if (!w) {
    const N = 64, re = new Float32Array(N), im = new Float32Array(N);
    for (let n = 1; n < N; n++) {
      const a = (2 / (n * Math.PI)) * Math.sin(Math.PI * n * key);
      re[n] = a * Math.cos(Math.PI * n * key);
      im[n] = a * Math.sin(Math.PI * n * key);
    }
    w = ctx.createPeriodicWave(re, im);
    m.set(key, w);
  }
  return w;
}

const noiseCache = new WeakMap<BaseAudioContext, AudioBuffer>();
function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  let b = noiseCache.get(ctx);
  if (!b) {
    b = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = b.getChannelData(0);
    let seed = 22222;
    for (let i = 0; i < d.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; d[i] = (seed / 0x3fffffff) - 1; }
    noiseCache.set(ctx, b);
  }
  return b;
}

/** An oscillator-like source whose `freq` param sets pitch (noise: low-pass cutoff). */
function source(ctx: BaseAudioContext, wave: Wave, duty: number): { node: AudioNode; freq: AudioParam; start(t: number): void; stop(t: number): void } {
  if (wave === "noise") {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx);
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 0.7;
    src.connect(lp);
    return { node: lp, freq: lp.frequency, start: (t) => src.start(t, Math.random() * 0.5), stop: (t) => src.stop(t) };
  }
  const osc = ctx.createOscillator();
  if (wave === "square") osc.setPeriodicWave(pulseWave(ctx, duty));
  else osc.type = wave === "saw" ? "sawtooth" : wave;
  return { node: osc, freq: osc.frequency, start: (t) => osc.start(t), stop: (t) => osc.stop(t) };
}

const LEVEL: Record<Wave, number> = { square: 0.5, saw: 0.45, triangle: 0.9, sine: 0.9, noise: 0.7 };

/** Schedule one sound effect at time t0. */
export function scheduleSfx(ctx: BaseAudioContext, dest: AudioNode, s: Sfx, t0: number, volume = 1, pitch = 1) {
  const dur = s.attack + s.sustain + s.decay;
  if (dur <= 0) return;
  const vol = s.volume * volume * LEVEL[s.wave];
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, t0);
  if (s.attack > 0) env.gain.linearRampToValueAtTime(vol, t0 + s.attack);
  else env.gain.setValueAtTime(vol, t0);
  env.gain.setValueAtTime(vol, t0 + s.attack + s.sustain);
  env.gain.linearRampToValueAtTime(0, t0 + dur);
  env.connect(dest);
  const src = source(ctx, s.wave, s.duty);
  src.node.connect(env);
  const f0 = Math.min(20000, Math.max(10, s.freq * pitch));
  src.freq.setValueAtTime(f0, t0);
  if (s.slide !== 0) src.freq.exponentialRampToValueAtTime(Math.min(20000, Math.max(10, f0 * 2 ** s.slide)), t0 + dur);
  if (s.vibrato > 0 && s.vibrato_speed > 0) {
    const lfo = ctx.createOscillator();
    lfo.frequency.value = s.vibrato_speed;
    const depth = ctx.createGain();
    depth.gain.value = f0 * (2 ** (s.vibrato / 12) - 1);
    lfo.connect(depth).connect(src.freq);
    lfo.start(t0);
    lfo.stop(t0 + dur + 0.05);
  }
  src.start(t0);
  src.stop(t0 + dur + 0.05);
}

export interface NoteEvent { ch: number; step: number; len: number; freq: number }
export interface CompiledSong { events: NoteEvent[]; totalSteps: number; stepDur: number; song: Music }

/** Flatten patterns/order into note events (start step, length in steps), sorted by start. */
export function compileSong(m: Music): CompiledSong {
  const order = songOrder(m);
  const events: NoteEvent[] = [];
  m.channels.forEach((c, ch) => {
    let cur: NoteEvent | null = null;
    let step = 0;
    for (const p of order) {
      for (let i = 0; i < m.steps; i++, step++) {
        const tok = c.notes[p * m.steps + i] ?? ".";
        if (tok === "-") { if (cur) cur.len++; continue; }
        cur = null;
        if (tok === ".") continue;
        const f = noteFreq(tok);
        if (f) { cur = { ch, step, len: 1, freq: f }; events.push(cur); }
      }
    }
  });
  events.sort((a, b) => a.step - b.step || a.ch - b.ch);
  return { events, totalSteps: order.length * m.steps, stepDur: 60 / m.bpm / 4, song: m };
}

function scheduleNote(ctx: BaseAudioContext, dest: AudioNode, song: Music, ev: NoteEvent, t: number, dur: number) {
  const c = song.channels[ev.ch]!;
  const vol = c.volume * LEVEL[c.wave] * 0.6;
  const env = ctx.createGain();
  const rel = Math.min(0.04, dur * 0.3);
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(vol, t + 0.004);
  env.gain.setValueAtTime(vol, t + Math.max(0.005, dur - rel));
  env.gain.linearRampToValueAtTime(0, t + dur);
  env.connect(dest);
  const src = source(ctx, c.wave, c.duty);
  src.freq.setValueAtTime(c.wave === "noise" ? Math.min(18000, ev.freq * 4) : ev.freq, t);
  src.node.connect(env);
  src.start(t);
  src.stop(t + dur + 0.02);
}

/** Schedule every note that starts in [from, to) for a song that began at `origin` (looping if set). */
export function scheduleSongRange(ctx: BaseAudioContext, dest: AudioNode, s: CompiledSong, origin: number, from: number, to: number) {
  const loopLen = s.totalSteps * s.stepDur;
  if (loopLen <= 0) return;
  let k = Math.max(0, Math.floor((from - origin) / loopLen));
  for (;; k++) {
    const base = origin + k * loopLen;
    if (base >= to || (!s.song.loop && k > 0)) break;
    for (const ev of s.events) {
      const t = base + ev.step * s.stepDur;
      if (t < from) continue;
      if (t >= to) break;
      scheduleNote(ctx, dest, s.song, ev, t, ev.len * s.stepDur);
    }
  }
}

// ---------------------------------------------------------------- live engine

interface Track { id: string; song: CompiledSong; gain: GainNode; origin: number; scheduledTo: number; endAt: number | null }

export class AudioEngine {
  ctx: AudioContext | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private duck: GainNode | null = null;
  private track: Track | null = null;
  private fading: Track[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private wanted: { id: string; fade: number } | null = null;
  private paused = false;
  private gestures = ["pointerdown", "keydown", "touchend", "mousedown"];

  constructor(private game: Game) {
    for (const g of this.gestures) window.addEventListener(g, this.unlock, { capture: true });
  }

  get running(): boolean { return this.ctx?.state === "running"; }

  /** Must run inside a user gesture on iOS. */
  unlock = () => {
    try {
      if (!this.ctx) {
        const AC: typeof AudioContext | undefined = (window as any).AudioContext ?? (window as any).webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
        this.duck = this.ctx.createGain();
        this.duck.connect(this.ctx.destination);
        this.sfxBus = this.ctx.createGain();
        this.musicBus = this.ctx.createGain();
        this.sfxBus.connect(this.duck);
        this.musicBus.connect(this.duck);
        this.applyVolumes();
        this.timer = setInterval(() => this.pump(), TICK_MS);
      }
      if (this.ctx.state !== "running") {
        void this.ctx.resume();
        const b = this.ctx.createBuffer(1, 1, 22050); // silent blip completes the iOS unlock
        const s = this.ctx.createBufferSource();
        s.buffer = b;
        s.connect(this.ctx.destination);
        s.start(0);
      }
    } catch (e) {
      console.warn("[dreamsy] audio unavailable", e);
    }
  };

  applyVolumes() {
    if (!this.ctx) return;
    const st = this.game.settings, now = this.ctx.currentTime;
    this.sfxBus!.gain.setTargetAtTime(st.mute ? 0 : st.sfx * MASTER, now, 0.02);
    this.musicBus!.gain.setTargetAtTime(st.mute ? 0 : st.music * MASTER, now, 0.05);
  }

  /** While the platform menu is open: music ducks, sfx stop. */
  setPaused(p: boolean) {
    this.paused = p;
    if (this.ctx) this.duck!.gain.setTargetAtTime(p ? 0.25 : 1, this.ctx.currentTime, 0.08);
  }

  /** Call once per frame: drain the game's audio events. */
  update() {
    const q = this.game.audioQueue;
    if (q.length) {
      this.game.audioQueue = [];
      for (const ev of q) {
        if (ev.kind === "sfx") {
          if (!this.running || this.paused) continue;
          try { scheduleSfx(this.ctx!, this.sfxBus!, this.game.sfxData(ev.id), this.ctx!.currentTime + 0.005, ev.volume, ev.pitch); } catch { /* reported by core */ }
        } else if (ev.kind === "music") this.wanted = { id: ev.id, fade: ev.fade };
        else { this.wanted = null; this.stopTrack(ev.fade); }
      }
    }
    if (this.running) {
      if (this.wanted && this.wanted.id !== this.track?.id) this.startTrack(this.wanted.id, this.wanted.fade);
      this.pump();
    }
  }

  private startTrack(id: string, fade: number) {
    const ctx = this.ctx!;
    let song: CompiledSong;
    try { song = compileSong(this.game.musicData(id)); } catch { this.wanted = null; return; }
    this.stopTrack(Math.max(fade, 0.05));
    const gain = ctx.createGain();
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(fade > 0 ? 0 : 1, now);
    if (fade > 0) gain.gain.linearRampToValueAtTime(1, now + fade);
    gain.connect(this.musicBus!);
    const origin = now + 0.05;
    this.track = { id, song, gain, origin, scheduledTo: origin, endAt: song.song.loop ? null : origin + song.totalSteps * song.stepDur };
  }

  private stopTrack(fade: number) {
    const t = this.track;
    if (!t || !this.ctx) { this.track = null; return; }
    const now = this.ctx.currentTime;
    t.gain.gain.cancelScheduledValues(now);
    t.gain.gain.setValueAtTime(t.gain.gain.value, now);
    t.gain.gain.linearRampToValueAtTime(0, now + Math.max(0.03, fade));
    t.endAt = now + Math.max(0.03, fade);
    this.fading.push(t);
    this.track = null;
  }

  /** Lookahead scheduler (also runs from a timer so music keeps going between frames). */
  private pump() {
    if (!this.running) return;
    const now = this.ctx!.currentTime;
    for (const t of [this.track, ...this.fading]) {
      if (!t) continue;
      const until = Math.min(now + LOOKAHEAD, t.endAt ?? Infinity);
      if (until > t.scheduledTo) {
        scheduleSongRange(this.ctx!, t.gain, t.song, t.origin, t.scheduledTo, until);
        t.scheduledTo = until;
      }
    }
    this.fading = this.fading.filter((t) => {
      if (t.endAt !== null && now > t.endAt + 0.1) { t.gain.disconnect(); return false; }
      return true;
    });
  }

  dispose() {
    for (const g of this.gestures) window.removeEventListener(g, this.unlock, { capture: true });
    if (this.timer) clearInterval(this.timer);
    void this.ctx?.close();
    this.ctx = null;
  }
}

// ---------------------------------------------------------------- offline check

export interface OfflineStats { seconds: number; peak: number; rms: number; nonSilentRatio: number }

function stats(buf: AudioBuffer): OfflineStats {
  const d = buf.getChannelData(0);
  let peak = 0, sum = 0, loud = 0;
  for (let i = 0; i < d.length; i++) {
    const a = Math.abs(d[i]!);
    if (a > peak) peak = a;
    sum += a * a;
    if (a > 0.01) loud++;
  }
  return { seconds: buf.duration, peak, rms: Math.sqrt(sum / d.length), nonSilentRatio: loud / d.length };
}

/** Render a sound effect or a song (for `seconds`) without speakers; used by tests/tools. */
export async function renderOffline(what: { sfx?: Sfx; music?: Music }, seconds: number, sampleRate = 44100): Promise<OfflineStats> {
  const ctx = new OfflineAudioContext(1, Math.ceil(seconds * sampleRate), sampleRate);
  if (what.sfx) scheduleSfx(ctx, ctx.destination, what.sfx, 0);
  if (what.music) scheduleSongRange(ctx, ctx.destination, compileSong(what.music), 0, 0, seconds);
  return stats(await ctx.startRendering());
}
