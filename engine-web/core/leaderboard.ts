// Leaderboards + ghosts (DREAMSY.MD §13): the host interface (like StoreHost), a deterministic in-memory host,
// and the ghost format helpers (recording / sampling). DOM-free; Game drives the runtime side.

export type BoardOrder = "asc" | "desc";
/** "public" | "me" | "group:<groupId>" */
export type LeaderboardScope = string;
/** One ghost sample: x, y (world px), flipX (0|1), frame (index into the sprite's anim textures; 0 without anims). */
export type GhostFrame = [number, number, number, number];
export interface Ghost { v: 1; hz: number; scene: string; frames: GhostFrame[] }

export const GHOST_HZ = 10;
/** ≤ 5 min at 10 Hz. */
export const GHOST_MAX_FRAMES = 3000;
export const DEFAULT_BOARD = "fastest";

export interface RunSubmit { board: string; order: BoardOrder; value: number; ghost?: Ghost }
/** rank = my rank on the board; best = the board's #1 value (the record); personalBest = this run beat my previous best. */
export interface SubmitResult { rank: number; best: number; personalBest: boolean; runId: string }
export interface LeaderboardEntry { rank: number; user: string; value: number; runId: string; hasGhost: boolean; version?: number | string; at?: string | number }
export interface LeaderboardPage { board: string; order: BoardOrder; entries: LeaderboardEntry[]; me?: { rank: number; value: number; runId: string } }

export interface LeaderboardHost {
  /** Submit a run; resolves with the player's rank/best on that board. */
  submit(run: RunSubmit): Promise<SubmitResult>;
  /** Top entries (best per player) of a board. */
  top(board: string, scope: LeaderboardScope, limit: number): Promise<LeaderboardPage>;
  /** A run's ghost: "best" = the #1 entry's, "pb" = mine, else a run id. null when there is none. */
  ghost(which: string, board: string): Promise<Ghost | null>;
}

interface MemRun { id: string; user: string; value: number; ghost?: Ghost; seq: number }

/**
 * Deterministic in-memory leaderboards for Node, tests, playtests and the dev page without an API.
 * The local player is `user` (default "you"); seed other players with `init.entries`. Run ids are mem_run_1, 2, ...
 */
export class MemoryLeaderboardHost implements LeaderboardHost {
  readonly boards = new Map<string, { order: BoardOrder; runs: MemRun[] }>();
  readonly submitted: RunSubmit[] = [];
  private next = 1;
  private seq = 0;

  constructor(init: { user?: string; entries?: { board?: string; order?: BoardOrder; user: string; value: number; ghost?: Ghost }[] } = {}, readonly user = init.user ?? "you") {
    for (const e of init.entries ?? []) this.add(e.board ?? DEFAULT_BOARD, e.order ?? "asc", e.user, e.value, e.ghost);
  }

  private add(board: string, order: BoardOrder, user: string, value: number, ghost?: Ghost): MemRun {
    let b = this.boards.get(board);
    if (!b) this.boards.set(board, (b = { order, runs: [] }));
    const run: MemRun = { id: `mem_run_${this.next++}`, user, value, ghost, seq: this.seq++ };
    const prev = this.bestOf(board, user);
    b.runs.push(run);
    // ghosts are kept only for a player's best run
    if (ghost) {
      if (prev && !this.better(b.order, value, prev.value)) delete run.ghost;
      else for (const r of b.runs) if (r !== run && r.user === user) delete r.ghost;
    }
    return run;
  }

  private better(order: BoardOrder, a: number, b: number) { return order === "asc" ? a < b : a > b; }

  private bestOf(board: string, user: string): MemRun | undefined {
    const b = this.boards.get(board);
    let best: MemRun | undefined;
    for (const r of b?.runs ?? []) if (r.user === user && (!best || this.better(b!.order, r.value, best.value))) best = r;
    return best;
  }

  /** Best run per player, ranked (ties: earlier first). */
  ranking(board: string): MemRun[] {
    const b = this.boards.get(board);
    if (!b) return [];
    const best = new Map<string, MemRun>();
    for (const r of b.runs) {
      const cur = best.get(r.user);
      if (!cur || this.better(b.order, r.value, cur.value)) best.set(r.user, r);
    }
    return [...best.values()].sort((x, y) => (x.value === y.value ? x.seq - y.seq : this.better(b.order, x.value, y.value) ? -1 : 1));
  }

