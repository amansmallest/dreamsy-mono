// Notifications inbox state: unread count (polled every 30 s while the app is in the foreground,
// and on focus of screens with a bell), the "You got paid" toast when new earnings arrive, the
// "@x invited you to Orb Duel · Join" banner when a friend's game invite arrives, and where tapping a
// notification (in the inbox or a push) goes.
//
// Older APIs have no /v1/me/notifications: the first 404 marks the feature unavailable and every
// bell hides.

import { router } from 'expo-router';
import { useEffect, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { api, ApiError, type AppNotification, type NotificationData } from './api';
import { formatCoins, formatUsd } from './coins';
import { inviteExpired, inviteTitle, openInvite, refreshFriends, resetFriends } from './friends';
import { showToast } from './toast';
import { walletChanged } from './wallet';

export const POLL_MS = 30_000;
const EARNING_KINDS = new Set(['play_earning', 'remix_earning', 'sale', 'royalty']);
export const isEarning = (kind: string) => EARNING_KINDS.has(kind);
export const isFriendKind = (kind: string) => kind === 'friend_request' || kind === 'friend_accept';

type State = { available: boolean | null; unread: number };
let state: State = { available: null, unread: 0 };
/** Last unread count seen; null until the first answer after sign-in (no toast for old news). */
let seen: number | null = null;
const listeners = new Set<() => void>();
const badgeListeners = new Set<(n: number) => void>();

function set(next: Partial<State>) {
  const merged = { ...state, ...next };
  if (merged.available === state.available && merged.unread === state.unread) return;
  state = merged;
  for (const l of listeners) l();
  for (const b of badgeListeners) b(state.unread);
}

/** Push module hooks this to mirror unread onto the app icon badge. */
export function onUnreadChange(fn: (n: number) => void) {
  badgeListeners.add(fn);
  return () => void badgeListeners.delete(fn);
}

export function useNotificationsState(): State {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

/** After POST /read, or anything else that knows the new count. */
export function setUnread(n: number) {
  seen = n;
  set({ unread: n, available: true });
}

/** Signed out: forget everything (the next account starts fresh). */
export function resetNotifications() {
  seen = null;
  inflight = null;
  bannered.clear();
  resetFriends();
  set({ unread: 0, available: null });
}

let inflight: Promise<void> | null = null;

/** GET /unread; toasts if it went up and the newest item is money in. Deduped while in flight. */
export function refreshUnread(): Promise<void> {
  if (state.available === false) return Promise.resolve();
  return (inflight ??= (async () => {
    try {
      const { unread } = await api.unreadCount();
      const before = seen;
      seen = unread;
      set({ unread, available: true });
      if (before !== null && unread > before) await announceNewest(unread - before);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) set({ available: false, unread: 0 });
      // Network blips: keep the last count.
    } finally {
      inflight = null;
    }
  })());
}

/** Invites already shown as a banner (the poller and a foreground push can both see one). */
const bannered = new Set<string>();

/** The `fresh` newest items: a live game invite wins (banner), else money in on the newest (toast). */
async function announceNewest(fresh: number) {
  const r = await api.notifications(null, Math.min(5, Math.max(1, fresh))).catch(() => null);
  const items = r?.items ?? [];
  if (items.some((n) => isFriendKind(n.kind))) void refreshFriends();
  const invite = items.find((n) => !n.read && n.kind === 'game_invite' && !inviteExpired(n.data) && !bannered.has(n.id));
  if (invite) return showInviteBanner(invite);
  const n = items[0];
  if (!n || n.read || !isEarning(n.kind)) return;
  walletChanged();
  showPaidToast(n);
}

/** "@x invited you to Orb Duel · Join"; tapping joins (play gate first) and marks it read. */
export function showInviteBanner(n: Pick<AppNotification, 'id' | 'body' | 'data'>) {
  bannered.add(n.id);
  showToast({
    kind: 'invite',
    title: inviteTitle(n.body),
    action: n.data?.spectate === true ? 'Watch' : 'Join',
    onPress: () => {
      void markRead([n.id]);
      void openInvite(n.data);
    },
  });
}

export function showPaidToast(n: Pick<AppNotification, 'body' | 'data'>) {
  const coins = typeof n.data?.coins === 'number' ? n.data.coins : null;
  showToast({
    kind: 'paid',
    title: 'You got paid',
    detail: coins !== null ? `+${formatCoins(coins, true)} · ${formatUsd(coins)}` : n.body,
    onPress: () => router.push('/notifications'),
  });
}

/**
 * Poll while signed in and the app is active: now, every 30 s, and whenever the app comes back to
 * the foreground. Mounted once in the root layout.
 */
export function useNotificationsPoller(enabled: boolean) {
  useEffect(() => {
    if (!enabled) {
      resetNotifications();
      return;
    }
    void refreshUnread();
    const t = setInterval(() => {
      if (AppState.currentState === 'active') void refreshUnread();
    }, POLL_MS);
    const sub = AppState.addEventListener('change', (s) => s === 'active' && void refreshUnread());
    return () => {
      clearInterval(t);
      sub.remove();
    };
  }, [enabled]);
}

/**
 * Where a notification leads: game_invite -> that room (play gate first; expired -> game page);
 * friend_* -> Friends; build_done -> the workspace; other game kinds -> game page; groups.
 */
export function openNotificationTarget(kind: string | undefined, data: NotificationData | null | undefined) {
  if (kind === 'game_invite') return void openInvite(data);
  if (kind && isFriendKind(kind)) return void router.push('/friends');
  const gameId = typeof data?.gameId === 'string' ? data.gameId : null;
  const groupId = typeof data?.groupId === 'string' ? data.groupId : null;
  if (gameId && kind === 'build_done') router.push({ pathname: '/game/[id]', params: { id: gameId } });
  else if (gameId) router.push({ pathname: '/discover/[id]', params: { id: gameId } });
  else if (groupId) router.push({ pathname: '/groups/[id]', params: { id: groupId } });
  else router.push('/notifications');
}

/** Mark some read; updates the badge from the server's answer. */
export async function markRead(ids: string[]) {
  if (!ids.length) return;
  try {
    const r = await api.markRead({ ids });
    setUnread(r.unread);
  } catch {}
}

export async function markAllRead() {
  const r = await api.markRead({ all: true });
  setUnread(r.unread);
}
