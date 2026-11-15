import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, TextInput, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api, type FeedGame, type FeedTab } from '@/api';
import { GameCard, GameRow } from '@/components/GameCard';
import { font, ink, radius } from '@/theme';
import { Chip, Empty, Pills, Skeleton, Txt } from '@/ui';
import { usePaged } from '@/usePaged';

const SORTS: { value: FeedTab; label: string }[] = [
  { value: 'trending', label: 'Trending' },
  { value: 'top', label: 'Most liked' },
  { value: 'new', label: 'New' },
  { value: 'following', label: 'Following' },
];
const PAD = 16;
const GAP = 12;
const idOf = (g: FeedGame) => g.id;

/** Discover: search, then charts by sort in a two-column grid. */
export default function DiscoverScreen() {
  const params = useLocalSearchParams<{ sort?: string; multiplayer?: string }>();
  const { width } = useWindowDimensions();
  const card = (width - PAD * 2 - GAP) / 2;
  const [sort, setSort] = useState<FeedTab>('trending');
  const [multiplayer, setMultiplayer] = useState(false);
  const [query, setQuery] = useState('');
  const q = useDebounced(query.trim(), 300);
  const searching = q.length > 0;

  useEffect(() => {
    if (params.sort && SORTS.some((s) => s.value === params.sort)) setSort(params.sort as FeedTab);
  }, [params.sort]);
  useEffect(() => {
    if (params.multiplayer !== undefined) setMultiplayer(params.multiplayer === '1');
  }, [params.multiplayer]);

  const fetchPage = useCallback(
    async (cursor: string | null) => {
      const r = searching ? await api.search(q, cursor, { multiplayer }) : await api.feed(sort, cursor, 30, { multiplayer });
      return { items: r.games, next: r.next };
    },
    [searching, q, sort, multiplayer],
  );
  const mp = multiplayer ? ':mp' : '';
  const list = usePaged(searching ? `search:${q}${mp}` : `chart:${sort}${mp}`, fetchPage, idOf);

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <Txt variant="title" style={styles.title}>
        Discover
      </Txt>
      <View style={styles.searchBar}>
        <Ionicons name="search" size={17} color={ink.muted} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search games and creators"
          placeholderTextColor={ink.faint}
          selectionColor={ink.accent}
          returnKeyType="search"
          autoCorrect={false}
          autoCapitalize="none"
          style={styles.input}
        />
        {!!query && (
          <Pressable accessibilityLabel="Clear search" onPress={() => setQuery('')} hitSlop={10}>
            <Ionicons name="close-circle" size={17} color={ink.faint} />
          </Pressable>
        )}
      </View>
      <View style={styles.filters}>
        <Chip label="Multiplayer" icon="people" filled={multiplayer} onPress={() => setMultiplayer((m) => !m)} />
        {!searching && (
          <View style={styles.flex}>
            <Pills options={SORTS} value={sort} onChange={setSort} style={styles.sorts} />
          </View>
        )}
      </View>

      {list.items === null ? (
        <View style={styles.skeletons}>
          {Array.from({ length: 6 }, (_, i) => (
            <View key={i} style={{ width: card, gap: 8 }}>
              <Skeleton style={{ width: card, height: card, borderRadius: radius.md }} />
              <Skeleton style={{ width: card * 0.7, height: 12, borderRadius: 6 }} />
            </View>
          ))}
        </View>
      ) : searching ? (
        <FlatList
          key="rows"
          data={list.items}
          keyExtractor={idOf}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          onEndReached={list.loadMore}
          contentContainerStyle={styles.rows}
          ListEmptyComponent={<Empty title="Nothing found" body={`No ${multiplayer ? 'multiplayer ' : ''}games match “${q}”.`} />}
          renderItem={({ item }) => <GameRow game={item} />}
        />
      ) : (
        <FlatList
          key="grid"
          data={list.items}
          keyExtractor={idOf}
          numColumns={2}
          columnWrapperStyle={styles.gridRow}
          contentContainerStyle={styles.grid}
          keyboardDismissMode="on-drag"
          onEndReached={list.loadMore}
          onEndReachedThreshold={0.6}
          refreshControl={<RefreshControl refreshing={list.refreshing} onRefresh={list.refresh} tintColor={ink.accent} />}
          ListEmptyComponent={
            list.error ? (
              <Empty title="Couldn't load" body={list.error} />
            ) : multiplayer ? (
              <Empty title="No multiplayer games yet" body="Games you can play together show up here." />
            ) : sort === 'following' ? (
              <Empty title="Nothing here yet" body="Games from creators you follow show up here." />
            ) : (
              <Empty title="No games yet" />
            )
          }
          renderItem={({ item, index }) => (
            <View>
              {index < 3 && sort !== 'following' && (
                <Txt variant="badge" color={ink.accent} style={styles.rank}>
                  #{index + 1}
                </Txt>
              )}
              <GameCard game={item} width={card} />
            </View>
          )}
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
  title: { paddingHorizontal: PAD, paddingTop: 8, color: ink.navy },
  searchBar: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: PAD, marginTop: 12, paddingHorizontal: 14, height: 44, borderRadius: radius.md, backgroundColor: ink.card },
  input: { flex: 1, fontFamily: font.medium, fontSize: 16, color: ink.fg, paddingVertical: 0 },
  filters: { flexDirection: 'row', alignItems: 'center', paddingLeft: PAD, paddingVertical: 12, gap: 8 },
  sorts: { paddingRight: PAD },
  flex: { flex: 1 },
  skeletons: { flexDirection: 'row', flexWrap: 'wrap', gap: GAP, paddingHorizontal: PAD, paddingTop: 12 },
  rows: { paddingVertical: 8 },
  grid: { paddingHorizontal: PAD, paddingBottom: 32, gap: 18 },
  gridRow: { gap: GAP },
  rank: { position: 'absolute', zIndex: 1, top: 8, right: 8, backgroundColor: ink.card, paddingHorizontal: 6, paddingVertical: 3, borderRadius: 6, overflow: 'hidden' },
});
