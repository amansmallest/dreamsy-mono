import { useFocusEffect } from 'expo-router';
import { useCallback } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { LedgerEntry } from '@/api';
import { useAuth } from '@/auth';
import { ProfileView } from '@/components/ProfileView';
import { ink } from '@/theme';
import { Card, Header, InkButton, Sparkle, Txt } from '@/ui';
import { useWallet } from '@/wallet';

const KIND_LABEL: Record<string, string> = {
  starter_grant: 'Welcome Stars',
  purchase: 'Purchase',
  sale: 'Sale',
};

const describe = (e: LedgerEntry) => {
  const kind = KIND_LABEL[e.kind] ?? e.kind;
  return e.itemId ? `${kind} · ${e.itemId}` : kind;
};

/** Own profile: avatar hero + level, games, Stars wallet + recent ledger. */
export default function ProfileScreen() {
  const { user, signOut } = useAuth();
  const { wallet, recent, error, refresh } = useWallet();

  // Refetch whenever the tab comes into view; in-game purchases also trigger a refetch (walletChanged).
  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  if (!user) return null;

  const confirmSignOut = () =>
    Alert.alert('Sign out?', undefined, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: () => void signOut() },
    ]);

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <Header title="Me" subtitle="lvl up ↑" />
      <ProfileView
        userId={user.id}
        onRefresh={refresh}
        header={
          <Card style={styles.wallet}>
            <View style={styles.walletTop}>
              <Sparkle size={18} />
              <Txt variant="label" muted>
                Stars
              </Txt>
            </View>
            <Txt variant="display">{wallet ? wallet.balance : '–'}</Txt>
            {error && (
              <Txt variant="meta" color={ink.danger}>
                {error}
              </Txt>
            )}
            {recent.slice(0, 5).map((item, i) => (
              <View key={`${item.createdAt}-${i}`} style={styles.row}>
                <View style={styles.rowMain}>
                  <Txt variant="body" numberOfLines={1}>
                    {describe(item)}
                  </Txt>
                  <Txt variant="meta" muted>
                    {new Date(item.createdAt).toLocaleDateString()}
                  </Txt>
                </View>
                <Txt variant="heading" color={item.delta < 0 ? ink.fg : ink.ok}>
                  {item.delta > 0 ? '+' : ''}
                  {item.delta}
                </Txt>
              </View>
            ))}
          </Card>
        }
        footer={<InkButton label="Sign out" variant="outline" size="md" icon="log-out-outline" onPress={confirmSignOut} style={styles.signOut} />}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: ink.bg },
  wallet: { padding: 16, gap: 6 },
  walletTop: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderTopWidth: 1.5, borderTopColor: ink.border },
  rowMain: { flex: 1, gap: 1 },
  signOut: { marginTop: 12 },
});
