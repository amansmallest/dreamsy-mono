import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActionSheetIOS, Alert, Platform, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { LedgerEntry } from '@/api';
import { useAuth } from '@/auth';
import { formatCoins, formatUsd } from '@/coins';
import { EarningsCard } from '@/components/EarningsCard';
import { NotificationBell } from '@/components/NotificationBell';
import { ProfileView } from '@/components/ProfileView';
import { useFriendsAvailable, useFriendsState } from '@/friends';
import { unregisterPush } from '@/push';
import { hairline, ink, radius } from '@/theme';
import { IconButton, PixelCoin, Pressy, Txt, type IconName } from '@/ui';
import { useWallet } from '@/wallet';

const KIND_LABEL: Record<string, string> = {
  starter_grant: 'Welcome coins',
  grant: 'Free coins',
  purchase: 'Purchase',
  sale: 'Sale',
  play: 'Played a game',
  play_earning: 'Someone played your game',
  platform_fee: 'Dreamsy fee',
  create: 'Created a game',
  create_refund: 'Build refund',
  remix: 'Remixed a game',
  remix_earning: 'Someone remixed your game',
  royalty: 'Spin-off royalty',
};

const describe = (e: LedgerEntry) => {
  const kind = KIND_LABEL[e.kind] ?? e.kind.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  return e.itemId ? `${kind} · ${e.itemId}` : kind;
};

/** Me: handle bar with a menu, Instagram profile, coins wallet, creator earnings. */
export default function ProfileScreen() {
  const { user, signOut } = useAuth();
  const { wallet, recent, error, refresh, live } = useWallet();
  const [open, setOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const hasFriends = useFriendsAvailable();
  const requests = useFriendsState().data?.incoming.length ?? 0;
  const pull = useCallback(async () => {
    setReloadKey((k) => k + 1);
    await refresh();
  }, [refresh]);

  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  if (!user) return null;

  const confirmSignOut = () =>
    Alert.alert('Sign out?', undefined, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: () => void unregisterPush().finally(() => signOut()) },
    ]);

  const menu = () => {
    const items = ['Family & friends', 'Edit avatar', 'Scan a game', 'Sign out'];
    const pick = (i: number) => (i === 0 ? router.push('/groups') : i === 1 ? router.push('/avatar') : i === 2 ? router.push('/scan') : confirmSignOut());
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions({ options: [...items, 'Cancel'], cancelButtonIndex: 4, destructiveButtonIndex: 3 }, (i) => i < 4 && pick(i));
    } else {
      Alert.alert('Menu', undefined, [...items.map((t, i) => ({ text: t, onPress: () => pick(i) })), { text: 'Cancel', style: 'cancel' as const }]);
    }
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.bar}>
        <Txt variant="title" numberOfLines={1} style={styles.handle}>
          {user.handle}
        </Txt>
        <View style={styles.barRight}>
          <NotificationBell size={40} ring={ink.card} />
          <IconButton icon="menu-outline" label="Menu" onPress={menu} />
        </View>
      </View>
      <ProfileView
        userId={user.id}
        onRefresh={pull}
        footer={
          <View style={styles.settings}>
            {hasFriends && <Row icon="person-add-outline" label="Friends" count={requests} onPress={() => router.push('/friends')} />}
            <Row icon="people-outline" label="Family & friends" onPress={() => router.push('/groups')} />
            <Row icon="person-circle-outline" label="Edit avatar" onPress={() => router.push('/avatar')} />
            <Row icon="qr-code-outline" label="Scan a game" onPress={() => router.push('/scan')} />
            <Row icon="log-out-outline" label="Sign out" danger last onPress={confirmSignOut} />
          </View>
        }
        header={
          <View style={styles.cards}>
          <Pressable onPress={() => setOpen((o) => !o)} style={styles.wallet} accessibilityRole="button" accessibilityLabel="Coins">
            <View style={styles.walletRow}>
              <View style={styles.star}>
                <PixelCoin size={14} color={ink.accentFg} />
              </View>
              <View style={styles.flex}>
                <Txt variant="pixel">{wallet ? formatCoins(wallet.balance, true) : '– coins'}</Txt>
                {wallet && live && (
                  <Txt variant="meta" muted>
                    {formatUsd(wallet.balance, wallet.usd)}
                  </Txt>
                )}
                {error && (
                  <Txt variant="meta" color={ink.danger}>
                    {error}
                  </Txt>
                )}
              </View>
              {recent.length > 0 && <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={18} color={ink.muted} />}
            </View>
            {open &&
              recent.slice(0, 6).map((item, i) => (
                <View key={`${item.createdAt}-${i}`} style={styles.ledger}>
                  <View style={styles.flex}>
                    <Txt variant="body" numberOfLines={1}>
                      {describe(item)}
                    </Txt>
                    <Txt variant="meta" muted>
                      {new Date(item.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                    </Txt>
                  </View>
                  <Txt variant="heading" color={item.delta < 0 ? ink.fg : ink.ok}>
                    {item.delta > 0 ? '+' : ''}
                    {formatCoins(item.delta)}
                  </Txt>
                </View>
              ))}
          </Pressable>
          <EarningsCard reloadKey={reloadKey} />
          </View>
        }
      />
    </SafeAreaView>
  );
}

function Row({ icon, label, onPress, danger, last, count }: { icon: IconName; label: string; onPress: () => void; danger?: boolean; last?: boolean; count?: number }) {
  const color = danger ? ink.danger : ink.fg;
  return (
    <Pressy accessibilityRole="button" onPress={onPress} haptic={false} style={[styles.row, !last && styles.rowLine]}>
      <Ionicons name={icon} size={20} color={color} />
      <Txt variant="heading" color={color} style={styles.flex}>
        {label}
      </Txt>
      {!!count && (
        <View style={styles.count}>
          <Txt variant="label" color={ink.accentFg} style={styles.countText}>
            {count > 99 ? '99+' : count}
          </Txt>
        </View>
      )}
      {!danger && <Ionicons name="chevron-forward" size={16} color={ink.faint} />}
    </Pressy>
  );
}

const styles = StyleSheet.create({
  settings: { marginTop: 28, borderRadius: radius.lg, backgroundColor: ink.bg, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, height: 52 },
  count: { minWidth: 20, height: 20, paddingHorizontal: 6, borderRadius: 10, backgroundColor: ink.accent, alignItems: 'center', justifyContent: 'center' },
  countText: { fontSize: 11, lineHeight: 13 },
  rowLine: { borderBottomWidth: hairline, borderBottomColor: ink.border },
  screen: { flex: 1, backgroundColor: ink.card },
  bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, height: 48 },
  handle: { flex: 1, fontSize: 22 },
  barRight: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  cards: { gap: 12 },
  wallet: { backgroundColor: ink.wash, borderRadius: radius.lg, padding: 12, gap: 8 },
  walletRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  star: { width: 32, height: 32, borderRadius: 16, backgroundColor: ink.accent, alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1 },
  ledger: { flexDirection: 'row', alignItems: 'center', paddingTop: 8, borderTopWidth: 1, borderTopColor: ink.sky },
});
