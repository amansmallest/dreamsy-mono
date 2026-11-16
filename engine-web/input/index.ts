// Browser input → core InputState: keyboard, on-screen touch controls, pointer/taps.
import { expandKits, kitSourceText, type Game, type Insets } from "../core/index.js";

export interface InputUsage { move: boolean; buttons: Set<string>; /** reads look_x / look_y (twin-stick aim) */ look?: boolean }

/** Which controls a game's scripts actually read (so phones only show what's needed). */
export function detectInputUsage(game: Game): InputUsage {
  let src = "";
  for (const p of game.pkg.paths("scripts/")) src += game.pkg.text(p) ?? "";
  // Kits read input too (e.g. the platformer kit's jump): scan the kits this game requires (+ their deps).
  const kits = [...new Set([...src.matchAll(/require\s*\(\s*["']@kit\/([a-z][a-z0-9-]*)/g)].map((m) => m[1]!))];
  if (kits.length) src += kitSourceText(expandKits(kits));
  const buttons = new Set<string>();
  for (const m of src.matchAll(/input\s*\.\s*(?:pressed|held)\s*\(\s*["'](\w+)["']/g)) buttons.add(m[1]!);
  return { move: /input\s*\.\s*axis\s*\(\s*["']move_/.test(src), buttons, look: /input\s*\.\s*axis\s*\(\s*["']look_/.test(src) };
}

const KEYS_LEFT = ["ArrowLeft", "KeyA"], KEYS_RIGHT = ["ArrowRight", "KeyD"];
const KEYS_UP = ["ArrowUp", "KeyW"], KEYS_DOWN = ["ArrowDown", "KeyS"];

export class KeyboardInput {
  private down = new Set<string>();
  private onKey = (ev: KeyboardEvent) => {
    if ((ev.target as HTMLElement)?.tagName === "INPUT") return;
    const isDown = ev.type === "keydown";
    if (isDown) this.down.add(ev.code); else this.down.delete(ev.code);
    if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(ev.code)) ev.preventDefault();
    this.apply();
  };
  private onBlur = () => { this.down.clear(); this.apply(); };

  constructor(private game: Game, private usage: InputUsage, private target: Window = window) {
    target.addEventListener("keydown", this.onKey);
    target.addEventListener("keyup", this.onKey);
    target.addEventListener("blur", this.onBlur);
  }

  private any(codes: string[]) { return codes.some((c) => this.down.has(c)); }

  private apply() {
    const i = this.game.input;
    const x = (this.any(KEYS_RIGHT) ? 1 : 0) - (this.any(KEYS_LEFT) ? 1 : 0);
    const y = (this.any(KEYS_DOWN) ? 1 : 0) - (this.any(KEYS_UP) ? 1 : 0);
    i.setAxis("move_x", x);
    i.setAxis("move_y", y);
    // Up/W also jump in games that never read move_y (platformers).
    const upJumps = !/move_y/.test(this.scriptsText());
    i.setButton("jump", this.down.has("Space") || (upJumps && this.any(KEYS_UP)) || this.down.has("KeyZ"));
    i.setButton("action", this.any(["KeyE", "KeyJ", "Enter", "KeyX"]));
    i.setButton("action2", this.any(["KeyQ", "KeyK", "KeyC"]));
  }

  private _src: string | null = null;
  private scriptsText() {
    if (this._src === null) {
      this._src = "";
      for (const p of this.game.pkg.paths("scripts/")) this._src += this.game.pkg.text(p) ?? "";
    }
    return this._src;
  }

  dispose() {
    this.target.removeEventListener("keydown", this.onKey);
    this.target.removeEventListener("keyup", this.onKey);
    this.target.removeEventListener("blur", this.onBlur);
  }
}

export function isTouchDevice(): boolean {
  return typeof window !== "undefined" && ("ontouchstart" in window || navigator.maxTouchPoints > 0);
}

/** On-screen controls for this game: never while spectating (no local avatar), else `force` or touch devices. */
export function touchControlsEnabled(game: Pick<Game, "net">, force?: boolean): boolean {
  if (game.net?.spectating) return false;
  return force ?? isTouchDevice();
}

/** Touch-control layout per orientation (container CSS px, before the touch-size setting). */
export interface TouchLayout {
  stick: number;
  knob: number;
  /** Stick center inset from the left / bottom (plus safe area). */
  stickX: number;
  stickY: number;
  /** [right, bottom, size] per button slot (jump, then action, action2), plus safe area. */
  buttons: [number, number, number][];
}

export function touchLayout(orientation: "portrait" | "landscape"): TouchLayout {
  return orientation === "portrait"
    ? // portrait: thumbs low on the screen, above the home indicator; bigger targets
      { stick: 116, knob: 48, stickX: 28, stickY: 40, buttons: [[26, 52, 96], [136, 30, 76], [44, 166, 76]] }
    : { stick: 100, knob: 42, stickX: 28, stickY: 28, buttons: [[26, 38, 88], [124, 24, 68], [42, 136, 68]] };
}

/** Virtual joystick (bottom-left) + jump/action buttons (bottom-right). Hidden for tap-only games. */
export class TouchControls {
  readonly root: HTMLDivElement;
  private stickId: number | null = null;
  private stickOrigin: [number, number] = [0, 0];
  private base: HTMLDivElement;
  private knob: HTMLDivElement;
  private layout: TouchLayout;
  private insets: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
  private slots: [HTMLElement, [number, number, number]][] = [];
  private scale = 1;
  private lookStick: LookStick | null = null;
  private allButtons: [string, HTMLDivElement][] = [];
  private shown = new Set<string>();
  private lift = 0;

  constructor(container: HTMLElement, private game: Game, usage: InputUsage, orientation: "portrait" | "landscape" = "landscape") {
    this.layout = touchLayout(orientation);
    const L = this.layout;
    this.root = document.createElement("div");
    Object.assign(this.root.style, { position: "absolute", inset: "0", pointerEvents: "none", zIndex: "50000" });
    if (!usage.move && !usage.look && usage.buttons.size === 0) this.root.style.display = "none"; // tap/pointer-only game
    container.appendChild(this.root);

    // FIXED joystick (bottom-left): it never follows the finger, and only the stick itself (plus a small ring)
    // takes touches, so on-screen game/platform buttons elsewhere stay tappable.
    this.base = document.createElement("div");
    Object.assign(this.base.style, {
      position: "absolute", width: `${L.stick}px`, height: `${L.stick}px`, borderRadius: "50%", boxSizing: "border-box",
      background: "rgba(255,255,255,0.12)", border: "2px solid rgba(255,255,255,0.35)", display: usage.move ? "block" : "none",
      pointerEvents: usage.move ? "auto" : "none", touchAction: "none",
    });
    const ring = document.createElement("div"); // slightly larger hit area than the visible stick
    Object.assign(ring.style, { position: "absolute", inset: "-22px", borderRadius: "50%" });
    this.base.appendChild(ring);
    this.knob = document.createElement("div");
    Object.assign(this.knob.style, {
      position: "absolute", width: `${L.knob}px`, height: `${L.knob}px`, borderRadius: "50%", left: `${(L.stick - L.knob) / 2 - 2}px`, top: `${(L.stick - L.knob) / 2 - 2}px`,
      background: "rgba(255,255,255,0.55)", pointerEvents: "none",
    });
    this.base.appendChild(this.knob);
    this.root.appendChild(this.base);
    this.homeStick();

    const zone = this.base;
    zone.addEventListener("pointerdown", (ev) => {
      if (this.stickId !== null) return;
      ev.preventDefault();
      ev.stopPropagation();
      this.stickId = ev.pointerId;
      zone.setPointerCapture(ev.pointerId);
      const r = this.base.getBoundingClientRect();
      this.stickOrigin = [r.left + r.width / 2, r.top + r.height / 2]; // always the stick's centre
      this.moveStick(ev.clientX, ev.clientY);
    });
    zone.addEventListener("pointermove", (ev) => { if (ev.pointerId === this.stickId) this.moveStick(ev.clientX, ev.clientY); });
    const end = (ev: PointerEvent) => {
      if (ev.pointerId !== this.stickId) return;
      this.stickId = null;
      this.game.input.setAxis("move_x", 0);
      this.game.input.setAxis("move_y", 0);
      this.knob.style.transform = "";
    };
    zone.addEventListener("pointerup", end);
    zone.addEventListener("pointercancel", end);

    // look / aim stick (twin-stick games reading input.axis("look_x/look_y")): bottom-right, buttons move above it
    if (usage.look) this.lookStick = new LookStick(this.root, game, L, orientation, () => this.insets, () => this.scale);

    // Buttons: the ones the scan found are shown now; any other one appears the first time the game reads it
    // (kits read buttons through config tables, e.g. the platformer's `input.pressed(b.jump)`).
    const btns: [string, string, string][] = [["jump", "A", "#3fb950"], ["action", "B", "#f0883e"], ["action2", "C", "#58a6ff"]];
    for (const [name, label, color] of btns) {
      const b = document.createElement("div");
      b.textContent = label;
      b.dataset.button = name;
      Object.assign(b.style, {
        position: "absolute", borderRadius: "50%",
        background: color, opacity: "0.78", color: "#fff",
        display: "none", alignItems: "center", justifyContent: "center", pointerEvents: "auto", touchAction: "none", userSelect: "none", webkitUserSelect: "none",
        boxShadow: "0 4px 0 rgba(0,0,0,0.3)",
      });
      // larger invisible hit area than the visible button
      const hit = document.createElement("div");
      Object.assign(hit.style, { position: "absolute", inset: "-14px", borderRadius: "50%" });
      b.appendChild(hit);
      const ids = new Set<number>();
      b.addEventListener("pointerdown", (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        ids.add(ev.pointerId);
        b.setPointerCapture(ev.pointerId);
        b.style.opacity = "1";
        this.game.input.setButton(name, true);
      });
      const up = (ev: PointerEvent) => {
        ids.delete(ev.pointerId);
        if (ids.size === 0) { b.style.opacity = "0.78"; this.game.input.setButton(name, false); }
      };
      b.addEventListener("pointerup", up);
      b.addEventListener("pointercancel", up);
      this.root.appendChild(b);
      this.allButtons.push([name, b]);
    }
    for (const n of usage.buttons) this.shown.add(n);
    this.lift = usage.look ? L.stick + 40 : 0;
    this.layoutButtons();
    game.input.onFirstRead = (name) => {
      if (name === "move_x" || name === "move_y") {
        if (this.base.style.display === "none") { this.base.style.display = "block"; this.base.style.pointerEvents = "auto"; this.root.style.display = ""; }
      } else if (this.allButtons.some(([n]) => n === name) && !this.shown.has(name)) {
        this.shown.add(name);
        this.root.style.display = "";
        this.layoutButtons();
      }
    };
    this.place();
  }

  /** Visible buttons take the layout slots in fixed order (A jump, B action, C action2). */
  private layoutButtons() {
    const L = this.layout;
    this.slots = [];
    let slot = 0;
    for (const [name, b] of this.allButtons) {
      if (!this.shown.has(name) || slot >= L.buttons.length) { b.style.display = "none"; continue; }
      const p0 = L.buttons[slot++]!;
      const size = p0[2];
      Object.assign(b.style, { display: "flex", width: `${size}px`, height: `${size}px`, font: `700 ${Math.round(size * 0.32)}px system-ui, sans-serif`, transformOrigin: "100% 100%", scale: String(this.scale) });
      this.slots.push([b, [p0[0], p0[1] + this.lift, size]]);
    }
    this.place();
  }

  private homeStick() {
    const L = this.layout;
    this.base.style.left = `${this.insets.left + L.stickX}px`;
    this.base.style.bottom = `${this.insets.bottom + L.stickY}px`;
  }

  private place() {
    for (const [b, [right, bottom]] of this.slots) {
      b.style.right = `${this.insets.right + right * this.scale}px`;
      b.style.bottom = `${this.insets.bottom + bottom * this.scale}px`;
    }
    if (this.stickId === null) this.homeStick();
    this.lookStick?.home();
  }

  private activeState = new Map<HTMLElement, boolean>();
  private setActive(el: HTMLElement, on: boolean) {
    if (this.activeState.get(el) === on) return;
    this.activeState.set(el, on);
    el.style.transition = "opacity 180ms ease";
    el.style.opacity = on ? "" : "0";
    el.style.visibility = on ? "" : "hidden";
  }
  /**
   * Per frame: show a control only while the game is actually reading it (gameplay), so title screens,
   * menus and shops aren't covered by a joystick/buttons. A control being touched stays visible.
   */
  syncActive() {
    const inp = this.game.input;
    const stickOn = this.stickId !== null || inp.recentlyRead("move_x") || inp.recentlyRead("move_y");
    this.setActive(this.base, stickOn);
    for (const [name, b] of this.allButtons) {
      if (!this.shown.has(name)) continue;
      this.setActive(b, inp.recentlyRead(name) || inp.rawHeld(name));
    }
    if (this.lookStick) this.lookStick.setActive(inp.recentlyRead("look_x") || inp.recentlyRead("look_y"));
  }

  private dimmed = false;
  /** Fade the controls while a dialog is open (jump/action still advance it). */
  setDimmed(d: boolean) {
    if (d === this.dimmed) return;
    this.dimmed = d;
    this.root.style.opacity = d ? "0.25" : "";
  }

  /** Safe-area insets (container px): controls sit above the home indicator / beside the notch. */
  setInsets(i: Insets) {
    this.insets = { ...i };
    this.place();
  }

  /** Platform setting "touch-control size" (0.75..1.5). */
  setScale(s: number) {
    this.scale = Math.max(0.75, Math.min(1.5, s));
    const k = String(this.scale);
    this.base.style.transformOrigin = "0% 100%";
    this.base.style.scale = k;
    for (const [b] of this.slots) { b.style.transformOrigin = "100% 100%"; b.style.scale = k; }
    this.place();
  }

  private moveStick(x: number, y: number) {
    let dx = x - this.stickOrigin[0], dy = y - this.stickOrigin[1];
    const max = this.layout.stick * 0.42 * this.scale;
    const len = Math.hypot(dx, dy);
    if (len > max) { dx = (dx / len) * max; dy = (dy / len) * max; }
    this.knob.style.transform = `translate(${dx / this.scale}px, ${dy / this.scale}px)`;
    const [ax, ay] = shapeStick(dx / max, dy / max);
    this.game.input.setAxis("move_x", ax);
    this.game.input.setAxis("move_y", ay);
  }

  dispose() { if (this.game.input.onFirstRead) this.game.input.onFirstRead = null; this.root.remove(); }
}

/**
 * Thumb-friendly stick shaping: radial dead zone, then a secondary axis is dropped while the thumb is
 * clearly pushing along the other one (a thumb steering left/right drifts down — that must not brake
 * a car or press "down" in a platformer). Diagonals (both axes similar) pass through.
 */
export function shapeStick(x: number, y: number): [number, number] {
  const len = Math.hypot(x, y);
  if (len < 0.18) return [0, 0];
  const k = Math.min(1, (len - 0.18) / 0.82) / len; // rescale so the edge of the dead zone reads ~0
  let ax = x * k, ay = y * k;
  if (Math.abs(ay) < Math.abs(ax) * 0.5) ay = 0;
  else if (Math.abs(ax) < Math.abs(ay) * 0.5) ax = 0;
  return [ax, ay];
}

/** Right-side aim stick feeding look_x / look_y (released = 0). */
class LookStick {
  private base: HTMLDivElement;
  private knob: HTMLDivElement;
  private id: number | null = null;
  private origin: [number, number] = [0, 0];

  constructor(root: HTMLElement, private game: Game, private L: TouchLayout, orientation: "portrait" | "landscape", private insets: () => Insets, private scale: () => number) {
    void orientation;
    this.base = document.createElement("div");
    Object.assign(this.base.style, { position: "absolute", width: `${L.stick}px`, height: `${L.stick}px`, borderRadius: "50%", boxSizing: "border-box", background: "rgba(255,255,255,0.10)", border: "2px solid rgba(255,120,120,0.45)", pointerEvents: "auto", touchAction: "none" });
    const ring = document.createElement("div");
    Object.assign(ring.style, { position: "absolute", inset: "-22px", borderRadius: "50%" });
    this.base.appendChild(ring);
    const zone = this.base;
    this.knob = document.createElement("div");
    Object.assign(this.knob.style, { position: "absolute", width: `${L.knob}px`, height: `${L.knob}px`, borderRadius: "50%", left: `${(L.stick - L.knob) / 2 - 2}px`, top: `${(L.stick - L.knob) / 2 - 2}px`, background: "rgba(255,160,160,0.6)" });
    this.base.dataset.stick = "look";
    this.knob.style.pointerEvents = "none";
    this.base.appendChild(this.knob);
    root.appendChild(this.base);
    this.home();
    zone.addEventListener("pointerdown", (ev) => {
      if (this.id !== null) return;
      ev.preventDefault(); ev.stopPropagation();
      this.id = ev.pointerId;
      zone.setPointerCapture(ev.pointerId);
      const r = this.base.getBoundingClientRect();
      this.origin = [r.left + r.width / 2, r.top + r.height / 2];
      this.move(ev.clientX, ev.clientY);
    });
    zone.addEventListener("pointermove", (ev) => { if (ev.pointerId === this.id) this.move(ev.clientX, ev.clientY); });
    const end = (ev: PointerEvent) => {
      if (ev.pointerId !== this.id) return;
      this.id = null;
      this.game.input.setAxis("look_x", 0);
      this.game.input.setAxis("look_y", 0);
      this.knob.style.transform = "";
    };
    zone.addEventListener("pointerup", end);
    zone.addEventListener("pointercancel", end);
  }

  setActive(on: boolean) {
    if (this.id !== null) on = true;
    this.base.style.transition = "opacity 180ms ease";
    this.base.style.opacity = on ? "" : "0";
    this.base.style.visibility = on ? "" : "hidden";
  }

  home() {
    const i = this.insets();
    this.base.style.right = `${i.right + this.L.stickX}px`;
    this.base.style.bottom = `${i.bottom + this.L.stickY}px`;
    this.base.style.transformOrigin = "100% 100%";
    this.base.style.scale = String(this.scale());
  }

  private move(x: number, y: number) {
    let dx = x - this.origin[0], dy = y - this.origin[1];
    const max = this.L.stick * 0.42 * this.scale();
    const len = Math.hypot(dx, dy);
    if (len > max) { dx = (dx / len) * max; dy = (dy / len) * max; }
    this.knob.style.transform = `translate(${dx / this.scale()}px, ${dy / this.scale()}px)`;
    const ax = dx / max, ay = dy / max;
    this.game.input.setAxis("look_x", Math.abs(ax) < 0.15 ? 0 : ax);
    this.game.input.setAxis("look_y", Math.abs(ay) < 0.15 ? 0 : ay);
  }
}

/**
 * Pointer on the game surface (the letterboxed canvas): feeds input.pointer() (reference/UI pixels) and world taps.
 * `toRef` maps canvas-local CSS px → reference px; `toWorld` maps canvas-local CSS px → world.
 */
export class PointerInput {
  private active = new Set<number>();
  private onDown = (ev: PointerEvent) => {
    this.active.add(ev.pointerId);
    const [rx, ry] = this.toRef(...this.local(ev));
    this.game.pointerDown(rx, ry);
    const [x, y] = this.local(ev);
    const [wx, wy] = this.toWorld(x, y);
    this.game.tapWorld(wx, wy);
  };
  private onMove = (ev: PointerEvent) => { if (this.active.has(ev.pointerId)) this.update(ev); };
  private onUp = (ev: PointerEvent) => {
    if (!this.active.delete(ev.pointerId)) return;
    // core keeps input.pointer() visible for one more tick, so a tap shorter than a frame is still seen
    const [rx, ry] = this.toRef(...this.local(ev));
    this.game.pointerUp(rx, ry);
  };

  constructor(private el: HTMLElement, private game: Game, private toWorld: (x: number, y: number) => [number, number], private toRef: (x: number, y: number) => [number, number]) {
    el.addEventListener("pointerdown", this.onDown);
    el.addEventListener("pointermove", this.onMove);
    el.addEventListener("pointerup", this.onUp);
    el.addEventListener("pointercancel", this.onUp);
  }

  private local(ev: PointerEvent): [number, number] {
    const r = this.el.getBoundingClientRect();
    return [ev.clientX - r.left, ev.clientY - r.top];
  }

  private update(ev: PointerEvent) {
    const [x, y] = this.toRef(...this.local(ev));
    this.game.pointerMove(x, y);
  }

  dispose() {
    this.el.removeEventListener("pointerdown", this.onDown);
    this.el.removeEventListener("pointermove", this.onMove);
    this.el.removeEventListener("pointerup", this.onUp);
    this.el.removeEventListener("pointercancel", this.onUp);
  }
}
