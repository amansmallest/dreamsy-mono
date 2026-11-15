// Tiny typed client for services/api. Base URL comes from EXPO_PUBLIC_API_URL (inlined at bundle time).
// It knows nothing about how auth works: the auth provider registers a bearer-token getter and a
// 401 handler via configureApi().

export type User = {
  id: string;
  handle: string;
  /** §11.4; older API builds omit it. */
  bio?: string;
  /** Ink avatar parts; null until the user makes one in onboarding. */
  avatar?: AvatarParts | null;
  createdAt: string;
};

export type AvatarParts = Record<string, number>;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Parsed JSON error body (`{ error, ...extra }`), if any. */
    readonly body: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type ApiHooks = {
  getAccessToken: () => Promise<string | null>;
  onUnauthorized: () => void;
};

let hooks: ApiHooks = { getAccessToken: async () => null, onUnauthorized: () => {} };

export function configureApi(next: ApiHooks) {
  hooks = next;
}

const baseUrl = (process.env.EXPO_PUBLIC_API_URL ?? '').replace(/\/+$/, '');
/** services/api base URL (no trailing slash); '' if EXPO_PUBLIC_API_URL is unset. */
export const apiBaseUrl = baseUrl;

export type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Attach the bearer token from the auth provider (default true). */
  auth?: boolean;
  /** Explicit token; overrides the provider (used while a session is being established). */
  token?: string;
};

/** Base URL + headers (incl. bearer) for calls that can't go through request(): streams, uploads. */
export async function authedRequestInit(): Promise<{ url: string; headers: Record<string, string> }> {
  if (!baseUrl) throw new ApiError(0, 'EXPO_PUBLIC_API_URL is not set');
  const token = await hooks.getAccessToken();
  return { url: baseUrl, headers: token ? { Authorization: `Bearer ${token}` } : {} };
}

/** Turn a non-2xx response into an ApiError (and sign out on 401). */
export function apiErrorFrom(status: number, data: unknown, hadToken: boolean): ApiError {
  if (status === 401 && hadToken) hooks.onUnauthorized();
  const message =
    data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
      ? data.error
      : `Request failed (${status})`;
  const body = data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
  return new ApiError(status, message, body);
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  if (!baseUrl) throw new ApiError(0, 'EXPO_PUBLIC_API_URL is not set');

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const token = opts.token ?? (opts.auth === false ? null : await hooks.getAccessToken());
  if (token) headers.Authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch (e) {
    throw new ApiError(0, e instanceof Error ? e.message : 'Network error');
  }

  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) throw apiErrorFrom(res.status, data, !!token && !opts.token);
  return data as T;
}



// ---------- shapes (mirror services/api views; timestamps are ISO strings) ----------

export type GameStatus = 'draft' | 'published';

export type Game = {
  id: string;
  ownerId: string;
  name: string;
  description: string;
  status: GameStatus;
  /** Highest committed version; 0 = empty game, no package yet. */
  latestVersion: number;
  publishedVersion: number | null;
  createdAt: string;
  updatedAt: string;
  // §11 additions; optional so older API builds still type-check at runtime.
  orientation?: Orientation;
  thumbnailUrl?: string | null;
  remixOf?: RemixOf | null;
  creator?: Creator;
  stats?: GameStats;
  /** If the API includes it: the running build, so the Create list needn't ask per game. */
  activeGeneration?: Generation | null;
};

/** What non-owners see: no latestVersion. */
export type PublicGame = Omit<Game, 'latestVersion'>;

// ---------- platform v1 (DREAMSY.MD §11) ----------

export type Orientation = 'portrait' | 'landscape';
/** Feed/public views carry the source name; owner views may only have {gameId, version}. */
export type RemixOf = { gameId: string; name?: string; version?: number };
export type Creator = { id: string; handle: string; avatar?: AvatarParts | null };
export type GameStats = { plays: number; likes: number; remixes: number };
export type Viewer = { liked?: boolean; ownedPasses?: string[] };

export type FeedGame = {
  id: string;
  name: string;
  description: string;
  orientation: Orientation;
  thumbnailUrl: string | null;
  creator: Creator;
  stats: GameStats;
  publishedAt: string;
  remixOf: RemixOf | null;
};
export type FeedTab = 'trending' | 'new' | 'top' | 'following';
export type Page<K extends string, T> = { [k in K]: T[] } & { next: string | null };

export type UserProfile = {
  user: { id: string; handle: string; bio: string; avatar?: AvatarParts | null; createdAt: string };
  stats: { games: number; plays: number; likes: number; followers: number; following: number };
  viewer: { following: boolean };
};

export type MarketSort = 'popular' | 'new' | 'price';
export type MarketItem = {
  gameId: string;
  gameName: string;
  itemId: string;
  kind: string;
  name: string;
  description: string;
  price: number;
  iconUrl?: string | null;
  sales: number;
};

