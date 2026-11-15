// Remote push via expo-notifications: permission + Expo push token after sign-in (POST
// /v1/me/push-tokens), foreground presentation, and opening the right screen when a push is tapped.
//
// Degrades silently: Expo Go on Android has no remote push (SDK 53+), a dev client built before
// expo-notifications was added has no native module, and without an EAS projectId Expo can't mint a
// token. In all of those the inbox still works by polling.

import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { api } from './api';
import { isEarning, markRead, onUnreadChange, openNotificationTarget, refreshUnread } from './notifications';
import { isExpoGo } from './runtime';

type NotificationsModule = typeof import('expo-notifications');

let mod: NotificationsModule | null | undefined;

/** The module, or null where push can't work. Required lazily so a missing native module can't crash startup. */
function notifications(): NotificationsModule | null {
  if (mod !== undefined) return mod;
  if (Platform.OS === 'web' || (isExpoGo && Platform.OS === 'android')) return (mod = null);
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('expo-notifications') as NotificationsModule;
  } catch {
    mod = null;
  }
  return mod;
}

const projectId = (): string | undefined => {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  return extra?.eas?.projectId ?? Constants.easConfig?.projectId ?? undefined;
};

let handlersInstalled = false;

/**
 * Once, at startup: how pushes show while the app is open, and the tap handler. Earnings in the
 * foreground skip the system banner because the in-app "You got paid" toast covers them.
 */
export function installPushHandlers(): () => void {
  const N = notifications();
  if (!N || handlersInstalled) return () => {};
  handlersInstalled = true;
  try {
    N.setNotificationHandler({
      handleNotification: async (n) => {
        const kind = (n.request.content.data as { kind?: unknown } | null)?.kind;
        const earning = typeof kind === 'string' && isEarning(kind);
        return { shouldShowBanner: !earning, shouldShowList: true, shouldPlaySound: !earning, shouldSetBadge: true };
      },
    });
    const received = N.addNotificationReceivedListener(() => void refreshUnread());
    const tapped = N.addNotificationResponseReceivedListener((r) => openFromPush(r.notification.request.identifier, r.notification.request.content.data));
    const badge = onUnreadChange((n) => void N.setBadgeCountAsync(n).catch(() => {}));
    return () => {
      received.remove();
      tapped.remove();
      badge();
      handlersInstalled = false;
    };
  } catch (e) {
    console.warn('[push] handlers unavailable', e);
    handlersInstalled = false;
    return () => {};
  }
}

/** A push that launched the app from a cold start; call once the signed-in stack is mounted. */
export async function openLaunchPush() {
  const N = notifications();
  if (!N) return;
  try {
    const r = await N.getLastNotificationResponseAsync();
    if (!r) return;
    await N.clearLastNotificationResponseAsync().catch(() => {});
    openFromPush(r.notification.request.identifier, r.notification.request.content.data);
  } catch {}
}

/** The launch response can also reach the listener; open each push once. */
const opened = new Set<string>();

function openFromPush(id: string, raw: unknown) {
  if (opened.has(id)) return;
  opened.add(id);
  const data = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const kind = typeof data.kind === 'string' ? data.kind : undefined;
  if (typeof data.notificationId === 'string') void markRead([data.notificationId]);
  openNotificationTarget(kind, data);
}

let registered: string | null = null;

/** After sign-in: ask permission once, get an Expo push token, hand it to the API. Never throws. */
export async function registerPush() {
  const N = notifications();
  if (!N) return;
  try {
    if (Platform.OS === 'android') {
      await N.setNotificationChannelAsync('default', { name: 'Default', importance: N.AndroidImportance.HIGH });
    }
    let perm = await N.getPermissionsAsync();
    if (!perm.granted && perm.canAskAgain) perm = await N.requestPermissionsAsync();
    if (!perm.granted) return;
    const id = projectId();
    const { data: token } = await N.getExpoPushTokenAsync(id ? { projectId: id } : undefined);
    if (!token || token === registered) return;
    await api.addPushToken(token, Platform.OS === 'android' ? 'android' : 'ios');
    registered = token;
  } catch (e) {
    // No projectId, simulator, older API (404), offline: polling still covers the inbox.
    console.log('[push] not registered:', e instanceof Error ? e.message : e);
  }
}

/** Before signing out, while the bearer token still works. Never throws. */
export async function unregisterPush() {
  const token = registered;
  registered = null;
  if (!token) return;
  await api.removePushToken(token).catch(() => {});
  await notifications()?.setBadgeCountAsync(0).catch(() => {});
}
