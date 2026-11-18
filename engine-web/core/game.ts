// Dreamsy simulation core: package → entity world + physics + Luau scripts, fixed timestep.
// No DOM dependency: runs in browsers and in Node (harness playtests, future multiplayer server).
import { registerKitDependencies, musicPath, parseAnims, parseMusic, parseSfx, referenceSize, sfxPath, validatePackage, type AnimSet, type AssetMeta, type Manifest, type Music, type Package, type Scene, type Sfx } from "@dreamsy/format";
import { LuauVM, LUA_TNUMBER, LUA_TSTRING, LUA_TBOOLEAN, LUA_TTABLE, type LuaState, type LuauOptions } from "../luau/index.js";
import { Dialogs, type DialogLine, type DialogState } from "./dialog.js";
import { InputState } from "./input.js";
import { expandKits, kitDependencies, kitSource, loadKitSources } from "./kits.js";
import { resolveTheme } from "./theme.js";
import { Emitter } from "./particles.js";
import { MAX_SAVE_BYTES, MemorySaveHost, type SaveData, type SaveHost } from "./save.js";
import { DEFAULT_EASING, EASINGS, trackValue, tweenProgress, type TweenRec, type TweenTrack } from "./tween.js";
import { anchorRect, refToWorld, uiChildRect, worldToRef } from "./view2d.js";
import { Physics2D, initRapier2D } from "./physics2d.js";
import { OP, PRELUDE, TAG } from "./prelude.js";
import { Random } from "./random.js";
import { MemoryStoreHost, type StoreHost, type StorePurchase } from "./store.js";
import { DEFAULT_BOARD, GhostRecorder, ghostAt, isGhost, MemoryLeaderboardHost, type BoardOrder, type Ghost, type GhostFrame, type LeaderboardHost, type SubmitResult } from "./leaderboard.js";
import { loadTileGrid, type TileGrid } from "./tilemap.js";
import { NetSession, type NetLink } from "./net.js";
import { coerceProp, global2D, apply, invert, parseColor, propAlias, World, type Entity, type RGBA } from "./world.js";

export interface ScriptError {
  script: string;
  line?: number;
  message: string;
  traceback?: string;
  /** How many times this exact error happened. */
  count: number;
  /** Sim time of the first occurrence. */
  time: number;
}

export interface LogLine { time: number; level: "info" | "warn" | "error"; text: string; script?: string }
export interface Toast { id: number; text: string; until: number }
export interface SoundEvent { asset: string; at?: number[] }

/** sfx.play / music.play / music.stop, recorded in core (Node, playtests) and played by render/audio.ts. */
export type AudioEvent =
  | { kind: "sfx"; id: string; volume: number; pitch: number; time: number }
  | { kind: "music"; id: string; fade: number; time: number }
  | { kind: "music_stop"; fade: number; time: number };

/** Player settings from the platform menu (persisted by the shell, read by scripts via settings.get). */
export interface Settings {
  music: number;
  sfx: number;
  mute: boolean;
  vibration: boolean;
  /** Touch control scale, 0.75..1.5. */
  touchSize: number;
}
export const DEFAULT_SETTINGS: Settings = { music: 0.7, sfx: 0.9, mute: false, vibration: true, touchSize: 1 };

export interface GameOptions extends LuauOptions {
  seed?: number;
  /** Simulation rate (Hz). Default 60. */
  tickRate?: number;
  onLog?: (line: LogLine) => void;
  onError?: (err: ScriptError) => void;
  /** Start in this scene instead of the manifest's entry_scene (tools/tests). */
  scene?: string;
  /** Platform store (Stars). Default: an in-memory store where everything is free. */
  store?: StoreHost;
  /** Save data persistence (save.get/set). Default: in-memory. */
  save?: SaveHost;
  /** Leaderboards + ghosts (DREAMSY.MD §13). Default: a fresh in-memory host. */
  leaderboard?: LeaderboardHost;
  /** Multiplayer room link (net/client.ts, net/loopback.ts). Default: offline (one local player). */
  net?: NetLink;
  /** clock.now() source (unix seconds). Default: wall clock. Playtests pass a fixed clock. */
  clock?: () => number;
  /** sceneParams() of the starting scene (with `scene`: start mid-game, e.g. { level = 3 }). */
  sceneParams?: Record<string, unknown>;
}

/** Swipe recognizer thresholds (reference px, seconds). */
export const SWIPE_MIN_DIST = 40;
export const SWIPE_MAX_TIME = 0.6;

/** Fixed clock.now() epoch for deterministic playtests: 2026-01-01T00:00:00Z (+ game time). */
export const PLAYTEST_EPOCH = 1767225600;

interface ScriptInst { path: string; owner: Entity | null; refs: Set<number>; timers: Set<number>; conns: Set<number> }
interface TickCb { id: number; ref: number; inst: ScriptInst }
interface Timer { id: number; due: number; interval: number; ref: number; inst: ScriptInst; seq: number }
/** e = null: game-level signal (game.sceneLoaded). */
interface Conn { id: number; e: Entity | null; signal: string; ref: number; inst: ScriptInst }

const TRANSFORM_KEYS = new Set(["position", "rotation", "scale"]);
const PHYSICS_KEYS = new Set(["body", "shape", "size", "mass", "friction", "bounce", "gravity_scale", "lock_rotation", "collision", "tile_size", "layer", "mask"]);
const TWEENABLE = new Set(["number", "int", "vec2", "color"]);
const TILE_KEYS = new Set(["tileset", "data"]);
/** Max scene switches processed back-to-back (loadScene from a sceneLoaded handler). */
const MAX_SCENE_CHAIN = 8;

export class GameLoadError extends Error {}

/** A leaderboard submit that resolved (or failed): the results card listens for these. */
export interface LeaderboardEvent { board: string; order: BoardOrder; value: number; finished: boolean; result?: SubmitResult; error?: string }
interface LbRun { board: string; t0: number; seq: number; rec: GhostRecorder | null; track: Entity | null; explicitTrack: boolean }
interface LbGhost { ghost: Ghost; board: string; entity: Entity | null; t0: number; tex: string[]; offset: [number, number]; endAt: number }
/**
 * "A run is over" for the host app (guided first experience: show what to play next). Sent when a leaderboard
 * finish/submit resolves, when a script calls platform.runEnded, and when a multiplayer match ends.
 */
export interface RunEnd { reason: "finish" | "submit" | "gameover" | "quit"; board?: string; value?: number; rank?: number }
/** At most one RunEnd per this many ms (wall clock); later ones inside the window are dropped. */
export const RUN_END_GAP_MS = 3000;
const SCRIPT_RUN_END = new Set(["gameover", "finish", "quit"]);
/** Same as the API (DREAMSY.MD §13): lowercase letters, digits, underscore; ≤ 40 chars. */
const BOARD_RE = /^[a-z0-9_]{1,40}$/;
/** Ghost display alpha. */
export const GHOST_ALPHA = 0.45;

export class Game {
  readonly world = new World();
  readonly input = new InputState();
  readonly errors: ScriptError[] = [];
  readonly logs: LogLine[] = [];
  toasts: Toast[] = [];
  sounds: SoundEvent[] = [];
  readonly dt: number;
  time = 0;
  tick = 0;
  /** Bumped when UI screens etc. change in ways renderers can't see via entity revs. */
  readonly assets: Record<string, AssetMeta>;

  private vm!: LuauVM;
  private physics: Physics2D | null = null;
  private rng: Random;
  private refs = { makeScript: 0, proxy: 0, flush: 0, start: 0, invoke: 0, player: 0, sceneSet: 0, done: 0 };
  private current: ScriptInst | null = null;
  private scripts: ScriptInst[] = [];
  private ticks: TickCb[] = [];
  private timers: Timer[] = [];
  private conns = new Map<number, Conn>();
  private nextId = 1;
  private modules = new Map<string, number>();
  private loadingModules = new Set<string>();
  private accumulator = 0;
  private disposed = false;
  /** Requested by loadScene(); switched at the end of the tick. */
  private pendingScene: string | null = null;
  /** Per TileMap2D: "bodyHandle:cell" pairs touching last tick (tileTouched fires on new pairs). */
  private tileTouching = new Map<Entity, Set<string>>();
  readonly store: StoreHost;
  /** Multiplayer session (players, remote events, room API); offline when no `net` link was given. */
  net!: NetSession;
  readonly leaderboardHost: LeaderboardHost;
  private lbRuns = new Map<string, LbRun>();
  private lbSeq = 0;
  private lbInFlight = 0;
  private lbQueue: SubmitResult[] = [];
  private lbListeners = new Set<(ev: LeaderboardEvent) => void>();
  private runEndListeners = new Set<(ev: RunEnd) => void>();
  private lastRunEndAt = -Infinity;
  /** Ghost waiting for its data / scene / run start ("armed" = spawn at the next leaderboard.start). */
  private lbPendingGhost: { which: string; board: string; armed: boolean; ghost: Ghost | null; token: number } | null = null;
  private lbGhost: LbGhost | null = null;
  private lbToken = 0;
  /** Boards this session used (and string literals found in scripts): the pause menu's Leaderboard view. */
  readonly leaderboardBoards: string[] = [];
  /** Last board started / submitted. */
  lastBoard: string | null = null;
  /** Undrained audio events (render/audio.ts plays and clears them). */
  audioQueue: AudioEvent[] = [];
  /** History of audio events (playtest reports). */
  readonly audioLog: AudioEvent[] = [];
  /** Uncapped audio totals (playtest reports): sfx id → count, music ids in play order. */
  readonly audioStats: { sfx: Record<string, number>; music: string[] } = { sfx: {}, music: [] };
  /** Pointer gesture in progress (input.pointerDown → pointerUp / swipe). */
  private gesture: { x: number; y: number; t: number; tick: number } | null = null;
  /** Music currently playing (id), per the last music.play/stop. */
  musicId: string | null = null;
  settings: Settings = { ...DEFAULT_SETTINGS };
  private _paused = false;
  private sfxCache = new Map<string, Sfx>();
  private musicCache = new Map<string, Music>();
  private storeOwned = new Set<string>();
  private storePending: StorePurchase[] = [];
  /** Purchases resolved by the host, fired as store.purchased at the start of the next tick. */
  private storeQueue: StorePurchase[] = [];
  private storeInFlight = 0;
  readonly saveHost: SaveHost;
  private saveData: SaveData = {};
  private tweens: TweenRec[] = [];
  /** ui.dialog / ui.choice (renderer draws dialogs.current). */
  readonly dialogs = new Dialogs();
  private dialogTapQ: number | null = null;
  private navPrev = 0;
  /** Camera state (smoothed center, shake); see cameraView(). */
  private cam = { x: 0, y: 0, init: false, entity: null as Entity | null, shakeT: 0, shakeDur: 0, shakeI: 0, ox: 0, oy: 0 };
  private camRng: Random;
  private animsCache = new Map<string, AnimSet | null>();
  /** Sprites and emitters, rebuilt when the world structure changes. */
  private live = { rev: -1, sprites: [] as Entity[], emitters: [] as Entity[] };
  private pointerClearTick = -1;
  /** Reference screen (portrait 720×1280 / landscape 1280×720). */
  readonly refSize: [number, number];
  /** Scales simulated time (onTick dt, timers, tweens, physics, anims, particles): 0..4. 0 = frozen (hit-stop). */
  timeScale = 1;
  /** Kits enabled for this game: manifest kits + their declared dependencies. */
  enabledKits: string[] = [];
  private fileCache = new Map<string, unknown>();
  /** spawn() in progress: props are applied one by one, so tile loading waits for the finish call. */
  private spawning = new Set<Entity>();
  private sessionInst: ScriptInst = { path: "(session)", owner: null, refs: new Set(), timers: new Set(), conns: new Set() };

  private constructor(
    readonly pkg: Package,
    readonly manifest: Manifest,
    public scene: Scene,
    public scenePath: string,
    readonly scenes: Record<string, Scene>,
    assets: Record<string, AssetMeta>,
    private readonly opts: GameOptions,
  ) {
    this.assets = assets;
    this.dt = 1 / (opts.tickRate ?? 60);
    this.rng = new Random(opts.seed ?? 1);
    this.store = opts.store ?? new MemoryStoreHost(manifest.store ?? []);
    this.leaderboardHost = opts.leaderboard ?? new MemoryLeaderboardHost();
    this.saveHost = opts.save ?? new MemorySaveHost();
    this.camRng = new Random(((opts.seed ?? 1) ^ 0x5bd1e995) >>> 0);
    this.refSize = referenceSize(manifest);
  }

  private async loadSave() {
    try {
      const d = await this.saveHost.load();
      this.saveData = d && typeof d === "object" && !Array.isArray(d) ? d : {};
    } catch (e) {
      this.log("warn", `[save] could not load save data: ${(e as Error).message ?? e}`);
    }
  }

  /** Current save table (read-only view for tools/tests). */
  get save(): Readonly<SaveData> { return this.saveData; }

  private async loadStore() {
    try {
      const [owned, pending] = await Promise.all([this.store.owned(), this.store.pending()]);
      this.storeOwned = new Set(owned);
      this.storePending = pending.map((p) => ({ itemId: p.itemId, purchaseId: p.purchaseId }));
    } catch (e) {
      this.log("warn", `[store] could not load purchases: ${(e as Error).message ?? e}`);
    }
  }

  // ---------------------------------------------------------------- platform shell

  get paused(): boolean { return this._paused; }

  /** Freeze the simulation (advance() runs no ticks) and fire game.paused. */
  pause() {
    if (this._paused || this.disposed) return;
    this._paused = true;
    this.fire(null, "paused", () => 0);
  }

  resume() {
    if (!this._paused || this.disposed) return;
    this._paused = false;
    this.accumulator = 0;
    this.fire(null, "resumed", () => 0);
  }

  /** Platform "Restart": fires game.restartRequested, or (no listeners) reloads the entry scene. */
  requestRestart() {
    if (this.disposed) return;
    this.lbCancelAll();
    if (this.hasConn(null, "restartRequested")) this.fire(null, "restartRequested", () => 0);
    else this.pendingScene = this.manifest.entry_scene;
    this.processSceneChange();
  }

