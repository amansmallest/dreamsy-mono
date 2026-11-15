// Room protocol (DREAMSY.MD §4.5): JSON messages over one WebSocket at <api>/rooms.
// Shared by the engine client (net/client.ts), the in-memory loopback (net/loopback.ts) and services/gameserver.
// DOM-free, dependency-free.

export type Team = "red" | "blue";
export type RoomMode = "duel" | "party";
export type RoomStatus = "lobby" | "playing";

/** True red vs true blue. */
export const TEAM_COLORS: Record<Team, string> = { red: "#ff2a2a", blue: "#2a6bff" };

/** A player in a room. `id` is per connection (two tabs of one account are two players). */
export interface RoomPlayer {
  id: string;
  userId: string;
  name: string;
  team: Team | null;
  ready: boolean;
}

export interface RoomInfo {
  code: string;
  game: string;
  mode: RoomMode;
  status: RoomStatus;
  min: number;
  max: number;
  /** Host = the device that runs `onServer` handlers (fireServer target). Moves to the next player when it leaves. */
  host: string;
  players: RoomPlayer[];
  /** Match counter (bumped by every start). */
  match: number;
  /** Seed for this match (same on every device). */
  seed: number;
  /** room.setState values (reset at each start). */
  state: Record<string, unknown>;
  /** room.addScore totals: player id or "red" / "blue" → value (reset at each start). */
  scores: Record<string, number>;
}

/** Replicated avatar sample: [scene, x, y, rotationDeg, flipH 0|1, anim, visible 0|1, template entity id]. */
export type AvatarState = [string, number, number, number, number, string, number, string];

export interface MatchResult {
  /** Winning player id (a player win), or null. */
  winner: string | null;
  /** Winning team (a team win, or the winner's team). */
  team: Team | null;
  draw: boolean;
  /** "finish" (a script called room.finish) | "forfeit" (the other side left). */
  reason: "finish" | "forfeit";
  scores: Record<string, number>;
  match: number;
}

/** Event routing: "host" (fireServer) | "others" (fireAll; the sender delivers to itself) | a player id (fireClient). */
export type EventTarget = "host" | "others" | string;

// ---------------------------------------------------------------- client → server
export type ClientMsg =
  | { t: "hello"; token: string; name?: string }
  | { t: "create"; game: string; max: number; min?: number; mode?: RoomMode }
  | { t: "join"; code: string; game?: string }
  | { t: "quick"; game: string }
  | { t: "cancel" }
  | { t: "ready"; v: boolean }
  | { t: "team"; team: Team }
  | { t: "start" }
  | { t: "leave" }
  | { t: "ping"; c: number }
  // in a match
  | { t: "st"; s: AvatarState }
  | { t: "ev"; n: string; to: EventTarget; a: unknown[] }
  | { t: "kv"; k: string; v: unknown }
  | { t: "score"; k: string; d: number }
  | { t: "end"; w: string | null };

// ---------------------------------------------------------------- server → client
export type ServerMsg =
  | { t: "welcome"; id: string; userId: string; name: string }
  | { t: "room"; room: RoomInfo; you: string }
  | { t: "queued"; game: string }
  | { t: "left" }
  | { t: "start"; room: RoomInfo; you: string }
  | { t: "pong"; c: number; s: number }
  | { t: "error"; code: ErrorCode; message: string }
  // in a match
  | { t: "st"; id: string; ts: number; s: AvatarState }
  | { t: "ev"; from: string; n: string; to: EventTarget; a: unknown[] }
  | { t: "kv"; from: string; k: string; v: unknown }
  | { t: "score"; k: string; v: number }
  | { t: "ended"; r: MatchResult };

export type ErrorCode =
  | "unauthorized" | "bad_message" | "not_found" | "full" | "wrong_game" | "in_room" | "not_in_room"
  | "not_host" | "not_ready" | "rate_limited" | "too_large" | "bad_state";

// ---------------------------------------------------------------- limits
export const LIMITS = {
  /** Max bytes of one client message (the socket closes above 2× this). */
  maxMessageBytes: 8 * 1024,
  /** Sustained client messages per second, and the burst on top. */
  msgsPerSecond: 40,
  msgsBurst: 80,
  /** Dropped (rate-limited) messages before the server disconnects the client. */
  maxDrops: 400,
  /** Encoded remote-event args / state value. */
  maxEventBytes: 4 * 1024,
  maxStateValueBytes: 2 * 1024,
  maxStateKeys: 64,
  maxPlayers: 8,
  nameLength: 20,
  /** Avatar sample rate (Hz). */
  stateHz: 15,
  /** Remote avatars render this far in the past (ms) so there are two samples to interpolate between. */
  interpDelayMs: 100,
} as const;

/** Room codes: 6 chars, no 0/O/1/I/L. */
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;

export function normalizeCode(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
}

/** WebSocket URL of the room server for an API base: https://api.x → wss://api.x/rooms; local :8787 → :8790. */
export function roomsUrl(api: string): string {
  const u = new URL(api);
  const local = u.port === "8787";
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  if (local) u.port = "8790";
  u.pathname = "/rooms";
  u.search = "";
  return u.toString();
}
