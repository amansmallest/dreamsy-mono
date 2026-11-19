type Wave = "square" | "saw" | "triangle" | "sine" | "noise";

export interface Channel {
  wave: Wave;
  volume: number;
  duty: number;
  notes: string[];
}

export interface Song {
  bpm: number;
  steps: number;
  loop: boolean;
  order: number[];
  channels: Channel[];
}

export interface Sfx {
  wave: Wave;
  attack: number;
  sustain: number;
  decay: number;
  freq: number;
  slide: number;
  vibrato: number;
  vibrato_speed: number;
  duty: number;
  volume: number;
}

const NOTE = /^([A-G])([#b]?)([0-8])$/;
const SEMI: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const WAVES = new Set(["square", "saw", "triangle", "sine", "noise"]);

export function noteFreq(note: string): number | null {
  const m = NOTE.exec(note);
  if (!m) return null;
  const semis = SEMI[m[1]!]! + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0) + 12 * (Number(m[3]) + 1);
  return 440 * 2 ** ((semis - 69) / 12);
}

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const wave = (v: unknown): Wave => (typeof v === "string" && WAVES.has(v) ? (v as Wave) : "square");

export function parseSong(text: string): Song {
  const raw = JSON.parse(text) as Record<string, unknown>;
  const steps = Math.max(1, Math.floor(num(raw.steps, 16)));
  const channels = (Array.isArray(raw.channels) ? raw.channels : []).slice(0, 4).map((c: Record<string, unknown>) => ({
    wave: wave(c.wave),
    volume: num(c.volume, 0.4),
    duty: num(c.duty, 0.5),
    notes: typeof c.notes === "string" ? c.notes.trim().split(/\s+/).filter(Boolean) : Array.isArray(c.notes) ? (c.notes as string[]) : [],
  }));
  if (!channels.length) throw new Error("song has no channels");
  const patterns = Math.max(1, Math.min(...channels.map((c) => Math.floor(c.notes.length / steps))));
  const order = Array.isArray(raw.order) && raw.order.length ? (raw.order as number[]).filter((p) => p < patterns) : Array.from({ length: patterns }, (_, i) => i);
  return { bpm: Math.min(240, Math.max(40, num(raw.bpm, 120))), steps, loop: raw.loop !== false, order, channels };
}

export function parseSfx(text: string): Sfx {
  const r = JSON.parse(text) as Record<string, unknown>;
  return {
    wave: wave(r.wave),
    attack: num(r.attack, 0),
    sustain: num(r.sustain, 0.1),
    decay: num(r.decay, 0.2),
    freq: num(r.freq, 440),
    slide: num(r.slide, 0),
    vibrato: num(r.vibrato, 0),
    vibrato_speed: num(r.vibrato_speed, 6),
    duty: num(r.duty, 0.5),
    volume: num(r.volume, 0.5),
  };
}

export interface NoteEvent {
  ch: number;
  step: number;
  len: number;
  freq: number;
  note: string;
}

export function compile(song: Song) {
  const events: NoteEvent[] = [];
  song.channels.forEach((c, ch) => {
    let cur: NoteEvent | null = null;
    let step = 0;
    for (const p of song.order) {
      for (let i = 0; i < song.steps; i++, step++) {
        const tok = c.notes[p * song.steps + i] ?? ".";
        if (tok === "-") {
          if (cur) cur.len++;
          continue;
        }
        cur = null;
        if (tok === ".") continue;
        const f = noteFreq(tok);
        if (f) {
          cur = { ch, step, len: 1, freq: f, note: tok };
          events.push(cur);
        }
      }
    }
  });
  events.sort((a, b) => a.step - b.step || a.ch - b.ch);
  const totalSteps = song.order.length * song.steps;
  const stepDur = 60 / song.bpm / 4;
  return { events, totalSteps, stepDur, seconds: totalSteps * stepDur };
}

const LEVEL: Record<Wave, number> = { square: 0.5, saw: 0.45, triangle: 0.9, sine: 0.9, noise: 0.7 };
const pulses = new WeakMap<BaseAudioContext, Map<number, PeriodicWave>>();
const noises = new WeakMap<BaseAudioContext, AudioBuffer>();

function pulseWave(ctx: BaseAudioContext, duty: number) {
  let m = pulses.get(ctx);
  if (!m) pulses.set(ctx, (m = new Map()));
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

function noiseBuffer(ctx: BaseAudioContext) {
  let b = noises.get(ctx);
  if (!b) {
    b = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = b.getChannelData(0);
    let seed = 22222;
    for (let i = 0; i < d.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      d[i] = seed / 0x3fffffff - 1;
    }
    noises.set(ctx, b);
  }
  return b;
}

function source(ctx: BaseAudioContext, w: Wave, duty: number) {
  if (w === "noise") {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx);
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 0.7;
    src.connect(lp);
    return { node: lp as AudioNode, freq: lp.frequency, start: (t: number) => src.start(t, Math.random() * 0.5), stop: (t: number) => src.stop(t) };
  }
  const osc = ctx.createOscillator();
  if (w === "square") osc.setPeriodicWave(pulseWave(ctx, duty));
  else osc.type = w === "saw" ? "sawtooth" : w;
  return { node: osc as AudioNode, freq: osc.frequency, start: (t: number) => osc.start(t), stop: (t: number) => osc.stop(t) };
}

function scheduleNote(ctx: BaseAudioContext, dest: AudioNode, c: Channel, freq: number, t: number, dur: number) {
  const vol = c.volume * LEVEL[c.wave] * 0.6;
  const env = ctx.createGain();
  const rel = Math.min(0.04, dur * 0.3);
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(vol, t + 0.004);
  env.gain.setValueAtTime(vol, t + Math.max(0.005, dur - rel));
  env.gain.linearRampToValueAtTime(0, t + dur);
  env.connect(dest);
  const src = source(ctx, c.wave, c.duty);
  src.freq.setValueAtTime(c.wave === "noise" ? Math.min(18000, freq * 4) : freq, t);
  src.node.connect(env);
  src.start(t);
  src.stop(t + dur + 0.02);
}

export function scheduleSfx(ctx: BaseAudioContext, dest: AudioNode, s: Sfx, t0: number) {
  const dur = s.attack + s.sustain + s.decay;
  if (dur <= 0) return;
  const vol = s.volume * LEVEL[s.wave];
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, t0);
  if (s.attack > 0) env.gain.linearRampToValueAtTime(vol, t0 + s.attack);
  else env.gain.setValueAtTime(vol, t0);
  env.gain.setValueAtTime(vol, t0 + s.attack + s.sustain);
  env.gain.linearRampToValueAtTime(0, t0 + dur);
  env.connect(dest);
  const src = source(ctx, s.wave, s.duty);
  src.node.connect(env);
  const f0 = Math.min(20000, Math.max(10, s.freq));
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

const LOOKAHEAD = 0.25;

export class ChipPlayer {
  private ctx: AudioContext | null = null;
  private bus: GainNode | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private track: { song: Song; compiled: ReturnType<typeof compile>; origin: number; scheduledTo: number; gain: GainNode } | null = null;

  private audio() {
    if (!this.ctx) {
      const AC: typeof AudioContext = (window as unknown as { AudioContext: typeof AudioContext; webkitAudioContext: typeof AudioContext }).AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AC();
      this.bus = this.ctx.createGain();
      this.bus.gain.value = 0.6;
      this.bus.connect(this.ctx.destination);
    }
    if (this.ctx.state !== "running") void this.ctx.resume();
    return this.ctx;
  }

  get position(): number | null {
    if (!this.track || !this.ctx) return null;
    const { compiled, origin, song } = this.track;
    const t = this.ctx.currentTime - origin;
    if (t < 0) return 0;
    if (!song.loop && t > compiled.seconds) return null;
    return (t % compiled.seconds) / compiled.seconds;
  }

  play(song: Song, onEnd?: () => void) {
    const ctx = this.audio();
    this.stop();
    const compiled = compile(song);
    if (compiled.seconds <= 0) return;
    const gain = ctx.createGain();
    gain.connect(this.bus!);
    const origin = ctx.currentTime + 0.06;
    this.track = { song, compiled, origin, scheduledTo: origin, gain };
    this.timer = setInterval(() => {
      const t = this.track;
      if (!t || !this.ctx) return;
      const now = this.ctx.currentTime;
      const end = t.song.loop ? Infinity : t.origin + t.compiled.seconds;
      if (now > end + 0.1) {
        this.stop();
        onEnd?.();
        return;
      }
      const until = Math.min(now + LOOKAHEAD, end);
      if (until <= t.scheduledTo) return;
      const len = t.compiled.seconds;
      for (let k = Math.max(0, Math.floor((t.scheduledTo - t.origin) / len)); ; k++) {
        const base = t.origin + k * len;
        if (base >= until || (!t.song.loop && k > 0)) break;
        for (const ev of t.compiled.events) {
          const at = base + ev.step * t.compiled.stepDur;
          if (at < t.scheduledTo) continue;
          if (at >= until) break;
          scheduleNote(this.ctx, t.gain, t.song.channels[ev.ch]!, ev.freq, at, ev.len * t.compiled.stepDur);
        }
      }
      t.scheduledTo = until;
    }, 25);
  }

  playSfx(s: Sfx) {
    const ctx = this.audio();
    scheduleSfx(ctx, this.bus!, s, ctx.currentTime + 0.01);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.track && this.ctx) {
      const g = this.track.gain;
      g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.02);
      setTimeout(() => g.disconnect(), 200);
    }
    this.track = null;
  }

  dispose() {
    this.stop();
    void this.ctx?.close();
    this.ctx = null;
  }
}
