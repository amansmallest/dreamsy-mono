import { text, textWidth } from "./font";
import { CAT, COIN, FLAME, FROG, HEART, HERO, SHIP, STRAWBERRY, stamp } from "./sprites";
import { INK, PAPER, shade, type Surface } from "./surface";

export const SCREEN_W = 160;
export const SCREEN_H = 144;

export interface Pad {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  a: boolean;
  b: boolean;
}

export const NO_PAD: Pad = { up: false, down: false, left: false, right: false, a: false, b: false };

export interface Scene {
  prompt: string;
  log: [string, string][];
  reset(): void;
  update(dt: number): void;
  draw(s: Surface): void;
  pad(): Pad;
}

const pad = (p: Partial<Pad>): Pad => ({ ...NO_PAD, ...p });

function rng(seed: number) {
  let x = seed >>> 0;
  return () => {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x / 4294967296;
  };
}

const score = (n: number) => String(n).padStart(4, "0");

function hud(s: Surface, left: string, right: string) {
  s.rect(0, 0, SCREEN_W, 9, PAPER);
  s.rect(0, 9, SCREEN_W, 1, INK);
  text(s, left, 3, 2);
  text(s, right, SCREEN_W - 3 - textWidth(right), 2);
}

function cloud(s: Surface, cx: number, cy: number, w: number) {
  const discs: [number, number, number][] = [
    [cx - w * 0.3, cy + 3, w * 0.24],
    [cx + w * 0.05, cy, w * 0.3],
    [cx + w * 0.32, cy + 4, w * 0.2],
  ];
  const r0 = Math.ceil(w * 0.6);
  const inside = (x: number, y: number, pad: number) =>
    discs.some(([dx, dy, r]) => (x - dx) ** 2 + (y - dy) ** 2 <= (r + pad) ** 2) && y <= cy + 6 + pad;
  for (let y = Math.floor(cy - r0); y <= cy + 8; y++)
    for (let x = Math.floor(cx - r0); x <= cx + r0; x++) {
      if (inside(x + 0.5, y + 0.5, 0)) s.set(x, y, y > cy + 3 && shade(x, y, 5) ? INK : PAPER);
      else if (inside(x + 0.5, y + 0.5, 1.2)) s.set(x, y, INK);
    }
}

function frogScene(): Scene {
  const P = 1.5, GAP = 46;
  const HEIGHTS = [0, -16, 6, -22, -6, 10, -12, 2, -18];
  const plat = (i: number) => ({ x: i * GAP + 30, y: 92 + HEIGHTS[((i % HEIGHTS.length) + HEIGHTS.length) % HEIGHTS.length]! });
  let t = 0;
  const pos = () => {
    const i = Math.floor(t / P), u = t / P - i;
    const a = plat(i), b = plat(i + 1);
    if (u < 0.3) return { i, x: a.x, y: a.y, air: false, s: 0 };
    const s = (u - 0.3) / 0.7;
    return { i, x: a.x + (b.x - a.x) * s, y: a.y + (b.y - a.y) * s - Math.sin(Math.PI * s) * 24, air: true, s };
  };
  return {
    prompt: "a frog that hops between clouds collecting strawberries",
    log: [["route", "new game"], ["kit", "platformer"], ["apply_ops", "18 ops"], ["draw_sprite", "frog, berry"], ["playtest", "0 errors"]],
    reset() { t = 0; },
    update(dt) { t += dt; },
    draw(s) {
      s.clear(PAPER);
      const cam = (t / P) * GAP - 18;
      s.disc(126, 34, 15, 5);
      s.ring(126, 34, 15);
      for (let k = 0; k < 4; k++) {
        const x = ((k * 61 - cam * 0.25) % 220 + 220) % 220 - 30;
        s.dither(x, 24 + (k % 2) * 14, 26, 3, 3);
        s.dither(x + 5, 21 + (k % 2) * 14, 14, 3, 3);
      }
      for (let x = 0; x < SCREEN_W; x++) {
        const hy = 116 + Math.sin((x + cam * 0.4) * 0.05) * 6 + Math.sin((x + cam * 0.4) * 0.13) * 2;
        for (let y = Math.floor(hy); y < SCREEN_H; y++) if (shade(x, y, y - hy < 1 ? 16 : 4)) s.set(x, y, INK);
      }
      for (let x = 0; x < SCREEN_W; x++) {
        const wy = 132 + Math.sin(x * 0.2 + t * 3) * 1.5;
        for (let y = Math.floor(wy); y < SCREEN_H; y++) s.set(x, y, shade(x, y, y - wy < 1 ? 16 : 10) ? INK : PAPER);
      }
      const f = pos();
      for (let i = Math.floor(cam / GAP) - 1; i < Math.floor(cam / GAP) + 6; i++) {
        const p = plat(i);
        cloud(s, p.x - cam, p.y + 6, 30);
        if (i % 2 === 1 && i > f.i) {
          const bob = Math.round(Math.sin(t * 4 + i) * 1.5);
          stamp(s, STRAWBERRY, p.x - cam - 4, p.y - 22 + bob);
        }
      }
      const got = Math.max(0, Math.floor((f.i + 1) / 2));
      stamp(s, FROG[f.air ? 1 : 0]!, f.x - cam - 6, f.y - 4);
      if (f.i % 2 === 1 && f.s === 0) text(s, "+10", f.x - cam - 5, f.y - 14 - (t / P - f.i) * 20);
      hud(s, "", "SCORE " + score(got * 10));
      for (let k = 0; k < 3; k++) stamp(s, HEART, 3 + k * 9, 2);
    },
    pad() {
      const f = pos();
      return pad({ right: true, a: f.air && f.s < 0.2 });
    },
  };
}

