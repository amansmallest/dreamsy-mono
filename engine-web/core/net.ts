// Multiplayer bridge (DREAMSY.MD §4.5): the Luau `players` / `remoteEvent` / `room` API on top of a NetLink.
// v1 = server-relayed state sync: every device simulates its own world + avatar, the room server relays
// avatar samples (15 Hz), remote events, room state, scores and the match result. Remote avatars are visual
// "puppets" (scripts and physics stripped) interpolated 100 ms in the past. No DOM: runs in Node too.
// Without a link (single player, playtests) the same API works offline: one local player, in-process events.
// Spectator links (link.spectator): no local player (players.local == nil), the scene's "player" avatar is hidden and its
// scripts don't run, nothing gameplay-related is sent; puppets for every player; the camera can follow one of them.
import type { LuauVM, LuaState } from "../luau/index.js";
import { ClockSync, SnapshotBuffer } from "../net/interp.js";
import { LIMITS, TEAM_COLORS, type AvatarState, type ClientMsg, type MatchResult, type RoomInfo, type ServerMsg, type Team } from "../net/protocol.js";
import { global2D, parseColor, type Entity, type RGBA, type World } from "./world.js";

/** A connection to a room for the lifetime of one match (net/client.ts RoomClient, net/loopback.ts). */
export interface NetLink {
  /** Room at match start. */
  readonly room: RoomInfo;
  /** This device's player id (a spectator: its connection id, not in room.players). */
  readonly self: string;
  /** Watching, not playing: no local player, nothing gameplay-related is sent. */
  readonly spectator?: boolean;
  /** Drain messages received since the last call. */
  poll(): ServerMsg[];
  send(msg: ClientMsg): void;
  /** Local monotonic clock, ms. */
  now(): number;
}

export interface NetHooks {
  vm(): LuauVM;
  world: World;
  scenePath(): string;
  avatar(): Entity | null;
  destroy(e: Entity): void;
  playAnim(e: Entity, name: string): void;
  call(ref: number, nargs: number, push: (L: LuaState) => void): void;
  entityArg(L: LuaState, i: number): Entity;
  readJSON(L: LuaState, i: number): unknown;
  pushJSON(L: LuaState, v: unknown): void;
  log(level: "info" | "warn" | "error", text: string): void;
  /** Hide an entity (and disable its physics body). */
  hide(e: Entity): void;
  /** A match result arrived (room.ended), before scripts see it. */
  ended?(r: MatchResult): void;
}

interface Disc { scene: string; flip: number; anim: string; vis: number; tpl: string }
interface Remote { buf: SnapshotBuffer<Disc>; puppet: Entity | null; body: Entity | null; sprites: Entity[] }

const TEAM_TINT = 0.45;
const OFFLINE_ID = "local";

function bytes(v: unknown): number {
  return new TextEncoder().encode(JSON.stringify(v ?? null)).length;
}

export class NetSession {
  readonly online: boolean;
  /** Watching a room (spectate): no local player, sends nothing. */
  readonly spectating: boolean;
  room: RoomInfo;
  readonly self: string;
  /** Spectators: the player the camera follows (null = the first player). */
  private focus: string | null = null;
  private dispatchRef = 0;
  /** Messages for scripts, processed at the start of the next tick (never re-entrantly inside a host call). */
  private inbox: ServerMsg[] = [];
  private remotes = new Map<string, Remote>();
  private clock = new ClockSync();
  replicated: Entity | null = null;
  private tint = true;
  private tinted = new WeakMap<Entity, RGBA>();
  private lastSend = -Infinity;
  private lastSent = "";
  private lastSentAt = -Infinity;
  /** Result of the match once room.finish resolved (scripts get room.ended). */
  result: MatchResult | null = null;
  private finishing = false;

  constructor(private link: NetLink | null, private hooks: NetHooks) {
    this.online = !!link;
    this.spectating = link?.spectator === true;
    this.self = link?.self ?? OFFLINE_ID;
    this.room = link ? structuredClone(link.room) : {
      code: "", game: "", mode: "party", status: "playing", min: 1, max: 1, host: OFFLINE_ID, match: 1, seed: 1, state: {}, scores: {}, spectators: 0,
      players: [{ id: OFFLINE_ID, userId: OFFLINE_ID, name: "Player", team: null, ready: true }],
    };
  }

