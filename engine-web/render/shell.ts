// Platform shell: the engine-owned pause button + menu (Resume, Restart, Settings, Controls, Quit),
// themed from dreamsy.toml [ui]. Games never build their own pause/settings UI (format/LUAU_API.md).
import { DEFAULT_SETTINGS, type Game, type Settings } from "../core/index.js";
import type { InputUsage } from "../input/index.js";
import { onColor, panelSurface, resolveTheme, withAlpha, type Theme } from "./theme.js";

const STORAGE_KEY = "dreamsy.settings.v1";

export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (raw && typeof raw === "object") {
      const s = { ...DEFAULT_SETTINGS };
      for (const k of Object.keys(s) as (keyof Settings)[]) if (typeof raw[k] === typeof s[k]) (s as any)[k] = raw[k];
      return s;
    }
  } catch { /* private mode / blocked storage */ }
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(s: Settings) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

export interface ShellHooks {
  onPauseChange?: (paused: boolean) => void;
  onSettings?: (s: Settings) => void;
  /** "Quit": the host decides (close the game, go back to the feed, ...). */
  onQuit?: () => void;
}

type View = "main" | "settings" | "controls";

export class Shell {
  readonly root: HTMLDivElement;
  readonly theme: Theme;
  private button: HTMLButtonElement;
  private overlay: HTMLDivElement;
  private panel: HTMLDivElement;
  private view: View = "main";

  constructor(private container: HTMLElement, private game: Game, private usage: InputUsage, private hooks: ShellHooks = {}) {
    this.theme = resolveTheme(game.manifest);
    const t = this.theme;
    this.root = el("div", { position: "absolute", inset: "0", pointerEvents: "none", zIndex: "150000", fontFamily: t.fontFamily });
    this.root.dataset.dreamsyShell = "";

    this.button = el("button", {
      position: "absolute", top: "calc(env(safe-area-inset-top) + 12px)", right: "calc(env(safe-area-inset-right) + 12px)",
      width: "44px", height: "44px", padding: "0", display: "flex", alignItems: "center", justifyContent: "center", gap: "6px",
      pointerEvents: "auto", cursor: "pointer", touchAction: "manipulation", ...this.surface(withAlpha(t.background, 0.75), true),
    });
    this.button.setAttribute("aria-label", "Pause");
    for (let i = 0; i < 2; i++) this.button.append(el("span", { width: "5px", height: "16px", background: t.text, borderRadius: t.panel === "pixel" || t.panel === "sharp" ? "0" : "2px" }));
    this.button.addEventListener("pointerdown", (e) => { e.stopPropagation(); e.preventDefault(); this.open(); });

    this.overlay = el("div", {
      position: "absolute", inset: "0", display: "none", alignItems: "center", justifyContent: "center",
      background: "rgba(0,0,0,0.55)", pointerEvents: "auto", padding: "16px", boxSizing: "border-box",
    });
    this.overlay.addEventListener("pointerdown", (e) => { e.stopPropagation(); if (e.target === this.overlay) this.close(); });
    this.panel = el("div", {
      width: "min(400px, 100%)", maxHeight: "100%", overflowY: "auto", boxSizing: "border-box", padding: "22px 22px 18px",
      color: t.text, display: "flex", flexDirection: "column", gap: "10px", ...this.surface(withAlpha(t.background, 0.96), false),
    });
    this.overlay.append(this.panel);
    this.root.append(this.button, this.overlay);
    container.append(this.root);
    window.addEventListener("keydown", this.onKey, true);
  }

  /** Keep the pause button clear of the notch (insets in container px; default env()). */
  setInsets(i: { top: number; right: number }) {
    this.button.style.top = `${i.top + 12}px`;
    this.button.style.right = `${i.right + 12}px`;
  }

  get isOpen(): boolean { return this.overlay.style.display !== "none"; }

