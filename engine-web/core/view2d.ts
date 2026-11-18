// Screen ↔ world mapping for 2D games (shared by renderer, input and headless tools).
//
// Contract (DREAMSY.MD §11.1, LUAU_API.md "Screen"):
//  - Fixed reference screen per orientation, short side 720: portrait 720×1280, landscape 1280×720
//    (manifest `orientation`; absent = landscape). The engine letterboxes/pillarboxes the reference
//    rectangle into the real screen, so every device shows exactly the same world and UI area.
//  - At Camera2D zoom 1 one world pixel is one reference pixel; UI offsets/sizes are reference pixels.
//  - Camera2D position (or its smoothed follow target) is the view center. Without a current Camera2D
//    the view's top-left is (0,0). The camera state itself (smoothing, limits, shake) lives in core
//    (Game.cameraView), so headless runs see the same view as the renderer.
import { referenceSize } from "@dreamsy/format";
import type { Game } from "./game.js";
import type { Entity } from "./world.js";

export const WORLD_SHORT_SIDE = 720;
export const UI_SHORT_SIDE = 720;

/** Safe-area insets in container CSS pixels (notch / home indicator). */
export interface Insets { top: number; right: number; bottom: number; left: number }
export const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

/** The letterboxed game rectangle inside a container. */
export interface Fit {
  /** Top-left of the game rect in container px. */
  x: number;
  y: number;
  /** Game rect size in container px. */
  w: number;
  h: number;
  /** Container px per reference px. */
  s: number;
  refW: number;
  refH: number;
}

/** Fit a refW×refH reference screen into W×H, centered (letterbox / pillarbox). */
export function fitRect(refW: number, refH: number, W: number, H: number): Fit {
  const s = Math.max(1e-6, Math.min(W / refW, H / refH));
  const w = refW * s, h = refH * s;
  return { x: (W - w) / 2, y: (H - h) / 2, w, h, s, refW, refH };
}

/**
 * Safe area inside the game rect, in reference px (insets that fall in the letterbox bars cost nothing).
 * Returned as insets from each edge of the reference screen.
 */
export function safeInsets(fit: Fit, insets: Insets, W: number, H: number): Insets {
  const top = Math.max(0, insets.top - fit.y) / fit.s;
  const left = Math.max(0, insets.left - fit.x) / fit.s;
  const bottom = Math.max(0, insets.bottom - (H - fit.y - fit.h)) / fit.s;
  const right = Math.max(0, insets.right - (W - fit.x - fit.w)) / fit.s;
  return { top, right, bottom, left };
}

export interface View2D {
  /** World point at the screen center (shake included). */
  cx: number;
  cy: number;
  zoom: number;
  /** Container (CSS) pixels per world pixel. */
  scale: number;
  /** Visible world size (= reference size / zoom). */
  w: number;
  h: number;
  /** The game rect in the container. */
  fit: Fit;
}

/** Reference screen size for a running game. */
export function gameRefSize(game: Game): [number, number] {
  return referenceSize(game.manifest);
}

/** Container px per UI reference px (letterboxed). */
export function uiScale(screenW: number, screenH: number, ref: [number, number] = [1280, 720]): number {
  return fitRect(ref[0], ref[1], screenW, screenH).s;
}

export function view2D(game: Game, screenW: number, screenH: number): View2D {
  const [rw, rh] = gameRefSize(game);
  const fit = fitRect(rw, rh, screenW, screenH);
  const c = game.cameraView();
  return { cx: c.x, cy: c.y, zoom: c.zoom, scale: fit.s * c.zoom, w: rw / c.zoom, h: rh / c.zoom, fit };
}

/** Container px → world. */
export function screenToWorld(v: View2D, sx: number, sy: number): [number, number] {
  const f = v.fit;
  return [v.cx + (sx - f.x - f.w / 2) / v.scale, v.cy + (sy - f.y - f.h / 2) / v.scale];
}