  get isHost(): boolean { return this.room.host === this.self; }
  get me() { return this.spectating ? null : this.room.players.find((p) => p.id === this.self) ?? null; }

  /** Spectators: the player id the camera follows (the chosen one while it's in the room, else the first player). */
  get focusId(): string | null {
    if (this.focus && this.room.players.some((p) => p.id === this.focus)) return this.focus;
    return this.room.players[0]?.id ?? null;
  }

  /** Spectators: follow this player (HUD name chips). */
  setFocus(id: string | null) { this.focus = id; }

  /** Spectators: the followed player's puppet (null until its first sample arrives). */
  focusPuppet(): Entity | null {
    const id = this.focusId;
    return id ? this.puppet(id) : null;
  }
  teamOf(id: string): Team | null { return this.room.players.find((p) => p.id === id)?.team ?? null; }

  /** Remote avatar puppets (tests/tools). */
  puppet(id: string): Entity | null {
    const r = this.remotes.get(id);
    return r?.puppet?.alive ? r.puppet : null;
  }

  // ------------------------------------------------------------ per tick

  /** Start of tick: room updates, events, state, scores, results → scripts. */
  beforeTick() {
    const msgs = this.link ? this.link.poll() : [];
    const all = this.inbox.length ? [...this.inbox, ...msgs] : msgs;
    this.inbox = [];
    const now = this.link?.now() ?? 0;
    for (const m of all) {
      switch (m.t) {
        case "room": case "start": this.applyRoom(m.room); break;
        case "st": {
          if (m.id === this.self) break;
          if (!this.room.players.some((p) => p.id === m.id)) break;
          this.clock.observe(m.ts, now);
          let r = this.remotes.get(m.id);
          if (!r) { r = { buf: new SnapshotBuffer<Disc>(), puppet: null, body: null, sprites: [] }; this.remotes.set(m.id, r); }
          const s = m.s;
          r.buf.push({ ts: m.ts, x: s[1], y: s[2], rot: s[3] }, { scene: s[0], flip: s[4], anim: s[5], vis: s[6], tpl: s[7] });
          break;
        }
        case "ev": this.dispatch("ev", m.n, m.from, m.to === "host", m.a); break;
        case "kv": this.room.state[m.k] = m.v; this.dispatch("kv", m.k, m.v); break;
        case "score": this.room.scores[m.k] = m.v; this.dispatch("score", m.k, m.v); break;
        case "ended":
          if (this.result && this.result.match === m.r.match) break;
          this.result = m.r;
          this.hooks.ended?.(m.r);
          this.dispatch("ended", m.r);
          break;
        default: break;
      }
    }
  }

  /** After physics: move puppets, send our avatar sample. */
  afterPhysics() {
    if (!this.link) return;
    const now = this.link.now();
    const t = this.clock.serverNow(now) - LIMITS.interpDelayMs;
    const scene = this.hooks.scenePath();
    for (const [id, r] of this.remotes) {
      const s = r.buf.at(t);
      if (!s) continue;
      if (!r.puppet?.alive) {
        if (s.data.scene !== scene) continue;
        if (!this.spawnPuppet(id, r, s.data.tpl)) continue;
      }
      const p = r.puppet!, body = r.body!;
      const vis = s.data.scene === scene && s.data.vis !== 0;
      if (p.props.visible !== vis) { p.props.visible = vis; p.rev++; }
      p.props.position = [s.x, s.y];
      p.rev++;
      if (body.props.rotation !== s.rot) { body.props.rotation = s.rot; body.rev++; }
      for (const sp of r.sprites) {
        if (!sp.alive) continue;
        const flip = s.data.flip === 1;
        if (sp.get<boolean>("flip_h") !== flip) { sp.props.flip_h = flip; sp.rev++; }
        if (s.data.anim && sp.props.anims && sp.props.anim !== s.data.anim) {
          try { this.hooks.playAnim(sp, s.data.anim); } catch { /* template without that anim */ }
        }
      }
    }
    // our avatar
    const e = this.replicated;
    if (!e?.alive) return;
    if (now - this.lastSend < 1000 / LIMITS.stateHz - 1) return;
    const m = global2D(e);
    const sprite = this.firstSprite(e);
    const st: AvatarState = [
      scene, Math.round(m[4] * 10) / 10, Math.round(m[5] * 10) / 10, Math.round(e.get<number>("rotation") * 10) / 10,
      sprite?.get<boolean>("flip_h") ? 1 : 0, sprite ? String(sprite.props.anim ?? "") : "", e.get<boolean>("visible") === false ? 0 : 1, e.id,
    ];
    const key = JSON.stringify(st);
    // idle avatars: a keep-alive sample every second instead of 15 Hz
    if (key === this.lastSent && now - this.lastSentAt < 1000) return;
    this.lastSend = now;
    this.lastSent = key;
    this.lastSentAt = now;
    this.link.send({ t: "st", s: st });
  }

