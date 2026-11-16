// "Invite friends" from the lobby room screen: GET {api}/v1/me/friends, POST {api}/v1/invites. DOM-free.
import type { Presence } from "./protocol.js";

export interface Friend {
  user: { id: string; handle: string; avatar?: string | null };
  since?: string;
  presence?: Presence;
}

export interface InviteTarget {
  api: string;
  /** A signed-in user's token (never a guest's: guests have no friends). */
  token: string;
  /** API game id. */
  gameId: string;
}

type Fetch = typeof fetch;
const RANK: Record<Presence["status"], number> = { in_room: 0, in_match: 1, online: 2, offline: 3 };

/** Friends, online / in a room first, then by handle. null = friends unavailable (no API route yet, signed out, offline). */
export async function fetchFriends(t: InviteTarget, f: Fetch = fetch): Promise<Friend[] | null> {
  try {
    const res = await f(`${t.api.replace(/\/$/, "")}/v1/me/friends`, { headers: { authorization: `Bearer ${t.token}` } });
    if (!res.ok) return null;
    const d = (await res.json()) as { friends?: Friend[] };
    return sortFriends(Array.isArray(d.friends) ? d.friends : []);
  } catch {
    return null;
  }
}

export function sortFriends(list: Friend[]): Friend[] {
  return [...list].sort((a, b) =>
    RANK[a.presence?.status ?? "offline"] - RANK[b.presence?.status ?? "offline"] || a.user.handle.localeCompare(b.user.handle));
}

/** POST /v1/invites. Resolves "ok" or a short reason for the button. */
export async function sendInvite(t: InviteTarget, userId: string, roomCode: string, f: Fetch = fetch): Promise<"ok" | string> {
  try {
    const res = await f(`${t.api.replace(/\/$/, "")}/v1/invites`, {
      method: "POST",
      headers: { authorization: `Bearer ${t.token}`, "content-type": "application/json" },
      body: JSON.stringify({ userId, gameId: t.gameId, roomCode }),
    });
    if (res.ok) return "ok";
    if (res.status === 429) return "Too many invites, wait a minute";
    if (res.status === 403) return "Not friends";
    return "Couldn't invite";
  } catch {
    return "Offline";
  }
}

/** One line under a friend's name. */
export function presenceLabel(p: Presence | undefined, roomCode: string): string {
  if (!p || p.status === "offline") return "Offline";
  if (p.roomCode && p.roomCode === roomCode) return "In this room";
  if (p.status === "online") return "Online";
  const game = p.gameName ?? "a game";
  return p.status === "in_match" ? `Playing ${game}` : `In ${game} lobby`;
}
