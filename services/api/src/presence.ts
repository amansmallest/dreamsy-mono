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
