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
  /**
   * Guided first experience done (the "Welcome to Dreamsy world" sheet was shown). null = new account
   * that gets the onboarding game; undefined = older API without onboarding (never runs the flow).
   */
  onboardedAt?: string | null;
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
/** DREAMSY.MD §11.8: public = newest version auto-live; private = never published. */
export type Visibility = 'public' | 'private';

export type Game = {
  id: string;
  ownerId: string;
  name: string;
  description: string;
  status: GameStatus;
  /** Owner views; absent on older APIs (then the explicit Publish UI is used). */
  visibility?: Visibility;
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
  /** Manifest `[players]` of the published version (else latest); multiplayer = max > 1 (§4.5). */
  players?: Players;
  multiplayer?: boolean;
  /** If the API includes it: the running build, so the Create list needn't ask per game. */
  activeGeneration?: Generation | null;
  /** Coins to play someone else's published game (§11.6). Missing on older APIs: treat as PLAY_PRICE. */
  playPrice?: number;
  /** Coins to remix (all to the owner; free on your own game). Missing on older APIs = remix is free. */
  remixPrice?: number;
};

/** What non-owners see: no latestVersion. */
export type PublicGame = Omit<Game, 'latestVersion'>;

// ---------- platform v1 (DREAMSY.MD §11) ----------

export type Orientation = 'portrait' | 'landscape';
/** Feed/public views carry the source name; owner views may only have {gameId, version}. */
export type RemixOf = { gameId: string; name?: string; version?: number };
export type Creator = { id: string; handle: string; avatar?: AvatarParts | null };
export type GameStats = { plays: number; likes: number; remixes: number };
export type Players = { min: number; max: number };
/** Short players label for badges: "2P" for duels, "Up to N" for bigger rooms; null for single-player. */
export const playersLabel = (g: { multiplayer?: boolean; players?: Players | null } | null | undefined): string | null =>
  g?.multiplayer && g.players ? (g.players.max === 2 ? '2P' : `Up to ${g.players.max}`) : null;
export type Viewer = { liked?: boolean; ownedPasses?: string[] };