  /** Parsed data/sfx/<id>.json (defaults applied). Throws a script-facing error when missing/invalid. */
  sfxData(id: string): Sfx {
    let v = this.sfxCache.get(id);
    if (v) return v;
    const text = this.pkg.text(sfxPath(id));
    if (text === undefined) throw new Error(`sfx.play: no sound "${id}" (add ${sfxPath(id)})`);
    const r = parseSfx(text);
    if (!r.value) throw new Error(`sfx.play: ${sfxPath(id)} is invalid: ${r.errors.join("; ")}`);
    v = r.value;
    this.sfxCache.set(id, v);
    return v;
  }

  musicData(id: string): Music {
    let v = this.musicCache.get(id);
    if (v) return v;
    const text = this.pkg.text(musicPath(id));
    if (text === undefined) throw new Error(`music.play: no song "${id}" (add ${musicPath(id)})`);
    const r = parseMusic(text);
    if (!r.value || r.errors.length) throw new Error(`music.play: ${musicPath(id)} is invalid: ${r.errors.join("; ")}`);
    v = r.value;
    this.musicCache.set(id, v);
    return v;
  }

  private audio(ev: AudioEvent) {
    this.audioQueue.push(ev);
    if (this.audioQueue.length > 64) this.audioQueue.shift();
    this.audioLog.push(ev);
    if (ev.kind === "sfx") this.audioStats.sfx[ev.id] = (this.audioStats.sfx[ev.id] ?? 0) + 1;
    else if (ev.kind === "music") this.audioStats.music.push(ev.id);
    if (this.audioLog.length > 500) this.audioLog.shift();
  }

  /** A store.prompt() is waiting on the host (headless runners await this between ticks). */
  get storeBusy(): boolean { return this.storeInFlight > 0; }

  private storeItem(id: string) {
    const item = (this.manifest.store ?? []).find((i) => i.id === id);
    if (!item) throw new Error(`store: no item "${id}"${this.manifest.store?.length ? ` (items: ${this.manifest.store.map((i) => i.id).join(", ")})` : " (declare [[store]] items in dreamsy.toml)"}`);
    return item;
  }

  private firePurchases() {
    const q = this.storeQueue;
    if (!q.length) return;
    this.storeQueue = [];
    for (const p of q) {
      const item = (this.manifest.store ?? []).find((i) => i.id === p.itemId);
      if (item?.kind === "pass") this.storeOwned.add(p.itemId);
      else if (!this.storePending.some((x) => x.purchaseId === p.purchaseId)) this.storePending.push(p);
      this.fire(null, "storePurchased", (L) => { this.vm.pushString(L, p.itemId); this.vm.pushString(L, p.purchaseId); return 2; });
    }
  }

  // ---------------------------------------------------------------- leaderboards + ghosts (DREAMSY.MD §13)

  /** A leaderboard submit/ghost fetch is waiting on the host (headless runners await this between ticks). */
  get leaderboardBusy(): boolean { return this.lbInFlight > 0; }
  /** True when the game uses leaderboards (scripts mention them, or a board was used): shows the pause-menu entry. */
  get usesLeaderboards(): boolean { return this.leaderboardBoards.length > 0 || this.lbUsed; }
  private lbUsed = false;

  /** Subscribe to submit results (UI). Returns an unsubscribe function. */
  onLeaderboard(fn: (ev: LeaderboardEvent) => void): () => void {
    this.lbListeners.add(fn);
    return () => this.lbListeners.delete(fn);
  }

  /** Subscribe to run ends (host bridge: {type:"runEnd"}). At most one per RUN_END_GAP_MS. Returns an unsubscribe function. */
  onRunEnd(fn: (ev: RunEnd) => void): () => void {
    this.runEndListeners.add(fn);
    return () => this.runEndListeners.delete(fn);
  }

  private emitRunEnd(ev: RunEnd) {
    if (this.disposed) return;
    const now = Date.now();
    if (now - this.lastRunEndAt < RUN_END_GAP_MS) return;
    this.lastRunEndAt = now;
    for (const fn of [...this.runEndListeners]) { try { fn(ev); } catch (e) { this.log("warn", `[platform] runEnd listener: ${(e as Error).message}`); } }
  }

  /** Running timers: board → game seconds elapsed. */
  get leaderboardRuns(): Record<string, number> {
    const o: Record<string, number> = {};
    for (const r of this.lbRuns.values()) o[r.board] = this.time - r.t0;
    return o;
  }

  /** Live ghost entity (tests/tools). */
  get ghostEntity(): Entity | null { return this.lbGhost?.entity?.alive ? this.lbGhost.entity : null; }

  /** Results card "Race the #1 ghost": fetch it now, spawn it at the next leaderboard.start of that scene. */
  armGhost(which: string, board: string) { this.requestGhost(which, board, true); }