function shooterScene(): Scene {
  let t = 0, shipX = 80, vx = 0, nextShot = 0, nextRock = 0, pts = 0, fire = 0;
  let rand = rng(7);
  let stars: { x: number; y: number; v: number }[] = [];
  let shots: { x: number; y: number }[] = [];
  let rocks: { x: number; y: number; r: number; v: number }[] = [];
  let bits: { x: number; y: number; vx: number; vy: number; life: number }[] = [];
  return {
    prompt: "a tiny ship blasting through an asteroid field",
    log: [["route", "new game"], ["kit", "shooter"], ["apply_ops", "23 ops"], ["luau", "waves.luau"], ["playtest", "0 errors"]],
    reset() {
      t = 0; shipX = 80; vx = 0; nextShot = 0.4; nextRock = 0; pts = 0; fire = 0;
      rand = rng(7);
      stars = Array.from({ length: 46 }, () => ({ x: rand() * SCREEN_W, y: rand() * SCREEN_H, v: 8 + rand() * 40 }));
      shots = []; rocks = []; bits = [];
    },
    update(dt) {
      t += dt;
      for (const st of stars) { st.y += st.v * dt; if (st.y > SCREEN_H) { st.y = 10; st.x = rand() * SCREEN_W; } }
      if (t > nextRock) { rocks.push({ x: 16 + rand() * 128, y: 2, r: 4 + rand() * 5, v: 18 + rand() * 18 }); nextRock = t + 0.55 + rand() * 0.4; }
      const target = rocks.filter((r) => r.y < 100).sort((a, b) => b.y - a.y)[0];
      const want = target ? target.x : 80 + Math.sin(t) * 40;
      vx = Math.max(-90, Math.min(90, (want - shipX) * 4));
      shipX += vx * dt;
      if (t > nextShot) { shots.push({ x: shipX, y: 112 }); nextShot = t + 0.28; fire = 0.09; }
      fire -= dt;
      for (const sh of shots) sh.y -= 130 * dt;
      for (const r of rocks) r.y += r.v * dt;
      for (const sh of shots)
        for (const r of rocks)
          if (r.r > 0 && (sh.x - r.x) ** 2 + (sh.y - r.y) ** 2 < (r.r + 2) ** 2) {
            for (let k = 0; k < 10; k++) { const a = (k / 10) * Math.PI * 2; bits.push({ x: r.x, y: r.y, vx: Math.cos(a) * 40, vy: Math.sin(a) * 40, life: 0.45 }); }
            r.r = 0; sh.y = -99; pts += 25;
          }
      for (const b of bits) { b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt; }
      shots = shots.filter((s) => s.y > 8);
      rocks = rocks.filter((r) => r.r > 0 && r.y < SCREEN_H + 10);
      bits = bits.filter((b) => b.life > 0);
    },
    draw(s) {
      s.clear(INK);
      for (const st of stars) {
        s.set(st.x, st.y, PAPER);
        if (st.v > 36) s.set(st.x, st.y - 1, PAPER);
      }
      s.disc(30, 40, 12, 3, PAPER);
      for (const r of rocks) {
        s.disc(r.x, r.y, r.r + 1, 16, INK);
        s.disc(r.x, r.y, r.r, 16, PAPER);
        s.disc(r.x + r.r * 0.25, r.y + r.r * 0.25, r.r * 0.75, 8, INK);
        s.set(r.x - r.r * 0.3, r.y - r.r * 0.3, INK);
      }
      for (const sh of shots) s.rect(sh.x, sh.y, 1, 4, PAPER);
      for (const b of bits) s.rect(b.x, b.y, b.life > 0.25 ? 2 : 1, b.life > 0.25 ? 2 : 1, PAPER);
      stamp(s, SHIP, shipX - 5, 112, { mode: "paper" });
      stamp(s, FLAME[Math.floor(t * 12) % 2]!, shipX - 5, 120, { mode: "paper" });
      s.rect(0, 0, SCREEN_W, 9, INK);
      s.rect(0, 9, SCREEN_W, 1, PAPER);
      text(s, "HI 9999", 3, 2, PAPER);
      const r = "SCORE " + score(pts);
      text(s, r, SCREEN_W - 3 - textWidth(r), 2, PAPER);
    },
    pad() { return pad({ left: vx < -15, right: vx > 15, a: fire > 0 }); },
  };
}

