import { shade, type Mode, type Surface } from "./surface";

export interface Sprite {
  w: number;
  h: number;
  rows: string[];
}

export const sprite = (...rows: string[]): Sprite => ({ w: Math.max(...rows.map((r) => r.length)), h: rows.length, rows });

export function stamp(s: Surface, sp: Sprite, x: number, y: number, opts: { flip?: boolean; mode?: Mode } = {}) {
  const mode = opts.mode ?? "ink";
  x = Math.round(x);
  y = Math.round(y);
  for (let j = 0; j < sp.h; j++) {
    const row = sp.rows[j]!;
    for (let i = 0; i < row.length; i++) {
      const c = row[opts.flip ? row.length - 1 - i : i];
      const px = x + i, py = y + j;
      if (c === "#") s.plot(px, py, mode);
      else if (c === "o") s.plot(px, py, mode === "paper" ? "ink" : "paper");
      else if (c === "+") s.plot(px, py, shade(px, py, 8) ? mode : mode === "paper" ? "ink" : "paper");
    }
  }
}

export const FROG = [
  sprite(
    "..##....##..",
    ".#oo#..#oo#.",
    ".#o##..#o##.",
    ".##########.",
    "############",
    "#o########o#",
    "#oo++++++oo#",
    ".##++++++##.",
    "..########..",
    ".##......##.",
  ),
  sprite(
    "..##....##..",
    ".#oo#..#oo#.",
    ".#o##..#o##.",
    ".##########.",
    "############",
    "#o########o#",
    "#oo++++++oo#",
    ".##++++++##.",
    "##.######.##",
    "#..........#",
  ),
];

export const STRAWBERRY = sprite(
  "...#.#..",
  "..####..",
  ".#o####.",
  "#####o##",
  "##o#####",
  ".####o#.",
  ".######.",
  "..####..",
  "...##...",
);

export const SHIP = sprite(
  ".....#.....",
  "....###....",
  "....#o#....",
  "...##o##...",
  "..#######..",
  ".##+###+##.",
  "###########",
  "#.#.....#.#",
);

export const FLAME = [sprite("..#.....#..", "..#.....#.."), sprite("..#.....#..", ".........")];

export const HERO = [
  sprite(
    "..####..",
    ".######.",
    ".#o##o#.",
    ".#oooo#.",
    "..####..",
    ".#++++#.",
    "#+#++#+#",
    "..####..",
    "..#..#..",
    ".##..##.",
  ),
  sprite(
    "..####..",
    ".######.",
    ".#o##o#.",
    ".#oooo#.",
    "..####..",
    ".#++++#.",
    "#+#++#+#",
    "..####..",
    ".#....#.",
    ".#....##",
  ),
];

export const CAT = sprite(
  "#...#.",
  "##.##.",
  "#o#o#.",
  "#####.",
  ".####.",
  ".#####",
  ".####.",
);

export const SPARKLE = [
  sprite("..#..", "..#..", "##o##", "..#..", "..#.."),
  sprite(".#.", "#o#", ".#."),
  sprite("#"),
];

export const HEART = sprite(".##.##.", "#######", "#######", ".#####.", "..###..", "...#...");

export const COIN = [
  sprite(".###.", "#o#o#", "#o#o#", "#o#o#", ".###."),
  sprite(".#.", "#o#", "#o#", "#o#", ".#."),
  sprite("#", "#", "#", "#", "#"),
];

export const STAR = sprite("...#...", "...#...", "..###..", "#######", ".#####.", ".##.##.", "#.....#");
