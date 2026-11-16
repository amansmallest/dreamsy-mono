// Engine-owned multiplayer UI (like the pause menu; themed by [ui]): lobby (quick match 1v1, create room + share link,
// join with an on-screen code keypad, solo), room screen (players with red/blue teams, ready, start, spectator count,
// invite friends), in-match HUD (team chip, scores, room code; spectators: SPECTATING chip + player chips to switch the
// camera) and the match results card (winner, rematch, leave). State lives in ./lobby-model.ts. Browser only.
import type { Theme } from "../core/theme.js";
import { onColor, panelSurface, withAlpha } from "../render/theme.js";
import { RoomClient } from "./client.js";
import { fetchFriends, presenceLabel, sendInvite, type Friend, type InviteTarget } from "./invites.js";
import { keepAboveKeyboard } from "./keyboard-safe.js";
import { KEYPAD_ROWS } from "./keypad.js";
import { LobbyModel, type LobbyConn } from "./lobby-model.js";
import { TEAM_COLORS, type RoomInfo, type Team } from "./protocol.js";

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
  /** ?room=<code>: join it right away (skips the menu). */
  initialCode?: string | null;
  /** ?spectate=1 (with ?room=): watch instead of joining. */
  initialSpectate?: boolean;
  /** Signed-in user + API game id: the room screen offers "Invite friends". null/absent: hidden. */
  invites?: InviteTarget | null;
  /** A match started (first or rematch): (re)start the game with client.link(). */
  onStart(client: LobbyConn, room: RoomInfo): void;
  /** Leave multiplayer: run the game single-player. */
  onSolo(): void;
  /** A match ended or the room was left: stop the running game (optional). */
  onStop?(): void;
  /** Spectators: follow this player with the camera. */
  onFocus?(playerId: string): void;
}

const NAME_KEY = "dreamsy.mp.name";
const EYE_SVG = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 12S5.5 4.5 12 4.5 22.5 12 22.5 12 18.5 19.5 12 19.5 1.5 12 1.5 12z"/><circle cx="12" cy="12" r="3.2"/></svg>`;

export class Lobby {
  readonly root: HTMLDivElement;
  readonly model: LobbyModel;
  private panel: HTMLDivElement;
  private hud: HTMLDivElement;
  private t: Theme;
  private focus: string | null = null;
  private friends: Friend[] | null = null;
  private friendsFor = "";
  private inviteOpen = false;
  private invited = new Map<string, string>();
  private disposers: (() => void)[] = [];

