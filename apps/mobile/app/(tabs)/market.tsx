import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useCallback, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { absoluteApiUrl, api, type MarketItem, type MarketSort } from '@/api';
import { openGame } from '@/components/GameCard';
import { compact } from '@/social';
import { ink, radius } from '@/theme';
import { formatCoins } from '@/coins';
import { Badge, Empty, Header, Loading, Pills, PixelCoin, PixelSky, Pressy, Txt, type IconName } from '@/ui';
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
      <Header title="Shop" />
      <View style={styles.top}>
        <Pills options={SORTS} value={sort} onChange={setSort} />
      </View>
      {list.items === null ? (
        <Loading />
      ) : (
        <FlatList
          data={list.items}
          keyExtractor={idOf}
          numColumns={2}
          columnWrapperStyle={styles.cols}
          refreshControl={<RefreshControl refreshing={list.refreshing} onRefresh={list.refresh} tintColor={ink.accent} />}
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
          ListEmptyComponent={list.error ? undefined : <Empty title="Nothing for sale yet" body="Items from games show up here." />}
          ListFooterComponent={list.loadingMore ? <Loading style={{ marginTop: 0 }} /> : undefined}
          renderItem={({ item }) => <ItemCard item={item} />}
        />
      )}
    </SafeAreaView>
  );
}

function ItemCard({ item }: { item: MarketItem }) {
  const icon = absoluteApiUrl(item.iconUrl);
  return (
    <Pressy
      accessibilityLabel={`${item.name}, ${item.price.toLocaleString()} coins, in ${item.gameName}`}
      onPress={() => openGame(item.gameId)}
      haptic={false}
      style={styles.item}
    >
      <View style={styles.art}>
        <PixelSky style={StyleSheet.absoluteFill} />
        {icon ? (
          <Image source={{ uri: icon }} style={StyleSheet.absoluteFill} contentFit="cover" transition={120} />
        ) : (
          <View style={styles.iconBubble}>
            <Ionicons name={KIND_ICON[item.kind] ?? 'pricetag-outline'} size={26} color={ink.navy} />
          </View>
        )}
        <Badge label={item.kind} tone="white" style={styles.kind} />
      </View>
      <View style={styles.meta}>
        <Txt variant="heading" numberOfLines={1}>
          {item.name}
        </Txt>
        <Txt variant="meta" muted numberOfLines={1}>
          {item.gameName}
        </Txt>
        <View style={styles.priceRow}>
          <View style={styles.price}>
            <PixelCoin size={10} color={ink.accentFg} />
            <Txt variant="label" color={ink.accentFg}>
              {formatCoins(item.price)}
            </Txt>
          </View>
          {item.sales > 0 && (
            <Txt variant="meta" muted>
              {compact(item.sales)} sold
            </Txt>
          )}
        </View>
      </View>
    </Pressy>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: ink.bg },
  top: { paddingHorizontal: 16, paddingBottom: 8 },
  list: { padding: 16, paddingTop: 4, gap: 12 },
  cols: { gap: 12 },
  item: { flex: 1, backgroundColor: ink.card, borderRadius: radius.lg, overflow: 'hidden' },
  art: { aspectRatio: 1, alignItems: 'center', justifyContent: 'center' },
  iconBubble: { width: 56, height: 56, borderRadius: 28, backgroundColor: ink.card, alignItems: 'center', justifyContent: 'center' },
  kind: { position: 'absolute', top: 8, left: 8 },
  meta: { padding: 12, gap: 3 },
  priceRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 },
  price: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: ink.accent, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4 },
});
