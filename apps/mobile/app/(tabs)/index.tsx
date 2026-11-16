import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActionSheetIOS, Alert, FlatList, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api, type FeedGame, type FeedTab } from '@/api';
import { useAuth } from '@/auth';
import { formatCoins, formatUsd } from '@/coins';
import { Avatar } from '@/components/Avatar';
import { FeaturedGame, GameCard } from '@/components/GameCard';
import { NotificationBell } from '@/components/NotificationBell';
import { useFriendsAvailable, useFriendsState, useRoomJoin } from '@/friends';
import { LiveHeader, LivePeopleList, useLive } from '@/live';
import { InstallBanner } from '@/install';
import { canScan, useAppDimensions } from '@/platform';
import { errorMessage, ink, radius } from '@/theme';
import { Button, Empty, IconButton, PixelCoin, PixelSparkle, Pressy, Skeleton, Txt } from '@/ui';
import { useWallet } from '@/wallet';

type ShelfKey = FeedTab | 'multiplayer';
const SHELVES: { key: ShelfKey; tab: FeedTab; title: string; multiplayer?: boolean }[] = [
  { key: 'trending', tab: 'trending', title: 'Trending' },
  { key: 'multiplayer', tab: 'trending', title: 'Multiplayer', multiplayer: true },
  { key: 'following', tab: 'following', title: 'From creators you follow' },
  { key: 'top', tab: 'top', title: 'Most liked' },
  { key: 'new', tab: 'new', title: 'Just released' },
];
const PER_SHELF = 12;
const PAD = 16;

type Shelves = Partial<Record<ShelfKey, FeedGame[]>>;

