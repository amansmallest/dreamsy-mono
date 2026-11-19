export const PAPER = 0;
export const INK = 1;
export const TINT = 2;
export const CLEAR = 255;

export type RGB = [number, number, number];

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

const BAYER8 = (() => {
  const m = new Uint8Array(64);
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) {
      const q = BAYER4[(y & 3) * 4 + (x & 3)]!;
      const k = ((y >> 2) << 1) | (x >> 2);
      m[y * 8 + x] = q * 4 + [0, 2, 3, 1][k]!;
    }
  return m;
})();

export const bayer4 = (x: number, y: number) => BAYER4[(y & 3) * 4 + (x & 3)]!;
export const bayer8 = (x: number, y: number) => BAYER8[(y & 7) * 8 + (x & 7)]!;
export const shade = (x: number, y: number, level: number) => bayer4(x, y) < level;

export type Mode = "ink" | "paper" | "xor";

export class Surface {
  px: Uint8Array;
  private image?: ImageData;

  constructor(public w: number, public h: number, fill = PAPER) {
    this.px = new Uint8Array(w * h).fill(fill);
  }

  clear(v = PAPER) {
    this.px.fill(v);
  }

  get(x: number, y: number) {
    x |= 0;
    y |= 0;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return CLEAR;
    return this.px[y * this.w + x]!;
  }

  set(x: number, y: number, v: number) {
    x |= 0;
    y |= 0;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.px[y * this.w + x] = v;
  }

  plot(x: number, y: number, mode: Mode) {
    if (mode === "xor") {
      const v = this.get(x, y);
      if (v !== CLEAR) this.set(x, y, v === INK ? PAPER : INK);
    } else this.set(x, y, mode === "ink" ? INK : PAPER);
  }

  rect(x: number, y: number, w: number, h: number, v = INK) {
    const x0 = Math.max(0, x | 0), y0 = Math.max(0, y | 0);
    const x1 = Math.min(this.w, (x + w) | 0), y1 = Math.min(this.h, (y + h) | 0);
    for (let j = y0; j < y1; j++) this.px.fill(v, j * this.w + x0, j * this.w + Math.max(x0, x1));
  }

  dither(x: number, y: number, w: number, h: number, level: number, v = INK) {
    const x0 = Math.max(0, x | 0), y0 = Math.max(0, y | 0);
    const x1 = Math.min(this.w, (x + w) | 0), y1 = Math.min(this.h, (y + h) | 0);
    for (let j = y0; j < y1; j++) for (let i = x0; i < x1; i++) if (shade(i, j, level)) this.px[j * this.w + i] = v;
  }

  frame(x: number, y: number, w: number, h: number, v = INK) {
    this.rect(x, y, w, 1, v);
    this.rect(x, y + h - 1, w, 1, v);
    this.rect(x, y, 1, h, v);
    this.rect(x + w - 1, y, 1, h, v);
  }

  line(x0: number, y0: number, x1: number, y1: number, v = INK) {
    x0 |= 0; y0 |= 0; x1 |= 0; y1 |= 0;
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.set(x0, y0, v);
      if (x0 === x1 && y0 === y1) return;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }

  disc(cx: number, cy: number, r: number, level = 16, v = INK) {
    const r2 = r * r;
    for (let j = Math.floor(cy - r); j <= cy + r; j++)
      for (let i = Math.floor(cx - r); i <= cx + r; i++) {
        const dx = i - cx + 0.5, dy = j - cy + 0.5;
        if (dx * dx + dy * dy <= r2 && shade(i, j, level)) this.set(i, j, v);
      }
  }

  ring(cx: number, cy: number, r: number, v = INK) {
    const r2o = r * r, r2i = (r - 1.2) * (r - 1.2);
    for (let j = Math.floor(cy - r); j <= cy + r; j++)
      for (let i = Math.floor(cx - r); i <= cx + r; i++) {
        const dx = i - cx + 0.5, dy = j - cy + 0.5, d = dx * dx + dy * dy;
        if (d <= r2o && d > r2i) this.set(i, j, v);
      }
  }

  poly(pts: [number, number][], level = 16, v = INK) {
    let minY = Infinity, maxY = -Infinity;
    for (const [, y] of pts) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    for (let y = Math.floor(minY); y <= maxY; y++) {
      const xs: number[] = [];
      for (let i = 0; i < pts.length; i++) {
        const [ax, ay] = pts[i]!, [bx, by] = pts[(i + 1) % pts.length]!;
        const yc = y + 0.5;
        if ((ay <= yc && by > yc) || (by <= yc && ay > yc)) xs.push(ax + ((yc - ay) / (by - ay)) * (bx - ax));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2)
        for (let x = Math.round(xs[k]!); x < Math.round(xs[k + 1]!); x++) if (shade(x, y, level)) this.set(x, y, v);
    }
  }

  outline(pts: [number, number][], v = INK) {
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i]!, [bx, by] = pts[(i + 1) % pts.length]!;
      this.line(ax, ay, bx, by, v);
    }
  }

  draw(other: Surface, ox: number, oy: number, map?: Record<number, number>) {
    for (let j = 0; j < other.h; j++)
      for (let i = 0; i < other.w; i++) {
        const v = other.px[j * other.w + i]!;
        if (v !== CLEAR) this.set(ox + i, oy + j, map?.[v] ?? v);
      }
  }

  blit(ctx: CanvasRenderingContext2D, palette: (RGB | null)[]) {
    if (!this.image || this.image.width !== this.w || this.image.height !== this.h) this.image = ctx.createImageData(this.w, this.h);
    const d = this.image.data;
    for (let i = 0, n = this.px.length; i < n; i++) {
      const c = palette[this.px[i]!] ?? null, o = i * 4;
      if (c) { d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255; }
      else d[o + 3] = 0;
    }
    ctx.putImageData(this.image, 0, 0);
  }
}

export function dissolve(out: Surface, from: Surface, to: Surface, p: number) {
  const t = p * 64;
  for (let y = 0; y < out.h; y++)
    for (let x = 0; x < out.w; x++) {
      const i = y * out.w + x;
      out.px[i] = bayer8(x, y) < t ? to.px[i]! : from.px[i]!;
    }
}