  private scanBoards() {
    const srcs: string[] = [];
    for (const p of this.pkg.paths("scripts/")) if (p.endsWith(".luau")) srcs.push(this.pkg.text(p) ?? "");
    let any = false;
    for (const src of srcs) {
      if (/\bleaderboard\s*\.\s*(start|finish|submit)\b/.test(src)) any = true;
      for (const m of src.matchAll(/\bleaderboard\s*\.\s*(?:start|finish|submit)\s*\(\s*"([a-z0-9_]{1,40})"/g)) this.noteBoard(m[1]!);
    }
    if (any && !this.leaderboardBoards.length) this.lbUsed = true;
  }

  private noteBoard(board: string) {
    this.lbUsed = true;
    if (!this.leaderboardBoards.includes(board)) this.leaderboardBoards.push(board);
  }

  private boardArg(L: LuaState, i: number, fn: string): string | null {
    const vm = this.vm;
    if (vm.isNil(L, i)) return null;
    const b = vm.toString(L, i) ?? "";
    if (!BOARD_RE.test(b)) throw new Error(`leaderboard.${fn}: board must be a name like "fastest" or "track_1" (lowercase letters, digits and _, at most 40), got "${b}"`);
    return b;
  }

  /** nil board → "fastest" if running, else the most recently started run, else "fastest". */
  private runningBoard(b: string | null): string {
    if (b) return b;
    if (this.lbRuns.has(DEFAULT_BOARD)) return DEFAULT_BOARD;
    let best: LbRun | null = null;
    for (const r of this.lbRuns.values()) if (!best || r.seq > best.seq) best = r;
    return best?.board ?? DEFAULT_BOARD;
  }

  private leaderboardOp(L: LuaState): number {
    const vm = this.vm;
    const what = vm.toString(L, 2);
    switch (what) {
      case "start": {
        const board = this.boardArg(L, 3, "start") ?? DEFAULT_BOARD;
        const track = vm.isNil(L, 4) ? null : this.entityArg(L, 4);
        this.noteBoard(board);
        this.lastBoard = board;
        const target = track ?? this.avatar();
        const run: LbRun = { board, t0: this.time, seq: this.lbSeq++, rec: target ? new GhostRecorder(this.scenePath, this.time) : null, track: target, explicitTrack: !!track };
        this.lbRuns.set(board, run);
        run.rec?.sample(this.time, () => this.ghostSample(run));
        const p = this.lbPendingGhost;
        if (p?.armed && p.board === board) p.armed = false; // spawns as soon as its data is here (scene permitting)
        this.removeGhost(); // a fresh run: drop the previous replay
        this.trySpawnGhost();
        return 0;
      }
      case "finish": {
        const board = this.runningBoard(this.boardArg(L, 3, "finish"));
        const run = this.lbRuns.get(board);
        if (!run) { this.log("warn", `[leaderboard] finish("${board}") without a running leaderboard.start("${board}")`); vm.pushNil(L); return 1; }
        this.lbRuns.delete(board);
        const value = Math.round((this.time - run.t0) * 1000) / 1000;
        run.rec?.sample(this.time, () => this.ghostSample(run));
        const ghost = run.rec && run.rec.frames.length >= 2 ? run.rec.ghost() : undefined;
        if (this.lbGhost?.board === board) this.removeGhost();
        this.submitRun(board, "asc", value, ghost, true);
        vm.pushNumber(L, value);
        return 1;
      }
      case "submit": {
        const board = this.boardArg(L, 3, "submit");
        if (!board) throw new Error('leaderboard.submit expects a board name, e.g. leaderboard.submit("score", 1200)');
        const value = vm.toNumber(L, 4);
        if (vm.type(L, 4) !== LUA_TNUMBER || !Number.isFinite(value)) throw new Error("leaderboard.submit expects a number value");
        const order = vm.isNil(L, 5) ? "desc" : vm.toString(L, 5);
        if (order !== "asc" && order !== "desc") throw new Error('leaderboard.submit: order must be "asc" (lower is better) or "desc" (higher is better)');
        this.noteBoard(board);
        this.lastBoard = board;
        this.submitRun(board, order, value, undefined, false);
        return 0;
      }
      case "cancel": {
        const b = this.boardArg(L, 3, "cancel");
        if (b === null) this.lbCancelAll();
        else { this.lbRuns.delete(b); if (this.lbGhost?.board === b) this.removeGhost(); }
        return 0;
      }
      case "elapsed": {
        const run = this.lbRuns.get(this.runningBoard(this.boardArg(L, 3, "elapsed")));
        vm.pushNumber(L, run ? this.time - run.t0 : 0);
        return 1;
      }
      case "running": {
        vm.pushBoolean(L, this.lbRuns.has(this.runningBoard(this.boardArg(L, 3, "running"))));
        return 1;
      }
      case "raceGhost": {
        const which = vm.toString(L, 3) ?? "";
        if (!which) throw new Error('leaderboard.raceGhost expects "best", "pb" or a run id');
        const board = this.boardArg(L, 4, "raceGhost") ?? (this.lbRuns.size ? this.runningBoard(null) : this.lastBoard ?? DEFAULT_BOARD);
        this.requestGhost(which, board, false);
        return 0;
      }
    }
    throw new Error(`leaderboard: unknown call ${what}`);
  }

  private lbCancelAll() {
    this.lbRuns.clear();
    this.removeGhost();
  }

  private submitRun(board: string, order: BoardOrder, value: number, ghost: Ghost | undefined, finished: boolean) {
    this.lbInFlight++;
    this.leaderboardHost.submit({ board, order, value, ...(ghost ? { ghost } : {}) }).then(
      (r) => {
        if (this.disposed) return;
        this.lbQueue.push(r);
        this.emitLb({ board, order, value, finished, result: r });
        this.emitRunEnd({ reason: finished ? "finish" : "submit", board, value, rank: r.rank });
      },
      (e) => {
        const msg = (e as Error)?.message ?? String(e);
        this.log("warn", `[leaderboard] submit to "${board}" failed: ${msg}`);
        if (!this.disposed) this.emitLb({ board, order, value, finished, error: msg });
        // the run still ended (offline / API down): no rank
        this.emitRunEnd({ reason: finished ? "finish" : "submit", board, value });
      },
    ).finally(() => this.lbInFlight--);
  }

  private emitLb(ev: LeaderboardEvent) {
    for (const fn of [...this.lbListeners]) { try { fn(ev); } catch (e) { this.log("warn", `[leaderboard] listener: ${(e as Error).message}`); } }
  }

  private fireLeaderboardResults() {
    const q = this.lbQueue;
    if (!q.length) return;
    this.lbQueue = [];
    for (const r of q) this.fire(null, "leaderboardResult", (L) => { this.vm.pushNumber(L, r.rank); this.vm.pushNumber(L, r.best); this.vm.pushBoolean(L, r.personalBest); return 3; });
  }

  /** The tracked entity's first Sprite2D (itself, or a descendant; prefers one with anims). */
  private trackedSprite(e: Entity | null): Entity | null {
    if (!e?.alive) return null;
    let first: Entity | null = null;
    for (const x of this.world.walk(e)) {
      if (x.type !== "Sprite2D") continue;
      if (x.get<string>("anims")) return x;
      first ??= x;
    }
    return first;
  }

  /** Deduplicated textures of a sprite's anim set, in file order: ghost frame indices point into this. */
  private animTextures(sprite: Entity | null): string[] {
    const path = sprite?.get<string>("anims");
    const set = path ? this.animSet(path) : null;
    const out: string[] = [];
    for (const a of Object.values(set ?? {})) for (const f of a.frames) if (!out.includes(f)) out.push(f);
    return out;
  }

  private ghostSample(run: LbRun): GhostFrame | null {
    if (!run.track?.alive && !run.explicitTrack) run.track = this.avatar();
    const e = run.track;
    if (!e?.alive) return null;
    const m = global2D(e);
    const sprite = this.trackedSprite(e);
    const tex = sprite?.get<string>("texture");
    const frame = sprite && tex ? Math.max(0, this.animTextures(sprite).indexOf(tex)) : 0;
    return [m[4], m[5], sprite?.get<boolean>("flip_h") ? 1 : 0, frame];
  }

  private requestGhost(which: string, board: string, armed: boolean) {
    const token = ++this.lbToken;
    this.lbPendingGhost = { which, board, armed, ghost: null, token };
    this.lbInFlight++;
    this.leaderboardHost.ghost(which, board).then(
      (g) => {
        const p = this.lbPendingGhost;
        if (this.disposed || !p || p.token !== token) return;
        if (!g || !isGhost(g)) { this.lbPendingGhost = null; this.log("warn", `[leaderboard] no ghost "${which}" on board "${board}"`); return; }
        p.ghost = g;
      },
      (e) => { if (this.lbPendingGhost?.token === token) this.lbPendingGhost = null; this.log("warn", `[leaderboard] ghost "${which}" failed: ${(e as Error)?.message ?? e}`); },
    ).finally(() => this.lbInFlight--);
  }

  private trySpawnGhost() {
    const p = this.lbPendingGhost;
    if (!p?.ghost || p.armed || p.ghost.scene !== this.scenePath) return;
    this.lbPendingGhost = null;
    this.removeGhost();
    const run = this.lbRuns.get(p.board);
    const tracked = run?.track?.alive ? run.track : this.avatar();
    const tmpl = this.trackedSprite(tracked);
    const e = this.world.create(null, "Sprite2D", "ghost");
    let offset: [number, number] = [0, 0];
    if (tmpl) {
      for (const k of ["texture", "size", "scale"]) if (k in tmpl.props) e.props[k] = structuredClone(tmpl.props[k]);
      const tm = global2D(tmpl), em = global2D(tracked);
      offset = [tm[4] - em[4], tm[5] - em[5]];
      let z = 0;
      for (let x: Entity | null = tmpl; x; x = x.parent) z += x.def.props.z_index ? x.get<number>("z_index") : 0;
      e.props.z_index = Math.max(-4096, z - 1);
    } else e.props.size = [32, 32];
    const mod = (tmpl?.get<number[]>("modulate") ?? [1, 1, 1, 1]);
    e.props.modulate = [mod[0]!, mod[1]!, mod[2]!, (mod[3] ?? 1) * GHOST_ALPHA];
    this.world.attach(e, this.world.root);
    const g = p.ghost;
    this.lbGhost = { ghost: g, board: p.board, entity: e, t0: this.time, tex: this.animTextures(tmpl), offset, endAt: g.frames.length / (g.hz || 10) + 1 };
    this.placeGhost();
  }

  private placeGhost() {
    const g = this.lbGhost!;
    const e = g.entity;
    if (!e?.alive) { this.lbGhost = null; return; }
    const t = this.time - g.t0;
    const s = ghostAt(g.ghost, t) ?? (t < g.endAt ? ghostAt(g.ghost, (g.ghost.frames.length - 1) / (g.ghost.hz || 10)) : null);
    if (!s) { this.removeGhost(); return; }
    const parent = e.parent ? global2D(e.parent) : null;
    const [x, y] = parent ? apply(invert(parent), s.x + g.offset[0], s.y + g.offset[1]) : [s.x + g.offset[0], s.y + g.offset[1]];
    e.props.position = [x, y];
    e.props.flip_h = s.flipX;
    const tex = g.tex[s.frame];
    if (tex) e.props.texture = tex;
    e.rev++;
  }

  private removeGhost() {
    const e = this.lbGhost?.entity;
    this.lbGhost = null;
    if (e?.alive) this.world.remove(e);
  }

  private lbSceneChanged() {
    // world.clear() already removed the ghost entity; recordings are single-scene, so stop sampling
    this.lbGhost = null;
    for (const r of this.lbRuns.values()) if (r.rec && r.rec.scene !== this.scenePath) { r.rec = null; r.track = null; }
  }

  private stepLeaderboard() {
    for (const r of this.lbRuns.values()) {
      if (!r.rec || r.rec.full) continue;
      r.rec.sample(this.time, () => this.ghostSample(r));
    }
    if (this.lbGhost) this.placeGhost();
    if (this.lbPendingGhost?.ghost) this.trySpawnGhost();
  }

  /** Load and start a package (runs scripts). Throws GameLoadError for unplayable packages. */
  static async load(pkg: Package, opts: GameOptions = {}): Promise<Game> {
    await loadKitSources();
    registerKitDependencies(kitDependencies());
    const v = validatePackage(pkg);
    if (!v.manifest) throw new GameLoadError(v.issues.filter((i) => i.severity === "error").map((i) => i.message).join("\n") || "invalid package");
    if (v.manifest.dimension === "3d") throw new GameLoadError("3D games are not supported yet");
    const path = opts.scene ?? v.manifest.entry_scene;
    const scene = v.scenes[path];
    if (!scene) throw new GameLoadError(`scene ${path} could not be loaded`);
    const game = new Game(pkg, v.manifest, scene, path, v.scenes, v.assets, opts);
    for (const i of v.issues) if (i.severity === "error") game.log("warn", `[validate] ${i.file ?? ""} ${i.message}`);
    await loadKitSources();
    registerKitDependencies(kitDependencies());
    game.enabledKits = expandKits(v.manifest.kits ?? []);
    game.scanBoards();
    await game.loadStore();
    await game.loadSave();
    await game.init();
    return game;
  }

  private async init() {
    await initRapier2D();
    this.physics = new Physics2D(this.dt, this.manifest.physics?.layers ?? []);
    this.vm = await LuauVM.create(this.opts);
    this.vm.host = (L) => this.host(L);
    this.net = new NetSession(this.opts.net ?? null, {
      vm: () => this.vm, world: this.world, scenePath: () => this.scenePath, avatar: () => this.avatar(),
      destroy: (e) => this.destroyEntity(e), playAnim: (e, name) => this.playAnim(e, name, false),
      call: (ref, nargs, push) => this.callRef(ref, null, nargs, push), entityArg: (L, i) => this.entityArg(L, i),
      readJSON: (L, i) => this.readJSON(L, i), pushJSON: (L, v) => this.pushJSON(L, v), log: (level, text) => this.log(level, text),
      hide: (e) => { if (e.props.visible !== false) { e.props.visible = false; e.rev++; } this.physics?.applyEnabled(e); },
      ended: () => { if (!this.net.spectating) this.emitRunEnd({ reason: "finish" }); },
    });
    const L = this.vm.L;
    const err = this.vm.load(L, "=dreamsy", PRELUDE);
    if (err) throw new Error(`prelude failed to compile: ${err}`);
    const perr = this.vm.pcall(L, 0, 0);
    if (perr) throw new Error(`prelude failed: ${perr.message}\n${perr.traceback}`);
    this.vm.sandbox();
    this.callRef(this.refs.sceneSet, null, 2, (L) => { this.vm.pushString(L, this.scenePath); if (this.opts.sceneParams) this.pushJSON(L, this.opts.sceneParams); else this.vm.pushNil(L); });
    this.buildScene();

    // unattached client/server scripts: the session (they survive loadScene)
    const attached = new Set<string>();
    for (const sc of this.pkg.paths("scenes/")) {
      try {
        const s = JSON.parse(this.pkg.text(sc)!) as Scene;
        for (const e of Object.values(s.entities)) for (const p of e.scripts ?? []) attached.add(p);
      } catch { /* validated elsewhere */ }
    }
    for (const dir of ["scripts/server/", "scripts/client/"]) {
      for (const p of this.pkg.paths(dir)) if (p.endsWith(".luau") && !attached.has(p)) this.runScript(p, null);
    }
    this.callRef(this.refs.start, null, 0);
    this.fire(null, "sceneLoaded", (L) => { this.vm.pushString(L, this.scenePath); return 1; });
    this.processSceneChange();
  }

  /** Instantiate this.scene: entities, tiles, physics, then attached scripts in tree order. */
  private buildScene() {
    const created = this.world.loadScene(this.scene, (m) => this.log("warn", `[scene] ${m}`));
    // spectators have no avatar: the scene's "player" entities stay hidden (no physics) and their scripts don't run;
    // they remain the visual template for the other players' puppets
    const skip = new Set<Entity>();
    if (this.net?.spectating) {
      for (const e of created) {
        if (!e.tags.has("player")) continue;
        e.props.visible = false;
        e.rev++;
        for (const x of this.world.walk(e)) skip.add(x);
      }
    }
    for (const e of created) {
      if (e.type === "TileMap2D") this.loadTiles(e, false);
      this.physics!.markDirty(e);
    }
    this.physics!.flush();
    for (const e of created) if (e.alive && !skip.has(e)) for (const p of e.scripts) this.runScript(p, e);
  }

  private processSceneChange() {
    for (let i = 0; this.pendingScene && i < MAX_SCENE_CHAIN; i++) {
      const path = this.pendingScene;
      this.pendingScene = null;
      this.switchScene(path);
    }
    this.pendingScene = null;
  }

  /**
   * Tear down the current scene (entities, attached-script instances with their ticks/timers/
   * connections, physics) and build `path`. Unattached (session) scripts keep running.
   */
  private switchScene(path: string) {
    const scene = this.scenes[path];
    if (!scene) return;
    const vm = this.vm, L = vm.L;
    this.world.clear();
    const dead = (inst: ScriptInst) => inst.owner !== null && !inst.owner.alive;
    for (const [id, c] of this.conns) {
      if ((c.e && !c.e.alive) || dead(c.inst)) { vm.unref(L, c.ref); this.conns.delete(id); }
    }
    this.ticks = this.ticks.filter((t) => { if (dead(t.inst)) { vm.unref(L, t.ref); return false; } return true; });
    for (const t of [...this.timers]) if (dead(t.inst)) this.removeTimer(t.id, true);
    this.scripts = this.scripts.filter((s) => !dead(s));
    this.tileTouching.clear();
    this.physics?.dispose();
    this.physics = new Physics2D(this.dt, this.manifest.physics?.layers ?? []);
    this.tweens = this.tweens.filter((t) => t.e.alive);
    this.dialogs.clear();
    this.cam.init = false;
    this.lbSceneChanged();
    this.scene = scene;
    this.scenePath = path;
    this.log("info", `[scene] loaded ${path}`);
    this.callRef(this.refs.sceneSet, null, 1, (L2) => vm.pushString(L2, path));
    this.buildScene();
    this.fire(null, "sceneLoaded", (L2) => { vm.pushString(L2, path); return 1; });
  }

  // ---------------------------------------------------------------- tiles

  /** (Re)load a TileMap2D's grid from its tileset/data props. `strict` throws (script set a bad value). */
  private loadTiles(e: Entity, strict: boolean) {
    const tileset = e.get<string>("tileset") ?? "", data = e.get<string>("data") ?? "";
    const key = `${tileset}\0${data}`;
    if (key === e.tilesKey && e.tiles) return;
    e.tilesKey = key;
    const r = loadTileGrid(this.pkg, tileset, data);
    if (r.errors.length) {
      const msg = `TileMap2D "${e.id}": ${r.errors.join("; ")}`;
      if (strict && !r.grid) throw new Error(msg);
      this.log("warn", `[tilemap] ${msg}`);
    }
    e.tiles = r.grid ?? null;
    e.rev++;
    this.physics?.markDirty(e);
  }

  private tilesOf(e: Entity): TileGrid {
    if (e.type !== "TileMap2D") throw new Error(`${e.type} "${e.id}" is not a TileMap2D`);
    if (!e.tiles) throw new Error(`TileMap2D "${e.id}" has no tiles (check its tileset and data)`);
    return e.tiles;
  }

  /** World point → [col, row] (may be out of bounds). */
  private worldToCell(e: Entity, x: number, y: number): [number, number] {
    const [lx, ly] = apply(invert(global2D(e)), x, y);
    const ts = e.get<number>("tile_size");
    return [Math.floor(lx / ts), Math.floor(ly / ts)];
  }

  /** Fire tileTouched for (moving body, tile) pairs that started touching this tick. */
  private detectTileTouches() {
    if (!this.physics) return;
    let maps: Entity[] | null = null;
    for (const c of this.conns.values()) {
      if (c.signal === "tileTouched" && c.e?.alive && c.e.tiles) (maps ??= []).includes(c.e) || maps.push(c.e);
    }
    if (!maps) { this.tileTouching.clear(); return; }
    const bodies = [...this.physics.movingBodies()];
    for (const map of maps) {
      const grid = map.tiles!;
      const prev = this.tileTouching.get(map) ?? new Set<string>();
      const now = new Set<string>();
      const fresh: [Entity, number, number][] = [];
      if (this.effectiveVisible(map)) {
        const inv = invert(global2D(map));
        const ts = map.get<number>("tile_size");
        for (const b of bodies) {
          if (!b.alive) continue;
          const box = this.physics.aabb(b);
          if (!box) continue;
          // body AABB in map-local pixels
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
          for (const [wx, wy] of [[box[0], box[1]], [box[2], box[1]], [box[0], box[3]], [box[2], box[3]]] as const) {
            const [lx, ly] = apply(inv, wx, wy);
            x0 = Math.min(x0, lx); y0 = Math.min(y0, ly); x1 = Math.max(x1, lx); y1 = Math.max(y1, ly);
          }
          const c0 = Math.max(0, Math.floor((x0 - 1) / ts)), c1 = Math.min(grid.cols - 1, Math.floor((x1 + 1) / ts));
          const r0 = Math.max(0, Math.floor((y0 - 1) / ts)), r1 = Math.min(grid.rows - 1, Math.floor((y1 + 1) / ts));
          for (let r = r0; r <= r1; r++) {
            for (let c = c0; c <= c1; c++) {
              const k = grid.kinds[grid.cells[r * grid.cols + c]!];
              if (!k || k.index === 0 || (!k.solid && k.tags.length === 0)) continue;
              const ox = Math.min(x1, (c + 1) * ts) - Math.max(x0, c * ts);
              const oy = Math.min(y1, (r + 1) * ts) - Math.max(y0, r * ts);
              // solid: touching (within 1px) along a shared edge; non-solid tagged: overlapping
              const hit = k.solid ? (ox > 0.5 && oy > -1) || (oy > 0.5 && ox > -1) : ox > 0.5 && oy > 0.5;
              if (!hit) continue;
              const key = `${b.handle}:${r * grid.cols + c}`;
              now.add(key);
              if (!prev.has(key)) fresh.push([b, c, r]);
            }
          }
        }
      }
      this.tileTouching.set(map, now);
      for (const [b, c, r] of fresh) {
        if (!map.alive || !b.alive || !map.tiles) break;
        const k = map.tiles.kindAt(c, r);
        if (!k) continue; // removed by an earlier handler this tick
        this.fire(map, "tileTouched", (L) => {
          this.pushEntity(L, b);
          this.vm.pushString(L, k.char);
          this.vm.pushNumber(L, c);
          this.vm.pushNumber(L, r);
          return 4;
        });
      }
    }
    for (const m of this.tileTouching.keys()) if (!m.alive) this.tileTouching.delete(m);
  }

  // ---------------------------------------------------------------- host API

  /** Advance by real elapsed seconds; runs 0..maxSteps fixed ticks. */
  advance(seconds: number, maxSteps = 5): number {
    if (this._paused) return 0;
    this.accumulator = Math.min(this.accumulator + seconds, this.dt * maxSteps);
    let n = 0;
    while (this.accumulator >= this.dt - 1e-9) {
      this.accumulator -= this.dt;
      this.step();
      n++;
    }
    return n;
  }

  /** One fixed simulation tick. */
  step() {
    if (this.disposed) return;
    this.input.beginTick();
    this.tick++;
    const sdt = this.dt * this.timeScale;
    this.time += sdt;
    this.callRef(this.refs.flush, null, 0);
    this.net.beforeTick();
    this.firePurchases();
    this.fireLeaderboardResults();
    if (this.pointerClearTick === this.tick) this.input.pointer = null;
    this.stepDialogs();

    // timers (deterministic order: due time, then creation order)
    for (;;) {
      let best: Timer | null = null;
      for (const t of this.timers) if (t.due <= this.time + 1e-9 && (!best || t.due < best.due || (t.due === best.due && t.seq < best.seq))) best = t;
      if (!best) break;
      if (best.interval > 0) {
        best.due += best.interval;
        best.seq = this.nextId++;
      } else {
        this.removeTimer(best.id, false);
      }
      this.callRef(best.ref, best.inst, 0);
      if (best.interval <= 0) this.vm.unref(this.vm.L, best.ref);
    }

    this.stepTweens(sdt);

    for (const cb of [...this.ticks]) {
      if (!this.ticks.includes(cb)) continue;
      this.callRef(cb.ref, cb.inst, 1, (L) => this.vm.pushNumber(L, sdt));
    }

    if (this.physics && sdt > 0) {
      this.physics.world.timestep = sdt;
      const events = this.physics.step((e) => e.rev++);
      for (const ev of events) {
        if (!ev.a.alive || !ev.b.alive) continue;
        this.fire(ev.a, ev.started ? "bodyEntered" : "bodyExited", (L) => { this.pushEntity(L, ev.b); return 1; });
      }
      this.detectTileTouches();
    }
    this.net.afterPhysics();
    this.stepSpritesAndParticles(sdt);
    this.stepLeaderboard();
    this.updateCamera(false);
    this.toasts = this.toasts.filter((t) => t.until > this.time);
    this.processSceneChange();
  }

  /** UIButton press (from the renderer's overlay). */
  press(id: string) {
    const e = this.world.byId.get(id);
    if (e && e.alive && this.effectiveVisible(e)) this.fire(e, "pressed", () => 0);
  }

  /** Fire `tapped` on a specific entity (UI overlay). */
  tapEntity(id: string): boolean {
    const e = this.world.byId.get(id);
    if (!e || !this.hasConn(e, "tapped")) return false;
    this.fire(e, "tapped", (L) => { this.vm.getRef(L, this.refs.player); return 1; });
    return true;
  }

  /** World-space tap: fires `tapped` on the topmost visible entity under the point that listens for it. */
  tapWorld(x: number, y: number): Entity | null {
    let best: Entity | null = null;
    let bestKey = -Infinity;
    let order = 0;
    const listeners = new Set<Entity>();
    for (const c of this.conns.values()) if ((c.signal === "tapped" || c.signal === "tileTapped" || c.signal === "tappedAt") && c.e) listeners.add(c.e);
    if (listeners.size === 0) return null;
    let cell: [number, number] | null = null, bestCell: [number, number] | null = null;
    const visit = (e: Entity, z: number, vis: boolean, inherited: Entity | null) => {
      const v = vis && e.get<boolean>("visible") !== false;
      const zz = z + (e.def.props.z_index ? e.get<number>("z_index") : 0);
      const target = listeners.has(e) ? e : inherited;
      order++;
      if (v && target && e.type === "TileMap2D" && e.tiles) {
        const [lx, ly] = apply(invert(global2D(e)), x, y);
        const ts = e.get<number>("tile_size");
        const c = Math.floor(lx / ts), r = Math.floor(ly / ts);
        if (e.tiles.inBounds(c, r)) {
          cell = [c, r];
          const key = zz * 1e6 + order;
          if (key > bestKey) { bestKey = key; best = target; bestCell = target === e ? cell : null; }
        }
      } else if (v && target && "size" in e.def.props && e.is2D) {
        const m = global2D(e);
        const [lx, ly] = apply(invert(m), x, y);
        const s = e.get<number[]>("size");
        if (Math.abs(lx) <= s[0]! / 2 && Math.abs(ly) <= s[1]! / 2) {
          const key = zz * 1e6 + order;
          if (key > bestKey) { bestKey = key; best = target; bestCell = null; }
        }
      }
      for (const c of e.children) visit(c, zz, v, target);
    };
    visit(this.world.root, 0, true, null);
    void cell;
    const hit = best as Entity | null;
    const hc = bestCell as [number, number] | null;
    if (hit && hc && hit.tiles) {
      const [c, r] = hc;
      const k = hit.tiles.kindAt(c, r);
      this.fire(hit, "tileTapped", (L) => { this.vm.pushNumber(L, c); this.vm.pushNumber(L, r); if (k) this.vm.pushString(L, k.char); else this.vm.pushNil(L); return 3; });
    }
    if (hit && this.hasConn(hit, "tappedAt")) {
      // local position inside the target: (0,0) = top-left corner of its `size` box (unrotated, unscaled)
      const [lx, ly] = apply(invert(global2D(hit)), x, y);
      const sz = "size" in hit.def.props ? hit.get<number[]>("size") : [0, 0];
      const off = hit.type === "TileMap2D" ? [0, 0] : [sz[0]! / 2, sz[1]! / 2];
      this.fire(hit, "tappedAt", (L) => this.pushVec2(L, lx + off[0]!, ly + off[1]!));
    }
    if (hit) this.tapEntity(hit.id);
    return hit;
  }

  currentCamera2D(): Entity | null {
    for (const e of this.world.walk()) if (e.type === "Camera2D" && e.get<boolean>("current")) return e;
    return null;
  }

  effectiveVisible(e: Entity): boolean {
    for (let x: Entity | null = e; x; x = x.parent) if (x.get<boolean>("visible") === false) return false;
    return true;
  }

  avatar(): Entity | null {
    return this.world.tagged("player")[0] ?? null;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.physics?.dispose();
    this.vm.close();
  }

  memoryUsed(): number { return this.vm.memUsed(); }

  // ---------------------------------------------------------------- camera

  /** View center (smoothing, limits and shake applied) and zoom. Same in Node and the renderer. */
  cameraView(): { x: number; y: number; zoom: number } {
    if (!this.cam.init) this.updateCamera(true);
    const cam = this.cam.entity && this.cam.entity.alive ? this.cam.entity : null;
    const zoom = cam ? Math.max(0.05, cam.get<number>("zoom")) : 1;
    return { x: this.cam.x + this.cam.ox, y: this.cam.y + this.cam.oy, zoom };
  }

  /** Re-center on the follow target immediately (after a teleport / respawn). */
  snapCamera() { this.cam.init = false; }

  private updateCamera(snap: boolean) {
    const [rw, rh] = this.refSize;
    const cam = this.currentCamera2D();
    const c = this.cam;
    if (!cam) {
      c.x = rw / 2; c.y = rh / 2;
    } else {
      const zoom = Math.max(0.05, cam.get<number>("zoom"));
      const followId = cam.get<string | undefined>("follow");
      // spectators: a camera that follows an avatar follows the watched player's puppet instead
      const watched = followId && this.net?.spectating ? this.net.focusPuppet() : null;
      const target = watched ?? (followId ? this.world.byId.get(followId) : undefined);
      const m = global2D(target ?? cam);
      let x = m[4], y = m[5];
      if (!snap && c.init && cam === c.entity && target) {
        const dz = cam.get<number[]>("deadzone");
        const dx = x - c.x, dy = y - c.y;
        const hx = dz[0]! / 2, hy = dz[1]! / 2;
        x = Math.abs(dx) <= hx ? c.x : x - Math.sign(dx) * hx;
        y = Math.abs(dy) <= hy ? c.y : y - Math.sign(dy) * hy;
        const sm = cam.get<number>("smoothing");
        if (sm > 0) {
          const k = 1 - Math.pow(sm, this.dt * 10);
          x = c.x + (x - c.x) * k;
          y = c.y + (y - c.y) * k;
        }
      }
      // limits: keep the visible rect inside [limit_min, limit_max]
      const lo = cam.get<number[] | undefined>("limit_min"), hi = cam.get<number[] | undefined>("limit_max");
      const vw = rw / zoom, vh = rh / zoom;
      const clamp = (v: number, a: number | undefined, b: number | undefined, half: number) => {
        const min = a === undefined ? -Infinity : a + half, max = b === undefined ? Infinity : b - half;
        if (min > max) return ((a ?? 0) + (b ?? 0)) / 2;
        return Math.max(min, Math.min(max, v));
      };
      c.x = clamp(x, lo?.[0], hi?.[0], vw / 2);
      c.y = clamp(y, lo?.[1], hi?.[1], vh / 2);
    }
    c.entity = cam;
    c.init = true;
    if (!snap) {
      if (c.shakeT > 0) {
        c.shakeT = Math.max(0, c.shakeT - this.dt);
        const amp = c.shakeI * (c.shakeDur > 0 ? c.shakeT / c.shakeDur : 0);
        c.ox = (this.camRng.next() * 2 - 1) * amp;
        c.oy = (this.camRng.next() * 2 - 1) * amp;
      } else {
        c.ox = 0; c.oy = 0;
      }
    }
  }

  /** camera.shake: world-pixel amplitude, decaying linearly over `seconds`. Stronger shakes replace weaker ones. */
  shake(intensity: number, seconds: number) {
    const c = this.cam;
    const remaining = c.shakeDur > 0 ? c.shakeI * (c.shakeT / c.shakeDur) : 0;
    if (intensity < remaining) return;
    c.shakeI = Math.max(0, intensity);
    c.shakeDur = c.shakeT = Math.max(this.dt, seconds);
  }

  /** Current shake offset (tests / tools). */
  get shakeOffset(): [number, number] { return [this.cam.ox, this.cam.oy]; }

  // ---------------------------------------------------------------- dialogs & taps

  /** A tap on the open dialog: option index (0-based) for a choice option, -1 = the box. Applied next tick. */
  dialogTap(option = -1) { if (this.dialogs.current) this.dialogTapQ = option; }

  private stepDialogs() {
    const d = this.dialogs;
    const wasBlocking = !!d.current?.blocking;
    if (d.current) {
      const ny = this.input.rawAxis("move_y");
      const dir = ny < -0.5 ? -1 : ny > 0.5 ? 1 : 0;
      const nav = dir !== this.navPrev ? dir : 0;
      this.navPrev = dir;
      const confirm = this.input.rawPressed("jump") || this.input.rawPressed("action");
      const tap = this.dialogTapQ;
      this.dialogTapQ = null;
      const done = d.step(this.dt, { confirm, nav, tap });
      if (done) this.callRef(this.refs.done, null, 2, (L) => { this.vm.pushNumber(L, done.id); if (done.choice >= 0) this.vm.pushNumber(L, done.choice + 1); else this.vm.pushNil(L); });
    } else {
      this.dialogTapQ = null;
      this.navPrev = 0;
    }
    // the tick a blocking dialog closes still swallows its confirm press
    this.input.blocked = wasBlocking || !!d.current?.blocking;
  }

  /**
   * Tap at reference-screen coordinates (headless playtests; the browser uses DOM events).
   * Advances an open dialog, else presses the topmost UIButton/UIPanel under the point, else taps the world.
   * Returns what was hit: "dialog", an entity id, or null.
   */
  tapScreen(x: number, y: number): string | null {
    this.pointerDown(x, y);
    this.pointerUp(x, y);
    this.input.pointer = [x, y];
    this.pointerClearTick = this.tick + 6;
    if (this.dialogs.current) { this.dialogTap(-1); return "dialog"; }
    const ui = this.uiHit(x, y);
    if (ui) {
      if (ui.type === "UIButton") this.press(ui.id);
      this.tapEntity(ui.id);
      return ui.id;
    }
    const v = this.cameraView();
    const [wx, wy] = refToWorld(v.x, v.y, v.zoom, this.refSize, x, y);
    return this.tapWorld(wx, wy)?.id ?? null;
  }

  /**
   * Raw pointer events in reference (UI) px, from the browser (canvas + UI overlay) or headless tools.
   * Fire input.pointerDown / pointerUp / swipe immediately, so flicks shorter than a frame are never lost.
   * `t` = event time in seconds (default: ticks × dt, unscaled); swipe velocity uses it (min one tick).
   */
  pointerDown(x: number, y: number, t?: number) {
    if (this.disposed) return;
    this.input.pointer = [x, y];
    this.pointerClearTick = -1;
    this.gesture = { x, y, t: t ?? this.tick * this.dt, tick: this.tick };
    this.fire(null, "pointerDown", (L) => this.pushVec2(L, x, y));
  }

  pointerMove(x: number, y: number) {
    if (this.gesture) this.input.pointer = [x, y];
  }

  pointerUp(x: number, y: number, t?: number) {
    if (this.disposed) return;
    const g = this.gesture;
    this.gesture = null;
    this.input.pointer = [x, y];
    // keep input.pointer() visible for the next tick even if down+up happened between two ticks
    this.pointerClearTick = this.tick + 2;
    this.fire(null, "pointerUp", (L) => this.pushVec2(L, x, y));
    if (!g) return;
    const dx = x - g.x, dy = y - g.y, dist = Math.hypot(dx, dy);
    const dt = Math.max(this.dt, (t ?? this.tick * this.dt) - g.t);
    if (dist < SWIPE_MIN_DIST || dt > SWIPE_MAX_TIME) return;
    const dir = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up";
    this.fire(null, "swipe", (L) => { this.vm.pushString(L, dir); this.pushVec2(L, dx / dt, dy / dt); return 3; });
  }

  /** Push x, y (the prelude wraps Vec2 signals' handlers and rebuilds the Vec2). */
  private pushVec2(L: LuaState, x: number, y: number): number {
    this.vm.pushNumber(L, x); this.vm.pushNumber(L, y);
    return 2;
  }

  /** UI element rect in reference px (no safe-area insets — headless). */
  uiRect(e: Entity): [number, number, number, number] {
    if (e.parent && (e.parent.type === "UIPanel" || e.parent.type === "UIButton" || e.parent.type === "UIText")) {
      const p = this.uiRect(e.parent);
      const r = uiChildRect(e, p[2], p[3]);
      return [p[0] + r[0], p[1] + r[1], r[2], r[3]];
    }
    return anchorRect(e.get<string>("anchor"), e.get<number[]>("offset"), e.get<number[]>("size"), 0, 0, this.refSize[0], this.refSize[1]);
  }

  private uiHit(x: number, y: number): Entity | null {
    let best: Entity | null = null, bestKey = -Infinity, order = 0;
    for (const e of this.world.walk()) {
      order++;
      if ((e.type !== "UIButton" && e.type !== "UIPanel" && e.type !== "UIText") || !this.effectiveVisible(e)) continue;
      if (e.type !== "UIButton" && e.get<boolean>("input_transparent")) continue;
      const [rx, ry, rw, rh] = this.uiRect(e);
      if (x < rx || y < ry || x > rx + rw || y > ry + rh) continue;
      const key = e.get<number>("z_index") * 1e6 + order;
      if (key > bestKey) { bestKey = key; best = e; }
    }
    return best;
  }

  // ---------------------------------------------------------------- tweens

  private startTween(e: Entity, tracks: TweenTrack[], duration: number, easing: string, delay: number, loop: boolean, yoyo: boolean): number {
    const ease = EASINGS[easing];
    if (!ease) throw new Error(`tween: unknown easing "${easing}" (use ${Object.keys(EASINGS).join(", ")})`);
    if (!(duration >= 0)) throw new Error("tween: seconds must be a number ≥ 0");
    // a new tween of the same prop on the same entity replaces the old one's track
    const keys = new Set(tracks.map((t) => t.key));
    for (const tw of this.tweens) if (tw.e === e) tw.tracks = tw.tracks.filter((t) => !keys.has(t.key));
    const id = this.nextId++;
    this.tweens.push({ id, e, tracks, duration, delay: Math.max(0, delay), t: 0, ease, loop, yoyo });
    return id;
  }

  private stepTweens(sdt: number) {
    if (!this.tweens.length) return;
    const finished: number[] = [];
    for (const tw of [...this.tweens]) {
      if (!tw.e.alive) { this.tweens.splice(this.tweens.indexOf(tw), 1); this.callRef(this.refs.done, null, 3, (L) => { this.vm.pushNumber(L, tw.id); this.vm.pushNil(L); this.vm.pushBoolean(L, true); }); continue; }
      tw.t += sdt;
      const [k, end] = tweenProgress(tw);
      if (k < 0) continue;
      for (const tr of tw.tracks) {
        try { this.setProp(tw.e, tr.key, trackValue(tr, k)); } catch (err) { this.log("warn", `[tween] ${(err as Error).message}`); }
      }
      if (end) { this.tweens.splice(this.tweens.indexOf(tw), 1); finished.push(tw.id); }
    }
    for (const id of finished) this.callRef(this.refs.done, null, 2, (L) => { this.vm.pushNumber(L, id); this.vm.pushNil(L); });
  }

  /** Live tween count (tests / tools). */
  get tweenCount(): number { return this.tweens.length; }

  // ---------------------------------------------------------------- sprite animation & particles

  /** Parsed data/anims/<name>.json (null when missing/invalid; logged once). */
  animSet(path: string): AnimSet | null {
    if (this.animsCache.has(path)) return this.animsCache.get(path)!;
    const text = this.pkg.text(path);
    let set: AnimSet | null = null;
    if (text === undefined) this.log("warn", `[anims] ${path} does not exist`);
    else {
      const r = parseAnims(text);
      if (r.errors.length) this.log("warn", `[anims] ${path}: ${r.errors.join("; ")}`);
      set = r.value && Object.keys(r.value).length ? r.value : null;
    }
    this.animsCache.set(path, set);
    return set;
  }

  /** e:play(name): on a Sprite2D with `anims`, else its first descendant that has them. */
  private playAnim(e: Entity, name: string, restart: boolean) {
    let sprite: Entity | null = null;
    for (const x of this.world.walk(e)) if (x.type === "Sprite2D" && x.get<string>("anims")) { sprite = x; break; }
    if (!sprite) throw new Error(`play: ${e.type} "${e.id}" has no Sprite2D with anims (set anims = "data/anims/<name>.json" on a Sprite2D)`);
    const set = this.animSet(sprite.get<string>("anims"));
    if (!set) throw new Error(`play: ${sprite.get<string>("anims")} could not be loaded`);
    if (!set[name]) throw new Error(`play: no animation "${name}" in ${sprite.get<string>("anims")} (has: ${Object.keys(set).join(", ")})`);
    sprite.animOwner = sprite === e ? null : e;
    if (sprite.get<string>("anim") === name && !restart && !sprite.animDone) return;
    sprite.props.anim = name;
    sprite.animName = "";
    this.advanceAnim(sprite, 0);
  }

  private advanceAnim(e: Entity, dt: number) {
    const name = e.get<string>("anim");
    if (!name) { e.animName = ""; return; }
    const set = this.animSet(e.get<string>("anims"));
    const a = set?.[name];
    if (!a) { e.animName = ""; return; }
    if (e.animName !== name) { e.animName = name; e.animT = 0; e.animDone = false; }
    else if (!e.animDone) e.animT += dt;
    let f = Math.floor(e.animT * a.fps + 1e-9);
    const n = a.frames.length;
    let finished = false;
    if (a.loop) f %= n;
    else if (f >= n) { f = n - 1; finished = !e.animDone; }
    const tex = a.frames[f]!;
    if (e.props.texture !== tex) { e.props.texture = tex; e.rev++; }
    if (finished) {
      e.animDone = true;
      for (const target of [e, e.animOwner]) {
        if (target?.alive) this.fire(target, "animFinished", (L) => { this.vm.pushString(L, name); return 1; });
      }
      if (a.next && e.alive && e.get<string>("anim") === name) { e.props.anim = a.next; e.rev++; this.advanceAnim(e, 0); }
    }
  }

  private stepSpritesAndParticles(sdt: number) {
    const w = this.world;
    if (this.live.rev !== w.structureRev) {
      this.live.rev = w.structureRev;
      this.live.sprites = []; this.live.emitters = [];
      for (const e of w.walk()) {
        if (e.type === "Sprite2D") this.live.sprites.push(e);
        else if (e.type === "Particles2D") this.live.emitters.push(e);
      }
    }
    for (const e of this.live.sprites) {
      if (!e.alive) continue;
      if (e.props.anim) this.advanceAnim(e, sdt);
      if (e.get<boolean>("auto_flip")) {
        let vx: number | null = null;
        for (let p: Entity | null = e.parent; p; p = p.parent) if (p.type === "Body2D") { vx = this.physics?.getVelocity(p)[0] ?? 0; break; }
        const gx = global2D(e)[4];
        if (vx === null) vx = Number.isNaN(e.lastX) || sdt <= 0 ? 0 : (gx - e.lastX) / sdt;
        e.lastX = gx;
        const flip = vx < -1 ? true : vx > 1 ? false : e.get<boolean>("flip_h");
        if (flip !== e.get<boolean>("flip_h")) { e.props.flip_h = flip; e.rev++; }
      }
    }
    for (const e of this.live.emitters) {
      if (!e.alive) continue;
      const em = (e.emitter ??= new Emitter((this.opts.seed ?? 1) * 7919 + e.handle * 104729));
      const m = global2D(e);
      em.step(e, sdt, m[4], m[5], (Math.atan2(m[1], m[0]) * 180) / Math.PI, this.effectiveVisible(e));
      e.rev++;
    }
  }

  private burst(e: Entity, n: number) {
    if (e.type !== "Particles2D") throw new Error(`burst: ${e.type} "${e.id}" is not a Particles2D`);
    const em = (e.emitter ??= new Emitter((this.opts.seed ?? 1) * 7919 + e.handle * 104729));
    const m = global2D(e);
    em.emit(e, Math.max(0, Math.floor(n)), m[4], m[5], (Math.atan2(m[1], m[0]) * 180) / Math.PI);
    e.rev++;
  }

  // ---------------------------------------------------------------- save data (JSON values across the boundary)

  /** Read a Lua value at index i as JSON (tables → arrays/objects). Throws for non-JSON values. */
  private readJSON(L: LuaState, i: number, depth = 0): unknown {
    const vm = this.vm;
    if (depth > 32) throw new Error("save: value is nested too deeply (max 32 levels)");
    const t = vm.type(L, i);
    if (t <= 0) return null;
    if (t === LUA_TBOOLEAN) return vm.toBoolean(L, i);
    if (t === LUA_TNUMBER) { const n = vm.toNumber(L, i); if (!Number.isFinite(n)) throw new Error("save: numbers must be finite"); return n; }
    if (t === LUA_TSTRING) return vm.toString(L, i);
    if (t !== LUA_TTABLE) throw new Error("save: values must be nil, booleans, numbers, strings or tables of those");
    const idx = i < 0 ? vm.getTop(L) + i + 1 : i;
    const entries: [string | number, unknown][] = [];
    vm.pushNil(L);
    while (vm.next(L, idx)) {
      const kt = vm.type(L, -2);
      let key: string | number;
      if (kt === LUA_TNUMBER) key = vm.toNumber(L, -2);
      else if (kt === LUA_TSTRING) key = vm.toString(L, -2) ?? "";
      else { vm.pop(L, 2); throw new Error("save: table keys must be strings or numbers"); }
      try { entries.push([key, this.readJSON(L, -1, depth + 1)]); } catch (e) { vm.pop(L, 2); throw e; }
      vm.pop(L, 1);
    }
    const n = entries.length;
    const isArray = n > 0 && entries.every(([k]) => typeof k === "number" && Number.isInteger(k) && k >= 1 && k <= n);
    if (isArray) {
      const arr = new Array(n);
      for (const [k, v] of entries) arr[(k as number) - 1] = v;
      return arr;
    }
    const obj: Record<string, unknown> = {};
    for (const [k, v] of entries) obj[String(k)] = v;
    return obj;
  }

  private pushJSON(L: LuaState, v: unknown) {
    const vm = this.vm;
    if (v === null || v === undefined) vm.pushNil(L);
    else if (typeof v === "boolean") vm.pushBoolean(L, v);
    else if (typeof v === "number") vm.pushNumber(L, v);
    else if (typeof v === "string") vm.pushString(L, v);
    else if (Array.isArray(v)) {
      vm.createTable(L, v.length, 0);
      v.forEach((x, i) => { this.pushJSON(L, x); vm.rawSetI(L, -2, i + 1); });
    } else if (typeof v === "object") {
      const ent = Object.entries(v as Record<string, unknown>);
      vm.createTable(L, 0, ent.length);
      for (const [k, x] of ent) { this.pushJSON(L, x); vm.rawSetField(L, -2, k); }
    } else vm.pushNil(L);
  }

  private writeSave(next: SaveData) {
    const bytes = new TextEncoder().encode(JSON.stringify(next)).length;
    if (bytes > MAX_SAVE_BYTES) throw new Error(`save: save data would be ${bytes} bytes; max ${MAX_SAVE_BYTES} (64KB) per game`);
    this.saveData = next;
    try { this.saveHost.write(next); } catch (e) { this.log("warn", `[save] write failed: ${(e as Error).message ?? e}`); }
  }

  // ---------------------------------------------------------------- scripts

  private log(level: LogLine["level"], text: string, script?: string) {
    const line = { time: this.time, level, text, script };
    this.logs.push(line);
    if (this.logs.length > 500) this.logs.splice(0, this.logs.length - 500);
    this.opts.onLog?.(line);
  }

  private recordError(message: string, traceback: string | undefined, fallbackScript: string) {
    let script = fallbackScript, line: number | undefined;
    const m = /^(scripts\/[^:\s]+\.luau):(\d+): ([\s\S]*)$/.exec(message);
    if (m) { script = m[1]!; line = Number(m[2]); message = m[3]!; }
    else if (traceback) {
      const t = /(scripts\/[^:\s]+\.luau):(\d+)/.exec(traceback);
      if (t) { script = t[1]!; line = Number(t[2]); }
    }
    const existing = this.errors.find((e) => e.script === script && e.line === line && e.message === message);
    if (existing) { existing.count++; return; }
    const err: ScriptError = { script, line, message, traceback, count: 1, time: this.time };
    this.errors.push(err);
    this.log("error", `${script}${line ? `:${line}` : ""}: ${message}`, script);
    this.opts.onError?.(err);
  }

  private runScript(path: string, owner: Entity | null) {
    const inst: ScriptInst = { path, owner, refs: new Set(), timers: new Set(), conns: new Set() };
    this.scripts.push(inst);
    const src = this.pkg.text(path);
    if (src === undefined) { this.recordError(`script ${path} does not exist`, undefined, path); return; }
    const vm = this.vm, L = vm.L;
    const top = vm.getTop(L);
    const T = vm.newThread(L);
    const lerr = vm.load(T, "@" + path, src);
    if (lerr) { this.recordError(lerr, undefined, path); vm.setTop(L, top); return; }
    this.setupScriptGlobals(T, owner, path);
    const prev = this.current;
    this.current = inst;
    const e = vm.pcall(T, 0, 0);
    this.current = prev;
    if (e) this.recordError(e.message, e.traceback, path);
    vm.setTop(L, top);
  }

  private setupScriptGlobals(T: LuaState, owner: Entity | null, path: string) {
    const vm = this.vm, L = vm.L;
    vm.getRef(L, this.refs.makeScript);
    if (owner) vm.pushNumber(L, owner.handle); else vm.pushNil(L);
    vm.pushString(L, path);
    const e = vm.pcall(L, 2, 2);
    if (e) throw new Error(e.message);
    vm.xmove(L, T, 2);
    vm.setGlobal(T, "require");
    vm.setGlobal(T, "script");
  }

  /** Call a ref'd Lua function protected. pushArgs pushes `nargs` values. */
  private callRef(ref: number, inst: ScriptInst | null, nargs: number, pushArgs?: (L: LuaState) => void) {
    if (!ref) return;
    const vm = this.vm, L = vm.L;
    const top = vm.getTop(L);
    vm.getRef(L, ref);
    pushArgs?.(L);
    const prev = this.current;
    this.current = inst;
    const e = vm.pcall(L, nargs, 0);
    this.current = prev;
    if (e) this.recordError(e.message, e.traceback, inst?.path ?? "?");
    vm.setTop(L, top);
  }

  private pushEntity(L: LuaState, e: Entity) {
    this.vm.getRef(L, this.refs.proxy);
    this.vm.pushNumber(L, e.handle);
    const err = this.vm.pcall(L, 1, 1);
    if (err) this.vm.pushNil(L);
  }

  private hasConn(e: Entity | null, signal: string): boolean {
    for (const c of this.conns.values()) if (c.e === e && c.signal === signal) return true;
    return false;
  }

  private fire(e: Entity | null, signal: string, pushArgs: (L: LuaState) => number) {
    const list = [...this.conns.values()].filter((c) => c.e === e && c.signal === signal);
    for (const c of list) {
      if (!this.conns.has(c.id)) continue;
      const vm = this.vm, L = vm.L;
      const top = vm.getTop(L);
      vm.getRef(L, c.ref);
      const n = pushArgs(L);
      const prev = this.current;
      this.current = c.inst;
      const err = vm.pcall(L, n, 0);
      this.current = prev;
      if (err) this.recordError(err.message, err.traceback, c.inst.path);
      vm.setTop(L, top);
    }
  }

  /** Resolve a require() name to a module path: "scripts/…luau" or "kits/<kit>/…luau". */
  private resolveModule(from: string, name: string): string {
    if (name.startsWith("@")) {
      const m = /^@kit\/([a-z][a-z0-9-]{0,31})(?:\/([a-z0-9_\-/]+))?$/.exec(name);
      if (!m) throw new Error(`require("${name}"): kits are required as "@kit/<kit>" or "@kit/<kit>/<module>"`);
      const kit = m[1]!;
      if (!this.enabledKits.includes(kit)) {
        const fromKit = /^kits\/([a-z][a-z0-9-]*)\//.exec(from)?.[1];
        throw new Error(fromKit
          ? `require("${name}") in kit "${fromKit}": kit "${kit}" is not enabled (declare it in kits/${fromKit}/kit.json "requires")`
          : `require("${name}"): kit "${kit}" is not enabled (add kits = ["${kit}"] to dreamsy.toml)`);
      }
      const sub = (m[2] ?? "init").replace(/\/+$/, "");
      if (sub.split("/").some((x) => x === ".." || x === "." || x === "")) throw new Error(`require("${name}"): bad kit module path`);
      let path = `kits/${kit}/${sub}.luau`;
      if (kitSource(path) === undefined && kitSource(`kits/${kit}/${sub}/init.luau`) !== undefined) path = `kits/${kit}/${sub}/init.luau`;
      if (kitSource(path) === undefined) throw new Error(`require("${name}"): kit module ${path} not found${kitSource(`kits/${kit}/init.luau`) === undefined ? ` (kit "${kit}" is not bundled with this engine)` : ""}`);
      return path;
    }
    const inKit = /^kits\/([a-z][a-z0-9-]*)\//.exec(from);
    const parts = from.split("/").slice(0, -1);
    const floor = inKit ? 2 : 1; // can't climb above kits/<kit>/ or scripts/
    for (const seg of name.replace(/\.luau$/, "").split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") { if (parts.length <= floor) throw new Error(`require("${name}") escapes ${inKit ? `kits/${inKit[1]}/` : "scripts/"}`); parts.pop(); }
      else parts.push(seg);
    }
    const path = parts.join("/") + ".luau";
    if (inKit) {
      if (!path.startsWith(`kits/${inKit[1]}/`)) throw new Error(`require("${name}"): kit modules can only require modules of their own kit`);
      if (kitSource(path) === undefined) throw new Error(`require("${name}"): kit module ${path} not found`);
      return path;
    }
    if (!path.startsWith("scripts/")) throw new Error(`require("${name}"): only modules under scripts/ (or "@kit/<kit>") can be required`);
    return path;
  }

  private requireModule(L: LuaState, from: string, name: string) {
    const path = this.resolveModule(from, name);
    const cached = this.modules.get(path);
    if (cached !== undefined) { this.vm.getRef(L, cached); return; }
    if (this.loadingModules.has(path)) throw new Error(`require("${name}"): circular require of ${path}`);
    const src = path.startsWith("kits/") ? kitSource(path) : this.pkg.text(path);
    if (src === undefined) throw new Error(`require("${name}"): module ${path} not found`);
    const vm = this.vm;
    const top = vm.getTop(vm.L);
    this.loadingModules.add(path);
    try {
      const T = vm.newThread(vm.L);
      const lerr = vm.load(T, "@" + path, src);
      if (lerr) throw new Error(lerr);
      this.setupScriptGlobals(T, null, path);
      // module top level belongs to the session: its onTick/timers/connections survive the requiring entity
      const prev = this.current;
      this.current = this.sessionInst;
      const err = vm.pcall(T, 0, 1);
      this.current = prev;
      if (err) throw new Error(err.message);
      const ref = vm.ref(T, -1);
      this.modules.set(path, ref);
    } finally {
      this.loadingModules.delete(path);
      vm.setTop(vm.L, top);
    }
    vm.getRef(L, this.modules.get(path)!);
  }

  // ---------------------------------------------------------------- entities

  private entityArg(L: LuaState, i: number): Entity {
    const h = this.vm.toNumber(L, i);
    const e = this.world.byHandle.get(h);
    if (!e) throw new Error("entity was destroyed");
    return e;
  }

  /** Read a tagged value (tag at i, payload after). */
  private readTagged(L: LuaState, i: number): unknown {
    const vm = this.vm;
    const tag = vm.toNumber(L, i);
    switch (tag) {
      case TAG.VEC2: return [vm.toNumber(L, i + 1), vm.toNumber(L, i + 2)];
      case TAG.VEC3: return [vm.toNumber(L, i + 1), vm.toNumber(L, i + 2), vm.toNumber(L, i + 3)];
      case TAG.COLOR: return [vm.toNumber(L, i + 1), vm.toNumber(L, i + 2), vm.toNumber(L, i + 3), vm.toNumber(L, i + 4)];
      case TAG.ENTITY: return vm.toNumber(L, i + 1);
      default: return this.readPlain(L, i + 1);
    }
  }

  private readPlain(L: LuaState, i: number): unknown {
    const t = this.vm.type(L, i);
    if (t === LUA_TNUMBER) return this.vm.toNumber(L, i);
    if (t === LUA_TSTRING) return this.vm.toString(L, i);
    if (t === LUA_TBOOLEAN) return this.vm.toBoolean(L, i);
    if (t <= 0) return undefined;
    throw new Error(`unsupported value type`);
  }

  private pushProp(L: LuaState, e: Entity, key: string): number {
    const vm = this.vm;
    switch (key) {
      case "id": vm.pushNumber(L, TAG.PLAIN); vm.pushString(L, e.id); return 2;
      case "type": vm.pushNumber(L, TAG.PLAIN); vm.pushString(L, e.type); return 2;
      case "name": vm.pushNumber(L, TAG.PLAIN); vm.pushString(L, e.name); return 2;
      case "parent":
        if (!e.parent) { vm.pushNumber(L, TAG.PLAIN); vm.pushNil(L); return 2; }
        vm.pushNumber(L, TAG.ENTITY); vm.pushNumber(L, e.parent.handle); return 2;
      case "velocity":
        if (e.type === "Body2D") {
          const v = this.physics!.getVelocity(e);
          vm.pushNumber(L, TAG.VEC2); vm.pushNumber(L, v[0]!); vm.pushNumber(L, v[1]!); return 3;
        }
        break;
      case "onFloor":
        if (e.type === "Body2D") { vm.pushNumber(L, TAG.PLAIN); vm.pushBoolean(L, this.physics!.onFloor(e)); return 2; }
        break;
      case "cols": case "rows":
        if (e.type === "TileMap2D") { vm.pushNumber(L, TAG.PLAIN); vm.pushNumber(L, e.tiles ? e.tiles[key as "cols" | "rows"] : 0); return 2; }
        break;
      case "particleCount":
        if (e.type === "Particles2D") { vm.pushNumber(L, TAG.PLAIN); vm.pushNumber(L, e.emitter?.n ?? 0); return 2; }
        break;
    }
    key = propAlias(e, key);
    const def = e.propDef(key);
    if (!def) throw new Error(`${e.type} "${e.id}" has no property "${key}"`);
    const v = e.get(key);
    if (v === undefined && (def.type.kind === "vec2" || def.type.kind === "vec3" || def.type.kind === "color")) { vm.pushNumber(L, TAG.PLAIN); vm.pushNil(L); return 2; }
    switch (def.type.kind) {
      case "vec2": { const a = v as number[]; vm.pushNumber(L, TAG.VEC2); vm.pushNumber(L, a[0]!); vm.pushNumber(L, a[1]!); return 3; }
      case "vec3": { const a = v as number[]; vm.pushNumber(L, TAG.VEC3); vm.pushNumber(L, a[0]!); vm.pushNumber(L, a[1]!); vm.pushNumber(L, a[2]!); return 4; }
      case "color": {
        const c = (Array.isArray(v) ? v : coerceProp(e, key, v, () => undefined)) as RGBA;
        vm.pushNumber(L, TAG.COLOR); for (const x of c) vm.pushNumber(L, x); return 5;
      }
      case "entity": {
        const t = typeof v === "string" ? this.world.byId.get(v) : undefined;
        if (!t) { vm.pushNumber(L, TAG.PLAIN); vm.pushNil(L); return 2; }
        vm.pushNumber(L, TAG.ENTITY); vm.pushNumber(L, t.handle); return 2;
      }
      default:
        vm.pushNumber(L, TAG.PLAIN);
        if (v === undefined || v === null) vm.pushNil(L);
        else if (typeof v === "number") vm.pushNumber(L, v);
        else if (typeof v === "boolean") vm.pushBoolean(L, v);
        else vm.pushString(L, String(v));
        return 2;
    }
  }

  private setProp(e: Entity, key: string, value: unknown) {
    if (key === "color" && e.type === "Sprite2D") { this.setProp(e, "modulate", value); return; }
    switch (key) {
      case "name": e.name = String(value ?? e.id); e.rev++; return;
      case "velocity":
        if (e.type === "Body2D") {
          if (!Array.isArray(value)) throw new Error(`velocity expects a Vec2`);
          this.physics!.setVelocity(e, value as number[]);
          return;
        }
        break;
      case "parent": {
        const p = value === undefined ? this.world.root : this.world.byHandle.get(value as number);
        if (!p) throw new Error("parent must be an Entity");
        for (let x: Entity | null = p; x; x = x.parent) if (x === e) throw new Error("cannot parent an entity to its own descendant");
        this.world.attach(e, p);
        this.afterTransform(e);
        return;
      }
      case "id": case "type": case "onFloor": case "particleCount":
        throw new Error(`${key} is read-only`);
      case "cols": case "rows":
        if (e.type === "TileMap2D") throw new Error(`${key} is read-only (edit tiles with setTile)`);
        break;
    }
    const v = coerceProp(e, key, value, (h) => this.world.resolve(h));
    const prev = e.props[key];
    // nil resets a prop to its catalog default (or unset for props without one)
    if (v === undefined || value === undefined || value === null) delete e.props[key]; else e.props[key] = v;
    if ((key === "layer" || key === "mask") && this.physics) {
      try { this.physics.groups(e); } catch (err) { if (prev === undefined) delete e.props[key]; else e.props[key] = prev; throw err; }
    }
    e.rev++;
    if (TRANSFORM_KEYS.has(key)) {
      this.afterTransform(e);
      if (key === "scale") this.markPhysicsSubtree(e);
    } else if (PHYSICS_KEYS.has(key)) this.physics?.markDirty(e);
    else if (key === "visible") this.physics?.applyEnabled(e);
    else if (e.type === "TileMap2D" && TILE_KEYS.has(key) && !this.spawning.has(e)) this.loadTiles(e, true);
  }

  private afterTransform(e: Entity) {
    if (!this.physics) return;
    const walk = (x: Entity) => {
      this.physics!.syncTransform(x);
      for (const c of x.children) walk(c);
    };
    walk(e);
  }

  private markPhysicsSubtree(e: Entity) {
    const walk = (x: Entity) => { this.physics?.markDirty(x); for (const c of x.children) walk(c); };
    walk(e);
  }

  private destroyEntity(e: Entity) {
    if (e === this.world.root) throw new Error("cannot destroy the scene root");
    const removed = this.world.remove(e);
    const set = new Set(removed);
    for (const x of removed) this.physics?.remove(x);
    for (const [id, c] of this.conns) if ((c.e && set.has(c.e)) || (c.inst.owner && set.has(c.inst.owner))) { this.vm.unref(this.vm.L, c.ref); this.conns.delete(id); }
    this.ticks = this.ticks.filter((t) => {
      if (t.inst.owner && set.has(t.inst.owner)) { this.vm.unref(this.vm.L, t.ref); return false; }
      return true;
    });
    for (const t of [...this.timers]) if (t.inst.owner && set.has(t.inst.owner)) this.removeTimer(t.id, true);
  }

  private cloneEntity(e: Entity, parent: Entity | null): Entity {
    const map: Entity[] = [];
    const copy = (src: Entity, p: Entity): Entity => {
      const c = this.world.create(null, src.type, src.name, [...src.scripts]);
      c.props = structuredClone(src.props);
      if (src.tiles) { c.tiles = src.tiles.clone(); c.tilesKey = src.tilesKey; }
      for (const t of src.tags) c.tags.add(t);
      this.world.attach(c, p);
      map.push(c);
      for (const ch of src.children) copy(ch, c);
      return c;
    };
    const root = copy(e, parent ?? e.parent ?? this.world.root);
    for (const c of map) this.physics?.markDirty(c);
    for (const c of map) if (c.alive) for (const s of c.scripts) this.runScript(s, c);
    return root;
  }

  private removeTimer(id: number, unref: boolean) {
    const i = this.timers.findIndex((t) => t.id === id);
    if (i < 0) return;
    const [t] = this.timers.splice(i, 1);
    if (unref) this.vm.unref(this.vm.L, t!.ref);
  }

  private refFn(L: LuaState, i: number, what: string): number {
    if (this.vm.type(L, i) !== 7) throw new Error(`${what} expects a function`);
    return this.vm.ref(L, i);
  }

  private get inst(): ScriptInst {
    return this.current ?? { path: "?", owner: null, refs: new Set(), timers: new Set(), conns: new Set() };
  }

  // ---------------------------------------------------------------- host dispatch

  private host(L: LuaState): number {
    const vm = this.vm;
    const op = vm.toNumber(L, 1);
    switch (op) {
      case OP.INIT: {
        const keys = ["makeScript", "proxy", "flush", "start", "invoke", "player", "sceneSet", "done"] as const;
        keys.forEach((k, i) => (this.refs[k] = vm.ref(L, i + 2)));
        return 0;
      }
      case OP.PRINT:
        this.log("info", vm.toString(L, 2) ?? "", this.current?.path);
        return 0;
      case OP.GET: {
        const e = this.entityArg(L, 2);
        return this.pushProp(L, e, vm.toString(L, 3) ?? "");
      }
      case OP.SET: {
        const e = this.entityArg(L, 2);
        this.setProp(e, vm.toString(L, 3) ?? "", this.readTagged(L, 4));
        return 0;
      }
      case OP.CALL: {
        const e = this.entityArg(L, 2);
        const m = vm.toString(L, 3);
        switch (m) {
          case "children": {
            vm.createTable(L, e.children.length, 0);
            e.children.forEach((c, i) => { vm.pushNumber(L, c.handle); vm.rawSetI(L, -2, i + 1); });
            return 1;
          }
          case "hasTag": vm.pushBoolean(L, e.tags.has(vm.toString(L, 4) ?? "")); return 1;
          case "addTag": e.tags.add(vm.toString(L, 4) ?? ""); return 0;
          case "removeTag": e.tags.delete(vm.toString(L, 4) ?? ""); return 0;
          case "destroy": this.destroyEntity(e); return 0;
          case "clone": {
            const p = vm.isNil(L, 4) ? null : this.entityArg(L, 4);
            vm.pushNumber(L, this.cloneEntity(e, p).handle);
            return 1;
          }
          case "tileAt": case "tagsAt": case "worldToCell": {
            const grid = this.tilesOf(e);
            const p = this.readTagged(L, 4);
            if (!Array.isArray(p) || p.length !== 2) throw new Error(`${m} expects a Vec2 world position`);
            const [c, r] = this.worldToCell(e, p[0] as number, p[1] as number);
            if (m === "worldToCell") { vm.pushNumber(L, c); vm.pushNumber(L, r); return 2; }
            const k = grid.kindAt(c, r);
            if (m === "tileAt") { if (k) vm.pushString(L, k.char); else vm.pushNil(L); return 1; }
            const tags = k?.tags ?? [];
            vm.createTable(L, tags.length, 0);
            tags.forEach((t, i) => { vm.pushString(L, t); vm.rawSetI(L, -2, i + 1); });
            return 1;
          }
          case "isSolid": {
            const k = this.tilesOf(e).kindAt(Math.floor(vm.toNumber(L, 4)), Math.floor(vm.toNumber(L, 5)));
            vm.pushBoolean(L, !!k?.solid);
            return 1;
          }
          case "tileDef": {
            const grid = this.tilesOf(e);
            const k = grid.byChar.get(vm.toString(L, 4) ?? "");
            if (!k) { vm.pushNil(L); return 1; }
            vm.createTable(L, 0, 5);
            vm.pushString(L, k.char); vm.rawSetField(L, -2, "char");
            vm.pushBoolean(L, k.solid); vm.rawSetField(L, -2, "solid");
            vm.createTable(L, k.tags.length, 0);
            k.tags.forEach((t, i) => { vm.pushString(L, t); vm.rawSetI(L, -2, i + 1); });
            vm.rawSetField(L, -2, "tags");
            if (k.sprite) { vm.pushString(L, k.sprite.startsWith("asset:") ? k.sprite : `asset:${k.sprite}`); vm.rawSetField(L, -2, "sprite"); }
            if (k.color) { vm.pushString(L, "#" + k.color.map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("").replace(/ff$/, "")); vm.rawSetField(L, -2, "color"); }
            return 1;
          }
          case "getTile": {
            const k = this.tilesOf(e).kindAt(Math.floor(vm.toNumber(L, 4)), Math.floor(vm.toNumber(L, 5)));
            if (k) vm.pushString(L, k.char); else vm.pushNil(L);
            return 1;
          }
          case "cellToWorld": {
            this.tilesOf(e);
            const ts = e.get<number>("tile_size");
            const [x, y] = apply(global2D(e), (vm.toNumber(L, 4) + 0.5) * ts, (vm.toNumber(L, 5) + 0.5) * ts);
            vm.pushNumber(L, x); vm.pushNumber(L, y);
            return 2;
          }
          case "setTile": {
            const grid = this.tilesOf(e);
            if (vm.type(L, 4) !== LUA_TNUMBER || vm.type(L, 5) !== LUA_TNUMBER) throw new Error("setTile expects (col: number, row: number, char: string?)");
            const c = Math.floor(vm.toNumber(L, 4)), r = Math.floor(vm.toNumber(L, 5));
            if (!grid.inBounds(c, r)) throw new Error(`setTile: cell (${c}, ${r}) is outside the map (cols 0..${grid.cols - 1}, rows 0..${grid.rows - 1})`);
            const ch = vm.isNil(L, 6) ? "." : vm.toString(L, 6) ?? ".";
            let kind = undefined;
            if (ch !== "." && ch !== " " && ch !== "") {
              kind = grid.byChar.get(ch);
              if (!kind) throw new Error(`setTile: tile "${ch}" is not defined in ${e.get<string>("tileset")}`);
            }
            const solid = grid.solidRev;
            grid.set(c, r, kind);
            if (grid.solidRev !== solid) this.physics?.markDirty(e);
            return 0;
          }
          case "play": {
            const name = vm.toString(L, 4);
            if (!name) throw new Error('play expects an animation name, e.g. e:play("run")');
            this.playAnim(e, name, vm.toBoolean(L, 5));
            return 0;
          }
          case "stop": {
            for (const x of this.world.walk(e)) if (x.type === "Sprite2D" && x.get<string>("anims")) { x.props.anim = ""; x.animName = ""; x.rev++; break; }
            return 0;
          }
          case "burst": this.burst(e, vm.isNil(L, 4) ? 16 : vm.toNumber(L, 4)); return 0;
          case "clearParticles": e.emitter?.clear(); e.rev++; return 0;
          case "applyImpulse": {
            const v = this.readTagged(L, 4);
            if (!Array.isArray(v)) throw new Error("applyImpulse expects a Vec2");
            if (e.type === "Body2D") this.physics?.applyImpulse(e, v as number[]);
            return 0;
          }
        }
        throw new Error(`unknown method ${m}`);
      }
      case OP.ENTITY: {
        const id = vm.toString(L, 2);
        const e = id ? this.world.byId.get(id) : undefined;
        if (e) vm.pushNumber(L, e.handle); else vm.pushNil(L);
        return 1;
      }
      case OP.TAGGED: {
        const list = this.world.tagged(vm.toString(L, 2) ?? "");
        vm.createTable(L, list.length, 0);
        list.forEach((c, i) => { vm.pushNumber(L, c.handle); vm.rawSetI(L, -2, i + 1); });
        return 1;
      }
      case OP.SPAWN: {
        if (vm.isNil(L, 2)) {
          const e = this.world.byHandle.get(vm.toNumber(L, 4));
          if (e) this.spawning.delete(e);
          if (e?.type === "TileMap2D" && !e.tiles) this.loadTiles(e, true);
          if (e) this.physics?.markDirty(e);
          return 0;
        }
        const type = vm.toString(L, 2)!;
        const parent = vm.isNil(L, 3) ? this.world.root : this.entityArg(L, 3);
        let e: Entity;
        try { e = this.world.create(null, type); } catch { throw new Error(`spawn: unknown entity type "${type}"`); }
        if (e.def.dimension === "3d") { this.world.remove(e); throw new Error(`spawn: ${type} is a 3D type; this is a 2D game`); }
        this.world.attach(e, parent);
        if (e.type === "TileMap2D") this.spawning.add(e);
        vm.pushNumber(L, e.handle);
        return 1;
      }
      case OP.ONTICK: {
        const ref = this.refFn(L, 2, "onTick");
        const id = this.nextId++;
        this.ticks.push({ id, ref, inst: this.inst });
        vm.pushNumber(L, id);
        return 1;
      }
      case OP.UNTICK: {
        const id = vm.toNumber(L, 2);
        const i = this.ticks.findIndex((t) => t.id === id);
        if (i >= 0) { vm.unref(L, this.ticks[i]!.ref); this.ticks.splice(i, 1); }
        return 0;
      }
      case OP.AFTER: case OP.EVERY: {
        const secs = vm.toNumber(L, 2);
        const ref = this.refFn(L, 3, op === OP.AFTER ? "after" : "every");
        const id = this.nextId++;
        const interval = op === OP.EVERY ? Math.max(this.dt, secs) : 0;
        this.timers.push({ id, due: this.time + Math.max(0, secs), interval, ref, inst: this.inst, seq: id });
        vm.pushNumber(L, id);
        return 1;
      }
      case OP.CANCEL: this.removeTimer(vm.toNumber(L, 2), true); return 0;
      case OP.RANDOM: {
        const r = this.rng.next();
        if (vm.isNil(L, 2)) vm.pushNumber(L, r);
        else {
          // random(max) -> [0, max); random(min, max) -> [min, max) (format/LUAU_API.md)
          const a = vm.isNil(L, 3) ? 0 : vm.toNumber(L, 2), b = vm.isNil(L, 3) ? vm.toNumber(L, 2) : vm.toNumber(L, 3);
          vm.pushNumber(L, a + (b - a) * r);
        }
        return 1;
      }
      case OP.TIME: vm.pushNumber(L, this.time); return 1;
      case OP.CONNECT: {
        const e = vm.toNumber(L, 2) === 0 ? null : this.entityArg(L, 2);
        const signal = vm.toString(L, 3)!;
        const ref = this.refFn(L, 4, `${signal}:connect`);
        const id = this.nextId++;
        this.conns.set(id, { id, e, signal, ref, inst: this.inst });
        vm.pushNumber(L, id);
        return 1;
      }
      case OP.DISCONNECT: {
        const id = vm.toNumber(L, 2);
        const c = this.conns.get(id);
        if (c) { vm.unref(L, c.ref); this.conns.delete(id); }
        return 0;
      }
      case OP.AXIS: vm.pushNumber(L, this.input.axis(vm.toString(L, 2) ?? "")); return 1;
      case OP.PRESSED: vm.pushBoolean(L, this.input.pressed(vm.toString(L, 2) ?? "")); return 1;
      case OP.HELD: vm.pushBoolean(L, this.input.held(vm.toString(L, 2) ?? "")); return 1;
      case OP.POINTER: {
        const p = this.input.pointer;
        if (!p) { vm.pushNumber(L, TAG.PLAIN); vm.pushNil(L); return 2; }
        vm.pushNumber(L, TAG.VEC2); vm.pushNumber(L, p[0]); vm.pushNumber(L, p[1]); return 3;
      }
      case OP.TOAST: {
        const secs = vm.isNil(L, 3) ? 2 : vm.toNumber(L, 3);
        this.toasts.push({ id: this.nextId++, text: vm.toString(L, 2) ?? "", until: this.time + secs });
        if (this.toasts.length > 4) this.toasts.shift();
        return 0;
      }
      case OP.SCREEN: {
        const id = vm.toString(L, 2) ?? "";
        const e = this.world.byId.get(id);
        if (!e) throw new Error(`ui screen "${id}" not found`);
        this.setProp(e, "visible", vm.toBoolean(L, 3));
        return 0;
      }
      case OP.AVATAR: {
        const a = this.avatar();
        if (a) vm.pushNumber(L, a.handle); else vm.pushNil(L);
        return 1;
      }
      case OP.FROMENTITY: {
        const e = this.entityArg(L, 2);
        const a = this.avatar();
        let hit = false;
        for (let x: Entity | null = e; x; x = x.parent) if (x === a || x.tags.has("player")) { hit = true; break; }
        vm.pushBoolean(L, hit);
        return 1;
      }
      case OP.REQUIRE:
        this.requireModule(L, vm.toString(L, 2) ?? "", vm.toString(L, 3) ?? "");
        return 1;
      case OP.ERROR:
        this.recordError(vm.toString(L, 2) ?? "error", vm.toString(L, 3) ?? undefined, this.current?.path ?? "?");
        return 0;
      case OP.LOADSCENE: {
        const path = vm.toString(L, 2) ?? "";
        if (!this.scenes[path]) {
          const guess = `scenes/${path.replace(/^scenes\//, "").replace(/\.scene\.json$/, "")}.scene.json`;
          throw new Error(`loadScene: no scene "${path}"${this.scenes[guess] ? ` (did you mean "${guess}"?)` : `; scenes: ${Object.keys(this.scenes).join(", ")}`}`);
        }
        this.pendingScene = path;
        return 0;
      }
      case OP.AUDIO: {
        const what = vm.toString(L, 2);
        const num = (i: number, d: number) => (vm.isNil(L, i) ? d : vm.toNumber(L, i));
        if (what === "sfx") {
          const id = vm.toString(L, 3) ?? "";
          this.sfxData(id);
          const volume = Math.max(0, Math.min(1, num(4, 1))), pitch = Math.max(0.1, Math.min(8, num(5, 1)));
          this.audio({ kind: "sfx", id, volume, pitch, time: this.time });
          return 0;
        }
        if (what === "music") {
          const id = vm.toString(L, 3) ?? "";
          this.musicData(id);
          if (this.musicId === id) return 0; // already playing: keep going (e.g. re-entering a scene)
          this.musicId = id;
          this.audio({ kind: "music", id, fade: Math.max(0, num(4, 0)), time: this.time });
          return 0;
        }
        if (what === "stop") {
          if (this.musicId === null) return 0;
          this.musicId = null;
          this.audio({ kind: "music_stop", fade: Math.max(0, num(3, 0)), time: this.time });
          return 0;
        }
        throw new Error(`audio: unknown call ${what}`);
      }
      case OP.SETTINGS: {
        const name = vm.toString(L, 2) ?? "";
        const st = this.settings;
        switch (name) {
          case "music": vm.pushNumber(L, st.mute ? 0 : st.music); return 1;
          case "sfx": vm.pushNumber(L, st.mute ? 0 : st.sfx); return 1;
          case "mute": vm.pushBoolean(L, st.mute); return 1;
          case "vibration": vm.pushBoolean(L, st.vibration); return 1;
        }
        throw new Error(`settings.get: unknown setting "${name}" (use "music", "sfx", "mute" or "vibration")`);
      }
      case OP.STORE: {
        const what = vm.toString(L, 2);
        switch (what) {
          case "items": {
            const items = this.manifest.store ?? [];
            vm.createTable(L, items.length, 0);
            items.forEach((it, i) => {
              vm.createTable(L, 0, 6);
              vm.pushString(L, it.id); vm.rawSetField(L, -2, "id");
              vm.pushString(L, it.kind); vm.rawSetField(L, -2, "kind");
              vm.pushString(L, it.name); vm.rawSetField(L, -2, "name");
              vm.pushString(L, it.description ?? ""); vm.rawSetField(L, -2, "description");
              vm.pushNumber(L, it.price); vm.rawSetField(L, -2, "price");
              if (it.icon) { vm.pushString(L, it.icon); vm.rawSetField(L, -2, "icon"); }
              vm.rawSetI(L, -2, i + 1);
            });
            return 1;
          }
          case "owns": vm.pushBoolean(L, this.storeOwned.has(vm.toString(L, 3) ?? "")); return 1;
          case "pending": {
            vm.createTable(L, this.storePending.length, 0);
            this.storePending.forEach((p, i) => {
              vm.createTable(L, 0, 2);
              vm.pushString(L, p.itemId); vm.rawSetField(L, -2, "itemId");
              vm.pushString(L, p.purchaseId); vm.rawSetField(L, -2, "purchaseId");
              vm.rawSetI(L, -2, i + 1);
            });
            return 1;
          }
          case "prompt": {
            const id = vm.toString(L, 3) ?? "";
            this.storeItem(id);
            this.storeInFlight++;
            this.store.prompt(id).then(
              (p) => { if (p && !this.disposed) this.storeQueue.push({ itemId: p.itemId, purchaseId: p.purchaseId }); },
              (e) => this.log("warn", `[store] purchase of "${id}" failed: ${(e as Error)?.message ?? e}`),
            ).finally(() => this.storeInFlight--);
            return 0;
          }
          case "consume": {
            const pid = vm.toString(L, 3) ?? "";
            this.storePending = this.storePending.filter((p) => p.purchaseId !== pid);
            this.store.consume(pid).catch((e) => this.log("warn", `[store] consume ${pid} failed: ${(e as Error)?.message ?? e}`));
            return 0;
          }
        }
        throw new Error(`store: unknown call ${what}`);
      }
      case OP.LEADERBOARD: return this.leaderboardOp(L);
      case OP.PLATFORM: {
        const what = vm.toString(L, 2);
        if (what !== "runEnded") throw new Error(`platform: unknown call ${what}`);
        const r = vm.isNil(L, 3) ? "gameover" : vm.toString(L, 3) ?? "gameover";
        // unknown reasons still end the run (AI-written games say "dead", "win", …)
        this.emitRunEnd({ reason: (SCRIPT_RUN_END.has(r) ? r : "gameover") as RunEnd["reason"] });
        return 0;
      }
      case OP.TWEEN: {
        const what = vm.toString(L, 2);
        if (what === "cancel") {
          const id = vm.toNumber(L, 3);
          const i = this.tweens.findIndex((t) => t.id === id);
          if (i >= 0) this.tweens.splice(i, 1);
          return 0;
        }
        // "start", handle, seconds, easing, delay, loop, yoyo, then (key, tag, a, b, c, d)*
        const e = this.entityArg(L, 3);
        const seconds = vm.toNumber(L, 4);
        const easing = vm.isNil(L, 5) ? DEFAULT_EASING : vm.toString(L, 5) ?? DEFAULT_EASING;
        const delay = vm.isNil(L, 6) ? 0 : vm.toNumber(L, 6);
        const loop = vm.toBoolean(L, 7), yoyo = vm.toBoolean(L, 8);
        const tracks: TweenTrack[] = [];
        for (let i = 9; i + 5 <= vm.getTop(L) && !vm.isNil(L, i); i += 6) {
          const key = propAlias(e, vm.toString(L, i) ?? "");
          const def = e.propDef(key);
          if (!def || !TWEENABLE.has(def.type.kind)) {
            throw new Error(`tween: ${e.type} "${e.id}" has no tweenable property "${key}" (numbers, Vec2s and colors: ${Object.entries(e.def.props).filter(([, d]) => TWEENABLE.has(d.type.kind)).map(([k]) => k).join(", ")})`);
          }
          const target = this.readTagged(L, i + 1);
          const kind = def.type.kind === "vec2" ? "vec2" : def.type.kind === "color" ? "color" : "number";
          let to: number[];
          if (kind === "number") {
            if (typeof target !== "number") throw new Error(`tween: ${key} expects a number`);
            to = [target];
          } else if (kind === "vec2") {
            if (!Array.isArray(target) || target.length !== 2) throw new Error(`tween: ${key} expects a Vec2`);
            to = target as number[];
          } else {
            const c = Array.isArray(target) && target.length === 4 ? target as number[] : typeof target === "string" ? parseColor(target) : null;
            if (!c) throw new Error(`tween: ${key} expects a Color or "#rrggbb"`);
            to = [...c];
          }
          const cur = e.get(key);
          const from = kind === "number" ? [Number(cur ?? 0)] : kind === "color" ? [...(parseColor(cur) ?? [1, 1, 1, 1])] : [...((cur as number[] | undefined) ?? [0, 0])];
          tracks.push({ key, from, to, kind });
        }
        if (!tracks.length) throw new Error("tween: give at least one property, e.g. tween(e, { position = vec2(100, 50) }, 0.5)");
        vm.pushNumber(L, this.startTween(e, tracks, seconds, easing, delay, loop, yoyo));
        return 1;
      }
      case OP.SAVE: {
        const what = vm.toString(L, 2);
        const key = vm.toString(L, 3);
        if (what === "keys") {
          const ks = Object.keys(this.saveData);
          vm.createTable(L, ks.length, 0);
          ks.forEach((k, i) => { vm.pushString(L, k); vm.rawSetI(L, -2, i + 1); });
          return 1;
        }
        if (typeof key !== "string" || !key || key.length > 128) throw new Error(`save.${what} expects a key string (1..128 chars)`);
        if (what === "get") {
          if (key in this.saveData) this.pushJSON(L, this.saveData[key]); else vm.pushValue(L, 4);
          return 1;
        }
        if (what === "set") {
          const v = this.readJSON(L, 4);
          const next = { ...this.saveData };
          if (v === null) delete next[key]; else next[key] = v;
          this.writeSave(next);
          return 0;
        }
        if (what === "remove") {
          if (key in this.saveData) { const next = { ...this.saveData }; delete next[key]; this.writeSave(next); }
          return 0;
        }
        throw new Error(`save: unknown call ${what}`);
      }
      case OP.DIALOG: {
        const what = vm.toString(L, 2);
        if (what === "open") {
          // kind, lines table, options table|nil, speed, position, block
          const kind = vm.toString(L, 3) === "choice" ? "choice" : "dialog";
          const lines: DialogLine[] = [];
          const n = vm.objLen(L, 4);
          for (let i = 1; i <= Math.min(n, 200); i++) {
            vm.rawGetI(L, 4, i);
            const t = vm.getTop(L);
            const field = (k: string) => { vm.rawGetField(L, t, k); const s2 = vm.isNil(L, -1) ? undefined : vm.toString(L, -1) ?? undefined; vm.pop(L, 1); return s2; };
            lines.push({ text: (field("text") ?? "").slice(0, 2000), speaker: field("speaker"), portrait: field("portrait") });
            vm.pop(L, 1);
          }
          if (!lines.length) throw new Error("ui.dialog: give at least one line");
          const options: string[] = [];
          if (!vm.isNil(L, 5)) {
            const m = vm.objLen(L, 5);
            for (let i = 1; i <= Math.min(m, 8); i++) { vm.rawGetI(L, 5, i); options.push(vm.toString(L, -1) ?? ""); vm.pop(L, 1); }
            if (kind === "choice" && options.length < 1) throw new Error("ui.choice: give at least one option");
          }
          const speed = vm.isNil(L, 6) ? 40 : Math.max(0, vm.toNumber(L, 6));
          const position = vm.toString(L, 7) === "top" ? "top" : "bottom";
          const blocking = vm.isNil(L, 8) ? true : vm.toBoolean(L, 8);
          const st: DialogState = { id: this.nextId++, kind, lines, index: 0, shown: speed > 0 ? 0 : lines[0]!.text.length, speed, options, selected: 0, position, blocking };
          this.dialogs.open(st);
          vm.pushNumber(L, st.id);
          return 1;
        }
        if (what === "close") { this.dialogs.close(vm.toNumber(L, 3)); return 0; }
        if (what === "isOpen") { vm.pushBoolean(L, !!this.dialogs.current); return 1; }
        throw new Error(`ui.dialog: unknown call ${what}`);
      }
      case OP.CAMERA: {
        const what = vm.toString(L, 2);
        switch (what) {
          case "shake": this.shake(vm.toNumber(L, 3), vm.isNil(L, 4) ? 0.3 : vm.toNumber(L, 4)); return 0;
          case "current": { const c = this.currentCamera2D(); if (c) vm.pushNumber(L, c.handle); else vm.pushNil(L); return 1; }
          case "center": { const v = this.cameraView(); vm.pushNumber(L, v.x - this.cam.ox); vm.pushNumber(L, v.y - this.cam.oy); return 2; }
          case "snap": this.snapCamera(); return 0;
          case "viewSize": { const z = this.cameraView().zoom; vm.pushNumber(L, this.refSize[0] / z); vm.pushNumber(L, this.refSize[1] / z); return 2; }
          case "screenSize": vm.pushNumber(L, this.refSize[0]); vm.pushNumber(L, this.refSize[1]); return 2;
          case "toWorld": case "toScreen": {
            const v = this.cameraView();
            const f = what === "toWorld" ? refToWorld : worldToRef;
            const [x, y] = f(v.x - this.cam.ox, v.y - this.cam.oy, v.zoom, this.refSize, vm.toNumber(L, 3), vm.toNumber(L, 4));
            vm.pushNumber(L, x); vm.pushNumber(L, y);
            return 2;
          }
        }
        throw new Error(`camera: unknown call ${what}`);
      }
      case OP.FILES: {
        const what = vm.toString(L, 2);
        const raw = (vm.toString(L, 3) ?? "").replace(/\/+$/, "");
        if (!raw || raw.startsWith("/") || raw.split("/").some((x) => x === ".." || x === "." || x === "")) throw new Error(`data.${what}: bad path "${raw}" (use package paths like "data/creatures")`);
        if (what === "list") {
          const paths = this.pkg.paths(raw + "/").filter((p) => !p.startsWith("assets/") || p.endsWith(".json")).sort();
          vm.createTable(L, paths.length, 0);
          paths.forEach((p, i) => { vm.pushString(L, p); vm.rawSetI(L, -2, i + 1); });
          return 1;
        }
        if (what === "read") {
          if (!/\.(json|txt|luau|md)$/.test(raw)) throw new Error(`data.read: only .json, .txt, .luau and .md files can be read ("${raw}")`);
          let v = this.fileCache.get(raw);
          if (v === undefined) {
            const text = this.pkg.text(raw);
            if (text === undefined) throw new Error(`data.read: no file "${raw}"`);
            if (raw.endsWith(".json")) {
              try { v = JSON.parse(text); } catch (e) { throw new Error(`data.read: ${raw} is not valid JSON: ${(e as Error).message}`); }
            } else v = text;
            this.fileCache.set(raw, v);
          }
          this.pushJSON(L, v);
          return 1;
        }
        if (what === "exists") { vm.pushBoolean(L, this.pkg.has(raw)); return 1; }
        throw new Error(`data: unknown call ${what}`);
      }
      case OP.ALIVE: vm.pushBoolean(L, this.world.byHandle.has(vm.toNumber(L, 2))); return 1;
      case OP.CLOCK: vm.pushNumber(L, this.opts.clock ? this.opts.clock() : Date.now() / 1000); return 1;
      case OP.GAMEPROP: {
        const what = vm.toString(L, 2);
        if (what === "getTimeScale") { vm.pushNumber(L, this.timeScale); return 1; }
        if (what === "setTimeScale") {
          const v = vm.toNumber(L, 3);
          if (!Number.isFinite(v)) throw new Error("game.timeScale must be a number 0..4");
          this.timeScale = Math.max(0, Math.min(4, v));
          return 0;
        }
        if (what === "theme") {
          const t = resolveTheme(this.manifest);
          vm.createTable(L, 0, 6);
          for (const k of ["primary", "accent", "background", "text", "panel", "font"] as const) { vm.pushString(L, t[k]); vm.rawSetField(L, -2, k); }
          return 1;
        }
        if (what === "session") {
          const prev = this.current;
          this.current = this.sessionInst;
          vm.pushValue(L, 3);
          const err = vm.pcall(L, 0, 0);
          this.current = prev;
          if (err) throw new Error(err.message);
          return 0;
        }
        throw new Error(`game: unknown call ${what}`);
      }
      case OP.NET: return this.net.op(L);
      case OP.SOUND: {
        const at = this.readTagged(L, 3);
        this.sounds.push({ asset: String(vm.toString(L, 2) ?? "").replace(/^asset:/, ""), at: Array.isArray(at) ? (at as number[]) : undefined });
        if (this.sounds.length > 32) this.sounds.shift();
        return 0;
      }
    }
    throw new Error(`unknown host op ${op}`);
  }
}
