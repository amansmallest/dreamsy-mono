// Typed client for services/api. Shapes mirror services/api/src/routes/* (and apps/mobile/src/api.ts).
import { env } from './env';

export type User = { id: string; handle: string; bio?: string; avatar?: Record<string, number>; createdAt: string };

export type GenerationStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
export const isActive = (s: GenerationStatus) => s === 'queued' || s === 'running';

export type BuildProgress = { round: number; rounds: number; phase: string };

export type Generation = {
  id: string;
  gameId: string;
  prompt: string;
  imageIds: string[];
  selection: string[];
  /** Sprite ids the edit is scoped to (newer API builds). */
  assetIds?: string[];
  baseVersion: number;
  status: GenerationStatus;
  attempts: number;
  resultVersion: number | null;
  error: string | null;
  etaSeconds?: number | null;
  progress?: BuildProgress | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Build metrics (jsonb; newer API builds). Fields are best-effort. */
  metrics?: BuildMetrics | null;
};

export type BuildMetrics = {
  artScore?: number | null;
  score?: number | null;
  costUsd?: number | null;
  minutes?: number | null;
  durationSec?: number | null;
  memoryHits?: number | null;
  spritesReusedPct?: number | null;
  [k: string]: unknown;
};

/** Normalized {score, cost, minutes} from metrics (tolerates a few field spellings). */
export function metricSummary(m: BuildMetrics | null | undefined): { score: number | null; cost: number | null; minutes: number | null } {
  if (!m) return { score: null, cost: null, minutes: null };
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    score: n(m.artScore) ?? n(m.score),
    cost: n(m.costUsd) ?? n(m.usd),
    minutes: n(m.minutes) ?? (n(m.durationSec) != null ? n(m.durationSec)! / 60 : n(m.seconds) != null ? n(m.seconds)! / 60 : null),
  };
}

export type InsightsDay = { date: string; builds: number; succeeded: number; failed: number; avgArtScore: number | null; avgCostUsd: number | null; avgMinutes: number | null; avgMemoryHits: number | null; spritesReusedPct: number | null };
export type Insights = {
  daily: InsightsDay[];
  byKit: { kit: string; builds: number; avgArtScore: number | null; avgCostUsd: number | null }[];
  totals: { builds: number; succeeded: number; avgArtScore: number | null; avgCostUsd: number | null; memoryItems?: number };
};

export type Game = {
  id: string;
  ownerId: string;
  name: string;
  description: string;
  status: 'draft' | 'published';
  latestVersion: number;
  publishedVersion: number | null;
  publishedAt: string | null;
  hidden?: boolean;
  orientation?: 'portrait' | 'landscape' | null;
  thumbnailUrl: string | null;
  /** Manifest `[players]` of the published version (else latest); multiplayer = max > 1. */
  players?: { min: number; max: number };
  multiplayer?: boolean;
  stats?: { plays: number; likes: number; remixes: number };
  activeGeneration?: Generation | null;
  createdAt: string;
  updatedAt: string;
};

export type GameVersion = {
  gameId: string;
  version: number;
  sha256: string;
  sizeBytes: number;
  manifest: { style?: { preset?: string }; dimension?: string; name?: string } | null;
  summary: string;
  players?: { min: number; max: number };
  generationId: string | null;
  createdBy: string;
  createdAt: string;
};

export type Asset = { id: string; kind: string; file: string; url: string; prompt?: string | null; model?: string | null; sizeBytes: number };
export type GenerationEvent = { id: string; type: string; data: Record<string, unknown> };
export type Quota = { limit: number; used: number; remaining: number; resetsAt: string | null };
export type Wallet = { balance: number; currency: 'stars' };
export type LedgerEntry = { delta: number; balanceAfter: number; kind: string; gameId: string | null; itemId: string | null; createdAt: string };
export type Upload = { id: string; contentType: string; sizeBytes: number; createdAt: string };
export type ActivityItem = { generation: Generation; game: { id: string; name: string; thumbnailUrl: string | null } };

// ---------- leaderboards + groups (DREAMSY.MD §13) ----------

