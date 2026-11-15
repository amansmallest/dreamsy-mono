// Room state machine (no sockets): create / join by code / quick-match 1v1 / ready / start / relay / end.
// The server is authoritative for room membership, teams, host, shared state, scores and match results;
// game simulation runs on the players' devices (DREAMSY.MD §4.5, multiplayer v1 = relayed state sync).
import { randomInt } from "node:crypto";
import {
  CODE_ALPHABET, LIMITS, matchResult, normalizeCode,
  type ClientMsg, type ErrorCode, type MatchResult, type RoomInfo, type RoomPlayer, type ServerMsg, type Team,
} from "@dreamsy/engine/net";

export interface Peer {
  /** Player id (per connection). */
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  send(msg: ServerMsg): void;
}

interface Room {
  info: RoomInfo;
  peers: Map<string, Peer>;
  t0: number;
  results: MatchResult[];
}

export interface RoomManagerOptions {
  now?: () => number;
  /** Max concurrent rooms (beyond: "full"). */
  maxRooms?: number;
}

const MAX_RESULTS = 20;
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v ?? null));

export class RoomManager {
  readonly rooms = new Map<string, Room>();
  /** Quick-match queue: one waiting peer per game (1v1). */
  readonly queue = new Map<string, Peer>();
  private roomOf = new Map<string, Room>();
  private queuedFor = new Map<string, string>();
  private now: () => number;
  private maxRooms: number;
  /** Finished matches (latest last), for logs/metrics. */
  readonly onResult: ((room: RoomInfo, r: MatchResult) => void)[] = [];

  constructor(opts: RoomManagerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.maxRooms = opts.maxRooms ?? 5000;
  }

  get playerCount(): number { return this.roomOf.size; }
  room(code: string): RoomInfo | null { return this.rooms.get(code)?.info ?? null; }
  results(code: string): MatchResult[] { return this.rooms.get(code)?.results ?? []; }

  disconnect(peer: Peer) {
    this.unqueue(peer);
    this.removeFromRoom(peer);
  }

  handle(peer: Peer, msg: ClientMsg) {
    const room = this.roomOf.get(peer.id) ?? null;
    switch (msg.t) {
      case "ping": peer.send({ t: "pong", c: msg.c, s: this.now() }); return;
      case "create": {
        if (room) return this.err(peer, "in_room", "leave your room first");
        if (this.rooms.size >= this.maxRooms) return this.err(peer, "full", "the server is full, try again soon");
        this.unqueue(peer);
        const max = clamp(Math.floor(msg.max), 2, LIMITS.maxPlayers);
        const r = this.newRoom(msg.game, msg.mode ?? "party", clamp(Math.floor(msg.min ?? 1), 1, max), max);
        this.addPeer(r, peer);
        this.broadcastRoom(r);
        return;
      }
      case "join": {
        if (room) return this.err(peer, "in_room", "leave your room first");
        const r = this.rooms.get(normalizeCode(msg.code));
        if (!r) return this.err(peer, "not_found", "no room with that code");
        if (msg.game && msg.game !== r.info.game) return this.err(peer, "wrong_game", "that room is playing a different game");
        if (r.info.players.length >= r.info.max) return this.err(peer, "full", "that room is full");
        this.unqueue(peer);
        this.addPeer(r, peer);
        this.broadcastRoom(r);
        // late join: drop straight into the running match
        if (r.info.status === "playing") peer.send({ t: "start", room: r.info, you: peer.id });
        return;
      }
      case "quick": {
        if (room) return this.err(peer, "in_room", "leave your room first");
        const waiting = this.queue.get(msg.game);
        if (waiting && waiting.id !== peer.id) {
          if (this.rooms.size >= this.maxRooms) return this.err(peer, "full", "the server is full, try again soon");
          this.unqueue(waiting);
          this.unqueue(peer);
          const r = this.newRoom(msg.game, "duel", 2, 2);
          this.addPeer(r, waiting);
          this.addPeer(r, peer);
          this.startMatch(r);
          return;
        }
        this.unqueue(peer);
        this.queue.set(msg.game, peer);
        this.queuedFor.set(peer.id, msg.game);
        peer.send({ t: "queued", game: msg.game });
        return;
      }
      case "cancel":
        this.unqueue(peer);
        peer.send({ t: "left" });
        return;
      case "leave":
        this.unqueue(peer);
        this.removeFromRoom(peer);
        peer.send({ t: "left" });
        return;
    }
    if (!room) return this.err(peer, "not_in_room", "join a room first");
    const info = room.info;
    switch (msg.t) {
      case "ready": {
        const p = this.player(room, peer.id);
        p.ready = !!msg.v;
        // duels (quick match rematch) start by themselves once both are ready
        if (info.status === "lobby" && info.mode === "duel" && info.players.length === 2 && info.players.every((x) => x.ready)) this.startMatch(room);
        else this.broadcastRoom(room);
        return;
      }
      case "team": {
        if (info.status !== "lobby") return this.err(peer, "bad_state", "teams are picked in the lobby");
        if (info.mode === "duel") return this.err(peer, "bad_state", "duel teams are fixed");
        this.player(room, peer.id).team = msg.team;
        this.broadcastRoom(room);
        return;
      }
      case "start": {
        if (info.host !== peer.id) return this.err(peer, "not_host", "only the host can start");
        if (info.status !== "lobby") return this.err(peer, "bad_state", "already playing");
        if (info.players.length < info.min) return this.err(peer, "not_ready", `needs at least ${info.min} players`);
        if (info.players.some((p) => p.id !== peer.id && !p.ready)) return this.err(peer, "not_ready", "waiting for everyone to be ready");
        this.startMatch(room);
        return;
      }
    }
    // in-match relay
    if (info.status !== "playing") return; // stale in-flight game messages after the match ended: drop quietly
    switch (msg.t) {
      case "st": {
        const out: ServerMsg = { t: "st", id: peer.id, ts: this.now() - room.t0, s: msg.s };
        for (const p of room.peers.values()) if (p.id !== peer.id) p.send(out);
        return;
      }
      case "ev": {
        if (bytes(msg.a) > LIMITS.maxEventBytes) return this.err(peer, "too_large", `remote event args > ${LIMITS.maxEventBytes} bytes`);
        const out: ServerMsg = { t: "ev", from: peer.id, n: msg.n, to: msg.to, a: msg.a };
        if (msg.to === "others") { for (const p of room.peers.values()) if (p.id !== peer.id) p.send(out); }
        else if (msg.to === "host") room.peers.get(info.host)?.send(out);
        else {
          const target = room.peers.get(msg.to);
          if (!target) return this.err(peer, "bad_message", "no such player in this room");
          target.send(out);
        }
        return;
      }
      case "kv": {
        if (bytes(msg.v) > LIMITS.maxStateValueBytes) return this.err(peer, "too_large", `state value > ${LIMITS.maxStateValueBytes} bytes`);
        if (!(msg.k in info.state) && Object.keys(info.state).length >= LIMITS.maxStateKeys) return this.err(peer, "too_large", "too many state keys");
        info.state[msg.k] = msg.v;
        const out: ServerMsg = { t: "kv", from: peer.id, k: msg.k, v: msg.v };
        for (const p of room.peers.values()) if (p.id !== peer.id) p.send(out);
        return;
      }
      case "score": {
        if (msg.k !== "red" && msg.k !== "blue" && !room.peers.has(msg.k)) return this.err(peer, "bad_message", "score key must be a player id, red or blue");
        const v = (info.scores[msg.k] ?? 0) + msg.d;
        info.scores[msg.k] = v;
        for (const p of room.peers.values()) p.send({ t: "score", k: msg.k, v });
        return;
      }
      case "end": {
        const w = msg.w;
        if (w !== null && w !== "draw" && w !== "red" && w !== "blue" && !room.peers.has(w)) return this.err(peer, "bad_message", "winner must be a player in this room, red, blue or draw");
        this.endMatch(room, w, "finish");
        return;
      }
    }
  }