function isoScene(): Scene {
  const N = 6, OX = 80, OY = 58;
  const iso = (gx: number, gy: number): [number, number] => [OX + (gx - gy) * 8, OY + (gx + gy) * 4];
  const PATH: [number, number][] = [[1, 1], [5, 1], [5, 5.2], [1.2, 5.2], [1.2, 2.2], [1, 1]];
  const lens = PATH.slice(1).map((p, i) => Math.hypot(p[0] - PATH[i]![0], p[1] - PATH[i]![1]));
  const total = lens.reduce((a, b) => a + b, 0);
  let t = 0;
  const walker = () => {
    let d = (t * 1.5) % total;
    for (let i = 0; i < lens.length; i++) {
      if (d <= lens[i]!) {
        const a = PATH[i]!, b = PATH[i + 1]!, u = d / lens[i]!;
        return { gx: a[0] + (b[0] - a[0]) * u, gy: a[1] + (b[1] - a[1]) * u, dx: b[0] - a[0], dy: b[1] - a[1] };
      }
      d -= lens[i]!;
    }
    return { gx: 1, gy: 1, dx: 1, dy: 0 };
  };
  const wall = (edge: "l" | "r", u: number, h: number): [number, number] => {
    const [x, y] = edge === "l" ? iso(0, u * N) : iso(u * N, 0);
    return [x, y - h];
  };
  const box = (s: Surface, gx0: number, gy0: number, gx1: number, gy1: number, h: number) => {
    const up = (p: [number, number]): [number, number] => [p[0], p[1] - h];
    const a = iso(gx0, gy0), b = iso(gx1, gy0), c = iso(gx1, gy1), d = iso(gx0, gy1);
    const left: [number, number][] = [d, c, up(c), up(d)];
    const right: [number, number][] = [c, b, up(b), up(c)];
    const top: [number, number][] = [up(a), up(b), up(c), up(d)];
    s.poly(left, 16, PAPER); s.poly(left, 7); s.outline(left);
    s.poly(right, 12); s.outline(right);
    s.poly(top, 16, PAPER); s.outline(top);
  };
  return {
    prompt: "a cozy isometric shop with a sleepy cat on the counter",
    log: [["route", "new game"], ["kit", "tycoon"], ["apply_ops", "31 ops"], ["draw_sprite", "cat, keeper"], ["playtest", "0 errors"]],
    reset() { t = 0; },
    update(dt) { t += dt; },
    draw(s) {
      s.clear(PAPER);
      const lw: [number, number][] = [iso(0, 0), iso(0, N), wall("l", 1, 42), wall("l", 0, 42)];
      const rw: [number, number][] = [iso(0, 0), iso(N, 0), wall("r", 1, 42), wall("r", 0, 42)];
      s.poly(lw, 6); s.outline(lw);
      s.poly(rw, 2); s.outline(rw);
      const win: [number, number][] = [wall("l", 0.3, 14), wall("l", 0.7, 14), wall("l", 0.7, 34), wall("l", 0.3, 34)];
      s.poly(win, 16, PAPER); s.outline(win);
      s.line(...wall("l", 0.5, 14), ...wall("l", 0.5, 34));
      s.line(...wall("l", 0.3, 24), ...wall("l", 0.7, 24));
      s.line(...wall("r", 0.15, 22), ...wall("r", 0.85, 22));
      for (let k = 0; k < 9; k++) {
        const [x, y] = wall("r", 0.2 + k * 0.07, 22);
        s.line(x, y - 1, x, y - 5 - (k % 3) * 2);
        if (k % 2) s.line(x + 1, y - 1, x + 1, y - 5 - (k % 3) * 2);
      }
      const clockC = wall("r", 0.5, 34);
      s.disc(clockC[0], clockC[1], 4, 16, PAPER); s.ring(clockC[0], clockC[1], 4);
      s.line(clockC[0], clockC[1], clockC[0] + Math.round(Math.cos(t) * 2), clockC[1] + Math.round(Math.sin(t) * 2));
      for (let gx = 0; gx < N; gx++)
        for (let gy = 0; gy < N; gy++) {
          const tile: [number, number][] = [iso(gx, gy), iso(gx + 1, gy), iso(gx + 1, gy + 1), iso(gx, gy + 1)];
          s.poly(tile, (gx + gy) % 2 ? 4 : 0);
        }
      s.outline([iso(0, 0), iso(N, 0), iso(N, N), iso(0, N)]);
      const rug: [number, number][] = [iso(1.6, 1.6), iso(3.8, 1.6), iso(3.8, 2.6), iso(1.6, 2.6)];
      s.poly(rug, 16, PAPER); s.poly(rug, 9); s.outline(rug);
      const w = walker();
      const drawHero = () => {
        const [x, y] = iso(w.gx, w.gy);
        s.disc(x, y, 3, 8);
        stamp(s, HERO[Math.floor(t * 7) % 2]!, x - 4, y - 10, { flip: w.dx - w.dy < 0 });
      };
      const behind = w.gx + w.gy < 6.6;
      if (behind) drawHero();
      box(s, 2.4, 3.6, 4.6, 4.6, 11);
      const [cx, cy] = iso(3.5, 4.1);
      stamp(s, CAT, cx - 3, cy - 18);
      if (Math.floor(t * 1.2) % 3 === 0) text(s, "Z", cx + 4, cy - 26 - ((t * 1.2) % 1) * 3);
      if (!behind) drawHero();
      const plant = iso(5.4, 0.5);
      s.rect(plant[0] - 3, plant[1] - 6, 7, 6, INK);
      s.disc(plant[0], plant[1] - 11, 5, 16); s.disc(plant[0] - 3, plant[1] - 9, 3, 16, PAPER); s.disc(plant[0] + 2, plant[1] - 13, 2, 16, PAPER);
      const coins = 251 + Math.floor(t / 1.3) * 3;
      s.rect(0, 0, SCREEN_W, 12, PAPER);
      stamp(s, COIN[Math.floor(t * 6) % 3]!, SCREEN_W - 4 - textWidth(String(coins)) - 8, 3);
      text(s, String(coins), SCREEN_W - 3 - textWidth(String(coins)), 3);
      text(s, "SEL", 4, 3);
      s.frame(2, 1, 15, 9);
      const mins = (48 + Math.floor(t)) % 60;
      text(s, "11:" + String(mins).padStart(2, "0"), 6, 122, INK, 2);
      text(s, "AM", 50, 127);
      s.rect(6, 135, 54, 1);
      text(s, "MAR 23 SUN", 6, 138);
    },
    pad() {
      const w = walker();
      return pad({ right: w.dx > 0.1, left: w.dx < -0.1, down: w.dy > 0.1, up: w.dy < -0.1 });
    },
  };
}