/** Home: a game marketplace. Featured banner, then shelves of games that scroll sideways. */
export default function HomeScreen() {
  const { user } = useAuth();
  const { wallet, live, refresh: refreshWallet } = useWallet();
  const { width } = useAppDimensions();
  const [shelves, setShelves] = useState<Shelves | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const results = await Promise.allSettled(SHELVES.map((s) => api.feed(s.tab, null, PER_SHELF, { multiplayer: s.multiplayer })));
    const next: Shelves = {};
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') next[SHELVES[i]!.key] = r.value.games;
    });
    const failed = results.find((r) => r.status === 'rejected');
    setError(failed && Object.keys(next).length === 0 ? errorMessage((failed as PromiseRejectedResult).reason) : null);
    setShelves(next);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useFocusEffect(
    useCallback(() => {
      if (user) void refreshWallet();
    }, [user, refreshWallet]),
  );

  const pull = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const trending = shelves?.trending ?? [];
  const featured = trending[0];
  const card = Math.round((width - PAD * 2 - 12 * 2) / 2.6);
  const nothing = shelves !== null && SHELVES.every((s) => !shelves[s.key]?.length);

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.bar}>
        <Pressable onPress={() => router.navigate('/profile')} hitSlop={6} accessibilityLabel="Profile">
          {user ? <Avatar user={user} size={34} /> : <View style={styles.avatarStub} />}
        </Pressable>
        <View style={styles.logo}>
          <PixelSparkle size={14} />
          <Txt variant="title" style={styles.word}>
            dreamsy
          </Txt>
        </View>
        <View style={styles.barRight}>
          {wallet && (
            <Pressy
              onPress={() => router.navigate('/market')}
              style={styles.coins}
              accessibilityLabel={`${wallet.balance.toLocaleString()} coins${live ? `, ${formatUsd(wallet.balance, wallet.usd)}` : ''}`}
            >
              <PixelCoin size={12} color={ink.accent} />
              <View>
                <Txt variant="label" color={ink.navy} style={styles.coinsAmount}>
                  {formatCoins(wallet.balance, true)}
                </Txt>
                {live && (
                  <Txt variant="meta" muted style={styles.coinsUsd}>
                    {formatUsd(wallet.balance, wallet.usd)}
                  </Txt>
                )}
              </View>
            </Pressy>
          )}
          <NotificationBell />
          <PeopleButton />
          {canScan && <IconButton icon="qr-code-outline" label="Scan a game QR code" size={36} onPress={() => router.push('/scan')} />}
        </View>
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={pull} tintColor={ink.accent} />}
      >
        {/* Web app only, after the first game + Welcome (onboardedAt set). */}
        <InstallBanner ready={!!user && user.onboardedAt !== null} />
        <Pressy onPress={() => router.navigate('/search')} haptic={false} style={styles.search} accessibilityRole="search">
          <Ionicons name="search" size={17} color={ink.muted} />
          <Txt variant="body" color={ink.faint}>
            Search games
          </Txt>
        </Pressy>

        {shelves === null ? (
          <HomeSkeleton width={width} card={card} />
        ) : nothing ? (
          <Empty
            title={error ? "Couldn't load games" : 'No games yet'}
            body={error ?? 'Make the first one.'}
            action={error ? <Button label="Try again" size="sm" variant="outline" onPress={load} /> : <Button label="Make a game" size="md" onPress={() => router.navigate('/create')} />}
          />
        ) : (
          <>
            {featured && (
              <View style={styles.pad}>
                <FeaturedGame game={featured} width={width - PAD * 2} />
              </View>
            )}
            <LiveNow />
            {SHELVES.map((s) => {
              const games = s.key === 'trending' ? trending.slice(1) : shelves[s.key];
              if (!games?.length) return null;
              return (
                <Shelf key={s.key} title={s.title} tab={s.tab} multiplayer={s.multiplayer} games={games} card={card}
                  subtitle={s.multiplayer ? 'Quick match or a room code with family' : undefined} />
              );
            })}
            <CreateBanner />
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

/**
 * Header people icon. With friends on this API: a small menu (Friends / Family & friends) and a dot
 * for pending friend requests; without: straight to groups, as before.
 */
function PeopleButton() {
  const hasFriends = useFriendsAvailable();
  const requests = useFriendsState().data?.incoming.length ?? 0;
  const open = () => {
    if (!hasFriends) return router.push('/groups');
    const items = [requests ? `Friends (${requests} new)` : 'Friends', 'Family & friends'];
    const pick = (i: number) => (i === 0 ? router.push('/friends') : i === 1 ? router.push('/groups') : undefined);
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions({ options: [...items, 'Cancel'], cancelButtonIndex: 2 }, pick);
    } else {
      Alert.alert('People', undefined, [...items.map((t, i) => ({ text: t, onPress: () => pick(i) })), { text: 'Cancel', style: 'cancel' as const }]);
    }
  };
  return (
    <IconButton label={hasFriends ? `Friends and family${requests ? `, ${requests} friend requests` : ''}` : 'Family & friends'} size={36} onPress={open}>
      <Ionicons name={requests ? 'people' : 'people-outline'} size={24} color={ink.fg} />
      {requests > 0 && <View style={styles.peopleDot} />}
    </IconButton>
  );
}

function Shelf({ title, subtitle, tab, multiplayer, games, card }: {
  title: string; subtitle?: string; tab: FeedTab; multiplayer?: boolean; games: FeedGame[]; card: number;
}) {
  return (
    <View style={styles.shelf}>
      <View style={styles.shelfHead}>
        <View style={styles.flexShrink}>
          <View style={styles.shelfTitleRow}>
            {multiplayer && <Ionicons name="people" size={17} color={ink.navy} />}
            <Txt variant="pixel" style={styles.shelfTitle}>
              {title}
            </Txt>
          </View>
          {subtitle && (
            <Txt variant="meta" muted numberOfLines={1}>
              {subtitle}
            </Txt>
          )}
        </View>
        <Pressable
          hitSlop={10}
          onPress={() => router.navigate({ pathname: '/search', params: { sort: tab, multiplayer: multiplayer ? '1' : '0' } })}
          style={styles.seeAll}
        >
          <Txt variant="label" color={ink.accent}>
            See all
          </Txt>
          <Ionicons name="chevron-forward" size={14} color={ink.accent} />
        </Pressable>
      </View>
      <FlatList
        horizontal
        data={games}
        keyExtractor={(g) => g.id}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.shelfRow}
        renderItem={({ item }) => <GameCard game={item} width={card} />}
      />
    </View>
  );
}

