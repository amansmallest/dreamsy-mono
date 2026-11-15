import { Ionicons } from '@expo/vector-icons';
import { Stack } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { api, type AppNotification } from '@/api';
import { isEarning, markAllRead, markRead, openNotificationTarget, setUnread, useNotificationsState } from '@/notifications';
import { usePaged } from '@/usePaged';
import { errorMessage, ink, radius } from '@/theme';
import { Button, Empty, Loading, PixelCoin, PixelSparkle, Pressy, Txt } from '@/ui';

/** Inbox: earnings, finished builds, family joins. Tap opens the game / group and marks it read. */
export default function NotificationsScreen() {
  const { unread } = useNotificationsState();
  const [marking, setMarking] = useState(false);
  const fetchPage = useCallback(async (cursor: string | null) => {
    const r = await api.notifications(cursor);
    if (!cursor) setUnread(r.unread);
    return { items: r.items, next: r.next };
  }, []);
  const { items, setItems, error, refreshing, loadingMore, refresh, loadMore } = usePaged('inbox', fetchPage, (n) => n.id);

  const open = (n: AppNotification) => {
    if (!n.read) {
      setItems((cur) => cur?.map((x) => (x.id === n.id ? { ...x, read: true } : x)) ?? cur);
      void markRead([n.id]);
    }
    openNotificationTarget(n.kind, n.data);
  };

  const allRead = async () => {
    if (marking) return;
    setMarking(true);
    try {
      await markAllRead();
      setItems((cur) => cur?.map((x) => ({ ...x, read: true })) ?? cur);
    } catch (e) {
      Alert.alert("Couldn't mark as read", errorMessage(e));
    } finally {
      setMarking(false);
    }
  };

  const anyUnread = unread > 0 || !!items?.some((n) => !n.read);

  return (
    <View style={styles.screen}>
      <Stack.Screen
        options={{
          title: 'Notifications',
          headerRight: () =>
            marking ? (
              <ActivityIndicator color={ink.accent} />
            ) : (
              <Pressable accessibilityRole="button" onPress={allRead} disabled={!anyUnread} hitSlop={10}>
                <Txt variant="label" color={anyUnread ? ink.accent : ink.faint}>
                  Mark all read
                </Txt>
              </Pressable>
            ),
        }}
      />
      {items === null ? (
        <Loading />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(n) => n.id}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={ink.accent} />}
          onEndReached={loadMore}
          onEndReachedThreshold={0.4}
          renderItem={({ item }) => <Row n={item} onPress={() => open(item)} />}
          ListEmptyComponent={
            <Empty
              title={error ? "Couldn't load notifications" : 'Nothing yet'}
              body={error ?? 'When someone plays or remixes your games, or a build finishes, it shows up here.'}
              action={error ? <Button label="Try again" size="sm" variant="outline" onPress={refresh} /> : undefined}
            />
          }
          ListFooterComponent={loadingMore ? <ActivityIndicator color={ink.accent} style={styles.more} /> : undefined}
        />
      )}
    </View>
  );
}

function Row({ n, onPress }: { n: AppNotification; onPress: () => void }) {
  return (
    <Pressy accessibilityRole="button" accessibilityLabel={`${n.read ? '' : 'Unread. '}${n.title}. ${n.body}`} onPress={onPress} haptic={false} style={[styles.row, !n.read && styles.rowUnread]}>
      <KindIcon kind={n.kind} onWash={!n.read} />
      <View style={styles.main}>
        <View style={styles.titleRow}>
          <Txt variant="heading" color={n.read ? ink.fg : ink.navy} numberOfLines={1} style={styles.flex}>
            {n.title}
          </Txt>
          <Txt variant="meta" color={ink.faint}>
            {ago(n.createdAt)}
          </Txt>
        </View>
        <Txt variant="body" muted numberOfLines={2}>
          {n.body}
        </Txt>
      </View>
      {!n.read && <View style={styles.dot} />}
    </Pressy>
  );
}

/** Coin for money in, sparkle for a finished build, people for family. */
function KindIcon({ kind, onWash }: { kind: string; onWash: boolean }) {
  if (isEarning(kind)) {
    return (
      <View style={[styles.icon, { backgroundColor: ink.accent }]}>
        <PixelCoin size={18} color={ink.accentFg} />
      </View>
    );
  }
  return (
    <View style={[styles.icon, { backgroundColor: onWash ? ink.card : ink.wash }]}>
      {kind === 'build_done' ? (
        <PixelSparkle size={18} />
      ) : (
        <Ionicons name={kind === 'group_join' ? 'people' : 'notifications'} size={20} color={ink.navy} />
      )}
    </View>
  );
}

/** "now", "5m", "3h", "2d", else "Nov 3". */
function ago(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)}d`;
  return new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: ink.bg },
  list: { padding: 16, paddingTop: 4, gap: 8, paddingBottom: 40 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: radius.lg, backgroundColor: ink.card },
  rowUnread: { backgroundColor: ink.wash },
  icon: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  main: { flex: 1, gap: 2 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  flex: { flex: 1 },
  dot: { width: 9, height: 9, borderRadius: 5, backgroundColor: ink.accent },
  more: { marginVertical: 16 },
});