  private applyRoom(next: RoomInfo) {
    const before = new Set(this.room.players.map((p) => p.id));
    const after = new Set(next.players.map((p) => p.id));
    const gone = this.room.players.filter((p) => !after.has(p.id));
    this.room = { ...next, state: { ...this.room.state, ...next.state }, scores: { ...this.room.scores, ...next.scores } };
    for (const p of gone) {
      const r = this.remotes.get(p.id);
      if (r?.puppet?.alive) this.hooks.destroy(r.puppet);
      this.remotes.delete(p.id);
      this.dispatch("leave", p.id, p.name, p.team);
    }
    for (const p of next.players) if (!before.has(p.id)) this.dispatch("join", p.id);
  }

  // ------------------------------------------------------------ puppets

  private firstSprite(e: Entity): Entity | null {
    for (const x of this.hooks.world.walk(e)) if (x.type === "Sprite2D") return x;
    return null;
  }

  private spawnPuppet(id: string, r: Remote, tpl: string): boolean {
    const w = this.hooks.world;
    // template: our own replicated avatar (every device runs the same package), else the entity with the sender's id
    const src = this.replicated?.alive ? this.replicated : w.byId.get(tpl) ?? null;
    const holder = w.create(null, "Node2D", `remote:${id}`);
    holder.tags.add("remote");
    holder.props.z_index = src?.get<number>("z_index") ?? 0;
    w.attach(holder, w.root);
    const sprites: Entity[] = [];
    let body: Entity;
    if (src) {
      body = this.copyVisual(src, holder, sprites);
      body.props.visible = true; // the holder carries visibility (a spectator's own copy of the avatar is hidden)
    } else {
      body = w.create(null, "Sprite2D");
      body.props.size = [24, 24];
      w.attach(body, holder);
      sprites.push(body);
    }
    body.props.position = [0, 0];
    const team = this.teamOf(id);
    if (team && this.tint) for (const sp of sprites) this.applyTint(sp, team);
    // name tag above (not rotated with the body)
    const h = sprites[0] ? sprites[0].get<number[]>("size")[1]! * Math.abs(body.get<number[]>("scale")[1] ?? 1) : 24;
    const tag = w.create(null, "Text2D", "nametag");
    const name = this.room.players.find((p) => p.id === id)?.name ?? "Player";
    tag.props = {
      text: name, font_size: 13, position: [0, -h / 2 - 12], z_index: 60, outline: parseColor("#000000")!, outline_size: 3,
      color: parseColor(team ? TEAM_COLORS[team] : "#ffffff")!,
    };
    w.attach(tag, holder);
    r.puppet = holder;
    r.body = body;
    r.sprites = sprites;
    this.dispatch("avatar", id, holder.handle);
    return true;
  }