/** Reference px (UI coordinates) → world, for a camera view. */
/** 2.5D: a ground point → where the view draws it (iso: the 2:1 diamond (x − y, (x + y) / 2); others: unchanged). */
export function projectGround(view: string, x: number, y: number): [number, number] {
  return view === "iso" ? [x - y, (x + y) / 2] : [x, y];
}

/** Inverse of projectGround. */
export function unprojectGround(view: string, px: number, py: number): [number, number] {
  return view === "iso" ? [py + px / 2, py - px / 2] : [px, py];
}

export function refToWorld(cx: number, cy: number, zoom: number, ref: [number, number], x: number, y: number): [number, number] {
  return [cx + (x - ref[0] / 2) / zoom, cy + (y - ref[1] / 2) / zoom];
}

export function worldToRef(cx: number, cy: number, zoom: number, ref: [number, number], x: number, y: number): [number, number] {
  return [(x - cx) * zoom + ref[0] / 2, (y - cy) * zoom + ref[1] / 2];
}

// ---------- UI layout (shared by the HTML overlay and headless taps) ----------

export const ANCHOR: Record<string, [number, number]> = {
  top_left: [0, 0], top: [0.5, 0], top_right: [1, 0],
  left: [0, 0.5], center: [0.5, 0.5], right: [1, 0.5],
  bottom_left: [0, 1], bottom: [0.5, 1], bottom_right: [1, 1],
};

/**
 * A UI element's rect [x, y, w, h] inside its container rect (cx, cy, cw, ch), all in reference px.
 * Top-level UI uses the safe area as its container; children of a UIPanel use the panel.
 */
export function anchorRect(anchor: string, offset: number[], size: number[], cx: number, cy: number, cw: number, ch: number): [number, number, number, number] {
  const [ax, ay] = ANCHOR[anchor] ?? [0, 0];
  const w = size[0]!, h = size[1]!;
  return [cx + ax * cw + offset[0]! - ax * w, cy + ay * ch + offset[1]! - ay * h, w, h];
}

const UI_TYPES = new Set(["UIText", "UIButton", "UIPanel"]);

/**
 * Rect [x, y, w, h] of a UI child inside its parent's local box (0, 0, pw, ph), reference px.
 * A UIPanel with layout = "stack" places its visible UI children top to bottom in order: y = padding + the
 * heights + gaps of the earlier ones + the child's own offset.y; x from the child's anchor column (left / center /
 * right) + offset.x. Otherwise the child's own anchor + offset (anchorRect).
 */
export function uiChildRect(e: Entity, pw: number, ph: number): [number, number, number, number] {
  const p = e.parent;
  const size = e.get<number[]>("size"), off = e.get<number[]>("offset");
  if (!p || p.type !== "UIPanel" || p.get<string>("layout") !== "stack") return anchorRect(e.get<string>("anchor"), off, size, 0, 0, pw, ph);
  const gap = p.get<number>("gap"), pad = p.get<number>("padding");
  let y = pad;
  for (const c of p.children) {
    if (!UI_TYPES.has(c.type)) continue;
    const visible = c.get<boolean>("visible") !== false;
    const co = c.get<number[]>("offset"), cs = c.get<number[]>("size");
    if (c === e) {
      const [ax] = ANCHOR[e.get<string>("anchor")] ?? [0, 0];
      return [ax * pw + off[0]! - ax * size[0]!, y + off[1]!, size[0]!, size[1]!];
    }
    if (visible) y += co[1]! + cs[1]! + gap;
  }
  return anchorRect(e.get<string>("anchor"), off, size, 0, 0, pw, ph);
}

/**
 * Text2D placement: the text block's top-left relative to the entity position, for a block w×h.
 * align "center" → centered on position; "left" → left edge at position; "right" → right edge at position.
 * Always vertically centered on position. (Renderer and tools share this.)
 */
export function text2DOrigin(align: string, w: number, h: number): [number, number] {
  return [align === "left" ? 0 : align === "right" ? -w : -w / 2, -h / 2];
}
