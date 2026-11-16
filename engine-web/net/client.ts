// Room server client: one WebSocket per player session (browser, WebView, or Node ≥ 22 with global WebSocket).
// Lobby calls (create / join / quick / ready / start) + `link()` → the NetLink a Game uses for one match.
import type { NetLink } from "../core/net.js";
import type { ClientMsg, ErrorCode, RoomInfo, ServerMsg, Team } from "./protocol.js";

export class RoomError extends Error {
  constructor(readonly code: ErrorCode | "closed", message: string) { super(message); }
}

const MAX_QUEUE = 4000;

export class RoomClient {
  self = "";
  userId = "";
  name = "";
  room: RoomInfo | null = null;
  /** This connection watches its room (spectate) instead of playing. */
  spectator = false;
  closed = false;
  private listeners = new Set<(m: ServerMsg) => void>();
  private queue: ServerMsg[] = [];
  private linked = false;

  private constructor(private ws: WebSocket) {}

  /** Connect + authenticate with the API user token. Resolves after the server's welcome. */
  static connect(url: string, token: string, name?: string, timeoutMs = 8000): Promise<RoomClient> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try { ws = new WebSocket(url); } catch (e) { reject(new RoomError("closed", `can't reach the room server: ${(e as Error).message}`)); return; }
      const c = new RoomClient(ws);
      let done = false;
      const fail = (err: RoomError) => { if (!done) { done = true; clearTimeout(timer); reject(err); try { ws.close(); } catch { /* */ } } };
      const timer = setTimeout(() => fail(new RoomError("closed", "the room server didn't answer")), timeoutMs);
      ws.onopen = () => c.raw({ t: "hello", token, name });
      ws.onerror = () => fail(new RoomError("closed", "can't reach the room server"));
      ws.onclose = (ev) => {
        c.closed = true;
        fail(new RoomError(ev.code === 4001 ? "unauthorized" : "closed", ev.code === 4001 ? "sign-in failed" : "connection closed"));
        for (const fn of [...c.listeners]) fn({ t: "error", code: "bad_state", message: `closed:${ev.code}` });
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

  /** Subscribe to every server message (lobby UI). Returns unsubscribe. */
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
    if (this.linked && m.t !== "pong" && m.t !== "welcome" && m.t !== "queued") {
      this.queue.push(m);
      if (this.queue.length > MAX_QUEUE) {
        const i = this.queue.findIndex((x) => x.t === "st");
        this.queue.splice(i >= 0 ? i : 0, 1);
      }
    }
    for (const fn of [...this.listeners]) fn(m);
  }

  private raw(m: ClientMsg) {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(m));
  }

  create(game: string, max: number, opts: { min?: number; mode?: "duel" | "party" } = {}) { this.raw({ t: "create", game, max, ...opts }); }
  join(code: string, game?: string) { this.raw({ t: "join", code, game }); }
  /** Watch a room: no seat, no avatar; receives everything players receive. */
  spectate(code: string, game?: string) { this.raw({ t: "spectate", code, game }); }
  quick(game: string) { this.raw({ t: "quick", game }); }
  cancel() { this.raw({ t: "cancel" }); }
  ready(v: boolean) { this.raw({ t: "ready", v }); }
  team(team: Team) { this.raw({ t: "team", team }); }
  start() { this.raw({ t: "start" }); }
  leave() { this.unlink(); this.raw({ t: "leave" }); }
  send(m: ClientMsg) { this.raw(m); }

  /** NetLink for the match that just started (call right after the "start" message). */
  link(): NetLink {
    if (!this.room) throw new Error("not in a room");
    this.queue = [];
    this.linked = true;
    const room = structuredClone(this.room);
    return {
      room, self: this.self, spectator: this.spectator,
      poll: () => { const q = this.queue; this.queue = []; return q; },
      send: (m) => this.raw(m),
      now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
    };
  }

  unlink() { this.linked = false; this.queue = []; }

  close() {
    this.closed = true;
    this.unlink();
    try { this.ws.close(1000, "bye"); } catch { /* already closed */ }
  }
}
