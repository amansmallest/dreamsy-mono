// Dev-page / WebView leaderboard host backed by the Dreamsy API (?api=&game=&token=), DREAMSY.MD §13.3:
//   POST /v1/games/:id/runs                 {board, order, version, value, ghost?} → {run, rank, best, personalBest}
//   GET  /v1/games/:id/leaderboards/:board  ?scope=public|me|group:<id>&limit=N → {board, order, entries, me?}
//   GET  /v1/runs/:runId/ghost              → ghost JSON
// "best" ghost = the #1 entry's runId; "pb" = me.runId.
import type { BoardOrder, Ghost, LeaderboardEntry, LeaderboardHost, LeaderboardPage, RunSubmit, SubmitResult } from "../core/index.js";

export class ApiLeaderboardHost implements LeaderboardHost {
  private api: string;

  /** `version`: the package version being played; when unknown (?version=latest) the game's latest (owner) or published version. */
  constructor(api: string, private gameId: string, private token: string, private version: number | undefined) {
    this.api = api.replace(/\/$/, "");
  }

  private async resolveVersion(): Promise<number | undefined> {
    if (this.version !== undefined) return this.version;
    const d = await this.call("GET", this.game()).catch(() => null);
    const v = Number(d?.game?.latestVersion ?? d?.game?.publishedVersion ?? d?.game?.version);
    if (Number.isInteger(v) && v > 0) this.version = v;
    return this.version;
  }

  private async call(method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(`${this.api}${path}`, {
      method,
      headers: { ...(this.token ? { authorization: `Bearer ${this.token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data: any = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${data?.error ?? ""}`.trim());
    return data;
  }

  private game() { return `/v1/games/${encodeURIComponent(this.gameId)}`; }

  async submit(run: RunSubmit): Promise<SubmitResult> {
    const version = await this.resolveVersion();
    const d = await this.call("POST", `${this.game()}/runs`, {
      board: run.board, order: run.order, value: run.value, ...(version !== undefined ? { version } : {}), ...(run.ghost ? { ghost: run.ghost } : {}),
    });
    return { rank: Number(d.rank) || 0, best: Number(d.best ?? run.value), personalBest: !!d.personalBest, runId: String(d.run?.id ?? d.run?.runId ?? d.runId ?? "") };
  }

  async top(board: string, scope: string, limit: number): Promise<LeaderboardPage> {
    const d = await this.call("GET", `${this.game()}/leaderboards/${encodeURIComponent(board)}?scope=${encodeURIComponent(scope)}&limit=${limit}`);
    const order: BoardOrder = d.order === "desc" ? "desc" : "asc";
    const entries: LeaderboardEntry[] = (d.entries ?? []).map((e: any) => ({
      rank: Number(e.rank), user: userName(e.user), value: Number(e.value), runId: String(e.runId ?? ""), hasGhost: !!e.hasGhost, version: e.version, at: e.at,
    }));
    return { board: d.board ?? board, order, entries, ...(d.me ? { me: { rank: Number(d.me.rank), value: Number(d.me.value), runId: String(d.me.runId ?? "") } } : {}) };
  }

  async ghost(which: string, board: string): Promise<Ghost | null> {
    let runId = which;
    if (which === "best" || which === "pb") {
      const page = await this.top(board, which === "pb" ? "me" : "public", 1);
      runId = (which === "pb" ? page.me?.runId : page.entries[0]?.hasGhost ? page.entries[0].runId : undefined) ?? "";
      if (!runId) return null;
    }
    try { return await this.call("GET", `/v1/runs/${encodeURIComponent(runId)}/ghost`); } catch (e) {
      if (/: 404\b/.test(String((e as Error).message))) return null;
      throw e;
    }
  }
}

function userName(u: unknown): string {
  if (typeof u === "string") return u;
  const o = (u ?? {}) as Record<string, unknown>;
  return String(o.displayName ?? o.username ?? o.name ?? o.handle ?? "player");
}