/** "Live now": N online + people in games (Join / Spectate). Hidden when nobody is playing or on older APIs. */
function LiveNow() {
  const { available, data } = useLive();
  const { join, spectate, busy, sheet } = useRoomJoin();
  if (available !== true || !data?.playing.length) return null;
  return (
    <View style={styles.shelf}>
      <LiveHeader online={data.online} style={styles.pad} compactCount />
      <LivePeopleList
        playing={data.playing}
        busy={busy}
        onJoin={(p) => void join(p.gameId, p.roomCode)}
        onSpectate={(p) => void spectate(p.gameId, p.roomCode)}
        padding={PAD}
      />
      {sheet}
    </View>
  );
}

/** Closing card: the way into Create. */
function CreateBanner() {
  return (
    <Pressy onPress={() => router.navigate('/create')} haptic={false} style={styles.create}>
      <View style={styles.createIcon}>
        <Ionicons name="add" size={22} color={ink.accentFg} />
      </View>
      <View style={styles.flex}>
        <Txt variant="heading" color={ink.navy}>
          Make your own game
        </Txt>
        <Txt variant="meta" color={ink.navy}>
          Describe it. Dreamsy builds it.
        </Txt>
      </View>
      <Ionicons name="chevron-forward" size={18} color={ink.navy} />
    </Pressy>
  );
}

function HomeSkeleton({ width, card }: { width: number; card: number }) {
  return (
    <View>
      <Skeleton style={{ marginHorizontal: PAD, height: Math.round((width - PAD * 2) * 0.62), borderRadius: radius.xl }} />
      {[0, 1].map((i) => (
        <View key={i} style={styles.shelf}>
          <Skeleton style={{ marginHorizontal: PAD, width: 120, height: 14, borderRadius: 7 }} />
          <View style={styles.shelfRow}>
            {[0, 1, 2].map((j) => (
              <Skeleton key={j} style={{ width: card, height: card, borderRadius: radius.md }} />
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: ink.bg },
  bar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: PAD, height: 52, gap: 10 },
  avatarStub: { width: 34, height: 34, borderRadius: 17, backgroundColor: ink.sky },
  logo: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 },
  word: { fontSize: 22, letterSpacing: -1, color: ink.navy },
  barRight: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  coins: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 36, paddingLeft: 9, paddingRight: 11, borderRadius: radius.pill, backgroundColor: ink.card },
  coinsAmount: { fontSize: 12, lineHeight: 14 },
  coinsUsd: { fontSize: 10, lineHeight: 12 },
  content: { paddingBottom: 32 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: PAD, marginTop: 4, marginBottom: 16, paddingHorizontal: 14, height: 44, borderRadius: radius.md, backgroundColor: ink.card },
  pad: { paddingHorizontal: PAD },
  shelf: { marginTop: 26, gap: 12 },
  shelfHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: PAD },
  shelfTitle: { fontSize: 18 },
  shelfTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  flexShrink: { flexShrink: 1 },
  seeAll: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  shelfRow: { flexDirection: 'row', gap: 12, paddingHorizontal: PAD },
  create: { flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: PAD, marginTop: 30, padding: 16, borderRadius: radius.lg, backgroundColor: ink.wash },
  createIcon: { width: 40, height: 40, borderRadius: radius.sm, backgroundColor: ink.accent, alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1 },
  peopleDot: { position: 'absolute', top: 5, right: 3, width: 10, height: 10, borderRadius: 5, backgroundColor: ink.accent, borderWidth: 2, borderColor: ink.bg },
});
