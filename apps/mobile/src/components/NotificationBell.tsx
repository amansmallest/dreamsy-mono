import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback } from 'react';
import { StyleSheet, View } from 'react-native';
import { refreshUnread, useNotificationsState } from '../notifications';
import { ink } from '../theme';
import { Pressy, Txt } from '../ui';

/**
 * Header bell with an unread badge; opens the inbox. Hidden on APIs without notifications.
 * `ring` = the header's background, so the badge reads as cut out of it.
 */
export function NotificationBell({ size = 36, ring = ink.bg }: { size?: number; ring?: string }) {
  const { available, unread } = useNotificationsState();
  useFocusEffect(
    useCallback(() => {
      void refreshUnread();
    }, []),
  );
  if (available !== true) return null;
  const label = unread > 0 ? `Notifications, ${unread} unread` : 'Notifications';
  return (
    <Pressy accessibilityRole="button" accessibilityLabel={label} onPress={() => router.push('/notifications')} hitSlop={8} style={[styles.bell, { width: size, height: size }]}>
      <Ionicons name={unread > 0 ? 'notifications' : 'notifications-outline'} size={23} color={ink.fg} />
      {unread > 0 && (
        <View style={[styles.badge, { borderColor: ring }]}>
          <Txt variant="label" color={ink.accentFg} style={styles.count}>
            {unread > 99 ? '99+' : unread}
          </Txt>
        </View>
      )}
    </Pressy>
  );
}

const styles = StyleSheet.create({
  bell: { alignItems: 'center', justifyContent: 'center' },
  badge: {
    position: 'absolute',
    top: 2,
    right: 0,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 5,
    borderRadius: 9,
    backgroundColor: ink.accent,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  count: { fontSize: 10, lineHeight: 12 },
});
