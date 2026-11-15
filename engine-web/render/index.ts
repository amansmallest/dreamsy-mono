import { orientationOf } from "@dreamsy/format";
import type { Game, Insets } from "../core/index.js";
import { detectInputUsage, isTouchDevice, KeyboardInput, PointerInput, TouchControls } from "../input/index.js";
import { AudioEngine } from "./audio.js";
import { Renderer2D, type Renderer2DOptions } from "./renderer2d.js";
import { loadSettings, Shell } from "./shell.js";

export { Renderer2D } from "./renderer2d.js";
export { UIOverlay } from "./ui.js";
export { TextureCache } from "./textures.js";
export { AudioEngine, renderOffline, scheduleSfx, compileSong } from "./audio.js";
export { Shell, loadSettings } from "./shell.js";
export { LocalStorageSaveHost } from "./save.js";
export { ParticlesView } from "./particles.js";
export { resolveTheme, type Theme } from "./theme.js";

export interface MountOptions extends Renderer2DOptions {
  /** Force touch controls on/off (default: on for touch devices). */
  touch?: boolean;
  /** Platform pause button + menu (default true). */
  shell?: boolean;
  /** Pause menu "Quit" (also dispatched as a bubbling "dreamsy:quit" event on the container). */
  onQuit?: () => void;
  /** Called after every rendered frame. */
  onFrame?: (stats: FrameStats) => void;
  /** Extra safe-area insets in CSS px (e.g. from the app WebView: ?insets=top,right,bottom,left). Combined with env(safe-area-inset-*) by max. */
  insets?: Partial<Insets>;
  /**
   * Deterministic stepping for playtest tools: no requestAnimationFrame loop; the host calls
   * view.stepTicks(n) to run n fixed ticks and render one frame (game time is then independent of wall time).
   */
  manual?: boolean;
}

/** Parse "top,right,bottom,left" (CSS px) as passed by the app WebView in ?insets=. */
export function parseInsets(s: string | null | undefined): Partial<Insets> | undefined {
  if (!s) return undefined;
  const n = s.split(",").map((x) => Number(x.trim()));
  if (n.length !== 4 || n.some((x) => !Number.isFinite(x) || x < 0 || x > 400)) return undefined;
  return { top: n[0], right: n[1], bottom: n[2], left: n[3] };
}

/** env(safe-area-inset-*) of the page, read through a probe element. */
function envInsets(container: HTMLElement): Insets {
  const probe = document.createElement("div");
  Object.assign(probe.style, {
    position: "absolute", visibility: "hidden", pointerEvents: "none", left: "0", top: "0",
    paddingTop: "env(safe-area-inset-top)", paddingRight: "env(safe-area-inset-right)",
    paddingBottom: "env(safe-area-inset-bottom)", paddingLeft: "env(safe-area-inset-left)",
  });
  container.appendChild(probe);
  const cs = getComputedStyle(probe);
  const r = { top: parseFloat(cs.paddingTop) || 0, right: parseFloat(cs.paddingRight) || 0, bottom: parseFloat(cs.paddingBottom) || 0, left: parseFloat(cs.paddingLeft) || 0 };
  probe.remove();
  return r;
}

export interface FrameStats { fps: number; frameMs: number; ticks: number; entities: number }

/** Mounts a running game into a container: renderer, inputs and the rAF loop. */
export class GameView {
  readonly renderer: Renderer2D;
  private keyboard: KeyboardInput;
  private touch: TouchControls | null = null;
  private pointer: PointerInput;
  readonly audio: AudioEngine;
  readonly shell: Shell | null = null;
  private raf = 0;
  private last = 0;
  private frames = 0;
  private fpsT0 = 0;
  fps = 0;
  /** Host-level pause without the menu (e.g. app backgrounded). */
  paused = false;

  constructor(readonly container: HTMLElement, readonly game: Game, private opts: MountOptions = {}) {
    if (getComputedStyle(container).position === "static") container.style.position = "relative";
    this.renderer = new Renderer2D(container, game, opts);
    const usage = detectInputUsage(game);
    this.keyboard = new KeyboardInput(game, usage);
    if (opts.touch ?? isTouchDevice()) this.touch = new TouchControls(container, game, usage, orientationOf(game.manifest));
    game.settings = loadSettings();
    this.touch?.setScale(game.settings.touchSize);
    this.audio = new AudioEngine(game);
    if (opts.shell !== false) {
      this.shell = new Shell(container, game, usage, {
        onPauseChange: (p) => this.audio.setPaused(p),
        onSettings: (s) => { this.audio.applyVolumes(); this.touch?.setScale(s.touchSize); },
        onQuit: opts.onQuit,
      });
    }
    this.pointer = new PointerInput(this.renderer.canvas, game, (x, y) => this.renderer.canvasToWorld(x, y), (x, y) => this.renderer.canvasToRef(x, y));
    this.applyInsets();
    window.addEventListener("resize", this.applyInsets);
    this.renderer.render();
    if (!opts.manual) this.raf = requestAnimationFrame(this.loop);
  }

  /** Manual mode: run `n` fixed ticks (none while paused), then render and update audio once. Returns ticks run. */
  stepTicks(n: number): number {
    let ran = 0;
    for (let i = 0; i < n && !this.paused && !this.game.paused; i++) { this.game.step(); ran++; }
    this.touch?.setDimmed(!!this.game.dialogs.current);
    const t0 = performance.now();
    this.renderer.render();
    this.audio.update();
    this.opts.onFrame?.({ fps: this.fps, frameMs: performance.now() - t0, ticks: ran, entities: this.game.world.count });
    return ran;
  }

  /** Safe-area insets in use (container px). */
  insets: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

  /** Update host-provided insets (e.g. the app rotated or its chrome changed). */
  setInsets(i: Partial<Insets>) {
    this.opts.insets = i;
    this.applyInsets();
  }

  private applyInsets = () => {
    const env = envInsets(this.container), extra = this.opts.insets ?? {};
    const i: Insets = {
      top: Math.max(env.top, extra.top ?? 0), right: Math.max(env.right, extra.right ?? 0),
      bottom: Math.max(env.bottom, extra.bottom ?? 0), left: Math.max(env.left, extra.left ?? 0),
    };
    this.insets = i;
    this.renderer.insets = i;
    this.touch?.setInsets(i);
    this.shell?.setInsets(i);
  };

  private loop = (t: number) => {
    this.raf = requestAnimationFrame(this.loop);
    const dt = this.last ? Math.min(0.1, (t - this.last) / 1000) : 0;
    this.last = t;
    const t0 = performance.now();
    const ticks = this.paused ? 0 : this.game.advance(dt);
    this.touch?.setDimmed(!!this.game.dialogs.current);
    this.renderer.render();
    this.audio.update();
    this.frames++;
    if (t - this.fpsT0 >= 500) {
      this.fps = (this.frames * 1000) / (t - this.fpsT0);
      this.frames = 0;
      this.fpsT0 = t;
    }
    this.opts.onFrame?.({ fps: this.fps, frameMs: performance.now() - t0, ticks, entities: this.game.world.count });
  };

  dispose() {
    cancelAnimationFrame(this.raf);
    window.removeEventListener("resize", this.applyInsets);
    this.keyboard.dispose();
    this.touch?.dispose();
    this.pointer.dispose();
    this.renderer.dispose();
    this.shell?.dispose();
    this.audio.dispose();
  }
}