  private onKey = (e: KeyboardEvent) => {
    if (e.code !== "Escape" && e.code !== "KeyP") return;
    if ((e.target as HTMLElement)?.tagName === "INPUT" && e.code === "KeyP") return;
    e.preventDefault();
    e.stopPropagation();
    if (!this.isOpen) this.open();
    else if (this.view !== "main") this.show("main");
    else this.close();
  };

  open() {
    if (this.isOpen) return;
    this.game.pause();
    this.hooks.onPauseChange?.(true);
    this.overlay.style.display = "flex";
    this.button.style.visibility = "hidden";
    this.show("main");
  }

  close() {
    if (!this.isOpen) return;
    this.overlay.style.display = "none";
    this.button.style.visibility = "visible";
    this.game.resume();
    this.hooks.onPauseChange?.(false);
  }

  show(view: View) {
    this.view = view;
    const t = this.theme;
    this.panel.replaceChildren();
    const title = (text: string) => el("div", {
      fontSize: t.font === "pixel" ? "20px" : "26px", fontWeight: "800", textAlign: "center", margin: "0 0 8px", color: t.accent,
      letterSpacing: t.font === "pixel" ? "0.08em" : "0.01em", textTransform: t.font === "pixel" ? "uppercase" : "none",
    }, text);
    if (view === "main") {
      this.panel.append(
        title("Paused"),
        this.btn("Resume", () => this.close(), true),
        this.btn("Restart", () => { this.close(); this.game.requestRestart(); }),
        this.btn("Settings", () => this.show("settings")),
        this.btn("Controls", () => this.show("controls")),
        this.btn("Quit", () => {
          this.container.dispatchEvent(new CustomEvent("dreamsy:quit", { bubbles: true }));
          this.hooks.onQuit?.();
        }),
      );
    } else if (view === "settings") {
      const st = this.game.settings;
      this.panel.append(
        title("Settings"),
        this.slider("Music", st.music, (v) => this.set({ music: v })),
        this.slider("Sound effects", st.sfx, (v) => this.set({ sfx: v })),
        this.toggle("Mute all", st.mute, (v) => this.set({ mute: v })),
        this.toggle("Vibration", st.vibration, (v) => this.set({ vibration: v })),
        this.choice("Touch controls", [["S", 0.8], ["M", 1], ["L", 1.25]], st.touchSize, (v) => this.set({ touchSize: v })),
        this.btn("Back", () => this.show("main"), true),
      );
    } else {
      const rows: [string, string, string][] = [];
      if (this.usage.move) rows.push(["Move", "Arrows / WASD", "Left joystick"]);
      const keys: Record<string, [string, string]> = { jump: ["Jump", "Space / Z / Up"], action: ["Action", "E / J / Enter"], action2: ["Action 2", "Q / K / C"] };
      const touch: Record<string, string> = { jump: "A button", action: "B button", action2: "C button" };
      for (const b of ["jump", "action", "action2"]) if (this.usage.buttons.has(b)) rows.push([keys[b]![0], keys[b]![1], touch[b]!]);
      rows.push(["Tap / click", "Mouse", "Tap the screen"], ["Pause", "Esc / P", "Pause button"]);
      const table = el("div", { display: "grid", gridTemplateColumns: "auto 1fr 1fr", gap: "8px 12px", fontSize: "14px", margin: "4px 0 8px" });
      for (const h of ["", "Keyboard", "Touch"]) table.append(el("div", { opacity: "0.6", fontSize: "12px", textTransform: "uppercase" }, h));
      for (const [a, k, tc] of rows) table.append(el("div", { fontWeight: "700", color: t.accent }, a), el("div", {}, k), el("div", {}, tc));
      this.panel.append(title("Controls"), table, this.btn("Back", () => this.show("main"), true));
    }
  }

  private set(patch: Partial<Settings>) {
    this.game.settings = { ...this.game.settings, ...patch };
    saveSettings(this.game.settings);
    this.hooks.onSettings?.(this.game.settings);
  }

  // ------------------------------------------------------------ themed widgets

  /** Panel/button surface for the theme's panel style. */
  private surface(bg: string, small: boolean): Partial<CSSStyleDeclaration> {
    return panelSurface(this.theme, bg, small);
  }