  /** Visual-only copy: bodies/areas become Node2D, cameras/UI/sounds/spawn points are skipped, no scripts, tags kept except "player". */
  private copyVisual(src: Entity, parent: Entity, sprites: Entity[]): Entity {
    const w = this.hooks.world;
    const physical = src.type === "Body2D" || src.type === "Area2D";
    const type = physical ? "Node2D" : src.type;
    const c = w.create(null, type, src.name);
    for (const tag of src.tags) if (tag !== "player") c.tags.add(tag);
    if (physical) {
      for (const k of ["visible", "position", "rotation", "scale", "z_index"]) if (k in src.props) c.props[k] = structuredClone(src.props[k]);
    } else {
      c.props = structuredClone(src.props);
    }
    if (c.type === "Sprite2D") {
      c.props.auto_flip = false;
      const orig = this.tinted.get(src);
      if (orig) c.props.modulate = [...orig];
      sprites.push(c);
    }
    w.attach(c, parent);
    for (const ch of src.children) {
      if (/^(Camera2D|SpawnPoint2D|Sound|UIText|UIButton|UIPanel|Lighting2D|TileMap2D)$/.test(ch.type)) continue;
      this.copyVisual(ch, c, sprites);
    }
    return c;
  }

  private applyTint(sp: Entity, team: Team) {
    const base = this.tinted.get(sp) ?? (sp.get<RGBA>("modulate") ?? [1, 1, 1, 1]);
    if (!this.tinted.has(sp)) this.tinted.set(sp, [...base] as RGBA);
    const t = parseColor(TEAM_COLORS[team])!;
    // plain white rects become exactly red/blue; textures and other colors keep their look with a team tint
    const white = !sp.props.texture && base[0]! > 0.98 && base[1]! > 0.98 && base[2]! > 0.98;
    const mix = (i: number) => (white ? t[i]! : base[i]! * (1 - TEAM_TINT + TEAM_TINT * t[i]!));
    sp.props.modulate = [mix(0), mix(1), mix(2), base[3]!];
    sp.rev++;
  }

  // ------------------------------------------------------------ Luau host op (OP.NET)

  private dispatch(kind: string, ...args: unknown[]) {
    if (!this.dispatchRef) return;
    this.hooks.call(this.dispatchRef, 1 + args.length, (L) => {
      const vm = this.hooks.vm();
      vm.pushString(L, kind);
      for (const a of args) this.hooks.pushJSON(L, a);
    });
  }

  private pushPlayer(L: LuaState, id: string) {
    const p = this.room.players.find((x) => x.id === id);
    this.hooks.pushJSON(L, p ? { id: p.id, name: p.name, team: p.team, userId: p.userId } : null);
  }