export type UserBrief = { id: string; handle: string; avatar: Record<string, number> | null };
export type BoardOrder = 'asc' | 'desc';
export type BoardSummary = { board: string; order: BoardOrder; players: number; best: number; updatedAt: string };
export type LeaderboardEntry = { rank: number; user: UserBrief; value: number; runId: string; hasGhost: boolean; version: number; at: string };
export type Leaderboard = {
  board: string;
  order: BoardOrder;
  scope: string;
  entries: LeaderboardEntry[];
  me?: { rank: number; value: number; runId: string };
};
export type Group = { id: string; name: string; ownerId: string; inviteCode: string; memberCount: number; role: 'owner' | 'member' | null; createdAt: string };
export type GroupMember = { user: UserBrief; role: 'owner' | 'member'; joinedAt: string };
export type SharedGame = Game & { creator?: UserBrief; sharedBy: UserBrief; sharedAt: string };

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly body: Record<string, unknown> | null = null) {
    super(message);
  }
}

type Hooks = {
  getToken: () => string | null;
  /** Called on 401; return a fresh token to retry once, or null to give up (caller signs out). */
  onUnauthorized: () => Promise<string | null>;
};
let hooks: Hooks = { getToken: () => null, onUnauthorized: async () => null };
export const setApiHooks = (h: Hooks) => { hooks = h; };

/** Relative API paths ("/v1/...") → absolute; absolute URLs pass through. */
export const absUrl = (u: string) => (/^https?:\/\//.test(u) ? u : `${env.apiUrl}${u.startsWith('/') ? '' : '/'}${u}`);

/** fetch() with the bearer injected and one re-auth retry on 401. */
export async function authedFetch(path: string, init: RequestInit = {}, auth = true): Promise<Response> {
  const go = (token: string | null) => {
    const headers = new Headers(init.headers);
    if (auth && token) headers.set('Authorization', `Bearer ${token}`);
    return fetch(absUrl(path), { ...init, headers });
  };
  let res = await go(hooks.getToken());
  if (res.status === 401 && auth && hooks.getToken()) {
    const fresh = await hooks.onUnauthorized();
    if (fresh) res = await go(fresh);
  }
  return res;
}

async function request<T>(path: string, opts: { method?: string; body?: unknown; auth?: boolean; signal?: AbortSignal } = {}): Promise<T> {
  const isForm = opts.body instanceof FormData;
  let res: Response;
  try {
    res = await authedFetch(path, {
      method: opts.method ?? 'GET',
      signal: opts.signal,
      headers: opts.body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body === undefined ? undefined : isForm ? (opts.body as FormData) : JSON.stringify(opts.body),
    }, opts.auth ?? true);
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(0, `Can't reach the Dreamsy API at ${env.apiUrl}`);
  }
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) throw new ApiError(res.status, typeof data?.error === 'string' ? data.error : `HTTP ${res.status}`, data);
  return data as T;
}

const enc = encodeURIComponent;

