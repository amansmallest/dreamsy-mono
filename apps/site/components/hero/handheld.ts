import { text, textWidth } from "@/lib/pixel/font";
import type { Pad } from "@/lib/pixel/scenes";
import { CLEAR, INK, PAPER, Surface, TINT } from "@/lib/pixel/surface";

export const DEVICE_W = 200;
export const DEVICE_H = 320;
export const SCREEN_X = 20;
export const SCREEN_Y = 28;
export const SCREEN_PAPER = 3;
export const SCREEN_INK = 4;
export const ACCENT = 5;

function inRounded(x: number, y: number, x0: number, y0: number, x1: number, y1: number, r: number, rbr: number) {
  if (x < x0 || x >= x1 || y < y0 || y >= y1) return false;
  const c = (cx: number, cy: number, rad: number) => (x - cx) ** 2 + (y - cy) ** 2 <= rad * rad;
  if (x < x0 + r && y < y0 + r) return c(x0 + r, y0 + r, r);
  if (x >= x1 - r && y < y0 + r) return c(x1 - r, y0 + r, r);
  if (x < x0 + r && y >= y1 - r) return c(x0 + r, y1 - r, r);
  if (x >= x1 - rbr && y >= y1 - rbr) return c(x1 - rbr, y1 - rbr, rbr);
  return true;
}

const DPAD = { x: 42, y: 254 };
const A = { x: 164, y: 246 };
const B = { x: 136, y: 262 };

export function buildShell() {
  const s = new Surface(DEVICE_W, DEVICE_H, CLEAR);
  for (let y = 0; y < DEVICE_H; y++)
    for (let x = 0; x < DEVICE_W; x++) {
      const cx = x + 0.5, cy = y + 0.5;
      if (!inRounded(cx, cy, 2, 2, 198, 318, 12, 40)) continue;
      s.set(x, y, inRounded(cx, cy, 5, 5, 195, 315, 9, 37) ? PAPER : INK);
    }
  for (let y = 0; y < DEVICE_H; y++)
    for (let x = 184; x < 196; x++)
      if (s.get(x, y) === PAPER && (x > 189 || ((x + y) & 1) === 0)) s.set(x, y, TINT);
  s.rect(12, 12, 176, 1);
  s.rect(12, 12, 1, 3);
  s.rect(187, 12, 1, 3);
  for (let y = 0; y < DEVICE_H; y++)
    for (let x = 0; x < DEVICE_W; x++) if (inRounded(x + 0.5, y + 0.5, 14, 19, 186, 192, 6, 22)) s.set(x, y, INK);
  text(s, "1-BIT  160X144", SCREEN_X, 180, PAPER);
  s.disc(176, 182, 2.5, 16, ACCENT);
  text(s, "DREAMSY", 16, 202, INK, 2);
  text(s, "ENGINE", 16 + textWidth("DREAMSY", 2) + 5, 207);
  for (let k = 0; k < 6; k++) {
    s.line(140 + k * 7, 306, 154 + k * 7, 286);
    s.line(141 + k * 7, 306, 155 + k * 7, 286);
  }
  pill(s, 72, 292);
  pill(s, 104, 292);
  text(s, "SELECT", 81 - textWidth("SELECT") / 2, 301);
  text(s, "START", 113 - textWidth("START") / 2, 301);
  text(s, "A", A.x - 1, A.y + 14);
  text(s, "B", B.x - 1, B.y + 14);
  return s;
}

function pill(s: Surface, x: number, y: number) {
  s.rect(x + 1, y, 16, 5);
  s.rect(x, y + 1, 18, 3);
}

export function drawControls(s: Surface, p: Pad) {
  const { x, y } = DPAD;
  s.rect(x - 16, y - 5, 32, 11);
  s.rect(x - 5, y - 16, 11, 32);
  const arm = (ax: number, ay: number, w: number, h: number) => s.rect(ax, ay, w, h, TINT);
  if (p.left) arm(x - 15, y - 4, 10, 9);
  if (p.right) arm(x + 6, y - 4, 10, 9);
  if (p.up) arm(x - 4, y - 15, 9, 10);
  if (p.down) arm(x - 4, y + 6, 9, 10);
  s.disc(x + 0.5, y + 0.5, 3, 6, PAPER);
  const tri = (pts: [number, number][]) => pts.forEach(([px, py]) => s.set(px, py, PAPER));
  tri([[x - 12, y], [x - 11, y - 1], [x - 11, y], [x - 11, y + 1]]);
  tri([[x + 12, y], [x + 11, y - 1], [x + 11, y], [x + 11, y + 1]]);
  tri([[x, y - 12], [x - 1, y - 11], [x, y - 11], [x + 1, y - 11]]);
  tri([[x, y + 12], [x - 1, y + 11], [x, y + 11], [x + 1, y + 11]]);
  for (const [b, down] of [[A, p.a], [B, p.b]] as const) {
    s.disc(b.x, b.y + (down ? 1 : 0), 11, 16, INK);
    s.disc(b.x, b.y + (down ? 1 : 0), 9, 16, down ? TINT : ACCENT);
    if (!down) {
      s.set(b.x - 4, b.y - 5, PAPER);
      s.set(b.x - 5, b.y - 4, PAPER);
    }
  }
}
