import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api, type FeedGame, type FeedTab } from '@/api';
import { useAuth } from '@/auth';
import { Avatar } from '@/components/Avatar';
import { GameCard } from '@/components/GameCard';
import { ink } from '@/theme';
import { Empty, Field, Header, Loading, Pills, Txt } from '@/ui';
import { usePaged } from '@/usePaged';

const TABS: { value: FeedTab; label: string }[] = [
  { value: 'trending', label: 'Hot' },
  { value: 'new', label: 'New' },
  { value: 'top', label: 'Top' },
  { value: 'following', label: 'Following' },
];

const idOf = (g: FeedGame) => g.id;

/** Home: feed tabs (GET /v1/feed) and search (GET /v1/search). */
export default function HomeScreen() {
  const { user } = useAuth();
  const [tab, setTab] = useState<FeedTab>('trending');
  const [query, setQuery] = useState('');
  const q = useDebounced(query.trim(), 300);
  const searching = q.length > 0;

  const fetchPage = useCallback(
    async (cursor: string | null) => {
      const r = searching ? await api.search(q, cursor) : await api.feed(tab, cursor);
      return { items: r.games, next: r.next };
    },
    [searching, q, tab],
  );
  const list = usePaged(searching ? `search:${q}` : `feed:${tab}`, fetchPage, idOf);

  const empty = searching
    ? { title: 'Nothing found', body: `No games match “${q}”.` }
    : tab === 'following'
      ? { title: 'Quiet in here', body: 'Follow creators to see their new games here.' }
      : { title: 'No games yet', body: 'Be the first: tap the big + and make one.' };

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <Header
        title="Dreamsy"
        subtitle={user ? `hi @${user.handle}` : undefined}
        right={
          user && (
            <Pressable accessibilityRole="button" accessibilityLabel="Your profile" onPress={() => router.navigate('/profile')} hitSlop={6}>
              <Avatar user={user} size={42} />
            </Pressable>
          )
        }
      />
      <View style={styles.top}>
        <Field
          value={query}
          onChangeText={setQuery}
          placeholder="Search games and creators"
          returnKeyType="search"
          autoCorrect={false}
          autoCapitalize="none"
          clearButtonMode="while-editing"
          style={styles.search}
        />
        {!searching && <Pills options={TABS} value={tab} onChange={setTab} />}
      </View>

      {list.items === null ? (
        <Loading />
      ) : (
        <FlatList
          data={list.items}
          keyExtractor={idOf}
          renderItem={({ item }) => <GameCard game={item} />}
          refreshControl={<RefreshControl refreshing={list.refreshing} onRefresh={list.refresh} tintColor={ink.fg} />}
          onEndReached={list.loadMore}
          onEndReachedThreshold={0.6}
          contentContainerStyle={styles.list}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={
            list.error ? (
              <Txt variant="meta" color={ink.danger} center>
                {list.error}
              </Txt>
            ) : undefined
          }
          ListEmptyComponent={list.error ? undefined : <Empty {...empty} />}
          ListFooterComponent={list.loadingMore ? <Loading style={{ marginTop: 0 }} /> : undefined}
        />
      )}
    </SafeAreaView>
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: ink.bg },
  top: { paddingHorizontal: 20, paddingBottom: 6, gap: 12 },
  search: { minHeight: 46 },
  list: { padding: 20, paddingTop: 10, gap: 18 },
});