/** §11.1: manifests without `orientation` are pre-v1 games, which are landscape. */
export const orientationOf = (manifest: unknown): Orientation => {
  const o = manifest && typeof manifest === 'object' ? (manifest as { orientation?: unknown }).orientation : undefined;
  return o === 'portrait' ? 'portrait' : 'landscape';
};

/** API-relative URLs (e.g. thumbnailUrl "/v1/games/…/thumbnail") made absolute. */
export const absoluteApiUrl = (url: string | null | undefined): string | null =>
  !url ? null : /^https?:\/\//.test(url) ? url : `${baseUrl}${url.startsWith('/') ? '' : '/'}${url}`;

export const thumbnailUrlFor = (gameId: string, version: number) =>
  `${baseUrl}/v1/games/${encodeURIComponent(gameId)}/versions/${version}/thumbnail`;

/** Bearer header for images that need auth (owner thumbnails of unpublished versions). */
export const authHeader = async (): Promise<Record<string, string>> => {
  const t = await hooks.getAccessToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
};

const qs = (params: Record<string, string | number | null | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
};

export type GameVersion = {
  gameId: string;
  version: number;
  sha256: string;
  sizeBytes: number;
  manifest: unknown;
  summary: string;
  generationId: string | null;
  createdBy: string;
  createdAt: string;
};

export type GenerationStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
export const isActiveGeneration = (s: GenerationStatus) => s === 'queued' || s === 'running';

export type Generation = {
  id: string;
  gameId: string;
  prompt: string;
  imageIds: string[];
  selection: string[];
  baseVersion: number;
  status: GenerationStatus;
  attempts: number;
  resultVersion: number | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Long multi-round builds: seconds left as of the response, and where it is. Absent on older APIs. */
  etaSeconds?: number | null;
  progress?: BuildProgress | null;
};

export type BuildProgress = { round: number; rounds: number; phase: string };

export type Quota = {
  limit: number;
  used: number;
  remaining: number;
  /** When the next build frees up; null unless at the limit. */
  resetsAt: string | null;
};

/** 409 from POST /v1/games/:id/generations: the generation already running on this game. */
export const activeGenerationIdFrom = (e: ApiError): string | null =>
  e.status === 409 && typeof e.body?.activeGenerationId === 'string' ? e.body.activeGenerationId : null;

/** 429 from POST /v1/games/:id/generations carries the quota. */
export const quotaFrom = (e: ApiError): Quota | null => {
  const q = e.body?.quota;
  return q && typeof q === 'object' && 'remaining' in q ? (q as Quota) : null;
};

export type Upload = { id: string; contentType: string; sizeBytes: number; createdAt: string };

/** One SSE progress event. `type` is open-ended (the harness adds its own); `data` is JSON. */
export type GenerationEvent = { id: string; type: string; data: Record<string, unknown> };

/** Stars wallet. Ledger kinds: "starter_grant" | "purchase" | "sale" (open-ended). */
export type Wallet = { balance: number; currency: 'stars' };
export type LedgerEntry = {
  delta: number;
  balanceAfter: number;
  kind: string;
  gameId: string | null;
  itemId: string | null;
  createdAt: string;
};

export type LocalImage = { uri: string; mimeType: string; fileName: string };

// ---------- endpoints ----------

const enc = encodeURIComponent;

