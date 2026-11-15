// Remote avatar smoothing: server-timestamped samples, rendered LIMITS.interpDelayMs in the past (DOM-free).

/**
 * Estimates server time from local time. Each sample's (serverTs - localRecv) is the clock offset minus the
 * one-way delay; the largest recent value is the least-delayed sample, so we track the max over a 5 s window.
 */
export class ClockSync {
  private samples: { at: number; v: number }[] = [];
  private offset: number | null = null;

  observe(serverTs: number, localNow: number) {
    const v = serverTs - localNow;
    this.samples.push({ at: localNow, v });
    while (this.samples.length > 1 && (this.samples[0]!.at < localNow - 5000 || this.samples.length > 128)) this.samples.shift();
    let m = -Infinity;
    for (const s of this.samples) if (s.v > m) m = s.v;
    this.offset = m;
  }

  get ready(): boolean { return this.offset !== null; }

  serverNow(localNow: number): number { return localNow + (this.offset ?? 0); }
}

export interface Sample { ts: number; x: number; y: number; rot: number }
export interface Interpolated<T> { x: number; y: number; rot: number; data: T }

/** Per remote avatar: last ~2 s of samples; `at(t)` interpolates position/rotation and returns the older sample's discrete data. */
export class SnapshotBuffer<T> {
  private buf: (Sample & { data: T })[] = [];

  push(s: Sample, data: T) {
    // out-of-order (shouldn't happen on one socket): drop
    const last = this.buf[this.buf.length - 1];
    if (last && s.ts <= last.ts) {
      if (s.ts === last.ts) this.buf[this.buf.length - 1] = { ...s, data };
      return;
    }
    this.buf.push({ ...s, data });
    if (this.buf.length > 40) this.buf.shift();
  }

  get size(): number { return this.buf.length; }
  get latest(): (Sample & { data: T }) | undefined { return this.buf[this.buf.length - 1]; }

  /** State at server time t. Before the first sample: the first; after the last: extrapolated ≤ 150 ms, then held. */
  at(t: number): Interpolated<T> | null {
    const b = this.buf;
    if (!b.length) return null;
    if (t <= b[0]!.ts) return { x: b[0]!.x, y: b[0]!.y, rot: b[0]!.rot, data: b[0]!.data };
    for (let i = b.length - 1; i > 0; i--) {
      const a = b[i - 1]!, c = b[i]!;
      if (t >= a.ts && t <= c.ts) {
        const k = (t - a.ts) / Math.max(1, c.ts - a.ts);
        // discontinuities (respawn/teleport > 400 px between samples): snap
        if (Math.hypot(c.x - a.x, c.y - a.y) > 400) return { x: c.x, y: c.y, rot: c.rot, data: c.data };
        return { x: a.x + (c.x - a.x) * k, y: a.y + (c.y - a.y) * k, rot: lerpAngle(a.rot, c.rot, k), data: k < 1 ? a.data : c.data };
      }
    }
    const last = b[b.length - 1]!, prev = b[b.length - 2];
    if (!prev) return { x: last.x, y: last.y, rot: last.rot, data: last.data };
    const ahead = Math.min(t - last.ts, 150);
    const dt = Math.max(1, last.ts - prev.ts);
    if (Math.hypot(last.x - prev.x, last.y - prev.y) > 400 || dt > 500) return { x: last.x, y: last.y, rot: last.rot, data: last.data };
    return { x: last.x + ((last.x - prev.x) / dt) * ahead, y: last.y + ((last.y - prev.y) / dt) * ahead, rot: last.rot, data: last.data };
  }
}

/** Degrees, shortest way round. */
export function lerpAngle(a: number, b: number, k: number): number {
  const d = ((b - a) % 360 + 540) % 360 - 180;
  return a + d * k;
}
