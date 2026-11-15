// In-memory room for tests, playtests and the harness: N Games in one process, wired like the room server
// (same messages, same routing), with a manual clock. DOM-free.
import type { NetLink } from "../core/net.js";
import type { ClientMsg, MatchResult, RoomInfo, RoomPlayer, ServerMsg, Team } from "./protocol.js";

export class LoopbackRoom {
  readonly room: RoomInfo;
  private inbox = new Map<string, ServerMsg[]>();
  /** Shared clock (ms); tests advance it with `tick(ms)`. */
  time = 0;
  /** Every relayed client message, for assertions. */
  readonly sent: { from: string; msg: ClientMsg }[] = [];

  constructor(players: { id: string; name?: string; team?: Team | null }[], opts: { mode?: "duel" | "party"; code?: string; seed?: number } = {}) {
    const list: RoomPlayer[] = players.map((p, i) => ({
      id: p.id, userId: `u_${p.id}`, name: p.name ?? p.id, ready: true,
      team: p.team !== undefined ? p.team : (i % 2 === 0 ? "red" : "blue"),
    }));
    this.room = {
      code: opts.code ?? "TEST42", game: "local:test", mode: opts.mode ?? (list.length === 2 ? "duel" : "party"), status: "playing",
      min: 1, max: Math.max(2, list.length), host: list[0]?.id ?? "", players: list, match: 1, seed: opts.seed ?? 7, state: {}, scores: {},
    };
    for (const p of list) this.inbox.set(p.id, []);
  }

  tick(ms: number) { this.time += ms; }

  link(id: string): NetLink {
    if (!this.inbox.has(id)) throw new Error(`no player ${id}`);
    const self = this;
    return {
      get room() { return structuredClone(self.room); },
      self: id,
      poll: () => { const q = self.inbox.get(id) ?? []; self.inbox.set(id, []); return q; },
      send: (msg) => self.receive(id, msg),
      now: () => self.time,
    };
  }

  /** Remove a player (disconnect): everyone gets the new room. */
  leave(id: string) {
    this.room.players = this.room.players.filter((p) => p.id !== id);
    this.inbox.delete(id);
    if (this.room.host === id) this.room.host = this.room.players[0]?.id ?? "";
    this.broadcast({ t: "room", room: structuredClone(this.room), you: "" });
  }

  private to(id: string, m: ServerMsg) { this.inbox.get(id)?.push(structuredClone(m)); }
  private broadcast(m: ServerMsg, except?: string) { for (const p of this.room.players) if (p.id !== except) this.to(p.id, m); }

  private receive(from: string, msg: ClientMsg) {
    this.sent.push({ from, msg });
    switch (msg.t) {
      case "st": this.broadcast({ t: "st", id: from, ts: this.time, s: msg.s }, from); break;
      case "ev": {
        const m: ServerMsg = { t: "ev", from, n: msg.n, to: msg.to, a: msg.a };
        if (msg.to === "others") this.broadcast(m, from);
        else if (msg.to === "host") this.to(this.room.host, m);
        else this.to(msg.to, m);
        break;
      }
      case "kv": this.room.state[msg.k] = msg.v; this.broadcast({ t: "kv", from, k: msg.k, v: msg.v }, from); break;
      case "score": {
        const v = (this.room.scores[msg.k] ?? 0) + msg.d;
        this.room.scores[msg.k] = v;
        this.broadcast({ t: "score", k: msg.k, v });
        break;
      }
      case "end": {
        if (this.room.status !== "playing") break;
        this.room.status = "lobby";
        this.broadcast({ t: "ended", r: matchResult(this.room, msg.w, "finish") });
        break;
      }
      default: break;
    }
  }
}

/** Shared by the loopback and services/gameserver. `w` = player id | "red" | "blue" | "draw" | null. */
export function matchResult(room: RoomInfo, w: string | null, reason: MatchResult["reason"]): MatchResult {
  const team = w === "red" || w === "blue" ? w : null;
  const winner = w && w !== "draw" && !team && room.players.some((p) => p.id === w) ? w : null;
  return {
    winner, team: team ?? (winner ? room.players.find((p) => p.id === winner)?.team ?? null : null),
    draw: !team && !winner, reason, scores: { ...room.scores }, match: room.match,
  };
}
