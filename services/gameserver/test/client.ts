// Minimal room client for the socket tests (Node >= 22 global WebSocket). Speaks src/protocol.ts like a real
// engine client would: hello -> welcome, lobby calls, then raw match messages. `link()` starts buffering
// the match messages so a test can poll them, like an engine does each tick.
import type { ClientMsg, ErrorCode, RoomInfo, ServerMsg, Team } from "../src/protocol.js";

export class RoomError extends Error {
  constructor(readonly code: ErrorCode | "closed", message: string) { super(message); }
}

export interface MatchLink {
  room: RoomInfo;
  self: string;
  spectator: boolean;
  /** Match messages received since the last poll. */
  poll(): ServerMsg[];
}

export class RoomClient {
  self = "";
  userId = "";
  name = "";
  room: RoomInfo | null = null;
  spectator = false;
  closed = false;
  private listeners = new Set<(m: ServerMsg) => void>();
  private queue: ServerMsg[] = [];
  private linked = false;

  private constructor(private ws: WebSocket) {}

  /** Connect + authenticate with the API user token. Resolves after the server's welcome. */
  static connect(url: string, token: string, name?: string, timeoutMs = 8000): Promise<RoomClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const c = new RoomClient(ws);
      let done = false;
      const fail = (err: RoomError) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(err);
        try { ws.close(); } catch { /* already closed */ }
      };
      const timer = setTimeout(() => fail(new RoomError("closed", "the room server didn't answer")), timeoutMs);
      ws.onopen = () => c.send({ t: "hello", token, name });
      ws.onerror = () => fail(new RoomError("closed", "can't reach the room server"));
      ws.onclose = (ev) => {
        c.closed = true;
        fail(new RoomError(ev.code === 4001 ? "unauthorized" : "closed", ev.code === 4001 ? "sign-in failed" : "connection closed"));
      };
      ws.onmessage = (ev) => {
        let m: ServerMsg;
        try { m = JSON.parse(String(ev.data)) as ServerMsg; } catch { return; }
        if (!done) {
          if (m.t === "welcome") {
            done = true;
            clearTimeout(timer);
            c.self = m.id; c.userId = m.userId; c.name = m.name;
            resolve(c);
          } else if (m.t === "error") fail(new RoomError(m.code, m.message));
          return;
        }
        c.receive(m);
      };
    });
  }

  on(fn: (m: ServerMsg) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Resolve on the first message matching `pred`, reject on an error message or timeout. */
  waitFor<T extends ServerMsg>(pred: (m: ServerMsg) => m is T, timeoutMs = 8000): Promise<T> {
    return new Promise((resolve, reject) => {
      const off = this.on((m) => {
        if (pred(m)) { off(); clearTimeout(t); resolve(m); }
        else if (m.t === "error" && m.code !== "rate_limited") { off(); clearTimeout(t); reject(new RoomError(m.code, m.message)); }
      });
      const t = setTimeout(() => { off(); reject(new RoomError("closed", "timed out")); }, timeoutMs);
    });
  }

  private receive(m: ServerMsg) {
    if (m.t === "room" || m.t === "start") { this.room = m.room; this.spectator = m.spectator === true; }
    if (m.t === "left") { this.room = null; this.spectator = false; }
    if (this.linked && m.t !== "pong" && m.t !== "welcome" && m.t !== "queued") this.queue.push(m);
    for (const fn of [...this.listeners]) fn(m);
  }

  send(m: ClientMsg) {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(m));
  }

  create(game: string, max: number, opts: { min?: number; mode?: "duel" | "party" } = {}) { this.send({ t: "create", game, max, ...opts }); }
  join(code: string, game?: string) { this.send({ t: "join", code, game }); }
  spectate(code: string, game?: string) { this.send({ t: "spectate", code, game }); }
  quick(game: string) { this.send({ t: "quick", game }); }
  ready(v: boolean) { this.send({ t: "ready", v }); }
  team(team: Team) { this.send({ t: "team", team }); }
  start() { this.send({ t: "start" }); }

  /** Start buffering match messages (call right after the "start" message). */
  link(): MatchLink {
    if (!this.room) throw new Error("not in a room");
    this.queue = [];
    this.linked = true;
    return {
      room: structuredClone(this.room), self: this.self, spectator: this.spectator,
      poll: () => { const q = this.queue; this.queue = []; return q; },
    };
  }

  close() {
    this.closed = true;
    this.linked = false;
    try { this.ws.close(1000, "bye"); } catch { /* already closed */ }
  }
}