export const api = {
  // auth
  guest: () => request<{ user: User; token: string }>('/v1/auth/guest', { method: 'POST', auth: false }),
  emailStart: (email: string) => request<{ ok: true }>('/v1/auth/email/start', { method: 'POST', auth: false, body: { email } }),
  emailVerify: (email: string, code: string) => request<{ user: User; token: string }>('/v1/auth/email/verify', { method: 'POST', auth: false, body: { email, code } }),
  demo: (username: string) => request<{ user: User; token: string }>('/v1/auth/demo', { method: 'POST', auth: false, body: { username } }),
  exchangeSupabase: (accessToken: string) =>
    request<{ user: User; token: string }>('/v1/auth/supabase', { method: 'POST', body: { accessToken }, auth: false }),
  me: () => request<{ user: User }>('/v1/me'),
  updateMe: (body: { handle?: string; bio?: string }) => request<{ user: User }>('/v1/me', { method: 'PATCH', body }),
  quota: () => request<{ quota: Quota }>('/v1/me/quota'),
  wallet: () => request<{ wallet: Wallet; recent: LedgerEntry[] }>('/v1/me/wallet'),
  activity: (cursor?: string | null) =>
    request<{ items: ActivityItem[]; next: string | null }>(`/v1/me/activity${cursor ? `?cursor=${enc(cursor)}` : ''}`),

  insightsMine: (days = 30) => request<Insights>(`/v1/me/insights?days=${days}`),
  insightsEngine: (days = 30) => request<Insights>(`/v1/insights/engine?days=${days}`),

  // games
  myGames: () => request<{ games: Game[] }>('/v1/me/games'),
  game: (id: string) => request<{ game: Game }>(`/v1/games/${enc(id)}`),
  createGame: (name: string, description?: string) => request<{ game: Game }>('/v1/games', { method: 'POST', body: { name, description } }),
  renameGame: (id: string, name: string) => request<{ game: Game }>(`/v1/games/${enc(id)}`, { method: 'PATCH', body: { name } }),
  publish: (id: string, version: number) => request<{ game: Game }>(`/v1/games/${enc(id)}/publish`, { method: 'POST', body: { version } }),
  unpublish: (id: string) => request<{ game: Game }>(`/v1/games/${enc(id)}/unpublish`, { method: 'POST', body: {} }),
  versions: (id: string) => request<{ versions: GameVersion[] }>(`/v1/games/${enc(id)}/versions`),
  revert: (id: string, version: number) => request<{ version: GameVersion }>(`/v1/games/${enc(id)}/revert`, { method: 'POST', body: { version } }),
  assets: (id: string, v: number) => request<{ assets: Asset[] }>(`/v1/games/${enc(id)}/versions/${v}/assets`),
  thumbnailPath: (id: string, v: number) => `/v1/games/${enc(id)}/versions/${v}/thumbnail`,

  // leaderboards
  boards: (gameId: string) => request<{ boards: BoardSummary[] }>(`/v1/games/${enc(gameId)}/leaderboards`),
  leaderboard: (gameId: string, board: string, scope = 'public', limit = 20) =>
    request<Leaderboard>(`/v1/games/${enc(gameId)}/leaderboards/${enc(board)}?scope=${enc(scope)}&limit=${limit}`),

  // groups
  myGroups: () => request<{ groups: Group[] }>('/v1/me/groups'),
  createGroup: (name: string) => request<{ group: Group; inviteCode: string }>('/v1/groups', { method: 'POST', body: { name } }),
  joinGroup: (code: string) => request<{ group: Group }>('/v1/groups/join', { method: 'POST', body: { code } }),
  group: (id: string) => request<{ group: Group; members: GroupMember[] }>(`/v1/groups/${enc(id)}`),
  leaveGroup: (id: string) => request<{ ok: true }>(`/v1/groups/${enc(id)}/leave`, { method: 'POST', body: {} }),
  deleteGroup: (id: string) => request<{ ok: true }>(`/v1/groups/${enc(id)}`, { method: 'DELETE' }),
  rotateInvite: (id: string) => request<{ inviteCode: string }>(`/v1/groups/${enc(id)}/invite-code`, { method: 'POST', body: {} }),
  groupGames: (id: string) => request<{ games: SharedGame[] }>(`/v1/groups/${enc(id)}/games`),
  shareGame: (groupId: string, gameId: string) => request<{ game: Game }>(`/v1/groups/${enc(groupId)}/games`, { method: 'POST', body: { gameId } }),
  unshareGame: (groupId: string, gameId: string) => request<{ ok: true }>(`/v1/groups/${enc(groupId)}/games/${enc(gameId)}`, { method: 'DELETE' }),

  // generations
  generations: (gameId: string) => request<{ generations: Generation[] }>(`/v1/games/${enc(gameId)}/generations`),
  generation: (id: string) => request<{ generation: Generation }>(`/v1/generations/${enc(id)}`),
  generate: (gameId: string, body: { prompt: string; imageIds?: string[]; assetIds?: string[] }) =>
    request<{ generation: Generation }>(`/v1/games/${enc(gameId)}/generations`, { method: 'POST', body }),
  cancel: (id: string) => request<{ generation: Generation }>(`/v1/generations/${enc(id)}/cancel`, { method: 'POST', body: {} }),

  upload: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<{ upload: Upload }>('/v1/uploads', { method: 'POST', body: form });
  },
};

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong');

/** 409 on POST generations carries the active generation id. */
export const activeGenerationIdFrom = (e: unknown) =>
  e instanceof ApiError && e.status === 409 && typeof e.body?.activeGenerationId === 'string' ? e.body.activeGenerationId : null;
