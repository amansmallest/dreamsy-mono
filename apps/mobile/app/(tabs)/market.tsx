import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useCallback, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { absoluteApiUrl, api, type MarketItem, type MarketSort } from '@/api';
import { openGame } from '@/components/GameCard';
import { compact } from '@/social';
import { ink, stroke } from '@/theme';
import { Card, Empty, Header, Loading, Pills, Txt, type IconName } from '@/ui';
import { usePaged } from '@/usePaged';

const SORTS: { value: MarketSort; label: string }[] = [
  { value: 'popular', label: 'Popular' },
  { value: 'new', label: 'New' },
  { value: 'price', label: 'Price' },
];

const KIND_ICON: Record<string, IconName> = {
  pass: 'key-outline',
  consumable: 'flask-outline',
  skin: 'shirt-outline',
};

const idOf = (i: MarketItem) => `${i.gameId}:${i.itemId}`;

/** Store items across published games. Buying happens in-game (engine purchase sheet). */
export default function MarketScreen() {
  const [sort, setSort] = useState<MarketSort>('popular');
  const fetchPage = useCallback(
    async (cursor: string | null) => {
      const r = await api.marketplace(sort, cursor);
      return { items: r.items, next: r.next };
    },
    [sort],
  );
  const list = usePaged(sort, fetchPage, idOf);

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <Header title="Shop" subtitle="items from the games" />
      <View style={styles.top}>
        <Pills options={SORTS} value={sort} onChange={setSort} />
      </View>
      {list.items === null ? (
        <Loading />
      ) : (
        <FlatList
          data={list.items}
          keyExtractor={idOf}
          refreshControl={<RefreshControl refreshing={list.refreshing} onRefresh={list.refresh} tintColor={ink.fg} />}
          onEndReached={list.loadMore}
          onEndReachedThreshold={0.6}
          contentContainerStyle={styles.list}
          ListHeaderComponent={
            list.error ? (
              <Txt variant="meta" color={ink.danger} center>
                {list.error}
              </Txt>
            ) : undefined
          }
          ListEmptyComponent={list.error ? undefined : <Empty title="Shelves are empty" body="Games with store items show up here." />}
          ListFooterComponent={list.loadingMore ? <Loading style={{ marginTop: 0 }} /> : undefined}
          renderItem={({ item }) => <ItemRow item={item} />}
        />
      )}
    </SafeAreaView>
  );
}

function ItemRow({ item }: { item: MarketItem }) {
  const icon = absoluteApiUrl(item.iconUrl);
  return (
    <Card
      accessibilityLabel={`${item.name}, ${item.price} Stars, in ${item.gameName}`}
      onPress={() => openGame(item.gameId)}
      style={styles.row}
    >
      <View style={styles.icon}>
        {icon ? (
          <Image source={{ uri: icon }} style={StyleSheet.absoluteFill} contentFit="cover" transition={120} />
        ) : (
          <Ionicons name={KIND_ICON[item.kind] ?? 'pricetag-outline'} size={26} color={ink.fg} />
        )}
      </View>
      <View style={styles.main}>
        <Txt variant="heading" numberOfLines={1}>
          {item.name}
        </Txt>
        <Txt variant="meta" muted numberOfLines={1}>
          {item.gameName}
          {item.sales > 0 ? ` · ${compact(item.sales)} sold` : ''}
        </Txt>
        {!!item.description && (
          <Txt variant="meta" muted numberOfLines={1}>
            {item.description}
          </Txt>
        )}
      </View>
      <View style={styles.price}>
        <Txt variant="pixel" color={ink.accentFg} style={styles.priceText}>
          ★ {item.price}
        </Txt>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: ink.bg },
  top: { paddingHorizontal: 20, paddingBottom: 6 },
  list: { padding: 20, paddingTop: 10, gap: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12 },
  icon: {
    width: 58,
    height: 58,
    borderRadius: 29,
    borderWidth: stroke.base,
    borderColor: ink.fg,
    backgroundColor: ink.wash,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  main: { flex: 1, gap: 2 },
  price: { borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7, backgroundColor: ink.fg },
  priceText: { fontSize: 12 },
});