  private btn(label: string, fn: () => void, primary = false): HTMLButtonElement {
    const t = this.theme;
    const bg = primary ? t.primary : withAlpha(t.text, 0.12);
    const b = el("button", {
      font: `700 ${t.font === "pixel" ? 15 : 18}px ${t.fontFamily}`, letterSpacing: t.font === "pixel" ? "0.06em" : "0",
      textTransform: t.font === "pixel" ? "uppercase" : "none", color: primary ? onColor(t.primary, "#ffffff") : t.text,
      padding: "13px 16px", cursor: "pointer", width: "100%", boxSizing: "border-box", ...this.surface(bg, true),
      ...(t.panel === "outlined" ? { background: primary ? t.primary : "transparent", border: `2px solid ${primary ? t.primary : t.text}` } : {}),
    }, label);
    b.addEventListener("pointerdown", (e) => e.stopPropagation());
    b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
    return b;
  }

  private row(label: string, control: HTMLElement): HTMLElement {
    const r = el("label", { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", fontSize: "15px", fontWeight: "700", padding: "4px 2px" });
    r.append(el("span", {}, label), control);
    return r;
  }

  private slider(label: string, value: number, onChange: (v: number) => void): HTMLElement {
    const i = document.createElement("input");
    i.type = "range"; i.min = "0"; i.max = "100"; i.value = String(Math.round(value * 100));
    Object.assign(i.style, { width: "55%", accentColor: this.theme.primary, cursor: "pointer" });
    i.addEventListener("input", () => onChange(Number(i.value) / 100));
    i.addEventListener("pointerdown", (e) => e.stopPropagation());
    return this.row(label, i);
  }

  private toggle(label: string, value: boolean, onChange: (v: boolean) => void): HTMLElement {
    const t = this.theme;
    let on = value;
    const knob = el("span", { position: "absolute", top: "3px", width: "20px", height: "20px", background: t.text, borderRadius: t.panel === "pixel" || t.panel === "sharp" ? "0" : "50%", transition: "left .12s" });
    const sw = el("button", { position: "relative", width: "48px", height: "26px", border: "none", padding: "0", cursor: "pointer", borderRadius: t.panel === "pixel" || t.panel === "sharp" ? "0" : "13px" });
    sw.append(knob);
    const paint = () => { sw.style.background = on ? t.primary : withAlpha(t.text, 0.25); knob.style.left = on ? "25px" : "3px"; sw.setAttribute("aria-pressed", String(on)); };
    paint();
    sw.addEventListener("pointerdown", (e) => e.stopPropagation());
    sw.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); on = !on; paint(); onChange(on); });
    return this.row(label, sw);
  }

  private choice(label: string, options: [string, number][], value: number, onChange: (v: number) => void): HTMLElement {
    const t = this.theme;
    const group = el("div", { display: "flex", gap: "6px" });
    const btns = options.map(([name, v]) => {
      const b = el("button", { width: "38px", height: "32px", border: "none", cursor: "pointer", font: `700 14px ${t.fontFamily}`, borderRadius: t.panel === "pixel" || t.panel === "sharp" ? "0" : "8px" }, name);
      b.addEventListener("pointerdown", (e) => e.stopPropagation());
      b.addEventListener("click", (e) => { e.stopPropagation(); value = v; paint(); onChange(v); });
      return [b, v] as const;
    });
    const paint = () => { for (const [b, v] of btns) { b.style.background = v === value ? t.primary : withAlpha(t.text, 0.15); b.style.color = v === value ? onColor(t.primary, "#fff") : t.text; } };
    paint();
    group.append(...btns.map(([b]) => b));
    return this.row(label, group);
  }

  dispose() {
    window.removeEventListener("keydown", this.onKey, true);
    this.root.remove();
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, style: Partial<CSSStyleDeclaration>, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  Object.assign(e.style, style);
  if (text !== undefined) e.textContent = text;
  return e;
}