  async submit(run: RunSubmit): Promise<SubmitResult> {
    this.submitted.push(run);
    const prev = this.bestOf(run.board, this.user);
    const r = this.add(run.board, run.order, this.user, run.value, run.ghost);
    const order = this.boards.get(run.board)!.order;
    const personalBest = !prev || this.better(order, run.value, prev.value);
    const ranked = this.ranking(run.board);
    const rank = ranked.findIndex((x) => x.user === this.user) + 1;
    return { rank, best: ranked[0]!.value, personalBest, runId: r.id };
  }

  async top(board: string, scope: LeaderboardScope, limit: number): Promise<LeaderboardPage> {
    const order = this.boards.get(board)?.order ?? "asc";
    const ranked = this.ranking(board);
    const all = ranked.map((r, i) => ({ rank: i + 1, user: r.user, value: r.value, runId: r.id, hasGhost: !!r.ghost, at: r.seq }));
    const mine = all.find((e) => e.user === this.user);
    const entries = (scope === "me" ? all.filter((e) => e.user === this.user) : all).slice(0, Math.max(0, limit));
    return { board, order, entries, ...(mine ? { me: { rank: mine.rank, value: mine.value, runId: mine.runId } } : {}) };
  }

  async ghost(which: string, board: string): Promise<Ghost | null> {
    let run: MemRun | undefined;
    if (which === "best") run = this.ranking(board)[0];
    else if (which === "pb") run = this.bestOf(board, this.user);
    else for (const b of this.boards.values()) run ??= b.runs.find((r) => r.id === which);
    return run?.ghost ? structuredClone(run.ghost) : null;
  }
}

/** Records ghost frames at `hz` in game time (call sample() every tick; it keeps only due samples). */
export class GhostRecorder {
  readonly frames: GhostFrame[] = [];
  private nextAt: number;
  constructor(readonly scene: string, readonly t0: number, readonly hz = GHOST_HZ, readonly max = GHOST_MAX_FRAMES) { this.nextAt = t0; }

  get full(): boolean { return this.frames.length >= this.max; }

  /** `t` = current game time; `read` gives the tracked state (null: entity gone, sample skipped but time advances). */
  sample(t: number, read: () => GhostFrame | null) {
    while (t + 1e-9 >= this.nextAt && !this.full) {
      this.nextAt = this.t0 + (this.frames.length + 1) / this.hz;
      const f = read();
      if (!f) { const last = this.frames[this.frames.length - 1]; if (last) this.frames.push([...last] as GhostFrame); else return; }
      else this.frames.push([Math.round(f[0] * 10) / 10, Math.round(f[1] * 10) / 10, f[2] ? 1 : 0, Math.max(0, Math.floor(f[3]))]);
    }
  }

  ghost(): Ghost { return { v: 1, hz: this.hz, scene: this.scene, frames: this.frames.map((f) => [...f] as GhostFrame) }; }
}

/** Ghost state `t` seconds into the replay: position interpolated, flip/frame from the earlier sample. null past the end. */
export function ghostAt(g: Ghost, t: number): { x: number; y: number; flipX: boolean; frame: number } | null {
  const n = g.frames.length;
  if (!n || t < 0) return null;
  const f = t * (g.hz || GHOST_HZ);
  const k = Math.floor(f + 1e-9);
  if (k >= n - 1) {
    if (k > n - 1) return null;
    const a = g.frames[n - 1]!;
    return { x: a[0], y: a[1], flipX: !!a[2], frame: a[3] };
  }
  const a = g.frames[k]!, b = g.frames[k + 1]!, u = f - k;
  return { x: a[0] + (b[0] - a[0]) * u, y: a[1] + (b[1] - a[1]) * u, flipX: !!a[2], frame: a[3] };
}

/** Validates a ghost from a host (untrusted JSON). */
export function isGhost(v: unknown): v is Ghost {
  const g = v as Ghost;
  return !!g && typeof g === "object" && typeof g.scene === "string" && Array.isArray(g.frames) && g.frames.length <= GHOST_MAX_FRAMES * 2
    && g.frames.every((f) => Array.isArray(f) && f.length >= 4 && f.every((x) => typeof x === "number" && Number.isFinite(x)));
}

/** Seconds → "mm:ss.cc". */
export function formatTime(seconds: number): string {
  const cs = Math.max(0, Math.round(seconds * 100));
  const m = Math.floor(cs / 6000), s = Math.floor((cs % 6000) / 100), c = cs % 100;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}

/** Board value for display: times for asc boards, numbers for desc boards. */
export function formatBoardValue(v: number, order: BoardOrder): string {
  return order === "asc" ? formatTime(v) : Number.isInteger(v) ? String(v) : v.toFixed(2);
}