export const SCENES = [frogScene(), shooterScene(), isoScene()];

export function bootScreen(s: Surface, t: number) {
  s.clear(PAPER);
  for (let y = 0; y < SCREEN_H; y++) for (let x = 0; x < SCREEN_W; x++) if ((x + y) % 8 === 0 && shade(x, y, 8)) s.set(x, y, INK);
  s.rect(24, 40, 112, 46, PAPER);
  s.frame(24, 40, 112, 46);
  s.frame(26, 42, 108, 42);
  const word = "DREAMSY";
  text(s, word, 80 - textWidth(word, 3) / 2, 50, INK, 3);
  text(s, "ENGINE + HARNESS", 80 - textWidth("ENGINE + HARNESS") / 2, 72);
  if (Math.floor(t * 2.5) % 2 === 0) {
    const m = "AWAITING PROMPT";
    text(s, m, 80 - textWidth(m) / 2, 104);
  }
  stamp(s, COIN[Math.floor(t * 8) % 3]!, 78, 92 + Math.round(Math.abs(Math.sin(t * 4)) * -3));
}

export function buildScreen(s: Surface, scene: Scene, p: number, t: number) {
  s.clear(PAPER);
  text(s, "BUILDING", 8, 10, INK, 2);
  const frames = ["-", "/", "!", "/"];
  text(s, frames[Math.floor(t * 10) % 4]!, 76, 15);
  s.rect(8, 24, 144, 1);
  const shown = Math.min(scene.log.length, Math.floor(p * (scene.log.length + 0.5)));
  scene.log.forEach(([k, v], i) => {
    if (i > shown) return;
    const y = 32 + i * 12;
    const done = i < shown;
    text(s, ">", 8, y);
    text(s, k, 16, y);
    if (done) {
      text(s, v, 152 - textWidth(v), y);
      for (let x = 20 + textWidth(k); x < 148 - textWidth(v); x += 3) s.set(x, y + 4, INK);
    } else if (Math.floor(t * 6) % 2 === 0) s.rect(16 + textWidth(k) + 3, y, 3, 5);
  });
  s.frame(8, 124, 144, 9);
  s.dither(10, 126, 140 * Math.min(1, p), 5, 10);
}
