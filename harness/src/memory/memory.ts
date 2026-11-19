import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { repoPath } from "../paths.js";

export type MemoryKind = "lesson" | "remix" | "outcome" | "sprite";

export interface MemoryItem {
  id: string;
  kind: MemoryKind;
  text: string;
  scopes: string[];
  score?: number | null;
  weight?: number;
  data?: Record<string, unknown>;
  createdAt?: string;
}

export interface RecallOpts {
  userId?: string;
  kinds?: MemoryKind[];
  scopes?: string[];
  kits?: string[];
  pack?: string;
  genre?: string;
  orientation?: string;
  gameId?: string;
  minScore?: number;
  limit?: number;
}

export interface MemoryHit { item: MemoryItem; score: number }

export interface Memory {
  readonly backend: "local" | "supermemory";
  remember(item: MemoryItem): Promise<void>;
  recall(query: string, opts?: RecallOpts): Promise<MemoryHit[]>;
  forget(ids: string[]): Promise<void>;
}

export const GLOBAL = "dreamsy:global";
export const scope = {
  user: (id: string) => `user:${id}`,
  game: (id: string) => `game:${id}`,
  kit: (id: string) => `kit:${id}`,
  pack: (id: string) => `pack:${id}`,
  genre: (g: string) => `genre:${g.toLowerCase()}`,
  orientation: (o: string) => `orientation:${o}`,
};

const ID_OK = /^[A-Za-z0-9_.-]{1,100}$/;
export function memId(prefix: string, ...parts: string[]): string {
  const raw = [prefix, ...parts].join("_").replace(/[^A-Za-z0-9_.-]+/g, "-");
  return raw.slice(0, 100);
}

export function visible(item: MemoryItem, userId?: string): boolean {
  for (const s of item.scopes) {
    if (s.startsWith("user:") && s !== `user:${userId ?? "\u0000"}`) return false;
  }
  return true;
}

const STOP = new Set("a an and are as at be but by for from has have in into is it its of on or that the this to was were will with not no yes do does did make made game games".split(" "));
export function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1 && !STOP.has(t));
}

function bm25(query: string[], docs: string[][]): number[] {
  if (!query.length || !docs.length) return docs.map(() => 0);
  const N = docs.length;
  const avg = docs.reduce((a, d) => a + d.length, 0) / N || 1;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const q = [...new Set(query)];
  return docs.map((d) => {
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    let s = 0;
    for (const t of q) {
      const f = tf.get(t);
      if (!f) continue;
      const n = df.get(t) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      s += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * d.length / avg));
    }
    return s;
  });
}

function boost(item: MemoryItem, o: RecallOpts): number {
  const has = (s: string) => item.scopes.includes(s);
  let b = 0;
  for (const k of o.kits ?? []) if (has(scope.kit(k))) b += 2;
  if (o.pack && has(scope.pack(o.pack))) b += 2;
  if (o.genre && has(scope.genre(o.genre))) b += 1;
  if (o.orientation && has(scope.orientation(o.orientation))) b += 0.5;
  if (o.gameId && has(scope.game(o.gameId))) b += 1.5;
  b += ((item.score ?? 5) - 5) / 5;
  b += Math.log2(1 + Math.max(1, item.weight ?? 1)) - 1;
  return b;
}

function eligible(item: MemoryItem, o: RecallOpts): boolean {
  if (!visible(item, o.userId)) return false;
  if (o.kinds?.length && !o.kinds.includes(item.kind)) return false;
  if (o.scopes?.some((s) => !item.scopes.includes(s))) return false;
  if (o.minScore != null && item.score != null && item.score < o.minScore) return false;
  return true;
}

export function rank(query: string, items: MemoryItem[], o: RecallOpts, semantic?: number[]): MemoryHit[] {
  const docs = items.map((i) => tokens(`${i.text} ${i.scopes.join(" ")}`));
  const lex = bm25(tokens(query), docs);
  const hits = items.map((item, i) => ({ item, score: 2 * lex[i]! + boost(item, o) + (semantic ? semantic[i]! * 6 : 0) }));
  hits.sort((a, b) => b.score - a.score || (b.item.createdAt ?? "").localeCompare(a.item.createdAt ?? "") || a.item.id.localeCompare(b.item.id));
  return hits.slice(0, o.limit ?? 10).map((h) => ({ ...h, score: Math.round(h.score * 1000) / 1000 }));
}

type LogLine = { op: "put"; item: MemoryItem } | { op: "forget"; ids: string[]; at: string };

export class LocalMemory implements Memory {
  readonly backend = "local" as const;
  private items = new Map<string, MemoryItem>();
  private loaded = false;
  private seq = 0;
  constructor(readonly file: string) {}