  op(L: LuaState): number {
    const vm = this.hooks.vm();
    const what = vm.toString(L, 2);
    const str = (i: number) => vm.toString(L, i) ?? "";
    switch (what) {
      case "bind": this.dispatchRef = vm.ref(L, 3); return 0;
      case "self": this.pushPlayer(L, this.self); return 1;
      case "active": vm.pushBoolean(L, this.online); return 1;
      case "prop": {
        const k = str(3);
        const r = this.room;
        const v = k === "code" ? (this.online ? r.code : null) : k === "mode" ? (this.online ? r.mode : null) : k === "max" ? r.max : k === "min" ? r.min
          : k === "isHost" ? this.isHost : k === "match" ? r.match : k === "seed" ? r.seed
          : k === "isSpectator" ? this.spectating : k === "spectators" ? (r.spectators ?? 0) : null;
        this.hooks.pushJSON(L, v);
        return 1;
      }
      case "players": this.hooks.pushJSON(L, this.room.players.map((p) => ({ id: p.id, name: p.name, team: p.team, userId: p.userId }))); return 1;
      case "player": this.pushPlayer(L, str(3)); return 1;
      case "host": vm.pushString(L, this.room.host); return 1;
      case "avatar": {
        const id = str(3);
        const e = id === this.self ? (this.spectating ? null : this.replicated?.alive ? this.replicated : this.hooks.avatar()) : this.puppet(id);
        if (e) vm.pushNumber(L, e.handle); else vm.pushNil(L);
        return 1;
      }
      case "fromEntity": {
        const e = this.hooks.entityArg(L, 3);
        for (let x: Entity | null = e; x; x = x.parent) {
          for (const [id, r] of this.remotes) if (r.puppet === x) { vm.pushString(L, id); return 1; }
          if (!this.spectating && (x === this.replicated || x.tags.has("player"))) { vm.pushString(L, this.self); return 1; }
        }
        vm.pushNil(L);
        return 1;
      }
      case "send": {
        if (!this.link || this.spectating) return 0;
        const n = str(3), to = str(4);
        const a = this.hooks.readJSON(L, 5);
        const args = Array.isArray(a) ? a : [];
        if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(n)) throw new Error(`remoteEvent "${n}": multiplayer event names are letters, digits, _ . : - (max 64)`);
        if (bytes(args) > LIMITS.maxEventBytes) throw new Error(`remoteEvent "${n}": arguments are too large (max ${LIMITS.maxEventBytes} bytes of JSON)`);
        this.link.send({ t: "ev", n, to, a: args });
        return 0;
      }
      case "replicate": {
        const e = this.hooks.entityArg(L, 3);
        // spectators have no avatar: whatever a script tries to replicate stays hidden on this device
        if (this.spectating) { this.hooks.hide(e); return 0; }
        this.replicated = e;
        this.tint = vm.toBoolean(L, 4);
        this.lastSent = "";
        const team = this.me?.team;
        if (this.online && team && this.tint) for (const x of this.hooks.world.walk(e)) if (x.type === "Sprite2D") this.applyTint(x, team);
        return 0;
      }
      case "setState": {
        if (this.spectating) return 0; // spectators watch: shared state comes from the players
        const k = str(3);
        const v = this.hooks.readJSON(L, 4);
        if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(k)) throw new Error(`room.setState: key must be a short name like "round" (got "${k}")`);
        if (bytes(v) > LIMITS.maxStateValueBytes) throw new Error(`room.setState("${k}"): value too large (max ${LIMITS.maxStateValueBytes} bytes of JSON)`);
        if (!(k in this.room.state) && Object.keys(this.room.state).length >= LIMITS.maxStateKeys) throw new Error(`room.setState: at most ${LIMITS.maxStateKeys} keys`);
        this.room.state[k] = v;
        this.inbox.push({ t: "kv", from: this.self, k, v });
        this.link?.send({ t: "kv", k, v });
        return 0;
      }
      case "state": this.hooks.pushJSON(L, this.room.state[str(3)] ?? null); return 1;
      case "addScore": {
        if (this.spectating) return 0;
        const k = str(3), d = vm.toNumber(L, 4);
        if (!Number.isFinite(d) || Math.abs(d) > 1e6) throw new Error("room.addScore: amount must be a number (|n| ≤ 1e6)");
        if (this.link) this.link.send({ t: "score", k, d });
        else {
          const v = (this.room.scores[k] ?? 0) + d;
          this.room.scores[k] = v;
          this.inbox.push({ t: "score", k, v });
        }
        return 0;
      }
      case "score": vm.pushNumber(L, this.room.scores[str(3)] ?? 0); return 1;
      case "scores": this.hooks.pushJSON(L, { ...this.room.scores }); return 1;
      case "finish": {
        if (this.result || this.finishing || this.spectating) return 0;
        const w = vm.isNil(L, 3) ? null : str(3);
        if (w !== null && w !== "draw" && w !== "red" && w !== "blue" && !this.room.players.some((p) => p.id === w)) throw new Error(`room.finish: winner must be a Player, "red", "blue", "draw" or nil (got "${w}")`);
        if (this.link) { this.finishing = true; this.link.send({ t: "end", w }); return 0; }
        const team = w === "red" || w === "blue" ? w : null;
        const winner = w && w !== "draw" && !team ? w : null;
        this.inbox.push({ t: "ended", r: { winner, team: team ?? (winner ? this.teamOf(winner) : null), draw: w === null || w === "draw", reason: "finish", scores: { ...this.room.scores }, match: this.room.match } });
        return 0;
      }
      case "teamColor": vm.pushString(L, TEAM_COLORS[str(3) as Team] ?? "#ffffff"); return 1;
    }
    throw new Error(`room: unknown call ${what}`);
  }
}
