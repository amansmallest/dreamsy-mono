// Platform shell: the engine-owned pause button + menu (Resume, Restart, Leaderboard, Settings, Controls, Quit),
// the leaderboard results card shown after leaderboard.finish (DREAMSY.MD §13),
// themed from dreamsy.toml [ui]. Games never build their own pause/settings UI (format/LUAU_API.md).
import { DEFAULT_SETTINGS, formatBoardValue, type BoardOrder, type Game, type LeaderboardEntry, type LeaderboardEvent, type Settings } from "../core/index.js";
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

type View = "main" | "settings" | "controls" | "leaderboard";

export class Shell {
  readonly root: HTMLDivElement;
  readonly theme: Theme;
  private button: HTMLButtonElement;
  private overlay: HTMLDivElement;
  private panel: HTMLDivElement;
  private view: View = "main";
  private card: HTMLDivElement;
  private lbBoard: string | null = null;
  private unsubLb: () => void;

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
    this.card = el("div", {
      position: "absolute", inset: "0", display: "none", alignItems: "center", justifyContent: "center",
      background: "rgba(0,0,0,0.45)", pointerEvents: "auto", padding: "16px", boxSizing: "border-box",
    });
    this.card.dataset.dreamsyResults = "";
    this.card.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.unsubLb = game.onLeaderboard((ev) => { if (ev.finished) this.showResults(ev); });
    this.root.append(this.button, this.overlay, this.card);
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
    if (this.cardOpen) this.closeCard();
    else if (!this.isOpen) this.open();
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
        ...(this.game.usesLeaderboards ? [this.btn("Leaderboard", () => this.show("leaderboard"))] : []),
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
    } else if (view === "leaderboard") {
      const boards = this.game.leaderboardBoards;
      const board = this.lbBoard ?? this.game.lastBoard ?? boards[0] ?? "fastest";
      this.panel.append(title("Leaderboard"));
      if (boards.length > 1) {
        const tabs = el("div", { display: "flex", flexWrap: "wrap", gap: "6px", justifyContent: "center" });
        for (const b of boards) {
          const on = b === board;
          const tb = el("button", {
            border: "none", cursor: "pointer", padding: "6px 10px", font: `700 13px ${t.fontFamily}`, borderRadius: t.panel === "pixel" || t.panel === "sharp" ? "0" : "8px",
            background: on ? t.primary : withAlpha(t.text, 0.15), color: on ? onColor(t.primary, "#fff") : t.text,
          }, boardLabel(b));
          tb.addEventListener("pointerdown", (e) => e.stopPropagation());
          tb.addEventListener("click", (e) => { e.stopPropagation(); this.lbBoard = b; this.show("leaderboard"); });
          tabs.append(tb);
        }
        this.panel.append(tabs);
      } else this.panel.append(el("div", { textAlign: "center", opacity: "0.7", fontSize: "13px", marginTop: "-6px" }, boardLabel(board)));
      const list = el("div", { minHeight: "60px" }, "Loading…");
      this.panel.append(list, this.btn("Back", () => this.show("main"), true));
      this.game.leaderboardHost.top(board, "public", 10).then(
        (page) => { if (this.view === "leaderboard") list.replaceChildren(this.rows(page.entries, page.order, page.me?.runId, 10)); },
        () => { list.textContent = "Couldn't load the leaderboard."; },
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

  // ------------------------------------------------------------ leaderboard results card

  get cardOpen(): boolean { return this.card.style.display !== "none"; }

  closeCard() { this.card.style.display = "none"; this.card.replaceChildren(); }

  /** After leaderboard.finish: time, rank, PB, top 5, "Race the #1 ghost", "Play again". */
  showResults(ev: LeaderboardEvent) {
    const t = this.theme;
    const panel = el("div", {
      width: "min(380px, 100%)", maxHeight: "100%", overflowY: "auto", boxSizing: "border-box", padding: "20px 20px 16px",
      color: t.text, display: "flex", flexDirection: "column", gap: "10px", ...this.surface(withAlpha(t.background, 0.96), false),
    });
    const pixel = t.font === "pixel";
    panel.append(
      el("div", { textAlign: "center", fontSize: "13px", opacity: "0.7", textTransform: "uppercase", letterSpacing: "0.08em" }, boardLabel(ev.board)),
      el("div", { textAlign: "center", fontSize: pixel ? "30px" : "40px", fontWeight: "800", color: t.accent, fontVariantNumeric: "tabular-nums" }, formatBoardValue(ev.value, ev.order)),
    );
    const r = ev.result;
    const meta = el("div", { display: "flex", justifyContent: "center", alignItems: "center", gap: "10px", fontWeight: "700", fontSize: "16px" });
    if (r) {
      meta.append(el("span", {}, `Rank #${r.rank}`));
      if (r.personalBest) meta.append(el("span", { background: t.primary, color: onColor(t.primary, "#fff"), padding: "3px 8px", fontSize: "12px", borderRadius: t.panel === "pixel" || t.panel === "sharp" ? "0" : "999px" }, "NEW PB"));
      else meta.append(el("span", { opacity: "0.7", fontSize: "14px" }, `Record ${formatBoardValue(r.best, ev.order)}`));
    } else meta.append(el("span", { opacity: "0.75", fontSize: "14px" }, "Couldn't submit this run."));
    const list = el("div", { minHeight: "40px", fontSize: "14px", opacity: "0.8" }, r ? "Loading…" : "");
    const race = this.btn("Race the #1 ghost", () => { this.closeCard(); this.game.armGhost("best", ev.board); this.game.requestRestart(); });
    race.style.display = "none";
    panel.append(meta, list, race,
      this.btn("Play again", () => { this.closeCard(); this.game.requestRestart(); }, true),
      this.btn("Close", () => this.closeCard()));
    this.card.replaceChildren(panel);
    this.card.style.display = "flex";
    if (r) {
      this.game.leaderboardHost.top(ev.board, "public", 5).then(
        (page) => {
          if (!panel.isConnected) return;
          list.style.opacity = "1";
          list.replaceChildren(this.rows(page.entries, page.order, r.runId ?? page.me?.runId, 5));
          if (page.entries[0]?.hasGhost) race.style.display = "";
        },
        () => { list.textContent = ""; },
      );
    }
  }

  private rows(entries: LeaderboardEntry[], order: BoardOrder, meRunId: string | undefined, limit: number): HTMLElement {
    const t = this.theme;
    if (!entries.length) return el("div", { textAlign: "center", opacity: "0.7", padding: "8px" }, "No runs yet. Be the first!");
    const box = el("div", { display: "grid", gridTemplateColumns: "auto 1fr auto", gap: "6px 10px", fontSize: "15px", alignItems: "center" });
    for (const e of entries.slice(0, limit)) {
      const me = !!meRunId && e.runId === meRunId;
      const c = me ? t.accent : t.text;
      box.append(
        el("div", { fontWeight: "800", color: c, opacity: me ? "1" : "0.7" }, `#${e.rank}`),
        el("div", { color: c, fontWeight: me ? "800" : "600", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, e.user),
        el("div", { color: c, fontWeight: "700", fontVariantNumeric: "tabular-nums" }, formatBoardValue(e.value, order)),
      );
    }
    return box;
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
    this.unsubLb();
    this.root.remove();
  }
}

/** "track_3" → "Track 3", "fastest" → "Fastest". */
function boardLabel(b: string): string {
  const s = b.replace(/[_:.-]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, style: Partial<CSSStyleDeclaration>, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  Object.assign(e.style, style);
  if (text !== undefined) e.textContent = text;
  return e;
}
