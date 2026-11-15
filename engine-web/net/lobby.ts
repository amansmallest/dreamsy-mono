// Engine-owned multiplayer UI (like the pause menu; themed by [ui]): lobby (quick match 1v1, create room + share link,
// join with code, solo), room screen (players with red/blue teams, ready, start), in-match HUD (team chip, scores,
// room code) and the match results card (winner, rematch, leave). Browser only.
import type { Theme } from "../core/theme.js";
import { onColor, panelSurface, withAlpha } from "../render/theme.js";
import { RoomClient, RoomError } from "./client.js";
import { CODE_RE, normalizeCode, TEAM_COLORS, type MatchResult, type RoomInfo, type ServerMsg, type Team } from "./protocol.js";

export interface LobbyOptions {
  container: HTMLElement;
  theme: Theme;
  /** Room "game" key: the API game id, or local:<path> in dev. */
  gameKey: string;
  gameName: string;
  /** [players] max/min from the manifest. */
  max: number;
  min: number;
  roomsUrl: string;
  /** API user token (creates a guest account when signed out). */
  getToken(): Promise<string>;
  /** Share link for a room code. */
  shareUrl(code: string): string;
  /** ?room=<code>: join it right away. */
  initialCode?: string | null;
  /** A match started (first or rematch): (re)start the game with client.link(). */
  onStart(client: RoomClient, room: RoomInfo): void;
  /** Leave multiplayer: run the game single-player. */
  onSolo(): void;
  /** A match ended or the room was left: stop the running game (optional). */
  onStop?(): void;
}

type Screen = "menu" | "busy" | "queue" | "room" | "playing" | "results";
const NAME_KEY = "dreamsy.mp.name";

export class Lobby {
  readonly root: HTMLDivElement;
  private panel: HTMLDivElement;
  private hud: HTMLDivElement;
  private client: RoomClient | null = null;
  private screen: Screen = "menu";
  private room: RoomInfo | null = null;
  private result: MatchResult | null = null;
  private status = "";
  private off: (() => void) | null = null;
  private codeInput = "";
  private t: Theme;

  constructor(private o: LobbyOptions) {
    const t = (this.t = o.theme);
    this.root = el("div", { position: "absolute", inset: "0", zIndex: "160000", display: "flex", alignItems: "center", justifyContent: "center",
      background: "rgba(0,0,0,0.6)", padding: "16px", boxSizing: "border-box", fontFamily: t.fontFamily, color: t.text });
    this.root.dataset.dreamsyLobby = "";
    for (const ev of ["pointerdown", "pointerup", "touchstart", "keydown"]) this.root.addEventListener(ev, (e) => e.stopPropagation());
    this.panel = el("div", { width: "min(420px, 100%)", maxHeight: "100%", overflowY: "auto", boxSizing: "border-box", padding: "22px 20px 18px",
      display: "flex", flexDirection: "column", gap: "10px", ...panelSurface(t, withAlpha(t.background, 0.97), false) });
    this.root.append(this.panel);
    this.hud = el("div", { position: "absolute", left: "calc(env(safe-area-inset-left) + 12px)", top: "calc(env(safe-area-inset-top) + 12px)",
      zIndex: "140000", display: "none", gap: "6px", flexWrap: "wrap", pointerEvents: "none", fontFamily: t.fontFamily, maxWidth: "calc(100% - 90px)" });
    this.hud.dataset.dreamsyRoomHud = "";
    o.container.append(this.root, this.hud);
    if (o.initialCode && CODE_RE.test(normalizeCode(o.initialCode))) void this.join(normalizeCode(o.initialCode));
    else this.render();
  }

  get inMatch(): boolean { return this.screen === "playing"; }

  dispose() {
    this.off?.();
    this.client?.close();
    this.root.remove();
    this.hud.remove();
  }

  // ------------------------------------------------------------ actions

  private async connect(): Promise<RoomClient> {
    if (this.client && !this.client.closed) return this.client;
    this.go("busy", "Connecting…");
    const token = await this.o.getToken();
    const c = await RoomClient.connect(this.o.roomsUrl, token, this.name() || undefined);
    this.client = c;
    this.off = c.on((m) => this.onMsg(m));
    return c;
  }

  private async run(label: string, fn: (c: RoomClient) => void) {
    try {
      const c = await this.connect();
      this.go("busy", label);
      fn(c);
    } catch (e) {
      this.go("menu", e instanceof RoomError ? friendly(e.code, e.message) : `Couldn't connect: ${(e as Error).message}`);
    }
  }

  private quick() { void this.run("Finding a player…", (c) => c.quick(this.o.gameKey)); }
  private create() { void this.run("Creating room…", (c) => c.create(this.o.gameKey, this.o.max, { min: this.o.min, mode: "party" })); }
  private join(code: string) { return this.run("Joining…", (c) => c.join(code, this.o.gameKey)); }