export type FeedGame = {
  id: string;
  name: string;
  description: string;
  orientation: Orientation;
  thumbnailUrl: string | null;
  /** Optional so older API builds still type-check at runtime. */
  players?: Players;
  multiplayer?: boolean;
  creator: Creator;
  stats: GameStats;
  publishedAt: string;
  remixOf: RemixOf | null;
  /** Present on authed lists (feed, search, profiles). */
  viewer?: Viewer;
  /** Coins to play (§11.6); missing on older APIs. */
  playPrice?: number;
  /** Coins to remix; missing on older APIs (remix is free there). */
  remixPrice?: number;
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
  /** Coins for a game's first build (edits are free). Missing on older APIs = creating is free. */
  createPrice?: number;
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

/**
 * Coins wallet (10,000 coins = $0.10). Ledger kinds: "starter_grant" | "grant" | "purchase" | "sale" |
 * "play" | "play_earning" | "platform_fee" (open-ended). Older APIs say currency "stars" and omit usd.
 */
export type Wallet = { balance: number; currency: 'coins' | 'stars'; usd?: number; createPrice?: number };
export type LedgerEntry = {
  delta: number;
  balanceAfter: number;
  kind: string;
  gameId: string | null;
  itemId: string | null;
  createdAt: string;
};

/** POST /v1/games/:id/play. 402 carries `{ error: "insufficient_coins", balance, price }`. */
export type PlayResult = {
  charged: boolean;
  price: number;
  balance: number;
  pass: { id: string; expiresAt: string } | null;
  creatorEarned: number;
};

/** GET /v1/games/:id/play: would playing now be free? No side effects. */
export type PlayStatus = {
  free: boolean;
  reason: 'owner' | 'draft' | 'pass' | null;
  price: number;
  balance: number;
  pass: { id: string; expiresAt: string } | null;
};

export type Earnings = {
  totalCoins: number;
  todayCoins: number;
  paidPlays: number;
  usd: { total: number; today: number };
  games: { gameId: string; name: string; coins: number; plays: number }[];
};

// ---------- notifications + push ----------

/** Open-ended; these are the ones the app knows how to draw. */
export type NotificationKind =
  | 'play_earning'
  | 'remix_earning'
  | 'sale'
  | 'build_done'
  | 'group_join'
  | 'friend_request'
  | 'friend_accept'
  | 'game_invite'
  | (string & {});
export type NotificationData = {
  gameId?: string;
  remixGameId?: string;
  groupId?: string;
  fromUserId?: string;
  coins?: number;
  version?: number;
  /** game_invite: the room to join, and when the invite stops working (ISO). */
  roomCode?: string;
  expiresAt?: string;
  spectate?: boolean;
  [k: string]: unknown;
};
export type AppNotification = {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  data: NotificationData | null;
  read: boolean;
  createdAt: string;
};

export type LocalImage = { uri: string; mimeType: string; fileName: string };

// ---------- friends + presence (404 on older APIs) ----------

/** Where a friend is right now, from the room server. "online" = in the lobby in the last 60 s. */
export type Presence = {
  status: 'offline' | 'online' | 'in_room' | 'in_match';
  gameId?: string;
  gameName?: string;
  roomCode?: string;
  mode?: 'duel' | 'party';
  players?: number;
  max?: number;
  spectatable?: boolean;
};
export type Friend = { user: Creator; since: string; presence: Presence };
export type FriendRequest = { user: Creator; at: string };
export type FriendStatus = 'none' | 'friends' | 'incoming' | 'outgoing';
export type UserHit = Creator & { friendStatus: FriendStatus };

// ---------- guided first experience + Live now (404 on older APIs) ----------

/** GET /v1/onboarding: the game a new account plays first (free). */
export type OnboardingGame = { gameId: string; gameName: string; version: number; message: string };

/** One person in a room right now (GET /v1/live `playing`); never the caller. */
export type LivePlayer = {
  user: Creator;
  gameId: string;
  gameName: string;
  mode?: 'duel' | 'party' | string;
  players: number;
  max: number;
  roomCode: string;
  status: 'in_room' | 'in_match';
  spectatable: boolean;
  /** Lobby with space. */
  joinable: boolean;
};

/** GET /v1/live: who's online, who's in a game, and 6 trending games. */
export type Live = { online: number; playing: LivePlayer[]; featured: FeedGame[] };

// ---------- leaderboards, ghosts, groups (DREAMSY.MD §13) ----------

export type BoardOrder = 'asc' | 'desc';
/** A board with runs (GET /v1/games/:id/leaderboards). */
export type BoardSummary = { board: string; order: BoardOrder; players: number; best: number; updatedAt: string };
/** `public`, `me`, or `group:<id>`. */
export type BoardScope = 'public' | 'me' | `group:${string}`;
export type BoardEntry = {
  rank: number;
  user: Creator;
  value: number;
  runId: string;
  hasGhost: boolean;
  version: number;
  at: string;
};
export type Leaderboard = {
  board: string;
  order: BoardOrder;
  scope: string;
  entries: BoardEntry[];
  /** My best within the scope (absent if I have no run on this board). */
  me?: { rank: number; value: number; runId: string };
};

export type GroupRole = 'owner' | 'member';
export type Group = {
  id: string;
  name: string;
  ownerId: string;
  inviteCode: string;
  memberCount: number;
  role: GroupRole | null;
  createdAt: string;
};
export type GroupMember = { user: Creator; role: GroupRole; joinedAt: string };
/** A game shared with a group: the owner-style view (drafts too) + who shared it. */
export type SharedGame = Game & { sharedBy: Creator; sharedAt: string };

/** Version a group member can play: the published one, else the latest draft (shared drafts). */
export const playableVersion = (g: { publishedVersion?: number | null; latestVersion?: number | null }): number | null =>
  g.publishedVersion || g.latestVersion || null;

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
  createGame: (body: { name: string; description?: string; visibility?: Visibility }) =>
    request<{ game: Game }>('/v1/games', { method: 'POST', body }),
  updateGame: (id: string, body: { name?: string; description?: string; visibility?: Visibility }) =>
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
  /** 402 = can't pay for a first build (`{ error: "insufficient_coins", balance, price }`). */
  generate: (gameId: string, body: { prompt: string; imageIds?: string[]; selection?: string[] }) =>
    request<{ generation: Generation; charged?: number }>(`/v1/games/${enc(gameId)}/generations`, { method: 'POST', body }),
  cancelGeneration: (id: string) =>
    request<{ generation: Generation }>(`/v1/generations/${enc(id)}/cancel`, { method: 'POST' }),

  upload: uploadImage,

  // ---------- platform v1 (§11) ----------

  updateMe: (body: { handle?: string; bio?: string; avatar?: AvatarParts }) => request<{ user: User }>('/v1/me', { method: 'PATCH', body }),

  /** `multiplayer` = only games whose published version has `[players] max > 1`. */
  feed: (tab: FeedTab, cursor?: string | null, limit = 20, opts: { multiplayer?: boolean } = {}) =>
    request<Page<'games', FeedGame>>(`/v1/feed${qs({ tab, cursor, limit, multiplayer: opts.multiplayer ? 1 : null })}`),
  search: (q: string, cursor?: string | null, opts: { multiplayer?: boolean } = {}) =>
    request<Page<'games', FeedGame>>(`/v1/search${qs({ q, cursor, multiplayer: opts.multiplayer ? 1 : null })}`),
  publicGame: (id: string) =>
    request<{ game: FeedGame & { publishedVersion: number } }>(`/v1/public/games/${enc(id)}`, { auth: false }),

  /** Start a play: charges coins unless free (own game, group draft, active pass). Counts the play. */
  play: (id: string) => request<PlayResult>(`/v1/games/${enc(id)}/play`, { method: 'POST' }),
  playStatus: (id: string) => request<PlayStatus>(`/v1/games/${enc(id)}/play`),
  earnings: () => request<Earnings>('/v1/me/earnings'),
  /** Pre-coins play counter; only used when POST /play isn't deployed. */
  countPlay: (id: string, version: number) =>
    request<unknown>(`/v1/games/${enc(id)}/plays`, { method: 'POST', body: { version } }),
  like: (id: string) => request<unknown>(`/v1/games/${enc(id)}/like`, { method: 'PUT' }),
  unlike: (id: string) => request<unknown>(`/v1/games/${enc(id)}/like`, { method: 'DELETE' }),
  /** 402 = can't pay the remix price. `charged` / `ownerEarned` absent on older APIs. */
  remix: (id: string) =>
    request<{ game: Game; charged?: number; ownerEarned?: number }>(`/v1/games/${enc(id)}/remix`, { method: 'POST' }),
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

  // ---------- leaderboards + groups (§13.3) ----------

  boards: (gameId: string) => request<{ boards: BoardSummary[] }>(`/v1/games/${enc(gameId)}/leaderboards`),
  leaderboard: (gameId: string, board: string, scope: BoardScope = 'public', limit = 20) =>
    request<Leaderboard>(`/v1/games/${enc(gameId)}/leaderboards/${enc(board)}${qs({ scope, limit })}`),

  myGroups: () => request<{ groups: Group[] }>('/v1/me/groups'),
  createGroup: (name: string) =>
    request<{ group: Group; inviteCode: string }>('/v1/groups', { method: 'POST', body: { name } }),
  /** Idempotent. 404 = unknown code, 409 = group full. */
  joinGroup: (code: string) => request<{ group: Group }>('/v1/groups/join', { method: 'POST', body: { code } }),
  group: (id: string) => request<{ group: Group; members: GroupMember[] }>(`/v1/groups/${enc(id)}`),
  leaveGroup: (id: string) => request<{ ok: true }>(`/v1/groups/${enc(id)}/leave`, { method: 'POST' }),
  /** Owner only. */
  deleteGroup: (id: string) => request<{ ok: true }>(`/v1/groups/${enc(id)}`, { method: 'DELETE' }),
  /** Owner only: rotates the code; old links stop working. */
  newInviteCode: (id: string) => request<{ inviteCode: string }>(`/v1/groups/${enc(id)}/invite-code`, { method: 'POST' }),
  groupGames: (id: string) => request<{ games: SharedGame[] }>(`/v1/groups/${enc(id)}/games`),
  /** Your own game (drafts too) or any published game. Idempotent. */
  shareWithGroup: (groupId: string, gameId: string) =>
    request<{ game: Game }>(`/v1/groups/${enc(groupId)}/games`, { method: 'POST', body: { gameId } }),
  unshareFromGroup: (groupId: string, gameId: string) =>
    request<{ ok: true }>(`/v1/groups/${enc(groupId)}/games/${enc(gameId)}`, { method: 'DELETE' }),

  // ---------- notifications + push (404 on older APIs) ----------

  notifications: (cursor?: string | null, limit = 30) =>
    request<{ items: AppNotification[]; unread: number; next: string | null }>(`/v1/me/notifications${qs({ cursor, limit })}`),
  unreadCount: () => request<{ unread: number }>('/v1/me/notifications/unread'),
  markRead: (body: { ids: string[] } | { all: true }) =>
    request<{ unread: number }>('/v1/me/notifications/read', { method: 'POST', body }),
  addPushToken: (token: string, platform: 'ios' | 'android') =>
    request<{ ok: boolean }>('/v1/me/push-tokens', { method: 'POST', body: { token, platform } }),
  removePushToken: (token: string) => request<{ ok: boolean }>('/v1/me/push-tokens', { method: 'DELETE', body: { token } }),

  // ---------- guided first experience (404 on older APIs) ----------

  onboarding: () => request<OnboardingGame>('/v1/onboarding'),
  /** Marks onboarding done (idempotent); called when the welcome sheet shows. */
  finishOnboarding: () => request<{ user: User }>('/v1/me/onboarding', { method: 'POST', body: { done: true } }),
  live: () => request<Live>('/v1/live'),

  // ---------- friends (404 on older APIs) ----------

  friends: () => request<{ friends: Friend[]; incoming: FriendRequest[]; outgoing: FriendRequest[] }>('/v1/me/friends'),
  /** Handle prefix, up to 20, never me. */
  searchUsers: (q: string) => request<{ users: UserHit[] }>(`/v1/users/search${qs({ q })}`),
  /** 201 {request} = sent; 200 {friend} = they had asked me (auto-accepted). 404 unknown, 409 already friends, 400 self. */
  requestFriend: (handle: string) =>
    request<{ request?: { id: string; user: Creator; status: 'pending'; direction: 'outgoing' }; friend?: Friend }>('/v1/friends/requests', {
      method: 'POST',
      body: { handle },
    }),
  acceptFriend: (userId: string) => request<{ friend: Friend }>(`/v1/friends/requests/${enc(userId)}/accept`, { method: 'POST' }),
  declineFriend: (userId: string) => request<{ ok: true }>(`/v1/friends/requests/${enc(userId)}/decline`, { method: 'POST' }),
  /** Unfriend, or cancel my outgoing request. */
  removeFriend: (userId: string) => request<{ ok: true }>(`/v1/friends/${enc(userId)}`, { method: 'DELETE' }),
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
