/** Friend presence, read from the room server (DREAMSY.MD §13.4). */

export type PresenceStatus = "offline" | "online" | "in_room" | "in_match";

export interface Presence {
  status: PresenceStatus;
  gameId?: string;
  gameName?: string;
  roomCode?: string;
  mode?: "duel" | "party";
  players?: number;
  max?: number;
  spectatable?: boolean;
}

/** userIds → presence for the ids the room server knows (missing = offline). May throw. */
export type PresenceFetcher = (userIds: string[]) => Promise<Record<string, Presence>>;

export const DEFAULT_GAMESERVER_INTERNAL_URL = "http://gameserver:8790";
const TIMEOUT_MS = 1500;
const STATUSES = new Set<PresenceStatus>(["offline", "online", "in_room", "in_match"]);

/** GET {baseUrl}/internal/presence?users=a,b with `x-internal-token`, 1.5 s timeout. */
export function httpPresence(baseUrl: string, token: string): PresenceFetcher {
  const base = baseUrl.replace(/\/+$/, "");
  return async (userIds) => {
    const url = `${base}/internal/presence?users=${userIds.map(encodeURIComponent).join(",")}`;
    const res = await fetch(url, { headers: { "x-internal-token": token }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`presence: HTTP ${res.status}`);
    const json = (await res.json()) as { presence?: Record<string, Presence> };
    return json.presence ?? {};
  };
}

export const OFFLINE: Presence = { status: "offline" };

/** Presence for every id; any failure (down, timeout, junk) → everyone offline. Never throws. */
export async function presenceFor(fetcher: PresenceFetcher, userIds: string[]): Promise<Map<string, Presence>> {
  const out = new Map<string, Presence>(userIds.map((id) => [id, OFFLINE]));
  if (!userIds.length) return out;
  try {
    const got = await fetcher(userIds);
    for (const id of userIds) {
      const p = got?.[id];
      if (p && typeof p === "object" && STATUSES.has(p.status)) out.set(id, p);
    }
  } catch { /* room server unreachable: offline */ }
  return out;
}

// ---------------------------------------------------------------- live rooms (GET /v1/live)

/** One room from the room server's GET /internal/live. */
export interface LiveRoom {
  code: string;
  gameId: string;
  mode: "duel" | "party";
  state: "lobby" | "running";
  /** Player user ids. */
  players: string[];
  max: number;
  spectators: number;
  spectatable: boolean;
}

/** online = distinct users connected to the room server in the last 60 s. */
export interface LiveSnapshot { online: number; rooms: LiveRoom[] }

/** Snapshot of every room. May throw. */
export type LiveFetcher = () => Promise<LiveSnapshot>;

/** GET {baseUrl}/internal/live with `x-internal-token`, 1.5 s timeout. */
export function httpLive(baseUrl: string, token: string): LiveFetcher {
  const base = baseUrl.replace(/\/+$/, "");
  return async () => {
    const res = await fetch(`${base}/internal/live`, { headers: { "x-internal-token": token }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`live: HTTP ${res.status}`);
    return (await res.json()) as LiveSnapshot;
  };
}

const EMPTY_LIVE: LiveSnapshot = { online: 0, rooms: [] };

/** Validated snapshot; any failure (down, > 1.5 s, junk) → `{online: 0, rooms: []}`. Never throws. */
export async function liveSnapshot(fetcher: LiveFetcher): Promise<LiveSnapshot> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const got = await Promise.race([
      fetcher(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("live: timeout")), TIMEOUT_MS); }),
    ]);
    if (!got || typeof got !== "object" || !Array.isArray(got.rooms)) return EMPTY_LIVE;
    const rooms = got.rooms.filter((r): r is LiveRoom =>
      !!r && typeof r === "object" && typeof r.code === "string" && typeof r.gameId === "string"
      && (r.state === "lobby" || r.state === "running") && Array.isArray(r.players) && typeof r.max === "number")
      .map((r) => ({ ...r, mode: r.mode === "duel" ? "duel" as const : "party" as const, players: r.players.filter((p) => typeof p === "string"), spectatable: r.spectatable === true }));
    const online = Number.isFinite(got.online) && got.online > 0 ? Math.floor(got.online) : 0;
    return { online, rooms };
  } catch {
    return EMPTY_LIVE;
  } finally {
    clearTimeout(timer);
  }
}