  private leave() {
    this.client?.leave();
    this.room = null;
    this.result = null;
    this.o.onStop?.();
    this.go("menu", "");
  }

  private onMsg(m: ServerMsg) {
    switch (m.t) {
      case "queued": this.go("queue", ""); break;
      case "room":
        this.room = m.room;
        if (this.screen === "playing" || this.screen === "results") this.renderHud();
        else this.go("room", "");
        break;
      case "start":
        this.room = m.room;
        this.result = null;
        this.go("playing", "");
        this.o.onStart(this.client!, m.room);
        break;
      case "score":
        if (this.room) { this.room.scores[m.k] = m.v; this.renderHud(); }
        break;
      case "ended":
        this.result = m.r;
        this.go("results", "");
        break;
      case "left": if (this.screen !== "menu") this.go("menu", ""); break;
      case "error":
        if (m.code === "rate_limited") break;
        if (m.message.startsWith("closed:")) { this.client = null; this.room = null; this.o.onStop?.(); this.go("menu", "Disconnected from the room server."); break; }
        if (this.screen === "busy" || this.screen === "queue") this.go(this.room ? "room" : "menu", friendly(m.code, m.message));
        else { this.status = friendly(m.code, m.message); this.render(); }
        break;
      default: break;
    }
  }

  private go(s: Screen, status: string) {
    this.screen = s;
    this.status = status;
    this.render();
  }

  // ------------------------------------------------------------ rendering

  private render() {
    const show = this.screen !== "playing";
    this.root.style.display = show ? "flex" : "none";
    this.renderHud();
    if (!show) return;
    const p = this.panel;
    p.replaceChildren();
    const t = this.t;
    p.append(el("div", { font: `800 ${t.font === "pixel" ? 16 : 22}px ${t.fontFamily}`, textAlign: "center", lineHeight: "1.3" }, this.o.gameName));
    switch (this.screen) {
      case "menu": {
        p.append(this.sub(`Multiplayer · up to ${this.o.max} players`));
        p.append(this.nameField());
        p.append(this.btn("Quick match 1v1", () => this.quick(), true));
        p.append(this.btn("Create room", () => this.create()));
        const row = el("div", { display: "flex", gap: "8px" });
        const input = document.createElement("input");
        Object.assign(input.style, this.inputStyle(), { flex: "1", textTransform: "uppercase", letterSpacing: "0.2em", textAlign: "center" });
        input.placeholder = "CODE";
        input.maxLength = 6;
        input.value = this.codeInput;
        input.autocapitalize = "characters";
        input.addEventListener("input", () => { this.codeInput = normalizeCode(input.value); input.value = this.codeInput; });
        input.addEventListener("keydown", (e) => { if (e.key === "Enter" && CODE_RE.test(this.codeInput)) void this.join(this.codeInput); });
        const j = this.btn("Join", () => { if (CODE_RE.test(this.codeInput)) void this.join(this.codeInput); else this.flash("Enter the 6-letter room code."); });
        j.style.width = "auto";
        row.append(input, j);
        p.append(row);
        p.append(this.btn("Play solo", () => { this.dispose(); this.o.onSolo(); }));
        break;
      }
      case "busy": p.append(this.sub(this.status || "…")); this.status = ""; p.append(this.btn("Cancel", () => this.leave())); break;
      case "queue":
        p.append(this.sub("Finding an opponent…"), this.spinner());
        p.append(this.btn("Cancel", () => { this.client?.cancel(); this.go("menu", ""); }));
        break;
      case "room": this.renderRoom(p); break;
      case "results": this.renderResults(p); break;
    }
    if (this.status && this.screen !== "busy") p.append(el("div", { fontSize: "13px", textAlign: "center", color: "#ff8a8a", lineHeight: "1.4" }, this.status));
  }