  // ------------------------------------------------------------ internals

  private err(peer: Peer, code: ErrorCode, message: string) { peer.send({ t: "error", code, message }); }

  private player(room: Room, id: string): RoomPlayer {
    return room.info.players.find((p) => p.id === id)!;
  }

  private newRoom(game: string, mode: RoomInfo["mode"], min: number, max: number): Room {
    let code: string;
    do code = Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join(""); while (this.rooms.has(code));
    const r: Room = {
      info: { code, game, mode, status: "lobby", min, max, host: "", players: [], match: 0, seed: 0, state: {}, scores: {} },
      peers: new Map(), t0: this.now(), results: [],
    };
    this.rooms.set(code, r);
    return r;
  }

  private addPeer(r: Room, peer: Peer) {
    const reds = r.info.players.filter((p) => p.team === "red").length;
    const blues = r.info.players.filter((p) => p.team === "blue").length;
    const team: Team = blues < reds ? "blue" : "red";
    r.info.players.push({ id: peer.id, userId: peer.userId, name: peer.name, team, ready: false });
    r.peers.set(peer.id, peer);
    if (!r.info.host) r.info.host = peer.id;
    this.roomOf.set(peer.id, r);
  }

  private removeFromRoom(peer: Peer) {
    const r = this.roomOf.get(peer.id);
    if (!r) return;
    this.roomOf.delete(peer.id);
    r.peers.delete(peer.id);
    r.info.players = r.info.players.filter((p) => p.id !== peer.id);
    if (!r.info.players.length) { this.rooms.delete(r.info.code); return; }
    if (r.info.host === peer.id) r.info.host = r.info.players[0]!.id;
    // the last player standing wins by forfeit (1v1s, and parties that drop to one player)
    if (r.info.status === "playing" && r.info.players.length < 2) {
      this.endMatch(r, r.info.players[0]!.id, "forfeit");
      return;
    }
    this.broadcastRoom(r);
  }

  private unqueue(peer: Peer) {
    const g = this.queuedFor.get(peer.id);
    if (g === undefined) return;
    this.queuedFor.delete(peer.id);
    if (this.queue.get(g)?.id === peer.id) this.queue.delete(g);
  }

  private startMatch(r: Room) {
    const i = r.info;
    i.status = "playing";
    i.match++;
    i.seed = randomInt(1, 2 ** 31 - 1);
    i.state = {};
    i.scores = {};
    for (const p of i.players) p.ready = false;
    r.t0 = this.now();
    for (const p of r.peers.values()) p.send({ t: "start", room: i, you: p.id });
  }

  private endMatch(r: Room, w: string | null, reason: MatchResult["reason"]) {
    const res = matchResult(r.info, w, reason);
    r.info.status = "lobby";
    r.results.push(res);
    if (r.results.length > MAX_RESULTS) r.results.shift();
    for (const p of r.peers.values()) p.send({ t: "ended", r: res });
    for (const fn of this.onResult) fn(r.info, res);
    this.broadcastRoom(r);
  }

  private broadcastRoom(r: Room) {
    for (const p of r.peers.values()) p.send({ t: "room", room: r.info, you: p.id });
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo;
}
