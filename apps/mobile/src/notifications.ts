// Notifications inbox state: unread count (polled every 30 s while the app is in the foreground,
// and on focus of screens with a bell), the "You got paid" toast when new earnings arrive, and
// where tapping a notification (in the inbox or a push) goes.
//
// Older APIs have no /v1/me/notifications: the first 404 marks the feature unavailable and every
// bell hides.

import { router } from 'expo-router';
import { useEffect, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { api, ApiError, type AppNotification, type NotificationData } from './api';
import { formatCoins, formatUsd } from './coins';
import { showToast } from './toast';
import { walletChanged } from './wallet';

export const POLL_MS = 30_000;
const EARNING_KINDS = new Set(['play_earning', 'remix_earning', 'sale', 'royalty']);
export const isEarning = (kind: string) => EARNING_KINDS.has(kind);

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
      if (before !== null && unread > before) await announceNewest();
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) set({ available: false, unread: 0 });
      // Network blips: keep the last count.
    } finally {
      inflight = null;
    }
  })());
}

async function announceNewest() {
  const r = await api.notifications(null, 1).catch(() => null);
  const n = r?.items[0];
  if (!n || n.read || !isEarning(n.kind)) return;
  walletChanged();
  showPaidToast(n);
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

/** Where a notification leads: build_done -> the workspace; other game kinds -> game page; groups. */
export function openNotificationTarget(kind: string | undefined, data: NotificationData | null | undefined) {
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
