// Friends, presence, and getting into a friend's room (join = a normal paid play, spectate = free).
//
// The friend list (GET /v1/me/friends) lives in a small store so Home / Profile know whether to show
// their Friends entry points and the Friends screen can poll it. Older APIs have no friends routes:
// the first 404 marks the feature unavailable and every entry point hides.

import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState, useSyncExternalStore } from 'react';
import { Alert } from 'react-native';
import { api, ApiError, playableVersion, type Friend, type FriendRequest, type NotificationData, type Presence } from './api';
import { gatePlay, OutOfCoinsSheet, playParams, type PlayTarget } from './coins';
import { errorMessage } from './theme';
import { showToast } from './toast';

export const FRIENDS_POLL_MS = 15_000;

export type FriendsData = { friends: Friend[]; incoming: FriendRequest[]; outgoing: FriendRequest[] };
type State = { available: boolean | null; data: FriendsData | null; error: string | null };

let state: State = { available: null, data: null, error: null };
const listeners = new Set<() => void>();
function set(next: Partial<State>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

export function useFriendsState(): State {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

let inflight: Promise<void> | null = null;

/** GET /v1/me/friends into the store. Deduped while in flight; a 404 hides friends app-wide. */
export function refreshFriends(): Promise<void> {
  if (state.available === false) return Promise.resolve();
  return (inflight ??= (async () => {
    try {
      const r = await api.friends();
      set({ available: true, data: { friends: r.friends ?? [], incoming: r.incoming ?? [], outgoing: r.outgoing ?? [] }, error: null });
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) set({ available: false, data: null, error: null });
      else set({ error: errorMessage(e) });
    } finally {
      inflight = null;
    }
  })());
}

/** Signed out: the next account starts fresh. */
export function resetFriends() {
  inflight = null;
  set({ available: null, data: null, error: null });
}

/**
 * Entry points (Home header, Profile row): true once the API is known to have friends. Refetches on
 * focus (pending request count); stops asking after a 404.
 */
export function useFriendsAvailable(): boolean {
  const { available } = useFriendsState();
  useFocusEffect(
    useCallback(() => {
      void refreshFriends();
    }, []),
  );
  return available === true;
}

// ---------- presence ----------

const RANK: Record<Presence['status'], number> = { in_match: 0, in_room: 1, online: 2, offline: 3 };

/** In a match, in a lobby, online, then offline; by handle within each. */
export const sortFriends = (list: Friend[]) =>
  [...list].sort((a, b) => (RANK[a.presence?.status] ?? 3) - (RANK[b.presence?.status] ?? 3) || a.user.handle.localeCompare(b.user.handle));

export const isOnline = (p: Presence | undefined) => !!p && p.status !== 'offline';

/** "Online", "In Orb Duel lobby", "Playing Orb Duel · 1v1", "Offline". */
export function presenceLine(p: Presence | undefined): string {
  const game = p?.gameName || 'a game';
  switch (p?.status) {
    case 'online':
      return 'Online';
    case 'in_room':
      return `In ${game} lobby`;
    case 'in_match': {
      const mode = p.mode === 'duel' ? '1v1' : p.players ? `${p.players} players` : null;
      return mode ? `Playing ${game} · ${mode}` : `Playing ${game}`;
    }
    default:
      return 'Offline';
  }
}

/** What the friend row offers: Join an open lobby, Spectate a running match, or nothing. */
export function presenceAction(p: Presence | undefined): 'join' | 'spectate' | null {
  if (!p?.gameId || !p.roomCode) return null;
  if (p.status === 'in_room') return p.max && p.players && p.players >= p.max ? null : 'join';
  if (p.status === 'in_match') return p.spectatable === false ? null : 'spectate';
  return null;
}

// ---------- into a room ----------

/** The version to open (given, else the game's playable one) + orientation. Throws if unknown. */
async function roomTarget(gameId: string, version?: number): Promise<PlayTarget> {
  try {
    const { game } = await api.game(gameId);
    const v = version && version > 0 ? version : playableVersion(game as { publishedVersion?: number | null; latestVersion?: number | null });
    if (!v) throw new Error('This game has nothing to play yet.');
    return { id: gameId, version: v, orientation: game.orientation ?? null };
  } catch (e) {
    if (version && version > 0) return { id: gameId, version };
    throw e;
  }
}

const roomParams = (code: string, spectate: boolean) => ({ room: code, ...(spectate ? { spectate: '1' } : {}) });

/**
 * Join a friend's room: POST /play first (a normal paid play), then the player with room=<code>.
 * Returns 'out' when the user can't pay (the caller shows "Out of coins").
 */
export async function joinRoom(
  gameId: string,
  code: string,
  version?: number,
): Promise<{ kind: 'open' } | { kind: 'out'; balance: number; price: number; target: PlayTarget }> {
  const t = await roomTarget(gameId, version);
  const r = await gatePlay(gameId);
  if (r.kind === 'out') return { ...r, target: t };
  router.push({ pathname: '/play/[id]', params: { ...playParams(t, r.charge), ...roomParams(code, false) } });
  return { kind: 'open' };
}

/** Watch a friend's match: free, no /play. */
export async function spectateRoom(gameId: string, code: string, version?: number) {
  const t = await roomTarget(gameId, version);
  router.push({
    pathname: '/play/[id]',
    params: { id: t.id, version: String(t.version), ...(t.orientation ? { orientation: t.orientation } : {}), ...roomParams(code, true) },
  });
}

/** For screens with Join / Spectate buttons; render `sheet` (the "Out of coins" sheet). `busy` = room code. */
export function useRoomJoin() {
  const [out, setOut] = useState<{ balance: number; price: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (code: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(code);
    try {
      await fn();
    } catch (e) {
      Alert.alert("Couldn't open the game", errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const join = (gameId: string, code: string, version?: number) =>
    run(code, async () => {
      const r = await joinRoom(gameId, code, version);
      if (r.kind === 'out') setOut({ balance: r.balance, price: r.price });
    });
  const spectate = (gameId: string, code: string, version?: number) => run(code, () => spectateRoom(gameId, code, version));

  const sheet = <OutOfCoinsSheet state={out} onClose={() => setOut(null)} />;
  return { join, spectate, busy, sheet };
}

// ---------- game invites ----------

export const inviteExpired = (data: NotificationData | null | undefined) => {
  const t = typeof data?.expiresAt === 'string' ? Date.parse(data.expiresAt) : NaN;
  return Number.isFinite(t) && t <= Date.now();
};

/** "@x invited you to play Orb Duel" -> "@x invited you to Orb Duel". */
export const inviteTitle = (body: string) => body.replace(/ invited you to play /, ' invited you to ');

let opening = false;

/**
 * A game_invite tapped (push, inbox, or the in-app banner): expired -> "Invite expired" + the game page;
 * else the play gate, then the player in that room. Out of coins -> the player screen, which gates
 * again and shows "Out of coins" itself.
 */
export async function openInvite(data: NotificationData | null | undefined) {
  const gameId = typeof data?.gameId === 'string' ? data.gameId : null;
  const code = typeof data?.roomCode === 'string' ? data.roomCode : null;
  if (!gameId) return;
  const gamePage = () => router.push({ pathname: '/discover/[id]', params: { id: gameId } });
  if (inviteExpired(data)) {
    showToast({ kind: 'info', icon: 'time-outline', title: 'Invite expired' });
    return gamePage();
  }
  if (!code) return gamePage();
  if (opening) return;
  opening = true;
  const version = typeof data?.version === 'number' ? data.version : undefined;
  try {
    if (data?.spectate === true) return await spectateRoom(gameId, code, version);
    const r = await joinRoom(gameId, code, version);
    // The player gates again on its own and shows "Out of coins" there.
    if (r.kind === 'out') router.push({ pathname: '/play/[id]', params: { id: gameId, version: String(r.target.version), ...roomParams(code, false) } });
  } catch (e) {
    Alert.alert("Couldn't open the game", errorMessage(e));
  } finally {
    opening = false;
  }
}