export const api = {
  me: (token?: string) => request<{ user: User }>('/v1/me', { token }),

  quota: () => request<{ quota: Quota }>('/v1/me/quota'),
  /** Balance + the 20 most recent ledger entries, newest first. */
  wallet: () => request<{ wallet: Wallet; recent: LedgerEntry[] }>('/v1/me/wallet'),

  myGames: () => request<{ games: Game[] }>('/v1/me/games'),
  discover: (opts: { limit?: number; before?: string } = {}) => {
    const q = new URLSearchParams();
    if (opts.limit) q.set('limit', String(opts.limit));
    if (opts.before) q.set('before', opts.before);
    const qs = q.toString();
    return request<{ games: PublicGame[]; next: string | null }>(`/v1/games${qs ? `?${qs}` : ''}`);
  },
  /** Owners get a full Game; anyone else gets a PublicGame (published only). §11.2: plus `viewer`. */
  game: (id: string) =>
    request<{ game: (Game | PublicGame) & { viewer?: Viewer }; viewer?: Viewer }>(`/v1/games/${enc(id)}`),
  createGame: (body: { name: string; description?: string }) =>
    request<{ game: Game }>('/v1/games', { method: 'POST', body }),
  updateGame: (id: string, body: { name?: string; description?: string }) =>
    request<{ game: Game }>(`/v1/games/${enc(id)}`, { method: 'PATCH', body }),
  publish: (id: string, version?: number) =>
    request<{ game: Game }>(`/v1/games/${enc(id)}/publish`, {
      method: 'POST',
      body: version === undefined ? {} : { version },
    }),
  unpublish: (id: string) => request<{ game: Game }>(`/v1/games/${enc(id)}/unpublish`, { method: 'POST' }),

  versions: (gameId: string) => request<{ versions: GameVersion[] }>(`/v1/games/${enc(gameId)}/versions`),
  version: (gameId: string, version: number) =>
    request<{ version: GameVersion }>(`/v1/games/${enc(gameId)}/versions/${version}`),
  revert: (gameId: string, version: number) =>
    request<{ version: GameVersion }>(`/v1/games/${enc(gameId)}/revert`, { method: 'POST', body: { version } }),

  generations: (gameId: string) =>
    request<{ generations: Generation[] }>(`/v1/games/${enc(gameId)}/generations`),
  generation: (id: string) => request<{ generation: Generation }>(`/v1/generations/${enc(id)}`),
  /** 409 = a generation is already active on this game; 429 = daily quota reached. */
  generate: (gameId: string, body: { prompt: string; imageIds?: string[]; selection?: string[] }) =>
    request<{ generation: Generation }>(`/v1/games/${enc(gameId)}/generations`, { method: 'POST', body }),
  cancelGeneration: (id: string) =>
    request<{ generation: Generation }>(`/v1/generations/${enc(id)}/cancel`, { method: 'POST' }),

  upload: uploadImage,

  // ---------- platform v1 (§11) ----------

  updateMe: (body: { handle?: string; bio?: string; avatar?: AvatarParts }) => request<{ user: User }>('/v1/me', { method: 'PATCH', body }),

  feed: (tab: FeedTab, cursor?: string | null, limit = 20) =>
    request<Page<'games', FeedGame>>(`/v1/feed${qs({ tab, cursor, limit })}`),
  search: (q: string, cursor?: string | null) => request<Page<'games', FeedGame>>(`/v1/search${qs({ q, cursor })}`),
  publicGame: (id: string) =>
    request<{ game: FeedGame & { publishedVersion: number } }>(`/v1/public/games/${enc(id)}`, { auth: false }),

  countPlay: (id: string, version: number) =>
    request<unknown>(`/v1/games/${enc(id)}/plays`, { method: 'POST', body: { version } }),
  like: (id: string) => request<unknown>(`/v1/games/${enc(id)}/like`, { method: 'PUT' }),
  unlike: (id: string) => request<unknown>(`/v1/games/${enc(id)}/like`, { method: 'DELETE' }),
  remix: (id: string) => request<{ game: Game }>(`/v1/games/${enc(id)}/remix`, { method: 'POST' }),
  /** Published spin-offs (remixes) of a game. */
  remixes: (id: string, cursor?: string | null) =>
    request<Page<'games', FeedGame>>(`/v1/games/${enc(id)}/remixes${qs({ cursor })}`),
  report: (id: string, reason: string) =>
    request<unknown>(`/v1/games/${enc(id)}/report`, { method: 'POST', body: { reason } }),

  user: (id: string) => request<UserProfile>(`/v1/users/${enc(id)}`),
  userGames: (id: string, cursor?: string | null) =>
    request<{ games: FeedGame[]; next?: string | null }>(`/v1/users/${enc(id)}/games${qs({ cursor })}`),
  follow: (id: string) => request<unknown>(`/v1/users/${enc(id)}/follow`, { method: 'PUT' }),
  unfollow: (id: string) => request<unknown>(`/v1/users/${enc(id)}/follow`, { method: 'DELETE' }),

  marketplace: (sort: MarketSort, cursor?: string | null) =>
    request<Page<'items', MarketItem>>(`/v1/marketplace${qs({ sort, cursor })}`),
};

/**
 * POST /v1/uploads (multipart `file`). Uses XMLHttpRequest because RN's FormData `{uri}` parts are
 * streamed natively by XHR, while expo/fetch (the global fetch in SDK 58) doesn't accept them.
 */
async function uploadImage(image: LocalImage): Promise<{ upload: Upload }> {
  const { url, headers } = await authedRequestInit();
  const form = new FormData();
  // RN FormData file part; not a web Blob.
  form.append('file', { uri: image.uri, name: image.fileName, type: image.mimeType } as unknown as Blob);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${url}/v1/uploads`);
    xhr.setRequestHeader('Accept', 'application/json');
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.onload = () => {
      let data: unknown = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as { upload: Upload });
      else reject(apiErrorFrom(xhr.status, data, !!headers.Authorization));
    };
    xhr.onerror = () => reject(new ApiError(0, 'Network error'));
    xhr.send(form);
  });
}