  private load() {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.file)) return;
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const l = JSON.parse(line) as LogLine;
        if (l.op === "put") this.items.set(l.item.id, l.item);
        else if (l.op === "forget") for (const id of l.ids) this.items.delete(id);
      } catch {}
    }
  }

  private append(l: LogLine) {
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, JSON.stringify(l) + "\n");
  }

  async remember(item: MemoryItem) {
    this.load();
    if (!ID_OK.test(item.id)) throw new Error(`invalid memory id ${item.id}`);
    const full = { weight: 1, ...item, createdAt: item.createdAt ?? `${new Date().toISOString()}#${String(this.seq++).padStart(6, "0")}` };
    this.items.set(item.id, full);
    this.append({ op: "put", item: full });
  }

  async recall(query: string, opts: RecallOpts = {}) {
    this.load();
    return rank(query, [...this.items.values()].filter((i) => eligible(i, opts)), opts);
  }

  async forget(ids: string[]) {
    this.load();
    const gone = ids.filter((id) => this.items.delete(id));
    if (gone.length) this.append({ op: "forget", ids: gone, at: new Date().toISOString() });
  }

  all(): MemoryItem[] {
    this.load();
    return [...this.items.values()];
  }
}

const containerFor = (item: MemoryItem) => {
  const user = item.scopes.find((s) => s.startsWith("user:"));
  return user ? `dreamsy_user_${user.slice(5).replace(/[^A-Za-z0-9_-]/g, "-")}` : "dreamsy_global";
};

interface SmResult { documentId: string; score: number; metadata: Record<string, unknown> | null; content?: string | null; chunks?: { content: string }[] }

export class SupermemoryMemory implements Memory {
  readonly backend = "supermemory" as const;
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "https://api.supermemory.ai",
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private async req(method: string, path: string, body?: unknown) {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.apiKey}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok && !(method === "DELETE" && res.status === 404)) throw new Error(`supermemory ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return res;
  }

  async remember(item: MemoryItem) {
    if (!ID_OK.test(item.id)) throw new Error(`invalid memory id ${item.id}`);
    const data = item.data ? JSON.stringify(item.data) : "";
    await this.req("POST", "/v3/documents", {
      content: item.text,
      containerTag: containerFor(item),
      customId: item.id,
      metadata: {
        memId: item.id,
        kind: item.kind,
        scopes: item.scopes,
        ...(item.score != null ? { score: item.score } : {}),
        weight: item.weight ?? 1,
        createdAt: item.createdAt ?? new Date().toISOString(),
        ...(data && data.length <= 12_000 ? { data } : {}),
      },
    });
  }

  async recall(query: string, opts: RecallOpts = {}) {
    const limit = opts.limit ?? 10;
    const and: unknown[] = [];
    if (opts.kinds?.length) and.push({ OR: opts.kinds.map((k) => ({ key: "kind", value: k })) });
    for (const s of opts.scopes ?? []) and.push({ key: "scopes", value: s, filterType: "array_contains" });
    const containers = ["dreamsy_global", ...(opts.userId ? [containerFor({ scopes: [scope.user(opts.userId)] } as MemoryItem)] : [])];
    const q = query.trim() || [opts.kinds?.join(" "), ...(opts.scopes ?? []), ...(opts.kits ?? []), opts.pack].filter(Boolean).join(" ") || "dreamsy";
    const results = await Promise.all(containers.map(async (containerTag) => {
      const res = await this.req("POST", "/v3/search", {
        q: q.slice(0, 1000),
        containerTag,
        limit: Math.min(100, limit * 4),
        includeFullDocs: true,
        ...(and.length ? { filters: { AND: and } } : {}),
      });
      return ((await res.json()) as { results: SmResult[] }).results ?? [];
    }));
    const items: MemoryItem[] = [];
    const sem: number[] = [];
    const seen = new Set<string>();
    for (const r of results.flat()) {
      const item = fromMetadata(r);
      if (!item || seen.has(item.id) || !eligible(item, opts)) continue;
      seen.add(item.id);
      items.push(item);
      sem.push(r.score ?? 0);
    }
    return rank(query, items, opts, sem);
  }

  async forget(ids: string[]) {
    await Promise.all(ids.map((id) => this.req("DELETE", `/v3/documents/${encodeURIComponent(id)}`)));
  }
}

function fromMetadata(r: SmResult): MemoryItem | null {
  const m = r.metadata ?? {};
  if (typeof m.memId !== "string" || typeof m.kind !== "string") return null;
  let data: Record<string, unknown> | undefined;
  if (typeof m.data === "string") { try { data = JSON.parse(m.data); } catch {} }
  return {
    id: m.memId,
    kind: m.kind as MemoryKind,
    text: r.content ?? r.chunks?.map((c) => c.content).join("\n") ?? "",
    scopes: Array.isArray(m.scopes) ? (m.scopes as string[]) : [],
    score: typeof m.score === "number" ? m.score : null,
    weight: typeof m.weight === "number" ? m.weight : 1,
    data,
    createdAt: typeof m.createdAt === "string" ? m.createdAt : undefined,
  };
}

export function dataDir(): string {
  return process.env.DREAMSY_DATA_DIR ?? repoPath(".data") + "/";
}

export function createMemory(opts: { dir?: string; env?: NodeJS.ProcessEnv; fetchFn?: typeof fetch } = {}): Memory {
  const env = opts.env ?? process.env;
  const key = env.SUPERMEMORY_API_KEY;
  if (key) return new SupermemoryMemory(key, env.SUPERMEMORY_BASE_URL ?? "https://api.supermemory.ai", opts.fetchFn);
  return new LocalMemory(join(opts.dir ?? dataDir(), "memory", "memory.jsonl"));
}