  constructor(private o: LobbyOptions) {
    const t = (this.t = o.theme);
    this.root = el("div", { position: "absolute", inset: "0", zIndex: "160000", display: "flex", alignItems: "center", justifyContent: "center",
      background: "rgba(0,0,0,0.6)", padding: "16px", boxSizing: "border-box", fontFamily: t.fontFamily, color: t.text });
    this.root.dataset.dreamsyLobby = "";
    for (const ev of ["pointerdown", "pointerup", "touchstart", "keydown"]) this.root.addEventListener(ev, (e) => e.stopPropagation());
    this.panel = el("div", { width: "min(420px, 100%)", maxHeight: "100%", overflowY: "auto", boxSizing: "border-box", padding: "22px 20px 18px",
      display: "flex", flexDirection: "column", gap: "10px", transition: "transform .15s ease-out", ...panelSurface(t, withAlpha(t.background, 0.97), false) });
    this.root.append(this.panel);
    this.hud = el("div", { position: "absolute", left: "calc(env(safe-area-inset-left) + 12px)", top: "calc(env(safe-area-inset-top) + 12px)",
      zIndex: "140000", display: "none", gap: "6px", flexWrap: "wrap", pointerEvents: "none", fontFamily: t.fontFamily, maxWidth: "calc(100% - 90px)" });
    this.hud.dataset.dreamsyRoomHud = "";
    o.container.append(this.root, this.hud);
    this.disposers.push(keepAboveKeyboard(this.root, this.panel));
    // desktop: type / paste the code on the keypad screen with a real keyboard
    const onKey = (e: KeyboardEvent) => {
      if (this.model.screen !== "join" || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "Escape") this.model.closeKeypad();
      else if (this.model.code.press(e.key)) e.preventDefault();
    };
    const onPaste = (e: ClipboardEvent) => {
      if (this.model.screen !== "join") return;
      const text = e.clipboardData?.getData("text") ?? "";
      if (text) { e.preventDefault(); this.model.code.paste(text); }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("paste", onPaste);
    this.disposers.push(() => { window.removeEventListener("keydown", onKey); window.removeEventListener("paste", onPaste); });

    this.model = new LobbyModel({
      gameKey: o.gameKey, max: o.max, min: o.min,
      initial: o.initialCode ? { code: o.initialCode, spectate: !!o.initialSpectate } : null,
      connect: async () => RoomClient.connect(o.roomsUrl, await o.getToken(), this.name() || undefined),
      onStart: (c, room) => { this.focus = null; o.onStart(c, room); },
      onStop: () => o.onStop?.(),
      onChange: () => this.render(),
    });
    void this.model.begin();
  }

  get inMatch(): boolean { return this.model.inMatch; }

  dispose() {
    this.model.dispose();
    for (const d of this.disposers) d();
    this.root.remove();
    this.hud.remove();
  }

  // ------------------------------------------------------------ rendering

  private render() {
    const m = this.model;
    const show = m.screen !== "playing";
    this.root.style.display = show ? "flex" : "none";
    this.renderHud();
    if (!show) return;
    const p = this.panel;
    p.replaceChildren();
    const t = this.t;
    p.append(el("div", { font: `800 ${t.font === "pixel" ? 16 : 22}px ${t.fontFamily}`, textAlign: "center", lineHeight: "1.3" }, this.o.gameName));
    switch (m.screen) {
      case "menu": {
        p.append(this.sub(`Multiplayer · up to ${this.o.max} players`));
        p.append(this.nameField());
        p.append(this.btn("Quick match 1v1", () => void m.quick(), true));
        p.append(this.btn("Create room", () => void m.create()));
        p.append(this.btn("Join with a code", () => m.openKeypad()));
        p.append(this.btn("Play solo", () => { this.dispose(); this.o.onSolo(); }));
        break;
      }
      case "join": this.renderKeypad(p); break;
      case "busy": p.append(this.sub(m.status || "…"), this.spinner()); m.status = ""; p.append(this.btn("Cancel", () => m.leave())); break;
      case "queue":
        p.append(this.sub("Finding an opponent…"), this.spinner());
        p.append(this.btn("Cancel", () => m.cancelQueue()));
        break;
      case "room": if (this.inviteOpen) this.renderInvites(p); else this.renderRoom(p); break;
      case "results": this.renderResults(p); break;
    }
    if (m.status && m.screen !== "busy") p.append(el("div", { fontSize: "13px", textAlign: "center", color: "#ff8a8a", lineHeight: "1.4" }, m.status));
  }

  /** On-screen keypad: 6 slots, the code alphabet only (no system keyboard), paste, auto-join on the 6th key. */
  private renderKeypad(p: HTMLElement) {
    const t = this.t, m = this.model;
    const sharp = t.panel === "pixel" || t.panel === "sharp";
    p.append(this.sub("Enter the room code"));
    const slots = el("div", { display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: "6px", margin: "2px 0 4px" });
    slots.dataset.dreamsyCodeSlots = "";
    m.code.slots().forEach((ch, i) => {
      const active = i === m.code.length;
      slots.append(el("div", { height: "52px", display: "flex", alignItems: "center", justifyContent: "center", font: `800 ${t.font === "pixel" ? 20 : 26}px ${t.fontFamily}`,
        background: withAlpha(t.text, 0.08), border: `2px solid ${active ? t.primary : withAlpha(t.text, ch ? 0.6 : 0.25)}`, borderRadius: sharp ? "0" : "10px" }, ch));
    });
    p.append(slots);
    const pad = el("div", { display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: "6px" });
    pad.dataset.dreamsyKeypad = "";
    for (const row of KEYPAD_ROWS) {
      for (const k of row) {
        const back = k === "⌫";
        const b = el("button", { minHeight: "48px", minWidth: "0", padding: "0", font: `800 ${back ? 20 : t.font === "pixel" ? 15 : 19}px ${t.fontFamily}`,
          color: t.text, cursor: "pointer", touchAction: "manipulation", userSelect: "none", webkitUserSelect: "none", border: "none",
          background: withAlpha(t.text, back ? 0.2 : 0.12), borderRadius: sharp ? "0" : "10px", gridColumn: back ? "span 1" : "auto" }, k);
        b.setAttribute("aria-label", back ? "Delete" : k);
        b.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); m.code.press(k); });
        b.addEventListener("click", (e) => { e.stopPropagation(); if (e.detail === 0) m.code.press(k); }); // keyboard activation
        pad.append(b);
      }
    }
    p.append(pad);
    const clip = (navigator as Navigator & { clipboard?: Clipboard }).clipboard;
    if (clip?.readText) {
      p.append(this.btn("Paste code", () => {
        void clip.readText().then((text) => { if (!m.code.paste(text)) m.flash("No room code on the clipboard."); })
          .catch(() => m.flash("Can't read the clipboard — type the code."));
      }));
    }
    p.append(this.btn("Back", () => m.closeKeypad()));
  }

  private renderRoom(p: HTMLElement) {
    const m = this.model;
    const r = m.room, c = m.client;
    if (!r || !c) return;
    const t = this.t;
    const watching = m.spectating;
    p.append(this.sub(watching ? `Watching · ${r.players.length} player${r.players.length === 1 ? "" : "s"}`
      : r.mode === "duel" ? "1v1 · red vs blue" : `Room · ${r.players.length}/${r.max} players`));
    p.append(el("div", { textAlign: "center", font: `800 ${t.font === "pixel" ? 22 : 32}px ${t.fontFamily}`, letterSpacing: "0.25em", padding: "6px 0" }, r.code));
    if (r.spectators > 0) p.append(this.watchers(r.spectators));
    if (!watching && r.mode === "party" && r.players.length < r.max) {
      const url = this.o.shareUrl(r.code);
      p.append(this.btn("Share invite link", () => void share(url, this.o.gameName).then((how) => m.flash(how)), true));
      p.append(el("div", { fontSize: "11px", textAlign: "center", opacity: "0.7", wordBreak: "break-all" }, url));
    }
    if (!watching && this.o.invites) {
      this.loadFriends(r.code);
      if (this.friends) p.append(this.btn("Invite friends", () => { this.inviteOpen = true; this.friendsFor = ""; this.loadFriends(r.code); this.render(); }));
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
    if (watching) {
      p.append(this.sub(r.status === "playing" ? "The match is on — loading…" : "Waiting for the match to start…"));
      p.append(this.btn("Stop watching", () => m.leave()));
      return;
    }
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
    p.append(this.btn("Leave room", () => { this.inviteOpen = false; this.friends = null; this.friendsFor = ""; m.leave(); }));
  }

  /** Friends list with Invite buttons (GET /v1/me/friends, POST /v1/invites). */
  private renderInvites(p: HTMLElement) {
    const r = this.model.room, inv = this.o.invites;
    if (!r || !inv) { this.inviteOpen = false; return; }
    const t = this.t;
    p.append(this.sub(`Invite friends to room ${r.code}`));
    const list = el("div", { display: "flex", flexDirection: "column", gap: "6px", margin: "4px 0", maxHeight: "50vh", overflowY: "auto" });
    if (!this.friends) list.append(this.spinner());
    else if (!this.friends.length) list.append(this.sub("No friends yet — add them in the app's Friends screen."));
    for (const f of this.friends ?? []) {
      const status = f.presence?.status ?? "offline";
      const row = el("div", { display: "flex", alignItems: "center", gap: "10px", padding: "8px 10px", background: withAlpha(t.text, 0.08),
        borderRadius: t.panel === "pixel" || t.panel === "sharp" ? "0" : "10px", opacity: status === "offline" ? "0.75" : "1" });
      const dot = el("span", { width: "10px", height: "10px", borderRadius: "50%", flex: "none", background: status === "offline" ? withAlpha(t.text, 0.3) : "#3ccf6a" });
      const who = el("div", { flex: "1", minWidth: "0", display: "flex", flexDirection: "column" });
      who.append(el("span", { fontWeight: "700", fontSize: "15px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, `@${f.user.handle}`),
        el("span", { fontSize: "12px", opacity: "0.75" }, presenceLabel(f.presence, r.code)));
      row.append(dot, who);
      const here = f.presence?.roomCode === r.code;
      const state = this.invited.get(f.user.id);
      const b = this.btn(here ? "Here" : state === "ok" ? "Invited ✓" : state === "…" ? "…" : state ?? "Invite", () => {
        this.invited.set(f.user.id, "…");
        this.render();
        void sendInvite(inv, f.user.id, r.code).then((res) => { this.invited.set(f.user.id, res); this.render(); });
      }, !here && !state);
      Object.assign(b.style, { width: "auto", padding: "9px 12px", fontSize: "14px", flex: "none" });
      b.disabled = here || state === "ok" || state === "…";
      if (b.disabled) b.style.opacity = "0.7";
      row.append(b);
      list.append(row);
    }
    p.append(list);
    p.append(this.btn("Back to room", () => { this.inviteOpen = false; this.render(); }, true));
  }

  private loadFriends(code: string) {
    const inv = this.o.invites;
    if (!inv || this.friendsFor === code) return;
    this.friendsFor = code;
    void fetchFriends(inv).then((list) => {
      this.friends = list;
      if (!list) this.inviteOpen = false; // 404 / signed out: no invite button
      if (this.model.screen === "room") this.render();
    });
  }

  private renderResults(p: HTMLElement) {
    const m = this.model;
    const r = m.result, room = m.room, c = m.client;
    if (!r || !c) return;
    const t = this.t;
    const meTeam = room?.players.find((x) => x.id === c.self)?.team ?? null;
    const name = (id: string | null) => room?.players.find((x) => x.id === id)?.name ?? "Player";
    const won = !m.spectating && (r.winner === c.self || (!r.winner && r.team !== null && r.team === meTeam));
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
        const team = k === "red" || k === "blue" ? k : room?.players.find((x) => x.id === k)?.team ?? null;
        const row = el("div", { display: "flex", justifyContent: "space-between", color: team ? TEAM_COLORS[team] : t.text });
        row.append(el("span", {}, label), el("span", {}, String(v)));
        box.append(row);
      }
      p.append(box);
    }
    if (m.spectating) p.append(this.btn("Keep watching", () => m.afterResults(), true));
    else if (room?.mode === "duel") p.append(this.btn("Rematch", () => m.afterResults(), true));
    else p.append(this.btn("Back to room", () => m.afterResults(), true));
    p.append(this.btn("Leave", () => m.leave()));
  }

  private renderHud() {
    const h = this.hud, m = this.model;
    const r = m.room, c = m.client;
    if ((m.screen !== "playing" && m.screen !== "results") || !r || !c) { h.style.display = "none"; return; }
    h.style.display = "flex";
    h.replaceChildren();
    const chip = (text: string, bg: string, onTap?: () => void, outline = false) => {
      const e = el("span", { padding: "5px 9px", font: `800 ${this.t.font === "pixel" ? 10 : 13}px ${this.t.fontFamily}`,
        color: onColor(bg, "#ffffff"), background: bg, borderRadius: this.t.panel === "pixel" || this.t.panel === "sharp" ? "0" : "999px",
        boxShadow: outline ? "0 0 0 2px #ffffff, 0 2px 6px rgba(0,0,0,0.35)" : "0 2px 6px rgba(0,0,0,0.35)", whiteSpace: "nowrap" }, text);
      if (onTap) {
        Object.assign(e.style, { pointerEvents: "auto", cursor: "pointer", touchAction: "manipulation" });
        e.addEventListener("pointerdown", (ev) => ev.stopPropagation());
        e.addEventListener("click", (ev) => { ev.stopPropagation(); onTap(); });
      }
      return e;
    };
    if (m.spectating) {
      const n = r.players.length;
      h.append(chip(`SPECTATING · ${n} player${n === 1 ? "" : "s"}`, "rgba(0,0,0,0.7)"));
      const focus = this.focus && r.players.some((x) => x.id === this.focus) ? this.focus : r.players[0]?.id;
      for (const pl of r.players) {
        h.append(chip(pl.name, pl.team ? TEAM_COLORS[pl.team] : "#444444", () => { this.focus = pl.id; this.o.onFocus?.(pl.id); this.renderHud(); }, pl.id === focus));
      }
    } else {
      const me = r.players.find((x) => x.id === c.self);
      if (me?.team) h.append(chip(`${me.team.toUpperCase()} · YOU`, TEAM_COLORS[me.team]));
    }
    for (const [k, v] of Object.entries(r.scores)) {
      if (k === "red" || k === "blue") h.append(chip(`${k.toUpperCase()} ${v}`, TEAM_COLORS[k]));
      else {
        const pl = r.players.find((x) => x.id === k);
        if (pl) h.append(chip(`${pl.id === c.self ? "You" : pl.name} ${v}`, pl.team ? TEAM_COLORS[pl.team] : "#444444"));
      }
    }
    if (r.mode === "party") h.append(chip(`ROOM ${r.code} · ${r.players.length}/${r.max}`, "rgba(0,0,0,0.55)"));
    if (r.spectators > 0) {
      const w = chip(` ${r.spectators}`, "rgba(0,0,0,0.55)");
      w.style.display = "inline-flex"; w.style.alignItems = "center"; w.style.gap = "2px";
      w.insertAdjacentHTML("afterbegin", EYE_SVG);
      h.append(w);
    }
    if (m.spectating) h.append(chip("Leave", "rgba(0,0,0,0.7)", () => m.leave()));
  }

  // ------------------------------------------------------------ bits

  /** "(eye) 1 watching" — drawn as SVG, no emoji. */
  private watchers(n: number): HTMLElement {
    const w = el("div", { display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", fontSize: "13px", fontWeight: "700", opacity: "0.85" });
    w.dataset.dreamsySpectators = String(n);
    w.innerHTML = EYE_SVG;
    w.append(document.createTextNode(`${n} watching`));
    return w;
  }

  private name(): string {
    try { return localStorage.getItem(NAME_KEY) ?? ""; } catch { return ""; }
  }

  private nameField(): HTMLElement {
    const input = document.createElement("input");
    Object.assign(input.style, this.inputStyle());
    input.placeholder = "Your name (shown to others)";
    input.maxLength = 20;
    input.value = this.name();
    input.enterKeyHint = "done";
    input.setAttribute("autocomplete", "nickname");
    input.addEventListener("input", () => { try { localStorage.setItem(NAME_KEY, input.value.trim()); } catch { /* private mode */ } });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
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

function el<K extends keyof HTMLElementTagNameMap>(tag: K, style: Partial<CSSStyleDeclaration>, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  Object.assign(e.style, style);
  if (text !== undefined) e.textContent = text;
  return e;
}
