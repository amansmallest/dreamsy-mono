// Lobby state machine (DOM-free; net/lobby.ts draws it): connect, quick match, create, join by code (keypad), spectate,
// room / match / results screens, ?room= auto-join. Testable in Node with a fake or loopback connection.
import type { NetLink } from "../core/net.js";
import { CodeEntry } from "./keypad.js";
import { CODE_RE, normalizeCode, type MatchResult, type RoomInfo, type ServerMsg, type Team } from "./protocol.js";

/** What the lobby needs from a room-server connection (net/client.ts RoomClient; LoopbackRoom.connection in tests). */
export interface LobbyConn {
  readonly self: string;
  readonly closed: boolean;
  readonly spectator: boolean;
  on(fn: (m: ServerMsg) => void): () => void;
  create(game: string, max: number, opts?: { min?: number; mode?: "duel" | "party" }): void;
  join(code: string, game?: string): void;
  spectate(code: string, game?: string): void;
  quick(game: string): void;
  cancel(): void;
  ready(v: boolean): void;
  team(team: Team): void;
  start(): void;
  leave(): void;
  close(): void;
  link(): NetLink;
}

/** Thrown by `connect` (RoomError has the same shape). */
export interface ConnError { code: string; message: string }

export type Screen = "menu" | "join" | "busy" | "queue" | "room" | "playing" | "results";

export interface LobbyModelOptions {
  gameKey: string;
  max: number;
  min: number;
  connect(): Promise<LobbyConn>;
  /** ?room=<code>[&spectate=1]: join (or watch) right away, skipping the menu. */
  initial?: { code: string; spectate?: boolean } | null;
  /** A match started (first or rematch, playing or watching): (re)start the game with conn.link(). */
  onStart(conn: LobbyConn, room: RoomInfo): void;
  /** A match ended or the room was left: stop the running game. */
  onStop?(): void;
  /** Anything visible changed: redraw. */
  onChange(): void;
}

export class LobbyModel {
  screen: Screen = "menu";
  room: RoomInfo | null = null;
  result: MatchResult | null = null;
  status = "";
  client: LobbyConn | null = null;
  /** Keypad code entry (screen "join"); auto-joins at 6 characters. */
  readonly code: CodeEntry;
  private off: (() => void) | null = null;
  /** The last room we tried, to come back to after an error. */
  private pending: "keypad" | "join" | "spectate" | null = null;

  constructor(private o: LobbyModelOptions) {
    this.code = new CodeEntry((c) => void this.join(c, true), () => this.o.onChange());
  }

  /** Auto-join from ?room= (returns the promise for tests); else the menu. */
  begin(): Promise<void> {
    const init = this.o.initial;
    const code = init ? normalizeCode(init.code) : "";
    if (init && CODE_RE.test(code)) return init.spectate ? this.spectate(code) : this.join(code);
    this.o.onChange();
    return Promise.resolve();
  }

  get spectating(): boolean { return !!this.client?.spectator && !!this.room; }
  get inMatch(): boolean { return this.screen === "playing"; }

  dispose() {
    this.off?.();
    this.off = null;
    this.client?.close();
    this.client = null;
  }

  // ------------------------------------------------------------ actions

  private async connect(): Promise<LobbyConn> {
    if (this.client && !this.client.closed) return this.client;
    this.go("busy", "Connecting…");
    const c = await this.o.connect();
    this.off?.();
    this.client = c;
    this.off = c.on((m) => this.onMsg(m));
    return c;
  }

  private async run(label: string, fn: (c: LobbyConn) => void) {
    try {
      const c = await this.connect();
      this.go("busy", label);
      fn(c);
    } catch (e) {
      const err = e as Partial<ConnError>;
      this.go("menu", err.code ? friendly(err.code, err.message ?? "") : `Couldn't connect: ${(e as Error).message}`);
    }
  }

  quick() { return this.run("Finding a player…", (c) => c.quick(this.o.gameKey)); }
  create() { return this.run("Creating room…", (c) => c.create(this.o.gameKey, this.o.max, { min: this.o.min, mode: "party" })); }
  join(code: string, fromKeypad = false) { this.pending = fromKeypad ? "keypad" : "join"; return this.run("Joining…", (c) => c.join(normalizeCode(code), this.o.gameKey)); }
  spectate(code: string) { this.pending = "spectate"; return this.run("Joining as a spectator…", (c) => c.spectate(normalizeCode(code), this.o.gameKey)); }

  /** Menu → keypad. */
  openKeypad() { this.code.clear(); this.go("join", ""); }
  closeKeypad() { this.go("menu", ""); }

  cancelQueue() { this.client?.cancel(); this.go("menu", ""); }

  leave() {
    this.client?.leave();
    this.room = null;
    this.result = null;
    this.o.onStop?.();
    this.go("menu", "");
  }

  /** Results → back to the room (party) or rematch (duel). */
  afterResults() {
    if (this.room?.mode === "duel" && !this.spectating) this.client?.ready(true);
    else this.o.onStop?.();
    this.go("room", "");
  }

  flash(text: string) { this.status = text; this.o.onChange(); }

  // ------------------------------------------------------------ server messages

  onMsg(m: ServerMsg) {
    switch (m.t) {
      case "queued": this.go("queue", ""); break;
      case "room":
        this.room = m.room;
        this.pending = null;
        if (this.screen === "playing" || this.screen === "results") this.o.onChange();
        else this.go("room", "");
        break;
      case "start":
        this.room = m.room;
        this.result = null;
        this.pending = null;
        this.go("playing", "");
        this.o.onStart(this.client!, m.room);
        break;
      case "score":
        if (this.room) { this.room.scores[m.k] = m.v; this.o.onChange(); }
        break;
      case "ended":
        this.result = m.r;
        this.go("results", "");
        break;
      case "left": if (this.screen !== "menu") { this.room = null; this.o.onStop?.(); this.go("menu", this.screen === "busy" ? "" : "The room closed."); } break;
      case "error":
        if (m.code === "rate_limited") break;
        if (m.message.startsWith("closed:")) { this.client = null; this.room = null; this.o.onStop?.(); this.go("menu", "Disconnected from the room server."); break; }
        if (this.screen === "busy" || this.screen === "queue") {
          // a failed keypad join goes back to the keypad (cleared) so the code can be fixed
          const back = this.room ? "room" : this.pending === "keypad" ? "join" : "menu";
          if (back === "join") this.code.clear();
          this.pending = null;
          this.go(back, friendly(m.code, m.message));
        } else this.flash(friendly(m.code, m.message));
        break;
      default: break;
    }
  }

  private go(s: Screen, status: string) {
    this.screen = s;
    this.status = status;
    this.o.onChange();
  }
}

export function friendly(code: string, message: string): string {
  switch (code) {
    case "not_found": return "No room with that code.";
    case "full": return message.includes("watching") ? "Too many people are watching that room." : "That room is full.";
    case "wrong_game": return "That code is for a different game.";
    case "unauthorized": return "Couldn't sign you in for multiplayer.";
    case "spectator": return "You're watching this room.";
    case "closed": return message.startsWith("can't") || message.startsWith("the room") ? "The room server is offline. Try again soon." : message;
    default: return message;
  }
}