  private renderRoom(p: HTMLElement) {
    const r = this.room;
    const c = this.client;
    if (!r || !c) return;
    const t = this.t;
    p.append(this.sub(r.mode === "duel" ? "1v1 · red vs blue" : `Room · ${r.players.length}/${r.max} players`));
    const codeBox = el("div", { textAlign: "center", font: `800 ${t.font === "pixel" ? 22 : 32}px ${t.fontFamily}`, letterSpacing: "0.25em", padding: "6px 0" }, r.code);
    p.append(codeBox);
    if (r.mode === "party" && r.players.length < r.max) {
      const url = this.o.shareUrl(r.code);
      p.append(this.btn("Share invite link", () => void share(url, this.o.gameName).then((how) => this.flash(how)), true));
      p.append(el("div", { fontSize: "11px", textAlign: "center", opacity: "0.7", wordBreak: "break-all" }, url));
    }
    const list = el("div", { display: "flex", flexDirection: "column", gap: "6px", margin: "4px 0" });
    for (const pl of r.players) {
      const me = pl.id === c.self;
      const row = el("div", { display: "flex", alignItems: "center", gap: "10px", padding: "8px 10px", borderRadius: t.panel === "pixel" || t.panel === "sharp" ? "0" : "10px",
        background: withAlpha(pl.team ? TEAM_COLORS[pl.team] : t.text, 0.18), border: `2px solid ${pl.team ? TEAM_COLORS[pl.team] : "transparent"}` });
      row.append(el("span", { width: "12px", height: "12px", borderRadius: "50%", background: pl.team ? TEAM_COLORS[pl.team] : t.text, flex: "none" }));
      row.append(el("span", { flex: "1", fontWeight: "700", fontSize: "15px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
        `${pl.name}${me ? " (you)" : ""}${pl.id === r.host ? " ★" : ""}`));
      row.append(el("span", { fontSize: "12px", fontWeight: "700", opacity: "0.85" }, pl.id === r.host ? "HOST" : pl.ready ? "READY" : "…"));
      list.append(row);
    }
    p.append(list);
    const mine = r.players.find((x) => x.id === c.self);
    if (r.mode === "party" && mine) {
      const other: Team = mine.team === "red" ? "blue" : "red";
      p.append(this.btn(`Switch to ${other}`, () => c.team(other)));
    }
    if (r.host === c.self && r.mode === "party") {
      const waiting = r.players.filter((x) => x.id !== c.self && !x.ready).length;
      const enough = r.players.length >= r.min;
      const b = this.btn(!enough ? `Waiting for players (${r.players.length}/${r.min})` : waiting ? `Waiting for ${waiting} to be ready` : "Start", () => c.start(), enough && !waiting);
      b.disabled = !enough || waiting > 0;
      b.style.opacity = b.disabled ? "0.6" : "1";
      p.append(b);
    } else if (mine) {
      p.append(this.btn(mine.ready ? "Not ready" : r.mode === "duel" ? "Rematch" : "Ready", () => c.ready(!mine.ready), !mine.ready));
    }
    p.append(this.btn("Leave room", () => this.leave()));
  }

  private renderResults(p: HTMLElement) {
    const r = this.result, room = this.room, c = this.client;
    if (!r || !c) return;
    const t = this.t;
    const meTeam = room?.players.find((x) => x.id === c.self)?.team ?? null;
    const name = (id: string | null) => room?.players.find((x) => x.id === id)?.name ?? "Player";
    const won = r.winner === c.self || (!r.winner && r.team !== null && r.team === meTeam);
    const color = r.team ? TEAM_COLORS[r.team] : t.primary;
    const headline = r.draw ? "Draw!" : won ? "You win!" : r.team && (room?.players.filter((x) => x.team === r.team).length ?? 0) > 1 && !r.winner
      ? `${r.team.toUpperCase()} wins!` : `${r.winner ? name(r.winner) : (r.team ?? "").toUpperCase()} wins!`;
    const banner = el("div", { textAlign: "center", padding: "14px 8px", font: `900 ${t.font === "pixel" ? 22 : 34}px ${t.fontFamily}`,
      color: onColor(color, "#ffffff"), background: color, ...(t.panel === "pixel" || t.panel === "sharp" ? {} : { borderRadius: "14px" }) }, headline);
    p.append(banner);
    if (r.team && !r.draw) p.append(this.sub(`${r.team === "red" ? "Red" : "Blue"} team${r.reason === "forfeit" ? " · the other side left" : ""}`));
    const scores = Object.entries(r.scores);
    if (scores.length) {
      const box = el("div", { display: "flex", flexDirection: "column", gap: "4px", fontSize: "15px", fontWeight: "700" });
      for (const [k, v] of scores.sort((a, b) => b[1] - a[1])) {
        const label = k === "red" || k === "blue" ? k.toUpperCase() : name(k);
        const col = k === "red" || k === "blue" ? TEAM_COLORS[k] : (room?.players.find((x) => x.id === k)?.team ? TEAM_COLORS[room!.players.find((x) => x.id === k)!.team!] : t.text);
        const row = el("div", { display: "flex", justifyContent: "space-between", color: col });
        row.append(el("span", {}, label), el("span", {}, String(v)));
        box.append(row);
      }
      p.append(box);
    }
    if (room?.mode === "duel") p.append(this.btn("Rematch", () => { c.ready(true); this.go("room", ""); }, true));
    else p.append(this.btn("Back to room", () => { this.o.onStop?.(); this.go("room", ""); }, true));
    p.append(this.btn("Leave", () => this.leave()));
  }

  private renderHud() {
    const h = this.hud;
    const r = this.room, c = this.client;
    if (this.screen !== "playing" && this.screen !== "results" || !r || !c) { h.style.display = "none"; return; }
    h.style.display = "flex";
    h.replaceChildren();
    const me = r.players.find((x) => x.id === c.self);
    const chip = (text: string, bg: string) => el("span", { padding: "5px 9px", font: `800 ${this.t.font === "pixel" ? 10 : 13}px ${this.t.fontFamily}`,
      color: onColor(bg, "#ffffff"), background: bg, borderRadius: this.t.panel === "pixel" || this.t.panel === "sharp" ? "0" : "999px",
      boxShadow: "0 2px 6px rgba(0,0,0,0.35)", whiteSpace: "nowrap" }, text);
    if (me?.team) h.append(chip(`${me.team.toUpperCase()} · YOU`, TEAM_COLORS[me.team]));
    for (const [k, v] of Object.entries(r.scores)) {
      if (k === "red" || k === "blue") h.append(chip(`${k.toUpperCase()} ${v}`, TEAM_COLORS[k]));
      else {
        const pl = r.players.find((x) => x.id === k);
        if (pl) h.append(chip(`${pl.id === c.self ? "You" : pl.name} ${v}`, pl.team ? TEAM_COLORS[pl.team] : "#444444"));
      }
    }
    if (r.mode === "party") h.append(chip(`ROOM ${r.code} · ${r.players.length}/${r.max}`, "rgba(0,0,0,0.55)"));
  }

  // ------------------------------------------------------------ bits

  private name(): string {
    try { return localStorage.getItem(NAME_KEY) ?? ""; } catch { return ""; }
  }

  private nameField(): HTMLElement {
    const input = document.createElement("input");
    Object.assign(input.style, this.inputStyle());
    input.placeholder = "Your name (shown to others)";
    input.maxLength = 20;
    input.value = this.name();
    input.addEventListener("input", () => { try { localStorage.setItem(NAME_KEY, input.value.trim()); } catch { /* private mode */ } });
    return input;
  }

  private inputStyle(): Partial<CSSStyleDeclaration> {
    const t = this.t;
    return { font: `700 16px ${t.fontFamily}`, padding: "12px", boxSizing: "border-box", width: "100%", color: t.text, background: withAlpha(t.text, 0.08),
      border: `2px solid ${withAlpha(t.text, 0.35)}`, borderRadius: t.panel === "pixel" || t.panel === "sharp" ? "0" : "12px", outline: "none" };
  }

  private sub(text: string): HTMLElement {
    return el("div", { textAlign: "center", fontSize: "14px", opacity: "0.85", lineHeight: "1.4" }, text);
  }

  private spinner(): HTMLElement {
    const s = el("div", { alignSelf: "center", width: "28px", height: "28px", border: `4px solid ${withAlpha(this.t.text, 0.25)}`, borderTopColor: this.t.primary, borderRadius: "50%" });
    s.animate?.([{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }], { duration: 900, iterations: Infinity });
    return s;
  }

  private flash(text: string) { this.status = text; this.render(); }

  private btn(label: string, fn: () => void, primary = false): HTMLButtonElement {
    const t = this.t;
    const bg = primary ? t.primary : withAlpha(t.text, 0.12);
    const b = el("button", {
      font: `700 ${t.font === "pixel" ? 14 : 17}px ${t.fontFamily}`, letterSpacing: t.font === "pixel" ? "0.06em" : "0",
      textTransform: t.font === "pixel" ? "uppercase" : "none", color: primary ? onColor(t.primary, "#ffffff") : t.text,
      padding: "13px 16px", cursor: "pointer", width: "100%", boxSizing: "border-box", touchAction: "manipulation", ...panelSurface(t, bg, true),
      ...(t.panel === "outlined" ? { background: primary ? t.primary : "transparent", border: `2px solid ${primary ? t.primary : t.text}` } : {}),
    }, label);
    b.addEventListener("click", (e) => { e.stopPropagation(); if (!b.disabled) fn(); });
    return b;
  }
}

/** Native share sheet (phones), else clipboard. Returns what happened, for a status line. */
async function share(url: string, title: string): Promise<string> {
  const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
  if (nav.share) {
    try { await nav.share({ title: `Play ${title} with me`, url }); return ""; } catch { /* cancelled */ }
  }
  try { await navigator.clipboard.writeText(url); return "Link copied — send it to your family or friends."; } catch { return "Copy the link below."; }
}

function friendly(code: string, message: string): string {
  switch (code) {
    case "not_found": return "No room with that code.";
    case "full": return "That room is full.";
    case "wrong_game": return "That code is for a different game.";
    case "unauthorized": return "Couldn't sign you in for multiplayer.";
    case "closed": return message.startsWith("can't") || message.startsWith("the room") ? "The room server is offline. Try again soon." : message;
    default: return message;
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, style: Partial<CSSStyleDeclaration>, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  Object.assign(e.style, style);
  if (text !== undefined) e.textContent = text;
  return e;
}
